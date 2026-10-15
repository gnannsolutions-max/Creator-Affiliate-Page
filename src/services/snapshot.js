'use strict';

const db = require('../db');
const { localDate, addDays, formatDateTimeDe } = require('../lib/dates');

const config = require('../config');

const CHART_DAYS = 30;
// Fester Abzug je Bestellung, bevor der Prozentsatz greift (siehe config).
// Als Zahl direkt ins SQL, weil EARNINGS ein Textbaustein ohne Parameter ist.
const DEDUCTION = Number.isFinite(config.program.commissionDeduction)
  ? Math.max(0, config.program.commissionDeduction)
  : 0;
const ORDER_LIST_LIMIT = 100;
const KEEP_RUNS = 60;

// Nur diese Creator bekommen einen Snapshot: freigegeben und mit mindestens
// einem aktiven Code ODER mit mindestens einer Umsatzzeile, die ihnen beim
// Import über den Namen zugeordnet wurde. Wer weder das eine noch das andere
// hat, hat nichts zu zeigen.
const ACTIVE = `c.status IN ('approved','paused') AND (
  EXISTS (SELECT 1 FROM creator_codes cc WHERE cc.creator_id = c.id AND cc.status = 'active')
  OR EXISTS (SELECT 1 FROM sales sx WHERE sx.creator_id = c.id)
)`;

/**
 * Jede Umsatzzeile, die einem Creator zusteht.
 *
 * Zwei Wege führen zum Creator, und die Zeile selbst hat Vorrang:
 *   1. Die Zeile trägt creator_id – gesetzt beim Import des Shop-Exports, der
 *      den Creator beim Namen nennt. Der Provisionssatz steht dann ebenfalls in
 *      der Zeile (commission_rate), weil der Shop ihn mitliefert.
 *   2. Die Zeile trägt einen Rabattcode – der alte Weg. Code und Marke
 *      zusammen zeigen auf den Creator; der Satz kommt vom Code. Marke UND
 *      Code, weil Codes nur innerhalb eines Shops eindeutig sind.
 *
 * Eine Zeile ohne creator_id und ohne passenden Code gehört niemandem und
 * fällt hier heraus – sie bleibt in `sales` und steht im Importergebnis.
 */
const EARNINGS = `
  SELECT COALESCE(s.creator_id, cc.creator_id) AS creator_id,
         s.brand_id, s.id AS sale_id, s.order_ref, s.order_date, s.status,
         -- Der Creator sieht den „realen“ Nettobetrag: Netto minus fester Abzug je
         -- Bestellung (eigene Kosten). Provision und Umsatz beziehen sich beide darauf.
         GREATEST(s.net_amount - ${DEDUCTION}, 0) AS net_amount,
         CASE WHEN s.status = 'confirmed' THEN GREATEST(s.net_amount - ${DEDUCTION}, 0) ELSE 0 END AS revenue,
         CASE WHEN s.status = 'confirmed'
              THEN GREATEST(s.net_amount - ${DEDUCTION}, 0) * COALESCE(s.commission_rate, cc.commission_rate, 0) / 100
              ELSE 0 END AS commission
    FROM sales s
    LEFT JOIN creator_codes cc
           ON s.creator_id IS NULL
          AND cc.brand_id = s.brand_id
          AND cc.code_norm = s.code_norm
          AND cc.status = 'active'
    JOIN creators cr ON cr.id = COALESCE(s.creator_id, cc.creator_id)
                    AND cr.status IN ('approved','paused')`;

/**
 * Baut den Stand, den Creator im Dashboard sehen.
 *
 * Die komplette Aggregation läuft in SQL. Das ist nicht nur schneller als eine
 * Schleife über alle Creator, sondern auch die Voraussetzung dafür, dass der
 * Lauf in das 30-Sekunden-Limit einer Netlify Scheduled Function passt: vier
 * Anweisungen statt vier Abfragen pro Creator.
 *
 * Provision entsteht ausschließlich auf Bestellungen mit Status 'confirmed'.
 * Retouren fallen damit automatisch wieder heraus, sobald sie im nächsten
 * CSV-Export als solche auftauchen.
 */
async function buildSnapshot({ triggeredBy = 'cron', slot = null } = {}) {
  const now = new Date();
  const today = localDate(now);
  const chartFrom = addDays(today, -(CHART_DAYS - 1));
  const win30From = addDays(today, -29);
  const win60From = addDays(today, -59);
  const win30PrevTo = addDays(today, -30);

  return db.tx(async (t) => {
    const run = await t.one(
      `INSERT INTO snapshot_runs (as_of, as_of_label, as_of_day, triggered_by, slot)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [now.toISOString(), formatDateTimeDe(now), today, triggeredBy, slot]
    );
    const runId = run.id;

    // --- Kennzahlen je Creator über alle Marken -------------------------------
    await t.run(
      `WITH earnings AS (${EARNINGS})
       INSERT INTO snapshot_totals (
         run_id, creator_id, orders_total, revenue_total, commission_total,
         orders_30d, revenue_30d, commission_30d, orders_prev30d, revenue_prev30d,
         avg_order_value, first_sale_date, last_sale_date, commission_paid, commission_open)
       SELECT
         $1, c.id,
         COALESCE(a.orders, 0),
         ROUND(COALESCE(a.revenue, 0)::numeric, 2)::float8,
         ROUND(COALESCE(a.commission, 0)::numeric, 2)::float8,
         COALESCE(w.orders, 0),
         ROUND(COALESCE(w.revenue, 0)::numeric, 2)::float8,
         ROUND(COALESCE(w.commission, 0)::numeric, 2)::float8,
         COALESCE(p.orders, 0),
         ROUND(COALESCE(p.revenue, 0)::numeric, 2)::float8,
         CASE WHEN COALESCE(a.orders, 0) > 0
              THEN ROUND((a.revenue / a.orders)::numeric, 2)::float8 ELSE 0 END,
         a.first_date, a.last_date,
         ROUND(COALESCE(pay.paid, 0)::numeric, 2)::float8,
         ROUND((COALESCE(a.commission, 0) - COALESCE(pay.paid, 0))::numeric, 2)::float8
       FROM creators c
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(e.revenue) AS revenue, SUM(e.commission) AS commission,
                MIN(e.order_date) AS first_date, MAX(e.order_date) AS last_date
           FROM earnings e
          WHERE e.creator_id = c.id AND e.status = 'confirmed'
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(e.revenue) AS revenue, SUM(e.commission) AS commission
           FROM earnings e
          WHERE e.creator_id = c.id AND e.status = 'confirmed'
            AND e.order_date >= $2 AND e.order_date <= $3
       ) w ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(e.revenue) AS revenue
           FROM earnings e
          WHERE e.creator_id = c.id AND e.status = 'confirmed'
            AND e.order_date >= $4 AND e.order_date <= $5
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(po.amount) AS paid
           FROM payouts po
          WHERE po.creator_id = c.id AND po.status = 'paid'
       ) pay ON TRUE
       WHERE ${ACTIVE}`,
      [runId, win30From, today, win60From, win30PrevTo]
    );

    // --- Dieselben Zahlen je Marke, für die Aufschlüsselung im Dashboard ------
    await t.run(
      `WITH earnings AS (${EARNINGS})
       INSERT INTO snapshot_brand_totals (
         run_id, creator_id, brand_id, orders_total, revenue_total, commission_total,
         orders_30d, revenue_30d, commission_30d, last_sale_date)
       SELECT
         $1, cc.creator_id, cc.brand_id,
         COALESCE(a.orders, 0),
         ROUND(COALESCE(a.revenue, 0)::numeric, 2)::float8,
         ROUND(COALESCE(a.commission, 0)::numeric, 2)::float8,
         COALESCE(w.orders, 0),
         ROUND(COALESCE(w.revenue, 0)::numeric, 2)::float8,
         ROUND(COALESCE(w.commission, 0)::numeric, 2)::float8,
         a.last_date
       FROM (
         -- Jede Kombination aus Creator und Marke, für die es entweder einen
         -- aktiven Code oder zugeordnete Umsatzzeilen gibt.
         SELECT cc.creator_id, cc.brand_id FROM creator_codes cc WHERE cc.status = 'active'
         UNION
         SELECT e.creator_id, e.brand_id FROM earnings e
       ) cc
       JOIN creators c ON c.id = cc.creator_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(e.revenue) AS revenue, SUM(e.commission) AS commission,
                MAX(e.order_date) AS last_date
           FROM earnings e
          WHERE e.creator_id = cc.creator_id AND e.brand_id = cc.brand_id
            AND e.status = 'confirmed'
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(e.revenue) AS revenue, SUM(e.commission) AS commission
           FROM earnings e
          WHERE e.creator_id = cc.creator_id AND e.brand_id = cc.brand_id
            AND e.status = 'confirmed'
            AND e.order_date >= $2 AND e.order_date <= $3
       ) w ON TRUE
       WHERE c.status IN ('approved','paused')`,
      [runId, win30From, today]
    );

    // --- Vermittler: Summe über die vermittelten Creator ----------------------
    //  Baut auf snapshot_totals auf, damit Vermittler und Creator garantiert
    //  dieselben Umsätze sehen. Beteiligung = Umsatz × Satz des Vermittlers.
    await t.run(
      `INSERT INTO snapshot_broker_creators (
         run_id, broker_id, creator_id, orders_total, revenue_total, share_total,
         orders_30d, revenue_30d, share_30d, last_sale_date)
       SELECT $1, b.id, c.id,
              st.orders_total, st.revenue_total,
              ROUND((st.revenue_total * b.share_rate / 100)::numeric, 2)::float8,
              st.orders_30d, st.revenue_30d,
              ROUND((st.revenue_30d * b.share_rate / 100)::numeric, 2)::float8,
              st.last_sale_date
         FROM brokers b
         JOIN creators c ON c.broker_id = b.id
         JOIN snapshot_totals st ON st.run_id = $1 AND st.creator_id = c.id`,
      [runId]
    );
    await t.run(
      `INSERT INTO snapshot_broker_totals (
         run_id, broker_id, creators_count, orders_total, revenue_total, share_total,
         orders_30d, revenue_30d, share_30d, revenue_prev30d)
       SELECT $1, b.id,
              (SELECT COUNT(*) FROM creators c WHERE c.broker_id = b.id AND c.status IN ('approved','paused')),
              COALESCE(SUM(x.orders_total), 0),
              ROUND(COALESCE(SUM(x.revenue_total), 0)::numeric, 2)::float8,
              ROUND((COALESCE(SUM(x.revenue_total), 0) * b.share_rate / 100)::numeric, 2)::float8,
              COALESCE(SUM(x.orders_30d), 0),
              ROUND(COALESCE(SUM(x.revenue_30d), 0)::numeric, 2)::float8,
              ROUND((COALESCE(SUM(x.revenue_30d), 0) * b.share_rate / 100)::numeric, 2)::float8,
              ROUND(COALESCE((SELECT SUM(st.revenue_prev30d) FROM snapshot_totals st
                                JOIN creators c ON c.id = st.creator_id
                               WHERE st.run_id = $1 AND c.broker_id = b.id), 0)::numeric, 2)::float8
         FROM brokers b
         LEFT JOIN snapshot_broker_creators x ON x.run_id = $1 AND x.broker_id = b.id
        GROUP BY b.id, b.share_rate`,
      [runId]
    );

    // --- Tagesreihe für den Chart, über alle Marken zusammen ------------------
    await t.run(
      `WITH earnings AS (${EARNINGS})
       INSERT INTO snapshot_days (run_id, creator_id, day, orders, revenue, commission)
       SELECT $1, c.id, d.day,
              COALESCE(e.orders, 0),
              ROUND(COALESCE(e.revenue, 0)::numeric, 2)::float8,
              ROUND(COALESCE(e.commission, 0)::numeric, 2)::float8
         FROM creators c
         CROSS JOIN (
           SELECT to_char(gs, 'YYYY-MM-DD') AS day
             FROM generate_series($2::date, $3::date, interval '1 day') AS gs
         ) d
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS orders, SUM(x.revenue) AS revenue, SUM(x.commission) AS commission
             FROM earnings x
            WHERE x.creator_id = c.id AND x.status = 'confirmed' AND x.order_date = d.day
         ) e ON TRUE
        WHERE ${ACTIVE}`,
      [runId, chartFrom, today]
    );

    // --- Bestellliste, je Creator die letzten 100 über alle Marken ------------
    await t.run(
      `WITH earnings AS (${EARNINGS})
       INSERT INTO snapshot_orders (run_id, creator_id, brand_id, order_ref, order_date, revenue, commission, status)
       SELECT $1, x.creator_id, x.brand_id, x.order_ref, x.order_date,
              ROUND(x.net_amount::numeric, 2)::float8,
              ROUND(x.commission::numeric, 2)::float8,
              x.status
         FROM (
           SELECT e.*,
                  ROW_NUMBER() OVER (PARTITION BY e.creator_id
                                     ORDER BY e.order_date DESC, e.sale_id DESC) AS rn
             FROM earnings e
         ) x
        WHERE x.rn <= $2`,
      [runId, ORDER_LIST_LIMIT]
    );

    const summary = await t.one(
      `UPDATE snapshot_runs SET
         creators_count = (SELECT COUNT(*) FROM snapshot_totals WHERE run_id = $1),
         orders_count   = (SELECT COALESCE(SUM(orders_total), 0) FROM snapshot_totals WHERE run_id = $1)
       WHERE id = $1
       RETURNING id, creators_count, orders_count`,
      [runId]
    );

    // Alte Läufe aufräumen, damit die Snapshot-Tabellen nicht unbegrenzt wachsen.
    await t.run(
      `DELETE FROM snapshot_runs
        WHERE id NOT IN (SELECT id FROM snapshot_runs ORDER BY id DESC LIMIT $1)`,
      [KEEP_RUNS]
    );

    // Abgelaufene Zähler und verbrauchte Login-Token gehören nicht auf Dauer
    // in die Datenbank. Der tägliche Lauf ist die passende Gelegenheit.
    await t.run("DELETE FROM rate_limits WHERE window_start < now() - interval '24 hours'");
    await t.run("DELETE FROM login_tokens WHERE expires_at < now() - interval '7 days'");

    return {
      runId: summary.id,
      creators: summary.creators_count,
      orders: summary.orders_count,
    };
  });
}

async function latestRun() {
  return db.one('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1');
}

/** Alles, was das Creator-Dashboard braucht – ausschließlich aus dem Snapshot. */
async function dashboardFor(creatorId) {
  const run = await latestRun();
  if (!run) return null;

  const totals = await db.one(
    'SELECT * FROM snapshot_totals WHERE run_id = $1 AND creator_id = $2',
    [run.id, creatorId]
  );
  if (!totals) return { run, totals: null, days: [], orders: [], brands: [] };

  const [days, orders, brands] = await Promise.all([
    db.many(
      `SELECT day, orders, revenue, commission
         FROM snapshot_days WHERE run_id = $1 AND creator_id = $2 ORDER BY day`,
      [run.id, creatorId]
    ),
    db.many(
      `SELECT o.order_ref, o.order_date, o.revenue, o.commission, o.status,
              b.name AS brand_name
         FROM snapshot_orders o
         LEFT JOIN brands b ON b.id = o.brand_id
        WHERE o.run_id = $1 AND o.creator_id = $2
        ORDER BY o.order_date DESC, o.order_ref DESC`,
      [run.id, creatorId]
    ),
    db.many(
      `SELECT t.*, b.name AS brand_name, b.slug AS brand_slug
         FROM snapshot_brand_totals t
         JOIN brands b ON b.id = t.brand_id
        WHERE t.run_id = $1 AND t.creator_id = $2
        ORDER BY b.sort_order, b.name`,
      [run.id, creatorId]
    ),
  ]);

  return { run, totals, days, orders, brands };
}

/** Alles, was das Vermittler-Dashboard braucht – ausschließlich aus dem Snapshot. */
async function brokerDashboardFor(brokerId) {
  const run = await latestRun();
  if (!run) return null;
  const totals = await db.one(
    'SELECT * FROM snapshot_broker_totals WHERE run_id = $1 AND broker_id = $2',
    [run.id, brokerId]
  );
  const creators = await db.many(
    `SELECT x.*, c.full_name, c.instagram, c.requested_code, c.status
       FROM snapshot_broker_creators x JOIN creators c ON c.id = x.creator_id
      WHERE x.run_id = $1 AND x.broker_id = $2
      ORDER BY x.revenue_30d DESC, c.full_name`,
    [run.id, brokerId]
  );
  // Tagesreihe = Summe der Tagesreihen aller vermittelten Creator.
  const days = await db.many(
    `SELECT d.day, SUM(d.orders)::int AS orders,
            ROUND(SUM(d.revenue)::numeric, 2)::float8 AS revenue,
            ROUND((SUM(d.revenue) * b.share_rate / 100)::numeric, 2)::float8 AS commission
       FROM snapshot_days d
       JOIN creators c ON c.id = d.creator_id
       JOIN brokers b ON b.id = c.broker_id
      WHERE d.run_id = $1 AND c.broker_id = $2
      GROUP BY d.day, b.share_rate ORDER BY d.day`,
    [run.id, brokerId]
  );
  return { run, totals, creators, days };
}

/**
 * Hat der Sicherheitslauf für diesen Slot (z. B. '10:30') heute schon
 * stattgefunden? Netlify ruft je Slot zwei Termine auf (Sommer- und
 * Winterzeit); der zweite muss folgenlos bleiben.
 */
async function hasRunForSlot(day, slot) {
  const row = await db.one(
    `SELECT id FROM snapshot_runs
      WHERE as_of_day = $1 AND slot = $2 AND triggered_by IN ('cron','schedule') LIMIT 1`,
    [day, slot]
  );
  return Boolean(row);
}

/** Abwärtskompatibel: irgendein Sicherheitslauf heute? */
async function hasRunToday(day) {
  const row = await db.one(
    `SELECT id FROM snapshot_runs WHERE as_of_day = $1 AND triggered_by IN ('cron','schedule') LIMIT 1`,
    [day]
  );
  return Boolean(row);
}

/**
 * Lohnt sich ein Sicherheitslauf überhaupt?
 *
 * Seit jeder Upload sofort einen Snapshot erzeugt, ist der feste Lauf nur noch
 * ein Netz: Er greift, wenn ein Upload ohne Snapshot geblieben ist (etwa weil
 * die Function nach dem Import abgebrochen ist) oder wenn heute noch gar kein
 * Stand erzeugt wurde – dann sind zumindest die 30-Tage-Fenster frisch.
 *
 * Liegt der jüngste Snapshot von heute NACH dem jüngsten Import, gibt es nichts
 * Neues zu rechnen, und der Lauf wird übersprungen. Das spart Function-Zeit
 * und hält die Liste der Läufe lesbar.
 */
async function needsSafetyRun(day) {
  const latest = await latestRun();
  if (!latest || latest.as_of_day !== day) return { needed: true, reason: 'Heute noch kein Stand erzeugt.' };
  const imp = await db.one('SELECT created_at FROM imports ORDER BY id DESC LIMIT 1');
  if (imp && new Date(imp.created_at) > new Date(latest.as_of)) {
    return { needed: true, reason: 'Nach dem letzten Upload wurde noch kein Stand erzeugt.' };
  }
  return { needed: false, reason: 'Der aktuelle Stand ist jünger als der letzte Upload.' };
}

module.exports = {
  buildSnapshot,
  latestRun,
  dashboardFor,
  brokerDashboardFor,
  hasRunToday,
  hasRunForSlot,
  needsSafetyRun,
  CHART_DAYS,
};
