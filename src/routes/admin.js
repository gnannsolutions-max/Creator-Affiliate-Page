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

// Der Adminbereich hängt an einem einzigen Passwort. Ohne Bremse wäre er
// systematisch durchprobierbar – deshalb die engste Grenze im ganzen Portal.
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
      error: `Zu viele Versuche. Nächster Versuch in etwa ${Math.ceil(gate.retryAfter / 60)} Minuten.`,
    });
  }

  if (!auth.checkAdminPassword(req.body.password)) {
    await db.log('system', 'admin.login.failed', ip, `Versuch ${gate.hits} von ${ADMIN_LOGIN_LIMIT.limit}`).catch(() => {});
    return res.status(401).render('admin/login', { title: 'Admin', nav: null, error: 'Falsches Passwort.' });
  }

  // Nach erfolgreichem Login den Zähler leeren, damit ein vertipptes Passwort
  // die eigene Sitzung nicht noch eine Viertelstunde lang ausbremst.
  await rateLimit.clear(bucket);
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
      `SELECT c.id, c.full_name, t.orders_30d, t.revenue_30d, t.commission_30d,
              (SELECT COUNT(*) FROM creator_codes cc WHERE cc.creator_id = c.id) AS brand_count
         FROM snapshot_totals t JOIN creators c ON c.id = t.creator_id
        WHERE t.run_id = $1 AND t.revenue_30d > 0
        ORDER BY t.revenue_30d DESC LIMIT 10`,
      [run.id]
    );
  }

  const akquise = await leadsLib.summary().catch(() => null);

  res.render('admin/home', {
    title: 'Übersicht',
    nav: 'admin-home',
    run,
    counts,
    akquise,
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

  // Die Kontodaten werden hier vollständig gezeigt – ohne sie lässt sich die
  // Überweisung nicht auslösen. In der Creator-Liste stehen sie bewusst nicht.
  const bank = await payout.load(c.id);

  // Marken und die bereits vergebenen Codes – daraus baut die Seite das
  // Zuweisungsformular und die Liste der Links.
  const [brandList, codes] = await Promise.all([brandsLib.all(), brandsLib.codesFor(c.id)]);
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

  const token = await auth.createLoginToken(id);
  const url = `${config.baseUrl}/login/${token}`;
  const result = await mailer
    .send({ to: updated.email, ...mailer.templates.approved(updated, url, wanted) })
    .catch((err) => ({ sent: false, error: err.message }));

  // Ohne SMTP bleibt die Seite stehen und zeigt den Link zum Kopieren an,
  // statt eine Erfolgsmeldung über eine Mail auszugeben, die nie ankommt.
  if (!result.sent) {
    return renderCreator(req, res, {
      loginLink: url,
      flash: `Freigegeben für ${wanted.length} Marke(n).`,
    });
  }

  res.redirect(
    `/admin/creators/${id}?ok=${encodeURIComponent(
      `Freigegeben für ${wanted.length} Marke(n), E-Mail mit den Links ist raus.`
    )}`
  );
});

/** Marken und Konditionen eines bereits freigegebenen Creators ändern. */
router.post('/creators/:id/codes', async (req, res) => {
  const id = req.params.id;
  const brandList = await brandsLib.all();
  const { wanted, errors } = await readBrandAssignments(id, brandList, req.body);
  if (errors.length) return renderCreator(req, res, { error: errors.join(' ') });

  await saveBrandAssignments(id, wanted);
  await db.log(
    config.adminName,
    'creator.codes.updated',
    String(id),
    wanted.map((w) => `${w.brandName}: ${w.code}`).join(', ') || 'alle entfernt'
  );

  res.redirect(
    `/admin/creators/${id}?ok=${encodeURIComponent(
      'Marken gespeichert. Die Zahlen ändern sich beim nächsten Lauf.'
    )}`
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
  const status = ['approved', 'paused'].includes(req.body.status) ? req.body.status : 'approved';

  await db.run(
    `UPDATE creators SET status = $1, note_internal = $2 WHERE id = $3`,
    [status, String(req.body.note_internal || '').slice(0, 2000) || null, id]
  );

  await db.log(config.adminName, 'creator.updated', String(id), `Status ${status}`);
  res.redirect(
    `/admin/creators/${id}?ok=${encodeURIComponent('Gespeichert. Wirkt im Creator-Dashboard nach dem nächsten Lauf.')}`
  );
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
    await db.log(config.adminName, 'brand.updated', values.slug, values.name);
  } else {
    await db.run(
      `INSERT INTO brands (name, slug, shop_url, link_template,
              default_commission_rate, default_customer_discount, note, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      params
    );
    await db.log(config.adminName, 'brand.created', values.slug, values.name);
  }

  res.redirect(`/admin/brands?ok=${encodeURIComponent(`Marke „${values.name}“ gespeichert.`)}`);
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
  const result = await importSalesCsv(text, {
    brandId: brand.id,
    filename: req.file.originalname,
    actor: config.adminName,
  });

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
    `SELECT code_norm, COUNT(*)::int AS rows FROM sales WHERE import_id = $1
      GROUP BY code_norm ORDER BY rows DESC LIMIT 12`,
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

  await db.log(config.adminName, 'lead.added', String(result.added), `${result.handles.length} eingegeben`);

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
  await db.log(config.adminName, 'lead.deleted', lead.instagram, null);
  res.redirect(`/admin/leads?ok=${encodeURIComponent(`@${lead.instagram} entfernt.`)}`);
});

module.exports = router;
