'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const auth = require('../lib/auth');
const mailer = require('../lib/mailer');
const { normalizeCode, codeIssue, codeTaken, codeTakenInBrand } = require('../lib/validate');
const rateLimit = require('../lib/ratelimit');
const payout = require('../lib/payout');
const brandsLib = require('../lib/brands');
const leadsLib = require('../lib/leads');
const adminUsers = require('../lib/adminUsers');
const { importAnyCsv } = require('../services/importSales');
const { barChart, rankBars } = require('../lib/chart');
const { money, num } = require('../lib/format');
const shopDb = require('../lib/shopDb');
const woo = require('../lib/woo');
const { syncWooOrders, normalizeAgentCode, attributionValues } = require('../services/syncWoo');
const { buildSnapshot, latestRun } = require('../services/snapshot');
const { localDate, monthKey, addDays, nextRefreshLabel } = require('../lib/dates');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// --- Login -------------------------------------------------------------------

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin', nav: null, error: null, email: '' });
});

// Der Adminbereich ist ohne Bremse systematisch durchprobierbar – deshalb die
// engste Grenze im ganzen Portal.
const ADMIN_LOGIN_LIMIT = { limit: 5, windowSeconds: 15 * 60 };

router.post('/login', async (req, res) => {
  const ip = rateLimit.clientIp(req);
  const bucket = `admin-login:${ip}`;

  const gate = await rateLimit.hit(bucket, ADMIN_LOGIN_LIMIT);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfter));
    await db.log('system', 'admin.login.blocked', ip, `Versuch ${gate.hits} im Fenster`).catch(() => {});
    return res.status(429).render('admin/login', {
      title: 'Admin',
      nav: null,
      email: String(req.body.email || ''),
      error: `Zu viele Versuche. Nächster Versuch in etwa ${Math.ceil(gate.retryAfter / 60)} Minuten.`,
    });
  }

  const email = String(req.body.email || '').trim();
  const password = req.body.password;

  // Anmeldung nur mit E-Mail-Adresse und Passwort aus der Zugangsliste.
  // Der Notzugang über ADMIN_PASSWORD (ohne Adresse) funktioniert nur, solange
  // noch kein Inhaber-Zugang angelegt ist – damit beim allerersten Start
  // niemand ausgesperrt ist. Sobald es einen Inhaber gibt, ist er abgeschaltet.
  let user = null;
  const ownerExists = await db.one("SELECT id FROM admin_users WHERE role = 'owner' AND active LIMIT 1");
  if (email) {
    user = await adminUsers.authenticate(email, password);
  } else if (!ownerExists && auth.checkAdminPassword(password)) {
    user = null; // Ersteinrichtung über den Notzugang
  } else {
    user = false; // Kennzeichnet: fehlgeschlagen
  }

  if (user === false || (email && !user)) {
    await db
      .log('system', 'admin.login.failed', email || ip, `Versuch ${gate.hits} von ${ADMIN_LOGIN_LIMIT.limit}`)
      .catch(() => {});
    // Bewusst dieselbe Meldung für falsche Adresse, falsches Passwort und
    // gesperrten Zugang – alles andere verrät, welche Zugänge es gibt.
    return res.status(401).render('admin/login', {
      title: 'Admin',
      nav: null,
      email,
      error: 'E-Mail-Adresse oder Passwort stimmt nicht.',
    });
  }

  // Nach erfolgreichem Login den Zähler leeren, damit ein vertipptes Passwort
  // die eigene Sitzung nicht noch eine Viertelstunde lang ausbremst.
  await rateLimit.clear(bucket);
  auth.startAdminSession(res, user);
  await db.log(user ? user.name : config.adminName, 'admin.login', user ? user.email : 'Notzugang', null).catch(() => {});
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  auth.endAdminSession(res);
  res.redirect('/admin/login');
});

router.use(auth.requireAdmin);

// Ab hier ist klar, wer angemeldet ist. Diese Bereiche bleiben dem Inhaber
// vorbehalten – Geld, Konditionen und Zugänge. Die Prüfung hängt am Pfad und
// nicht an den Routen einzeln, damit beim Nachrüsten einer Route niemand
// vergisst, sie abzusichern.
router.use(['/brands', '/import', '/payouts', '/mails', '/team', '/shop-db', '/woo', '/brokers', '/agents'], auth.requireRole('owner'));

/** Wer die Aktion ausgelöst hat – steht so im Protokoll. */
const actor = (req) => (req.admin && req.admin.name) || config.adminName;

// --- Übersicht ---------------------------------------------------------------

router.get('/', async (req, res) => {
  const run = await latestRun();
  const period = req.query.zeitraum === 'gesamt' ? 'total' : '30d';
  const col = (base) => (period === 'total' ? `${base}_total` : `${base}_30d`);

  const counts = await db.one(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
       COUNT(*) FILTER (WHERE status = 'approved') AS approved,
       COUNT(*) FILTER (WHERE status = 'paused')   AS paused
     FROM creators`
  );
  const partnerCounts = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM agents  WHERE status = 'active')  AS agents_active,
       (SELECT COUNT(*) FROM agents  WHERE status = 'pending') AS agents_pending,
       (SELECT COUNT(*) FROM brokers WHERE status = 'active')  AS brokers_active,
       (SELECT COUNT(*) FROM brokers WHERE status = 'pending') AS brokers_pending`
  );

  let kpi = { revenue: 0, gross: 0, net: 0, orders: 0, creatorCommission: 0, agentCommission: 0, brokerShare: 0, commissionOpen: 0, revenuePrev: 0, grossPrev: 0 };
  let days = [];
  let creators = [];
  let agents = [];
  let brokers = [];
  if (run) {
    // Umsatz der Firma = alle bestätigten Bestellungen im Snapshot, egal ob
    // Creator, Agent oder beide dranhängen. Aus den Rohdaten, damit nichts
    // doppelt zählt.
    const win = period === 'total' ? '' : `AND s.order_date >= $2`;
    const from30 = addDays(localDate(), -29);
    const base = await db.one(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(s.gross_amount), 0) AS gross,
              COALESCE(SUM(s.net_amount), 0) AS net,
              COALESCE(SUM(GREATEST(s.net_amount - $1, 0)), 0) AS revenue
         FROM sales s WHERE s.status = 'confirmed' ${win}`,
      period === 'total' ? [config.program.commissionDeduction] : [config.program.commissionDeduction, from30]
    );
    const prev = period === 'total' ? { revenue: 0, gross: 0 } : await db.one(
      `SELECT COALESCE(SUM(s.gross_amount), 0) AS gross,
              COALESCE(SUM(GREATEST(s.net_amount - $1, 0)), 0) AS revenue
         FROM sales s WHERE s.status = 'confirmed' AND s.order_date >= $2 AND s.order_date < $3`,
      [config.program.commissionDeduction, addDays(localDate(), -59), from30]
    );
    const c = await db.one(
      `SELECT COALESCE(SUM(${col('commission')}), 0) AS commission, COALESCE(SUM(commission_open), 0) AS open
         FROM snapshot_totals WHERE run_id = $1`, [run.id]);
    const a = await db.one(`SELECT COALESCE(SUM(${col('commission')}), 0) AS commission FROM snapshot_agent_totals WHERE run_id = $1`, [run.id]);
    const b = await db.one(`SELECT COALESCE(SUM(${col('share')}), 0) AS share FROM snapshot_broker_totals WHERE run_id = $1`, [run.id]);
    kpi = {
      revenue: Number(base.revenue), gross: Number(base.gross), net: Number(base.net), orders: base.orders,
      revenuePrev: Number(prev.revenue), grossPrev: Number(prev.gross),
      creatorCommission: Number(c.commission), agentCommission: Number(a.commission), brokerShare: Number(b.share),
      commissionOpen: Number(c.open),
    };

    days = await db.many(
      `SELECT to_char(gs, 'YYYY-MM-DD') AS day,
              COALESCE(x.orders, 0)::int AS orders,
              ROUND(COALESCE(x.revenue, 0)::numeric, 2)::float8 AS revenue,
              ROUND(COALESCE(x.gross, 0)::numeric, 2)::float8 AS gross
         FROM generate_series($2::date, $3::date, interval '1 day') gs
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS orders, SUM(s.gross_amount) AS gross, SUM(GREATEST(s.net_amount - $1, 0)) AS revenue
             FROM sales s WHERE s.status = 'confirmed' AND s.order_date = to_char(gs, 'YYYY-MM-DD')) x ON TRUE
        ORDER BY gs`,
      [config.program.commissionDeduction, from30, localDate()]
    );

    creators = await db.many(
      `SELECT c.id, c.full_name, c.requested_code, t.${col('orders')} AS orders, t.${col('revenue')} AS revenue, t.${col('commission')} AS commission
         FROM snapshot_totals t JOIN creators c ON c.id = t.creator_id
        WHERE t.run_id = $1 AND t.${col('revenue')} > 0 ORDER BY t.${col('revenue')} DESC LIMIT 15`, [run.id]);
    agents = await db.many(
      `SELECT a.id, a.full_name, a.agent_code, t.${col('orders')} AS orders, t.${col('revenue')} AS revenue, t.${col('commission')} AS commission
         FROM snapshot_agent_totals t JOIN agents a ON a.id = t.agent_id
        WHERE t.run_id = $1 AND t.${col('revenue')} > 0 ORDER BY t.${col('revenue')} DESC LIMIT 15`, [run.id]);
    brokers = await db.many(
      `SELECT b.id, b.full_name, t.creators_count, t.${col('orders')} AS orders, t.${col('revenue')} AS revenue, t.${col('share')} AS share
         FROM snapshot_broker_totals t JOIN brokers b ON b.id = t.broker_id
        WHERE t.run_id = $1 AND t.${col('revenue')} > 0 ORDER BY t.${col('revenue')} DESC LIMIT 15`, [run.id]);
  }

  const akquise = await leadsLib.summary().catch(() => null);
  const isOwner = req.admin && req.admin.role === 'owner';

  res.render('admin/home', {
    title: 'Übersicht',
    nav: 'admin-home',
    run,
    period,
    counts,
    partnerCounts,
    akquise,
    kpi,
    chartHtml: days.length ? barChart(days, { valueKey: 'gross', height: 200 }) : '',
    creatorRank: rankBars(
      creators.map((c) => ({ label: c.full_name, sub: c.requested_code, value: c.revenue, secondary: `${num(c.orders)} Best. · ${money(c.commission)} Prov.`, href: `/admin/creators/${c.id}` })),
      { emptyText: 'Noch keine Creator-Umsätze.' }
    ),
    agentRank: rankBars(
      agents.map((a) => ({ label: a.full_name, sub: a.agent_code, value: a.revenue, secondary: `${num(a.orders)} Best. · ${money(a.commission)} Prov.`, href: isOwner ? `/admin/agents/${a.id}` : null })),
      { emptyText: 'Noch keine Agenten-Umsätze.' }
    ),
    brokerRank: rankBars(
      brokers.map((b) => ({ label: b.full_name, sub: `${num(b.creators_count)} Creator`, value: b.revenue, secondary: `${money(b.share)} Beteiligung`, href: isOwner ? `/admin/brokers/${b.id}` : null })),
      { emptyText: 'Noch keine Vermittler-Umsätze.' }
    ),
    refreshTime: config.refresh.label,
    nextRefresh: nextRefreshLabel(),
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

  // Kontodaten sieht nur der Inhaber. Für Creator Success sind sie ohne
  // Nutzen, und was nicht geladen wird, kann auch nicht versehentlich in einer
  // Vorlage landen (Art. 5 Abs. 1 lit. c DSGVO, Datenminimierung).
  const bank = req.admin.role === 'owner' ? await payout.load(c.id) : null;

  // Marken und die bereits vergebenen Codes – daraus baut die Seite das
  // Zuweisungsformular und die Liste der Links.
  const [brandList, codes, brokerList] = await Promise.all([
    brandsLib.all(),
    brandsLib.codesFor(c.id),
    db.many('SELECT id, full_name, share_rate, status FROM brokers ORDER BY full_name'),
  ]);
  const codeByBrand = Object.fromEntries(codes.map((row) => [String(row.brand_id), row]));

  return res.render('admin/creator', {
    title: c.full_name,
    nav: 'admin-creators',
    c,
    run,
    totals,
    bank,
    brandList,
    codes,
    codeByBrand,
    brokerList,
    formatIban: payout.formatIban,
    taxStatusLabel: payout.TAX_STATUS,
    defaultPeriod: monthKey(addDays(localDate(), -15)),
    flash: req.query.ok || null,
    error: null,
    loginLink: null,
    hasSmtp: mailer.hasSmtp(),
    ...extra,
  });
}

router.get('/creators/:id', (req, res) => renderCreator(req, res));

/**
 * Liest die Marken-Zuweisungen aus dem Formular.
 *
 * Je Marke gibt es drei Felder: ob sie vergeben wird, mit welchem Code und zu
 * welchen Konditionen. Geprüft wird der Code gegen die Regeln UND gegen die
 * bereits vergebenen Codes derselben Marke – marken­übergreifend darf sich ein
 * Code wiederholen, weil die Shops getrennt sind.
 */
async function readBrandAssignments(creatorId, brandList, rawBody) {
  // Ohne Formularinhalt liefert Express kein body-Objekt. Das ist kein Absturz
  // wert – es heißt schlicht: keine Marke angehakt.
  const body = rawBody || {};
  const wanted = [];
  const errors = [];

  for (const brand of brandList) {
    if (body[`brand_${brand.id}_on`] !== '1') continue;

    const code = normalizeCode(body[`brand_${brand.id}_code`]);
    const issue =
      codeIssue(code) ||
      ((await codeTakenInBrand(brand.id, code, creatorId))
        ? `Der Code ${code} ist bei ${brand.name} schon vergeben.`
        : null);
    if (issue) {
      errors.push(`${brand.name}: ${issue}`);
      continue;
    }

    const rate = Number(String(body[`brand_${brand.id}_rate`]).replace(',', '.'));
    const discount = Number(String(body[`brand_${brand.id}_discount`]).replace(',', '.'));
    if (!Number.isFinite(rate) || rate < 0 || rate > 90) {
      errors.push(`${brand.name}: Provision muss zwischen 0 und 90 % liegen.`);
      continue;
    }

    wanted.push({
      brandId: brand.id,
      brandName: brand.name,
      code,
      rate,
      discount: Number.isFinite(discount) ? discount : brand.default_customer_discount,
      link: brandsLib.buildLink(brand.link_template, code),
    });
  }

  return { wanted, errors };
}

/** Schreibt die Zuweisungen und entfernt Marken, die nicht mehr angehakt sind. */
async function saveBrandAssignments(creatorId, wanted) {
  await db.tx(async (t) => {
    for (const w of wanted) {
      await t.run(
        `INSERT INTO creator_codes (creator_id, brand_id, code, code_norm, commission_rate, customer_discount)
         VALUES ($1, $2, $3, $3, $4, $5)
         ON CONFLICT (creator_id, brand_id) DO UPDATE SET
           code = EXCLUDED.code,
           code_norm = EXCLUDED.code_norm,
           commission_rate = EXCLUDED.commission_rate,
           customer_discount = EXCLUDED.customer_discount`,
        [creatorId, w.brandId, w.code, w.rate, w.discount]
      );
    }

    const keep = wanted.map((w) => Number(w.brandId));
    if (keep.length) {
      await t.run('DELETE FROM creator_codes WHERE creator_id = $1 AND brand_id <> ALL($2::bigint[])', [
        creatorId,
        keep,
      ]);
    } else {
      await t.run('DELETE FROM creator_codes WHERE creator_id = $1', [creatorId]);
    }
  });
}

router.post('/creators/:id/approve', async (req, res) => {
  const id = req.params.id;
  const c = await db.one('SELECT * FROM creators WHERE id = $1', [id]);
  if (!c) return res.redirect('/admin/creators');

  const brandList = await brandsLib.all({ onlyActive: true });
  if (!brandList.length) {
    return renderCreator(req, res, {
      error: 'Es gibt noch keine aktive Marke. Lege zuerst unter „Marken“ mindestens eine an.',
    });
  }

  const { wanted, errors } = await readBrandAssignments(id, brandList, req.body);
  if (errors.length) return renderCreator(req, res, { error: errors.join(' ') });
  if (!wanted.length) {
    return renderCreator(req, res, {
      error: 'Bitte hake mindestens eine Marke an – ohne Marke gibt es keinen Link.',
    });
  }

  await saveBrandAssignments(id, wanted);
  const { claimed } = await claimOrphanSales(id, wanted);

  const updated = await db.one(
    `UPDATE creators
        SET status = 'approved', reviewed_at = now(), reviewed_by = $1, decision_reason = NULL
      WHERE id = $2
      RETURNING *`,
    [config.adminName, id]
  );

  await db.log(
    config.adminName,
    'creator.approved',
    updated.email,
    wanted.map((w) => `${w.brandName}: ${w.code} (${w.rate} %)`).join(', ')
  );

  // Die Freigabe verschickt bewusst KEINE E-Mail: Die Ansprache der Creator
  // übernimmt eine andere Abteilung über ihre eigenen Kanäle. Der Creator hat
  // ab jetzt ein Dashboard und kommt über /login mit seiner E-Mail-Adresse
  // hinein; wer ihm den Zugang direkt schicken will, erzeugt auf dieser Seite
  // einen Login-Link zum Kopieren.
  res.redirect(
    `/admin/creators/${id}?ok=${encodeURIComponent(
      `Freigegeben für ${wanted.length} Marke(n).${claimed ? ` ${claimed} bereits eingegangene Bestellung(en) mit dieser Kennung wurden übernommen.` : ''} Es wurde keine E-Mail verschickt – der Creator meldet sich über ${config.baseUrl}/login an, oder du erzeugst hier einen Login-Link zum Weitergeben.`
    )}`
  );
});

/** Marken und Konditionen eines bereits freigegebenen Creators ändern. */
/**
 * Nach dem Speichern von Codes: Bestellungen, die schon im Portal liegen, aber
 * niemandem gehören, und deren Kennung/Code jetzt zu diesem Creator passt,
 * werden ihm sofort zugeschrieben. Danach wird der Stand neu berechnet, damit
 * das Dashboard nicht auf den nächsten Lauf wartet.
 *
 * Gilt für Zeilen aus dem Shop (creator_name trägt die utm-Kennung, code_norm
 * den Gutscheincode) und für CSV-Uploads ohne Zuordnung.
 */
async function claimOrphanSales(creatorId, wanted) {
  let claimed = 0;
  for (const w of wanted) {
    const codeNorm = String(w.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!codeNorm) continue;
    const res = await db.many(
      `UPDATE sales
          SET creator_id = $1, commission_rate = COALESCE(commission_rate, $2), updated_at = now()
        WHERE brand_id = $3 AND creator_id IS NULL
          AND (code_norm = $4 OR UPPER(regexp_replace(COALESCE(creator_name, ''), '[^A-Za-z0-9]', '', 'g')) = $4)
        RETURNING id`,
      [creatorId, w.rate, w.brandId, codeNorm]
    );
    claimed += res.length;
  }
  let refreshed = false;
  try {
    await buildSnapshot({ triggeredBy: 'import' });
    refreshed = true;
  } catch (err) {
    console.error('Snapshot nach Code-Änderung fehlgeschlagen:', err.message);
  }
  return { claimed, refreshed };
}

router.post('/creators/:id/codes', async (req, res) => {
  const id = req.params.id;
  const brandList = await brandsLib.all();
  const { wanted, errors } = await readBrandAssignments(id, brandList, req.body);
  if (errors.length) return renderCreator(req, res, { error: errors.join(' ') });

  await saveBrandAssignments(id, wanted);
  const { claimed, refreshed } = await claimOrphanSales(id, wanted);
  await db.log(
    config.adminName,
    'creator.codes.updated',
    String(id),
    (wanted.map((w) => `${w.brandName}: ${w.code}`).join(', ') || 'alle entfernt') +
      (claimed ? ` – ${claimed} bisher unzugeordnete Bestellungen übernommen` : '')
  );

  const note = claimed
    ? `Codes gespeichert. ${claimed} Bestellung${claimed === 1 ? '' : 'en'}, die bereits mit dieser Kennung eingegangen ${claimed === 1 ? 'war' : 'waren'}, ${claimed === 1 ? 'wurde' : 'wurden'} dem Creator zugeschrieben${refreshed ? ' – das Dashboard ist aktuell' : ''}.`
    : `Codes gespeichert${refreshed ? ', Dashboard ist aktuell' : ''}. Ab jetzt zählen alle Bestellungen mit dieser Kennung für den Creator.`;
  res.redirect(`/admin/creators/${id}?ok=${encodeURIComponent(note)}`);
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

  await db.log(actor(req), 'creator.rejected', c.email, reason);
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
  const status = ['approved', 'paused'].includes(req.body.status) ? req.body.status : 'approved';

  const brokerId = req.body.broker_id ? Number(req.body.broker_id) : null;
  await db.run(
    `UPDATE creators SET status = $1, note_internal = $2, broker_id = $3 WHERE id = $4`,
    [status, String(req.body.note_internal || '').slice(0, 2000) || null, brokerId, id]
  );

  await db.log(actor(req), 'creator.updated', String(id), `Status ${status}${brokerId ? `, Vermittler ${brokerId}` : ''}`);
  // Vermittler-Zuordnung wirkt sofort auf dessen Dashboard.
  try {
    await buildSnapshot({ triggeredBy: 'import' });
  } catch (err) {
    console.error('Snapshot nach Creator-Update fehlgeschlagen:', err.message);
  }
  res.redirect(`/admin/creators/${id}?ok=${encodeURIComponent('Gespeichert.')}`);
});

// --- Vermittler --------------------------------------------------------------

const BROKER_LIST = `
  SELECT b.*,
         (SELECT COUNT(*) FROM creators c WHERE c.broker_id = b.id) AS creators_count,
         t.revenue_total, t.share_total, t.revenue_30d, t.share_30d
    FROM brokers b
    LEFT JOIN snapshot_broker_totals t
      ON t.broker_id = b.id AND t.run_id = (SELECT id FROM snapshot_runs ORDER BY id DESC LIMIT 1)
   ORDER BY CASE b.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, b.full_name`;

function validateBroker(body) {
  const values = {
    full_name: String(body.full_name || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    email: String(body.email || '').trim().slice(0, 200),
    share_rate: Number(String(body.share_rate || '').replace(',', '.')),
    status: ['active', 'paused', 'rejected'].includes(body.status) ? body.status : 'active',
    note: String(body.note || '').trim().slice(0, 2000) || null,
  };
  const errors = {};
  if (values.full_name.length < 2) errors.full_name = 'Bitte einen Namen eintragen.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) errors.email = 'Bitte eine gültige E-Mail-Adresse eintragen – darüber meldet sich der Vermittler an.';
  if (!Number.isFinite(values.share_rate) || values.share_rate < 0 || values.share_rate > 100) errors.share_rate = 'Beteiligung in Prozent, zwischen 0 und 100.';
  return { values, errors };
}

async function renderBrokers(req, res, extra = {}) {
  return res.render('admin/brokers', {
    title: 'Vermittler',
    nav: 'admin-brokers',
    rows: await db.many(BROKER_LIST),
    values: {},
    errors: {},
    editing: null,
    editingCreators: [],
    baseUrl: config.baseUrl,
    loginLink: null,
    flash: req.query.ok || null,
    ...extra,
  });
}

router.get('/brokers', (req, res) => renderBrokers(req, res));

router.get('/brokers/:id', async (req, res) => {
  const b = await db.one('SELECT * FROM brokers WHERE id = $1', [req.params.id]);
  if (!b) return res.redirect('/admin/brokers');
  const editingCreators = await db.many(
    `SELECT c.id, c.full_name, c.requested_code, c.status, c.instagram FROM creators c WHERE c.broker_id = $1 ORDER BY c.full_name`,
    [b.id]
  );
  return renderBrokers(req, res, { editing: b, values: b, editingCreators });
});

router.post('/brokers', async (req, res) => {
  const editingId = req.body.id ? Number(req.body.id) : null;
  const { values, errors } = validateBroker(req.body);
  const emailNorm = values.email.toLowerCase();
  if (!errors.email) {
    const clash = await db.one('SELECT id FROM brokers WHERE email_norm = $1 AND id <> COALESCE($2, 0)', [emailNorm, editingId]);
    if (clash) errors.email = 'Diese E-Mail-Adresse gehört schon einem anderen Vermittler.';
  }
  if (Object.keys(errors).length) {
    const editing = editingId ? await db.one('SELECT * FROM brokers WHERE id = $1', [editingId]) : null;
    return renderBrokers(req, res, { values: { ...values, id: editingId }, errors, editing });
  }
  let row;
  if (editingId) {
    row = await db.one(
      `UPDATE brokers SET full_name = $1, email = $2, email_norm = $3, share_rate = $4, status = $5, note = $6
        WHERE id = $7 RETURNING *`,
      [values.full_name, values.email, emailNorm, values.share_rate, values.status, values.note, editingId]
    );
  } else {
    row = await db.one(
      `INSERT INTO brokers (full_name, email, email_norm, share_rate, status, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [values.full_name, values.email, emailNorm, values.share_rate, values.status, values.note]
    );
  }
  await db.log(actor(req), editingId ? 'broker.updated' : 'broker.created', row.email, `${row.full_name}, ${row.share_rate} %`);
  // Satzänderung wirkt sofort auf das Vermittler-Dashboard.
  try {
    await buildSnapshot({ triggeredBy: 'import' });
  } catch (err) {
    console.error('Snapshot nach Vermittler-Änderung fehlgeschlagen:', err.message);
  }
  res.redirect(`/admin/brokers/${row.id}?ok=${encodeURIComponent(editingId ? 'Gespeichert.' : 'Vermittler angelegt.')}`);
});

/** Login-Link für den Vermittler – zum Weitergeben, wie bei Creatorn. */
router.post('/brokers/:id/login-link', async (req, res) => {
  const b = await db.one('SELECT * FROM brokers WHERE id = $1', [req.params.id]);
  if (!b) return res.redirect('/admin/brokers');
  const token = await auth.createBrokerLoginToken(b.id);
  await db.log(actor(req), 'broker.login_link', b.email, 'manuell erzeugt');
  const editingCreators = await db.many(
    `SELECT c.id, c.full_name, c.requested_code, c.status, c.instagram FROM creators c WHERE c.broker_id = $1 ORDER BY c.full_name`,
    [b.id]
  );
  return renderBrokers(req, res, { editing: b, values: b, editingCreators, loginLink: `${config.baseUrl}/login/${token}` });
});

// --- Agenten -----------------------------------------------------------------

const AGENT_LIST = `
  SELECT a.*,
         (SELECT COUNT(*) FROM sales s WHERE s.agent_id = a.id) AS sales_count,
         t.revenue_total, t.commission_total, t.revenue_30d, t.commission_30d
    FROM agents a
    LEFT JOIN snapshot_agent_totals t
      ON t.agent_id = a.id AND t.run_id = (SELECT id FROM snapshot_runs ORDER BY id DESC LIMIT 1)
   ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, a.agent_code_norm`;

function validateAgent(body) {
  const values = {
    full_name: String(body.full_name || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    email: String(body.email || '').trim().slice(0, 200),
    agent_code: String(body.agent_code || '').trim().slice(0, 20),
    commission_rate: Number(String(body.commission_rate || '').replace(',', '.')),
    status: ['active', 'paused', 'rejected'].includes(body.status) ? body.status : 'active',
    note: String(body.note || '').trim().slice(0, 2000) || null,
  };
  const errors = {};
  if (values.full_name.length < 2) errors.full_name = 'Bitte einen Namen eintragen.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) errors.email = 'Bitte eine gültige E-Mail-Adresse eintragen.';
  values.agent_code_norm = normalizeAgentCode(values.agent_code);
  if (!values.agent_code_norm) errors.agent_code = 'Kennung als „A“ plus Nummer, z. B. A12.';
  if (!Number.isFinite(values.commission_rate) || values.commission_rate < 0 || values.commission_rate > 100) errors.commission_rate = 'Provision in Prozent, zwischen 0 und 100.';
  return { values, errors };
}

/** Bestellungen, die schon mit dieser Kennung im Portal liegen, dem Agenten zuschreiben. */
async function claimAgentSales(agentId, codeNorm) {
  const rows = await db.many(
    `UPDATE sales SET agent_id = $1, updated_at = now()
      WHERE agent_id IS NULL AND agent_code = $2 RETURNING id`,
    [agentId, codeNorm]
  );
  return rows.length;
}

async function renderAgents(req, res, extra = {}) {
  return res.render('admin/agents', {
    title: 'Agenten',
    nav: 'admin-agents',
    rows: await db.many(AGENT_LIST),
    values: {},
    errors: {},
    editing: null,
    baseUrl: config.baseUrl,
    loginLink: null,
    unclaimed: await db.many(
      `SELECT agent_code, COUNT(*)::int AS n FROM sales WHERE agent_id IS NULL AND agent_code IS NOT NULL GROUP BY agent_code ORDER BY agent_code`
    ),
    flash: req.query.ok || null,
    ...extra,
  });
}

router.get('/agents', (req, res) => renderAgents(req, res));

router.get('/agents/:id', async (req, res) => {
  const a = await db.one('SELECT * FROM agents WHERE id = $1', [req.params.id]);
  if (!a) return res.redirect('/admin/agents');
  return renderAgents(req, res, { editing: a, values: a });
});

router.post('/agents', async (req, res) => {
  const editingId = req.body.id ? Number(req.body.id) : null;
  const { values, errors } = validateAgent(req.body);
  const emailNorm = values.email.toLowerCase();
  if (!errors.email && (await db.one('SELECT id FROM agents WHERE email_norm = $1 AND id <> COALESCE($2, 0)', [emailNorm, editingId]))) {
    errors.email = 'Diese E-Mail-Adresse gehört schon einem anderen Agenten.';
  }
  if (!errors.agent_code && (await db.one('SELECT id FROM agents WHERE agent_code_norm = $1 AND id <> COALESCE($2, 0)', [values.agent_code_norm, editingId]))) {
    errors.agent_code = 'Diese Kennung ist schon vergeben.';
  }
  if (Object.keys(errors).length) {
    const editing = editingId ? await db.one('SELECT * FROM agents WHERE id = $1', [editingId]) : null;
    return renderAgents(req, res, { values: { ...values, id: editingId }, errors, editing });
  }
  let row;
  if (editingId) {
    row = await db.one(
      `UPDATE agents SET full_name = $1, email = $2, email_norm = $3, agent_code = $4, agent_code_norm = $4,
              commission_rate = $5, status = $6, note = $7 WHERE id = $8 RETURNING *`,
      [values.full_name, values.email, emailNorm, values.agent_code_norm, values.commission_rate, values.status, values.note, editingId]
    );
  } else {
    row = await db.one(
      `INSERT INTO agents (full_name, email, email_norm, agent_code, agent_code_norm, commission_rate, status, note)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7) RETURNING *`,
      [values.full_name, values.email, emailNorm, values.agent_code_norm, values.commission_rate, values.status, values.note]
    );
  }
  const claimed = row.status === 'active' || row.status === 'paused' ? await claimAgentSales(row.id, row.agent_code_norm) : 0;
  await db.log(actor(req), editingId ? 'agent.updated' : 'agent.created', row.email, `${row.full_name} (${row.agent_code}), ${row.commission_rate} %${claimed ? `, ${claimed} Bestellungen übernommen` : ''}`);
  try {
    await buildSnapshot({ triggeredBy: 'import' });
  } catch (err) {
    console.error('Snapshot nach Agenten-Änderung fehlgeschlagen:', err.message);
  }
  const note = (editingId ? 'Gespeichert.' : 'Agent angelegt.') + (claimed ? ` ${claimed} bereits eingegangene Bestellung(en) mit ${row.agent_code} wurden übernommen.` : '');
  res.redirect(`/admin/agents/${row.id}?ok=${encodeURIComponent(note)}`);
});

router.post('/agents/:id/login-link', async (req, res) => {
  const a = await db.one('SELECT * FROM agents WHERE id = $1', [req.params.id]);
  if (!a) return res.redirect('/admin/agents');
  const token = await auth.createAgentLoginToken(a.id);
  await db.log(actor(req), 'agent.login_link', a.email, 'manuell erzeugt');
  return renderAgents(req, res, { editing: a, values: a, loginLink: `${config.baseUrl}/login/${token}` });
});

// --- Marken ------------------------------------------------------------------

async function renderBrands(req, res, extra = {}) {
  return res.render('admin/brands', {
    title: 'Marken',
    nav: 'admin-brands',
    rows: await brandsLib.all(),
    values: {},
    errors: {},
    editing: null,
    placeholder: brandsLib.PLACEHOLDER,
    flash: req.query.ok || null,
    ...extra,
  });
}

router.get('/brands', (req, res) => renderBrands(req, res));

router.get('/brands/:id', async (req, res) => {
  const brand = await brandsLib.byId(req.params.id);
  if (!brand) return res.redirect('/admin/brands');
  return renderBrands(req, res, { editing: brand, values: brand });
});

router.post('/brands', async (req, res) => {
  const editingId = req.body.id ? Number(req.body.id) : null;
  const { values, errors } = brandsLib.validateBrand(req.body);

  if (!errors.slug && (await brandsLib.slugTaken(values.slug, editingId))) {
    errors.slug = 'Dieses Kürzel ist schon vergeben.';
  }

  if (Object.keys(errors).length) {
    const editing = editingId ? await brandsLib.byId(editingId) : null;
    return res.status(400).render('admin/brands', {
      title: 'Marken',
      nav: 'admin-brands',
      rows: await brandsLib.all(),
      values: { ...values, id: editingId },
      errors,
      editing,
      placeholder: brandsLib.PLACEHOLDER,
      flash: null,
    });
  }

  const params = [
    values.name,
    values.slug,
    values.shop_url,
    values.link_template,
    values.default_commission_rate,
    values.default_customer_discount,
    values.note || null,
    values.active,
  ];

  if (editingId) {
    await db.run(
      `UPDATE brands SET name=$1, slug=$2, shop_url=$3, link_template=$4,
              default_commission_rate=$5, default_customer_discount=$6, note=$7, active=$8
        WHERE id=$9`,
      [...params, editingId]
    );
    await db.log(actor(req), 'brand.updated', values.slug, values.name);
  } else {
    await db.run(
      `INSERT INTO brands (name, slug, shop_url, link_template,
              default_commission_rate, default_customer_discount, note, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      params
    );
    await db.log(actor(req), 'brand.created', values.slug, values.name);
  }

  res.redirect(`/admin/brands?ok=${encodeURIComponent(`Marke „${values.name}“ gespeichert.`)}`);
});

/**
 * Erzeugt einen Login-Link und zeigt ihn direkt an, statt ihn nur zu mailen.
 * Damit funktioniert das Portal auch ohne SMTP-Zugang: Ihr kopiert den Link
 * und schickt ihn dem Creator über den Kanal, über den ihr ohnehin schreibt.
 */
router.post('/creators/:id/login-link', auth.requireRole('owner'), async (req, res) => {
  const c = await db.one('SELECT * FROM creators WHERE id = $1', [req.params.id]);
  if (!c) return res.redirect('/admin/creators');

  const token = await auth.createLoginToken(c.id);
  const url = `${config.baseUrl}/login/${token}`;
  await db.log(actor(req), 'creator.login_link', c.email, 'manuell erzeugt');

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

const IMPORT_LIST = `SELECT i.*, b.name AS brand_name
       FROM imports i LEFT JOIN brands b ON b.id = i.brand_id
      ORDER BY i.id DESC LIMIT 15`;

router.get('/import', async (req, res) => {
  res.render('admin/import', {
    title: 'Umsätze importieren',
    nav: 'admin-import',
    result: null,
    flash: req.query.ok || null,
    refreshTime: config.refresh.label,
    brandList: await brandsLib.all({ onlyActive: true }),
    selectedBrand: null,
    imports: await db.many(IMPORT_LIST),
  });
});

router.get('/import/vorlage.csv', (req, res) => {
  const csv = [
    'Nettoumsatz;Creatorbeteiligung in %;Creatorname',
    '89,90;30;Max Mustermann',
    '45,00;30;Max Mustermann',
    '129,00;50;Mira Beispiel',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="umsatz-vorlage.csv"');
  res.send(csv);
});

router.post('/import', upload.single('file'), async (req, res) => {
  const brandList = await brandsLib.all({ onlyActive: true });
  const brand = await brandsLib.byId(req.body && req.body.brand_id);

  // Ohne Marke wüsste der Import nicht, wessen Codes gelten und gegen welche
  // Bestellnummern er abgleichen muss. Deshalb hier kein stiller Rückfall.
  if (!brand) {
    return res.status(400).render('admin/import', {
      title: 'Umsätze importieren',
      nav: 'admin-import',
      result: { ok: false, problems: ['Bitte wähle die Marke aus, zu der diese Datei gehört.'] },
      flash: null,
      refreshTime: config.refresh.label,
      brandList,
      selectedBrand: null,
      imports: await db.many(IMPORT_LIST),
    });
  }
  if (!req.file) return res.redirect('/admin/import');

  const text = req.file.buffer.toString('utf8');
  const result = await importAnyCsv(text, {
    brandId: brand.id,
    filename: req.file.originalname,
    actor: config.adminName,
    force: Boolean(req.body && req.body.force),
  });

  // Der Upload ist der Moment, in dem neue Zahlen da sind – also sofort den
  // Stand für die Dashboards erzeugen, statt auf den Sicherheitslauf zu warten.
  if (result.ok) {
    try {
      const snap = await buildSnapshot({ triggeredBy: 'import' });
      result.snapshot = { ok: true, ...snap };
    } catch (err) {
      console.error('Snapshot nach Import fehlgeschlagen:', err.message);
      result.snapshot = { ok: false, error: err.message };
    }
  }

  res.render('admin/import', {
    title: 'Umsätze importieren',
    nav: 'admin-import',
    result: { ...result, brandName: brand.name },
    flash: null,
    refreshTime: config.refresh.label,
    brandList,
    selectedBrand: brand.id,
    imports: await db.many(IMPORT_LIST),
  });
});

// --- WooCommerce -------------------------------------------------------------
//
//  Verbindung testen, eine Beispielbestellung ansehen (Gutscheine, Zusatzfelder)
//  und den Abgleich von Hand anstoßen. Der automatische Abgleich läuft in den
//  Sicherheitsläufen (10:30 / 17:30), siehe netlify/functions/snapshot.js.

async function renderWoo(req, res, extra = {}) {
  const configured = woo.isConfigured();
  let ping = null;
  let pingError = null;
  let sample = null;
  let orders = [];
  if (configured) {
    try {
      ping = await woo.ping();
      const list = await woo.fetchOrders({ max: 50 });
      sample = list[list.length - 1] || null;
      orders = list.map((o) => ({
        id: o.id,
        date: String(o.date_created || '').slice(0, 10),
        status: o.status,
        total: o.total,
        currency: o.currency,
        coupons: (o.coupon_lines || []).map((c) => c.code).join(', '),
        items: (o.line_items || []).map((l) => `${l.quantity}× ${l.name}`).join(', '),
        source: (o.meta_data || []).find((m) => m.key === '_wc_order_attribution_utm_source')?.value || '',
        campaign: (o.meta_data || []).find((m) => m.key === '_wc_order_attribution_utm_campaign')?.value || '',
        linkData: attributionValues(o).map((a) => `${a.key}=${a.value}`).join(' · '),
        sourceType: (o.meta_data || []).find((m) => m.key === '_wc_order_attribution_source_type')?.value || '',
        creatorFound: (attributionValues(o).map((a) => a.value.toUpperCase().replace(/[^A-Z0-9]/g, '')).find((v) => /^CREATOR[0-9]+$/.test(v))) || null,
        agentFound: attributionValues(o).map((a) => normalizeAgentCode(a.value)).find(Boolean) || null,
        note: o.customer_note || '',
        extra: (o.meta_data || [])
          .filter((m) => !/^_wc_order_attribution|^_ziina|^_googlesitekit|^is_vat_exempt/.test(m.key))
          .map((m) => `${m.key}=${typeof m.value === 'object' ? JSON.stringify(m.value) : m.value}`)
          .join(' · '),
      }));
    } catch (err) {
      pingError = err.message;
    }
  }
  const s = woo.settings();
  res.render('admin/woo', {
    title: 'WooCommerce',
    nav: 'admin-import',
    configured,
    settings: { url: s.url, brandId: s.brandId, creatorMeta: process.env.WOO_CREATOR_META || '', rateMeta: process.env.WOO_RATE_META || '' },
    webhook: {
      url: `${config.baseUrl}/webhooks/woocommerce`,
      secretSet: Boolean(process.env.WOO_WEBHOOK_SECRET),
      last: await db.one(`SELECT * FROM audit_log WHERE action = 'woo.webhook' ORDER BY id DESC LIMIT 1`),
    },
    ping,
    pingError,
    sample,
    orders,
    lastImports: await db.many(`SELECT * FROM imports WHERE import_kind = 'woo' ORDER BY id DESC LIMIT 10`),
    result: null,
    ...extra,
  });
}

router.get('/woo', (req, res) => renderWoo(req, res));

router.post('/woo/sync', async (req, res) => {
  let result;
  try {
    result = await syncWooOrders({ actor: actor(req), full: Boolean(req.body && req.body.full) });
    if (result.ok) {
      try {
        const snap = await buildSnapshot({ triggeredBy: 'import' });
        result.snapshot = { ok: true, ...snap };
      } catch (err) {
        result.snapshot = { ok: false, error: err.message };
      }
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  return renderWoo(req, res, { result });
});

// --- Shop-Datenbank: Diagnose ------------------------------------------------
//
//  Zeigt, was in der Datenbank des Shops steht: Tabellen, Spalten, ein paar
//  Beispielzeilen. Dient dazu, die Bestelltabelle und die Spalten für
//  Creatorname, Prozentsatz und Nettoumsatz zu finden. Reiner Lesezugriff.

router.get('/shop-db', async (req, res) => {
  const database = String(req.query.db || '').trim() || null;
  let result = null;
  let error = null;
  if (shopDb.isConfigured()) {
    try {
      result = await shopDb.inspect({ database });
    } catch (err) {
      error = err.message;
    }
  }
  res.render('admin/shop-db', {
    title: 'Shop-Datenbank',
    nav: 'admin-import',
    configured: shopDb.isConfigured(),
    settings: { ...shopDb.settings(), password: undefined },
    result,
    error,
  });
});

// --- Import zurücknehmen -----------------------------------------------------
//
//  Gedacht für Testläufe und für Dateien, die versehentlich hochgeladen wurden.
//
//  Wichtige Einschränkung, die auch auf der Bestätigungsseite steht: Das Portal
//  speichert von einer Bestellung nur den letzten Stand. Zeilen, die dieser
//  Import nicht neu angelegt, sondern überschrieben hat, lassen sich deshalb
//  nicht auf ihren früheren Wert zurücksetzen – sie werden mitgelöscht. Bei
//  einem reinen Testimport ist das folgenlos, weil dort alles neu ist.

/** Was hängt aktuell an diesem Import? */
async function importSummary(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const record = await db.one('SELECT * FROM imports WHERE id = $1', [id]);
  if (!record) return null;
  const stats = await db.one(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(gross_amount), 0) AS gross,
            MIN(order_date) AS first_day,
            MAX(order_date) AS last_day
       FROM sales WHERE import_id = $1`,
    [id]
  );
  const codes = await db.many(
    `SELECT COALESCE(NULLIF(creator_name, ''), NULLIF(code_norm, ''), '–') AS code_norm,
            COUNT(*)::int AS rows
       FROM sales WHERE import_id = $1
      GROUP BY 1 ORDER BY rows DESC LIMIT 12`,
    [id]
  );
  return { id, record, stats, codes };
}

router.get('/import/:id/zuruecknehmen', async (req, res) => {
  const summary = await importSummary(req.params.id);
  if (!summary) return res.redirect('/admin/import');
  res.render('admin/import-rollback', {
    title: 'Import zurücknehmen',
    nav: 'admin-import',
    ...summary,
  });
});

router.post('/import/:id/zuruecknehmen', async (req, res) => {
  const summary = await importSummary(req.params.id);
  if (!summary) return res.redirect('/admin/import');

  const removed = await db.tx(async (t) => {
    const rows = await t.many('DELETE FROM sales WHERE import_id = $1 RETURNING id', [summary.id]);
    await t.run('DELETE FROM imports WHERE id = $1', [summary.id]);
    return rows.length;
  });

  await db.log(
    config.adminName,
    'import.rolled_back',
    summary.record.filename,
    `${removed} Bestellungen entfernt`
  );

  // Ohne neuen Snapshot stünden die Testzahlen bis zum nächsten Lauf weiter in
  // den Creator-Dashboards. Deshalb sofort neu rechnen.
  let refreshed = false;
  try {
    await buildSnapshot({ triggeredBy: 'import-rollback' });
    refreshed = true;
  } catch (err) {
    console.error('Snapshot nach Rücknahme fehlgeschlagen:', err.message);
  }

  const note = refreshed
    ? `Import „${summary.record.filename}“ zurückgenommen: ${removed} Bestellungen gelöscht, Dashboards neu berechnet.`
    : `Import „${summary.record.filename}“ zurückgenommen: ${removed} Bestellungen gelöscht. Die Dashboards konnten nicht neu berechnet werden – bitte den Lauf manuell anstoßen.`;

  res.redirect(`/admin/import?ok=${encodeURIComponent(note)}`);
});

// --- Auszahlungen ------------------------------------------------------------

router.get('/payouts', async (req, res) => {
  const run = await latestRun();
  const open = run
    ? await db.many(
        `SELECT c.id, c.full_name, t.commission_total, t.commission_paid, t.commission_open,
                (SELECT string_agg(cc.code, ', ' ORDER BY cc.code)
                   FROM creator_codes cc WHERE cc.creator_id = c.id) AS codes
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

  await db.log(actor(req), 'payout.saved', String(creatorId), `${period}: ${amount} (${status})`);
  res.redirect(`/admin/creators/${creatorId}?ok=${encodeURIComponent('Auszahlung gespeichert.')}`);
});

router.post('/payouts/:id/paid', async (req, res) => {
  await db.run("UPDATE payouts SET status = 'paid', paid_at = $1 WHERE id = $2", [
    localDate(),
    req.params.id,
  ]);
  res.redirect(`/admin/payouts?ok=${encodeURIComponent('Als ausgezahlt markiert.')}`);
});

// --- Zugänge -----------------------------------------------------------------
//  Der Pfad /team ist weiter oben bereits auf den Inhaber beschränkt.

async function renderTeam(req, res, extra = {}) {
  res.render('admin/team', {
    title: 'Zugänge',
    nav: 'admin-team',
    rows: await adminUsers.all(),
    roles: adminUsers.ROLES,
    roleLabel: adminUsers.roleLabel,
    values: {},
    errors: {},
    flash: req.query.ok || null,
    ...extra,
  });
}

router.get('/team', (req, res) => renderTeam(req, res));

router.post('/team', async (req, res) => {
  const { values, errors } = adminUsers.validate(req.body);

  if (!errors.email && (await adminUsers.emailTaken(values.email_norm))) {
    errors.email = 'Für diese Adresse gibt es schon einen Zugang.';
  }

  if (Object.keys(errors).length) {
    return res.status(400).render('admin/team', {
      title: 'Zugänge',
      nav: 'admin-team',
      rows: await adminUsers.all(),
      roles: adminUsers.ROLES,
      roleLabel: adminUsers.roleLabel,
      values,
      errors,
      flash: null,
    });
  }

  const created = await adminUsers.create(values, req.body.password);
  // Bewusst ohne das Passwort im Protokoll – dort steht nur, dass es passiert ist.
  await db.log(actor(req), 'admin.user.created', created.email, adminUsers.roleLabel(created.role));

  res.redirect(
    `/admin/team?ok=${encodeURIComponent(
      `Zugang für ${created.name} angelegt. Gib ihm das Passwort persönlich weiter.`
    )}`
  );
});

router.post('/team/:id/aktiv', async (req, res) => {
  const user = await adminUsers.byId(req.params.id);
  if (!user) return res.redirect('/admin/team');

  const active = req.body.active === '1';
  await adminUsers.setActive(user.id, active);
  await db.log(actor(req), active ? 'admin.user.enabled' : 'admin.user.disabled', user.email, null);

  res.redirect(
    `/admin/team?ok=${encodeURIComponent(
      active ? `${user.name} ist wieder freigeschaltet.` : `${user.name} ist gesperrt.`
    )}`
  );
});

// --- Akquise -----------------------------------------------------------------

/**
 * Die Liste ist nach Dringlichkeit sortiert und wird zusätzlich in „fällig“ und
 * „später“ geteilt. Wer die Seite öffnet, soll oben sehen, was heute ansteht,
 * ohne zu suchen.
 */
async function renderLeads(req, res, extra = {}) {
  const rows = await leadsLib.all();
  const today = localDate();

  // follow_up_on kommt als 'YYYY-MM-DD' – so lässt es sich direkt vergleichen.
  const isDue = (l) => leadsLib.OPEN.includes(l.status) && l.follow_up_on && l.follow_up_on <= today;

  res.render('admin/leads', {
    title: 'Akquise',
    nav: 'admin-leads',
    today,
    due: rows.filter(isDue),
    // Zugesagt, aber noch nicht beworben: Das ist der Stapel, bei dem Geld
    // liegen bleibt – deshalb ein eigener Abschnitt und nicht unter
    // „abgeschlossen“ mit halber Deckkraft.
    awaiting: rows.filter((l) => l.status === 'won' && !l.creator_id),
    open: rows.filter((l) => leadsLib.OPEN.includes(l.status) && !isDue(l)),
    closed: rows.filter(
      (l) => !leadsLib.OPEN.includes(l.status) && !(l.status === 'won' && !l.creator_id)
    ),
    statuses: leadsLib.STATUS,
    statusLabel: leadsLib.statusLabel,
    profileUrl: leadsLib.profileUrl,
    applyUrlFor: (lead) => leadsLib.applyUrl(config.baseUrl, lead),
    flash: req.query.ok || null,
    error: null,
    openId: Number(req.query.offen) || null,
    ...extra,
  });
}

router.get('/leads', (req, res) => renderLeads(req, res));

router.post('/leads', async (req, res) => {
  const result = await leadsLib.addMany(req.body && req.body.handles);

  if (!result.handles.length) {
    return renderLeads(req, res, {
      error: 'Kein brauchbarer Instagram-Name dabei. Ein Name je Zeile, mit oder ohne @.',
    });
  }

  await db.log(actor(req), 'lead.added', String(result.added), `${result.handles.length} eingegeben`);

  const parts = [`${result.added} neu`];
  if (result.skipped) parts.push(`${result.skipped} schon vorhanden`);
  res.redirect(`/admin/leads?ok=${encodeURIComponent(parts.join(', ') + '.')}`);
});

router.post('/leads/:id', async (req, res) => {
  const lead = await leadsLib.byId(req.params.id);
  if (!lead) return res.redirect('/admin/leads');

  await leadsLib.save(lead.id, req.body || {});
  res.redirect(`/admin/leads?ok=${encodeURIComponent(`@${lead.instagram} gespeichert.`)}`);
});

router.post('/leads/:id/loeschen', async (req, res) => {
  const lead = await leadsLib.byId(req.params.id);
  if (!lead) return res.redirect('/admin/leads');

  await leadsLib.remove(lead.id);
  await db.log(actor(req), 'lead.deleted', lead.instagram, null);
  res.redirect(`/admin/leads?ok=${encodeURIComponent(`@${lead.instagram} entfernt.`)}`);
});

module.exports = router;
