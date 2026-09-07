'use strict';

const db = require('../db');
const { localDate, addDays, formatDateTimeDe } = require('../lib/dates');

const CHART_DAYS = 30;
const ORDER_LIST_LIMIT = 100;
const KEEP_RUNS = 60;

// Nur diese Creator bekommen einen Snapshot.
const ACTIVE = `c.status IN ('approved','paused') AND c.assigned_code_norm IS NOT NULL`;

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

    // --- Kennzahlen je Creator ------------------------------------------------
    await t.run(
      `INSERT INTO snapshot_totals (
         run_id, creator_id, orders_total, revenue_total, commission_total,
         orders_30d, revenue_30d, commission_30d, orders_prev30d, revenue_prev30d,
         avg_order_value, first_sale_date, last_sale_date, commission_paid, commission_open)
       SELECT
         $1, c.id,
         COALESCE(a.orders, 0),
         ROUND(COALESCE(a.revenue, 0)::numeric, 2)::float8,
         ROUND((COALESCE(a.revenue, 0) * c.commission_rate / 100)::numeric, 2)::float8,
         COALESCE(w.orders, 0),
         ROUND(COALESCE(w.revenue, 0)::numeric, 2)::float8,
         ROUND((COALESCE(w.revenue, 0) * c.commission_rate / 100)::numeric, 2)::float8,
         COALESCE(p.orders, 0),
         ROUND(COALESCE(p.revenue, 0)::numeric, 2)::float8,
         CASE WHEN COALESCE(a.orders, 0) > 0
              THEN ROUND((a.revenue / a.orders)::numeric, 2)::float8 ELSE 0 END,
         a.first_date, a.last_date,
         ROUND(COALESCE(pay.paid, 0)::numeric, 2)::float8,
         ROUND((COALESCE(a.revenue, 0) * c.commission_rate / 100
                - COALESCE(pay.paid, 0))::numeric, 2)::float8
       FROM creators c
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(s.net_amount) AS revenue,
                MIN(s.order_date) AS first_date, MAX(s.order_date) AS last_date
           FROM sales s
          WHERE s.code_norm = c.assigned_code_norm AND s.status = 'confirmed'
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(s.net_amount) AS revenue
           FROM sales s
          WHERE s.code_norm = c.assigned_code_norm AND s.status = 'confirmed'
            AND s.order_date >= $2 AND s.order_date <= $3
       ) w ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders, SUM(s.net_amount) AS revenue
           FROM sales s
          WHERE s.code_norm = c.assigned_code_norm AND s.status = 'confirmed'
            AND s.order_date >= $4 AND s.order_date <= $5
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(po.amount) AS paid
           FROM payouts po
          WHERE po.creator_id = c.id AND po.status = 'paid'
       ) pay ON TRUE
       WHERE ${ACTIVE}`,
      [runId, win30From, today, win60From, win30PrevTo]
    );

    // --- Tagesreihe für den Chart, inklusive Tagen ohne Bestellung ------------
    await t.run(
      `INSERT INTO snapshot_days (run_id, creator_id, day, orders, revenue, commission)
       SELECT $1, c.id, d.day,
              COALESCE(s.orders, 0),
              ROUND(COALESCE(s.revenue, 0)::numeric, 2)::float8,
              ROUND((COALESCE(s.revenue, 0) * c.commission_rate / 100)::numeric, 2)::float8
         FROM creators c
         CROSS JOIN (
           SELECT to_char(gs, 'YYYY-MM-DD') AS day
             FROM generate_series($2::date, $3::date, interval '1 day') AS gs
         ) d
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS orders, SUM(s.net_amount) AS revenue
             FROM sales s
            WHERE s.code_norm = c.assigned_code_norm
              AND s.status = 'confirmed'
              AND s.order_date = d.day
         ) s ON TRUE
        WHERE ${ACTIVE}`,
      [runId, chartFrom, today]
    );

    // --- Bestellliste, je Creator die letzten 100 -----------------------------
    await t.run(
      `INSERT INTO snapshot_orders (run_id, creator_id, order_ref, order_date, revenue, commission, status)
       SELECT $1, x.creator_id, x.order_ref, x.order_date,
              ROUND(x.net_amount::numeric, 2)::float8,
              CASE WHEN x.status = 'confirmed'
                   THEN ROUND((x.net_amount * x.commission_rate / 100)::numeric, 2)::float8
                   ELSE 0 END,
              x.status
         FROM (
           SELECT c.id AS creator_id, c.commission_rate,
                  s.order_ref, s.order_date, s.net_amount, s.status,
                  ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY s.order_date DESC, s.id DESC) AS rn
             FROM creators c
             JOIN sales s ON s.code_norm = c.assigned_code_norm
            WHERE ${ACTIVE}
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
  if (!totals) return { run, totals: null, days: [], orders: [] };

  const [days, orders] = await Promise.all([
    db.many(
      `SELECT day, orders, revenue, commission
         FROM snapshot_days WHERE run_id = $1 AND creator_id = $2 ORDER BY day`,
      [run.id, creatorId]
    ),
    db.many(
      `SELECT order_ref, order_date, revenue, commission, status
         FROM snapshot_orders WHERE run_id = $1 AND creator_id = $2
        ORDER BY order_date DESC, order_ref DESC`,
      [run.id, creatorId]
    ),
  ]);

  return { run, totals, days, orders };
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
