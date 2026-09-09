'use strict';

const db = require('../db');
const { localDate, addDays, formatDateTimeDe } = require('../lib/dates');

const CHART_DAYS = 30;
const ORDER_LIST_LIMIT = 100;
const KEEP_RUNS = 60;

// Nur diese Creator bekommen einen Snapshot: freigegeben und mit mindestens
// einem aktiven Code. Ein Creator ohne zugewiesene Marke hat nichts zu zeigen.
const ACTIVE = `c.status IN ('approved','paused') AND EXISTS (
  SELECT 1 FROM creator_codes cc WHERE cc.creator_id = c.id AND cc.status = 'active'
)`;

/**
 * Jede Bestellung, die einem Creator zusteht – aufgelöst über Marke UND Code.
 *
 * Die Zuordnung läuft bewusst über beides: Bestellnummern und Rabattcodes sind
 * nur innerhalb eines Shops eindeutig. Würden wir nur über den Code verbinden,
 * bekäme bei zwei Marken mit gleichlautendem Code der falsche Creator das Geld.
 *
 * Die Provision hängt am Code, nicht am Creator: Für dieselbe Person können je
 * Marke unterschiedliche Sätze gelten.
 */
const EARNINGS = `
  SELECT cc.creator_id, cc.brand_id, s.id AS sale_id, s.order_ref, s.order_date, s.status,
         s.net_amount,
         CASE WHEN s.status = 'confirmed' THEN s.net_amount ELSE 0 END AS revenue,
         CASE WHEN s.status = 'confirmed'
              THEN s.net_amount * cc.commission_rate / 100 ELSE 0 END AS commission
    FROM creator_codes cc
    JOIN creators cr ON cr.id = cc.creator_id AND cr.status IN ('approved','paused')
    JOIN sales s ON s.brand_id = cc.brand_id AND s.code_norm = cc.code_norm
   WHERE cc.status = 'active'`;

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
async function buildSnapshot({ triggeredBy = 'cron' } = {}) {
  const now = new Date();
  const today = localDate(now);
  const chartFrom = addDays(today, -(CHART_DAYS - 1));
  const win30From = addDays(today, -29);
  const win60From = addDays(today, -59);
  const win30PrevTo = addDays(today, -30);

  return db.tx(async (t) => {
    const run = await t.one(
      `INSERT INTO snapshot_runs (as_of, as_of_label, as_of_day, triggered_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [now.toISOString(), formatDateTimeDe(now), today, triggeredBy]
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
       FROM creator_codes cc
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
       WHERE cc.status = 'active' AND c.status IN ('approved','paused')`,
      [runId, win30From, today]
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

/**
 * Wurde heute nach dem geplanten Zeitpunkt bereits ein Lauf erzeugt?
 * Der stündliche Scheduler auf Netlify nutzt das, um nicht mehrfach zu laufen.
 */
async function hasRunToday(day) {
  const row = await db.one(
    `SELECT id FROM snapshot_runs WHERE as_of_day = $1 AND triggered_by IN ('cron','schedule') LIMIT 1`,
    [day]
  );
  return Boolean(row);
}

module.exports = { buildSnapshot, latestRun, dashboardFor, hasRunToday, CHART_DAYS };
