'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const auth = require('../lib/auth');
const mailer = require('../lib/mailer');
const { normalizeCode, codeIssue, codeTaken } = require('../lib/validate');
const { importSalesCsv } = require('../services/importSales');
const { buildSnapshot, latestRun } = require('../services/snapshot');
const { localDate, monthKey, addDays } = require('../lib/dates');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// --- Login -------------------------------------------------------------------

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin', nav: null, error: null });
});

router.post('/login', (req, res) => {
  if (!auth.checkAdminPassword(req.body.password)) {
    return res.status(401).render('admin/login', { title: 'Admin', nav: null, error: 'Falsches Passwort.' });
  }
  auth.startAdminSession(res);
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  auth.endAdminSession(res);
  res.redirect('/admin/login');
});

router.use(auth.requireAdmin);

// --- Übersicht ---------------------------------------------------------------

router.get('/', async (req, res) => {
  const run = await latestRun();

  const counts = await db.one(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
       COUNT(*) FILTER (WHERE status = 'approved') AS approved,
       COUNT(*) FILTER (WHERE status = 'paused')   AS paused
     FROM creators`
  );

  let totals = { revenue30: 0, orders30: 0, commissionOpen: 0 };
  let top = [];
  if (run) {
    totals = await db.one(
      `SELECT COALESCE(SUM(revenue_30d), 0)     AS "revenue30",
              COALESCE(SUM(orders_30d), 0)      AS "orders30",
              COALESCE(SUM(commission_open), 0) AS "commissionOpen"
         FROM snapshot_totals WHERE run_id = $1`,
      [run.id]
    );
    top = await db.many(
      `SELECT c.id, c.full_name, c.assigned_code, t.orders_30d, t.revenue_30d, t.commission_30d
         FROM snapshot_totals t JOIN creators c ON c.id = t.creator_id
        WHERE t.run_id = $1 AND t.revenue_30d > 0
        ORDER BY t.revenue_30d DESC LIMIT 10`,
      [run.id]
    );
  }

  res.render('admin/home', {
    title: 'Übersicht',
    nav: 'admin-home',
    run,
    counts,
    totals,
    top,
    refreshTime: config.refresh.label,
    timezone: config.refresh.timezone,
    hasSmtp: mailer.hasSmtp(),
    flash: req.query.ok || null,
  });
});

router.post('/refresh', async (req, res) => {
  const result = await buildSnapshot({ triggeredBy: 'admin' });
  res.redirect(
    `/admin?ok=${encodeURIComponent(
      `Snapshot erzeugt: ${result.creators} Creator, ${result.orders} Bestellungen.`
    )}`
  );
});

// --- Creatorliste ------------------------------------------------------------

router.get('/creators', async (req, res) => {
  const status = ['pending', 'approved', 'paused', 'rejected', 'all'].includes(req.query.status)
    ? req.query.status
    : 'pending';

  const [rows, counts] = await Promise.all([
    status === 'all'
      ? db.many('SELECT * FROM creators ORDER BY created_at DESC')
      : db.many('SELECT * FROM creators WHERE status = $1 ORDER BY created_at DESC', [status]),
    db.one(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
         COUNT(*) FILTER (WHERE status = 'approved') AS approved,
         COUNT(*) FILTER (WHERE status = 'paused')   AS paused,
         COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
         COUNT(*)                                    AS all
       FROM creators`
    ),
  ]);

  res.render('admin/creators', {
    title: 'Creator',
    nav: 'admin-creators',
    rows,
    status,
    counts,
    baseUrl: config.baseUrl,
    flash: req.query.ok || null,
  });
});

async function renderCreator(req, res, extra = {}) {
  const c = await db.one('SELECT * FROM creators WHERE id = $1', [req.params.id]);
  if (!c) {
    return res.status(404).render('error', {
      title: 'Nicht gefunden',
      nav: null,
      heading: 'Nicht gefunden',
      message: 'Diesen Creator gibt es nicht.',
    });
  }

  const run = await latestRun();
  const totals = run
    ? await db.one('SELECT * FROM snapshot_totals WHERE run_id = $1 AND creator_id = $2', [run.id, c.id])
    : null;

  return res.render('admin/creator', {
    title: c.full_name,
    nav: 'admin-creators',
    c,
    run,
    totals,
    defaultPeriod: monthKey(addDays(localDate(), -15)),
    flash: req.query.ok || null,
    error: null,
    loginLink: null,
    hasSmtp: mailer.hasSmtp(),
    ...extra,
  });
}

router.get('/creators/:id', (req, res) => renderCreator(req, res));

router.post('/creators/:id/approve', async (req, res) => {
  const id = req.params.id;
  const c = await db.one('SELECT * FROM creators WHERE id = $1', [id]);
  if (!c) return res.redirect('/admin/creators');

  const code = normalizeCode(req.body.code);
  const issue = codeIssue(code) || ((await codeTaken(code, id)) ? 'Dieser Code ist bereits vergeben.' : null);
  if (issue) return renderCreator(req, res, { error: issue });

  const rate = Number(req.body.commission_rate);
  const discount = Number(req.body.customer_discount);
  if (!Number.isFinite(rate) || rate < 0 || rate > 90) {
    return renderCreator(req, res, { error: 'Provision muss zwischen 0 und 90 % liegen.' });
  }

  const updated = await db.one(
    `UPDATE creators
        SET assigned_code = $1, assigned_code_norm = $1, status = 'approved',
            commission_rate = $2, customer_discount = $3,
            reviewed_at = now(), reviewed_by = $4, decision_reason = NULL
      WHERE id = $5
      RETURNING *`,
    [code, rate, Number.isFinite(discount) ? discount : config.program.defaultCustomerDiscount, config.adminName, id]
  );

  await db.log(config.adminName, 'creator.approved', updated.email, `Code ${code}, ${rate} %`);

  const token = await auth.createLoginToken(id);
  const url = `${config.baseUrl}/login/${token}`;
  const result = await mailer
    .send({ to: updated.email, ...mailer.templates.approved(updated, url) })
    .catch((err) => ({ sent: false, error: err.message }));

  // Ohne SMTP bleibt die Seite stehen und zeigt den Link zum Kopieren an,
  // statt eine Erfolgsmeldung über eine Mail auszugeben, die nie ankommt.
  if (!result.sent) {
    return renderCreator(req, res, {
      loginLink: url,
      flash: `Freigegeben. Code ${code} ist aktiv.`,
    });
  }

  res.redirect(
    `/admin/creators/${id}?ok=${encodeURIComponent(`Freigegeben. Code ${code} ist aktiv, E-Mail ist raus.`)}`
  );
});

router.post('/creators/:id/reject', async (req, res) => {
  const id = req.params.id;
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const c = await db.one(
    `UPDATE creators SET status = 'rejected', decision_reason = $1, reviewed_at = now(), reviewed_by = $2
      WHERE id = $3 RETURNING *`,
    [reason || null, config.adminName, id]
  );
  if (!c) return res.redirect('/admin/creators');

  await db.log(config.adminName, 'creator.rejected', c.email, reason);
  await mailer
    .send({ to: c.email, ...mailer.templates.rejected(c) })
    .catch((err) => console.error('Mailversand fehlgeschlagen:', err.message));

  res.redirect(`/admin/creators/${id}?ok=${encodeURIComponent('Abgelehnt und benachrichtigt.')}`);
});

router.post('/creators/:id/reopen', async (req, res) => {
  await db.run("UPDATE creators SET status = 'pending', decision_reason = NULL WHERE id = $1", [req.params.id]);
  res.redirect(`/admin/creators/${req.params.id}?ok=${encodeURIComponent('Wieder auf offen gesetzt.')}`);
});

router.post('/creators/:id/update', async (req, res) => {
  const id = req.params.id;
  const code = normalizeCode(req.body.code);
  const issue = codeIssue(code) || ((await codeTaken(code, id)) ? 'Dieser Code ist bereits vergeben.' : null);
  if (issue) return renderCreator(req, res, { error: issue });

  const rate = Number(req.body.commission_rate);
  const discount = Number(req.body.customer_discount);
  const status = ['approved', 'paused'].includes(req.body.status) ? req.body.status : 'approved';

  await db.run(
    `UPDATE creators
        SET assigned_code = $1, assigned_code_norm = $1, commission_rate = $2,
            customer_discount = $3, status = $4, note_internal = $5
      WHERE id = $6`,
    [
      code,
      Number.isFinite(rate) ? rate : config.program.defaultCommissionRate,
      Number.isFinite(discount) ? discount : config.program.defaultCustomerDiscount,
      status,
      String(req.body.note_internal || '').slice(0, 2000) || null,
      id,
    ]
  );

  await db.log(config.adminName, 'creator.updated', String(id), `Code ${code}, ${rate} %, ${status}`);
  res.redirect(
    `/admin/creators/${id}?ok=${encodeURIComponent('Gespeichert. Wirkt im Creator-Dashboard nach dem nächsten Lauf.')}`
  );
});

/**
 * Erzeugt einen Login-Link und zeigt ihn direkt an, statt ihn nur zu mailen.
 * Damit funktioniert das Portal auch ohne SMTP-Zugang: Ihr kopiert den Link
 * und schickt ihn dem Creator über den Kanal, über den ihr ohnehin schreibt.
 */
router.post('/creators/:id/login-link', async (req, res) => {
  const c = await db.one('SELECT * FROM creators WHERE id = $1', [req.params.id]);
  if (!c) return res.redirect('/admin/creators');

  const token = await auth.createLoginToken(c.id);
  const url = `${config.baseUrl}/login/${token}`;
  await db.log(config.adminName, 'creator.login_link', c.email, 'manuell erzeugt');

  return renderCreator(req, res, { loginLink: url });
});

// --- Ausgangspostfach --------------------------------------------------------

router.get('/mails', async (req, res) => {
  res.render('admin/mails', {
    title: 'Ausgehende Nachrichten',
    nav: 'admin-mails',
    hasSmtp: mailer.hasSmtp(),
    rows: await db.many('SELECT * FROM outbox ORDER BY id DESC LIMIT 50'),
  });
});

// --- Import ------------------------------------------------------------------

router.get('/import', async (req, res) => {
  res.render('admin/import', {
    title: 'Umsätze importieren',
    nav: 'admin-import',
    result: null,
    refreshTime: config.refresh.label,
    imports: await db.many('SELECT * FROM imports ORDER BY id DESC LIMIT 15'),
  });
});

router.get('/import/vorlage.csv', (req, res) => {
  const today = localDate();
  const csv = [
    'order_ref;code;order_date;gross_amount;net_amount;status',
    `1001;LUAN15;${today};89,90;75,55;paid`,
    `1002;LUAN15;${today};45,00;37,82;paid`,
    `1003;MIRA10;${addDays(today, -1)};129,00;108,40;refunded`,
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="umsatz-vorlage.csv"');
  res.send(csv);
});

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/import');
  const text = req.file.buffer.toString('utf8');
  const result = await importSalesCsv(text, { filename: req.file.originalname, actor: config.adminName });

  res.render('admin/import', {
    title: 'Umsätze importieren',
    nav: 'admin-import',
    result,
    refreshTime: config.refresh.label,
    imports: await db.many('SELECT * FROM imports ORDER BY id DESC LIMIT 15'),
  });
});

// --- Auszahlungen ------------------------------------------------------------

router.get('/payouts', async (req, res) => {
  const run = await latestRun();
  const open = run
    ? await db.many(
        `SELECT c.id, c.full_name, c.assigned_code, t.commission_total, t.commission_paid, t.commission_open
           FROM snapshot_totals t JOIN creators c ON c.id = t.creator_id
          WHERE t.run_id = $1 AND t.commission_open > 0.005
          ORDER BY t.commission_open DESC`,
        [run.id]
      )
    : [];

  const rows = await db.many(
    `SELECT p.*, c.full_name FROM payouts p JOIN creators c ON c.id = p.creator_id
      ORDER BY p.created_at DESC LIMIT 100`
  );

  res.render('admin/payouts', {
    title: 'Auszahlungen',
    nav: 'admin-payouts',
    run,
    open,
    rows,
    flash: req.query.ok || null,
  });
});

router.post('/payouts', async (req, res) => {
  const creatorId = req.body.creator_id;
  const period = String(req.body.period || '').trim().slice(0, 20);
  const amount = Number(String(req.body.amount).replace(',', '.'));
  const status = req.body.status === 'paid' ? 'paid' : 'open';
  if (!creatorId || !period || !Number.isFinite(amount)) {
    return res.redirect(`/admin/creators/${creatorId || ''}`);
  }

  await db.run(
    `INSERT INTO payouts (creator_id, period, amount, status, paid_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (creator_id, period) DO UPDATE SET
       amount = EXCLUDED.amount, status = EXCLUDED.status, paid_at = EXCLUDED.paid_at`,
    [creatorId, period, Math.round(amount * 100) / 100, status, status === 'paid' ? localDate() : null]
  );

  await db.log(config.adminName, 'payout.saved', String(creatorId), `${period}: ${amount} (${status})`);
  res.redirect(`/admin/creators/${creatorId}?ok=${encodeURIComponent('Auszahlung gespeichert.')}`);
});

router.post('/payouts/:id/paid', async (req, res) => {
  await db.run("UPDATE payouts SET status = 'paid', paid_at = $1 WHERE id = $2", [
    localDate(),
    req.params.id,
  ]);
  res.redirect(`/admin/payouts?ok=${encodeURIComponent('Als ausgezahlt markiert.')}`);
});

module.exports = router;
