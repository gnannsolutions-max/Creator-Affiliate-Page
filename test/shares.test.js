'use strict';

// Tests für den Shop-Export mit Umsatz je Creator (Nettoumsatz, Beteiligung in
// %, Creatorname) und die zwei Sicherheitsläufe.

const test = require('node:test');
const assert = require('node:assert');

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://postgres@127.0.0.1:5432/creator_affiliate_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'test-passwort';
process.env.NODE_ENV = 'test';
process.env.REFRESH_TIMES = '10:30,17:30';

const config = require('../src/config');
const db = require('../src/db');
const {
  buildSnapshot,
  dashboardFor,
  latestRun,
  hasRunForSlot,
  needsSafetyRun,
} = require('../src/services/snapshot');
const { importAnyCsv, importCreatorSharesCsv, importSalesCsv } = require('../src/services/importSales');
const { parseCreatorSharesCsv, detectFormat, parseCsv, parseRate, normalizeName } = require('../src/lib/csv');
const { localDate, nextRefreshLabel } = require('../src/lib/dates');

// --- Reine Funktionstests (ohne Datenbank) -----------------------------------

test('Slots aus REFRESH_TIMES: zwei Läufe, sortiert, mit Beschriftung', () => {
  assert.deepStrictEqual(
    config.refresh.slots.map((s) => s.label),
    ['10:30', '17:30']
  );
  assert.strictEqual(config.refresh.label, '10:30 und 17:30 Uhr');
  assert.strictEqual(config.refresh.hour, 10, 'der erste Slot bleibt als hour erreichbar');
});

test('nextRefreshLabel zeigt heute oder morgen, je nach Uhrzeit', () => {
  // 08:00 Berlin → heute 10:30; 12:00 → heute 17:30; 20:00 → morgen 10:30
  const at = (h) => new Date(`2026-01-15T${String(h - 1).padStart(2, '0')}:00:00Z`); // Winterzeit: UTC+1
  assert.strictEqual(nextRefreshLabel(at(8)), 'heute um 10:30 Uhr');
  assert.strictEqual(nextRefreshLabel(at(12)), 'heute um 17:30 Uhr');
  assert.strictEqual(nextRefreshLabel(at(20)), 'morgen um 10:30 Uhr');
});

test('Beteiligung: 30, „30 %“ und 0,3 bedeuten dasselbe', () => {
  assert.strictEqual(parseRate('30'), 30);
  assert.strictEqual(parseRate('30 %'), 30);
  assert.strictEqual(parseRate('0,3'), 30);
  assert.strictEqual(parseRate('12,5%'), 12.5);
  assert.strictEqual(parseRate(''), null);
});

test('Namen werden unabhängig von Schreibweise und Umlauten verglichen', () => {
  assert.strictEqual(normalizeName('Jörg Müller-Lüdenscheidt'), 'jorgmullerludenscheidt');
  assert.strictEqual(normalizeName('Max Mustermann'), 'maxmustermann');
  assert.strictEqual(normalizeName('  MAX   mustermann '), 'maxmustermann');
  assert.strictEqual(normalizeName('Straße'), 'strasse');
});

test('Formaterkennung unterscheidet Bestellliste und Creator-Export', () => {
  assert.strictEqual(detectFormat(parseCsv('order_ref;code;datum;total\n1;A;2026-01-01;10').header), 'orders');
  assert.strictEqual(detectFormat(parseCsv('Nettoumsatz;Creatorbeteiligung in %;Creatorname').header), 'shares');
  assert.strictEqual(detectFormat(parseCsv('Netto-Umsatz (EUR),Provision,Creator').header), 'shares');
  assert.strictEqual(detectFormat(parseCsv('foo;bar').header), null);
});

test('Creator-Export: Überschriften, deutsche Zahlen und kaputte Zeilen', () => {
  const r = parseCreatorSharesCsv(
    'Nettoumsatz;Creatorbeteiligung in %;Creatorname\n89,90;30;Max Mustermann\n1.250,00;50 %;Mira Beispiel\n;30;Ohne Umsatz\n12;abc;Ohne Satz'
  );
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].net_amount, 89.9);
  assert.strictEqual(r.rows[1].net_amount, 1250);
  assert.strictEqual(r.rows[1].commission_rate, 50);
  assert.strictEqual(r.problems.length, 2);
  assert.strictEqual(r.total, 4);
});

test('Creator-Export ohne Überschriften wird am Inhalt erkannt', () => {
  const r = parseCreatorSharesCsv('120,00;30;Anna Schmidt\n80,50;50;Ben Weiß');
  assert.strictEqual(r.headerless, true);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].creator_name, 'Anna Schmidt', 'die erste Zeile ist Daten, keine Überschrift');
  assert.strictEqual(r.rows[0].net_amount, 120);
  assert.strictEqual(r.rows[0].commission_rate, 30);
});

// --- Datenbanktests ------------------------------------------------------------

let available = true;

test.before(async () => {
  try {
    await db.migrate();
    await db.run(
      `TRUNCATE snapshot_orders, snapshot_days, snapshot_totals, snapshot_brand_totals,
               snapshot_runs, payouts, sales, imports, login_tokens, audit_log, outbox,
               creator_codes, brands, creators RESTART IDENTITY CASCADE`
    );
  } catch (err) {
    available = false;
    console.error(`\nDatenbanktests übersprungen – kein Postgres erreichbar (${err.message}).\n`);
  }
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (!available) return t.skip('kein Postgres erreichbar');
    await fn(t);
  });
}

let brandSeq = 0;
async function seedBrand() {
  brandSeq += 1;
  const slug = `shop-${brandSeq}`;
  return db.one(
    `INSERT INTO brands (name, slug, shop_url, link_template) VALUES ($1, $2, $3, $4) RETURNING *`,
    [`Shop ${brandSeq}`, slug, `https://${slug}.test`, `https://${slug}.test/?c={CODE}`]
  );
}

/** Freigegebener Creator – wahlweise OHNE Code, denn der Export braucht keinen. */
async function seedCreator(fullName, { code = null, brand = null, instagram = null, status = 'approved' } = {}) {
  const handle = instagram || fullName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const creator = await db.one(
    `INSERT INTO creators (full_name, email, email_norm, instagram, requested_code,
       status, commission_rate, customer_discount, terms_version, terms_accepted_at)
     VALUES ($1,$2,$2,$3,$4,$5,15,10,'test', now()) RETURNING *`,
    [fullName, `${handle}@test.de`, handle, code || handle.toUpperCase().slice(0, 8), status]
  );
  if (code && brand) {
    await db.run(
      `INSERT INTO creator_codes (creator_id, brand_id, code, code_norm, commission_rate, customer_discount)
       VALUES ($1,$2,$3,$3,15,10)`,
      [creator.id, brand.id, code]
    );
  }
  return creator;
}

dbTest('Der Creator-Export wird über den Namen zugeordnet und mit dem Satz aus der Datei vergütet', async () => {
  const brand = await seedBrand();
  const max = await seedCreator('Max Mustermann');
  const mira = await seedCreator('Mira Beispiel');

  const csv =
    'Nettoumsatz;Creatorbeteiligung in %;Creatorname\n' +
    '100,00;30;max mustermann\n' + // Kleinschreibung trifft trotzdem
    '50,00;30;MAX MUSTERMANN\n' +
    '200,00;50;Mira Beispiel\n' +
    '10,00;30;Niemand Bekannt';

  const r = await importAnyCsv(csv, { brandId: brand.id, filename: 'export.csv', actor: 'test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'shares');
  assert.strictEqual(r.inserted, 4);
  assert.deepStrictEqual(r.unknownNames, [{ name: 'Niemand Bekannt', count: 1 }]);
  assert.strictEqual(r.matched.length, 2);

  await buildSnapshot({ triggeredBy: 'import' });

  const dMax = await dashboardFor(max.id);
  assert.strictEqual(dMax.totals.orders_total, 2);
  assert.strictEqual(dMax.totals.revenue_total, 150);
  assert.strictEqual(dMax.totals.commission_total, 45, '30 % von 150');
  assert.strictEqual(dMax.brands.length, 1, 'die Marke erscheint in der Aufschlüsselung – auch ohne Code');
  assert.strictEqual(dMax.brands[0].commission_total, 45);
  assert.strictEqual(dMax.orders.length, 2);
  assert.strictEqual(dMax.orders[0].order_date, localDate(), 'gebucht auf den Tag des Uploads');

  const dMira = await dashboardFor(mira.id);
  assert.strictEqual(dMira.totals.commission_total, 100, '50 % von 200');

  const rows = await db.many('SELECT * FROM sales WHERE creator_id IS NULL AND creator_name = $1', ['Niemand Bekannt']);
  assert.strictEqual(rows.length, 1, 'unbekannte Zeile ist gespeichert, aber niemandem zugeordnet');
});

dbTest('Dieselbe Datei wird nicht zweimal angenommen – außer mit force', async () => {
  const brand = await seedBrand();
  await seedCreator('Dana Doppelt');
  const csv = 'Nettoumsatz;Creatorbeteiligung in %;Creatorname\n100,00;30;Dana Doppelt';

  const first = await importCreatorSharesCsv(csv, { brandId: brand.id, filename: 'a.csv', actor: 'test' });
  assert.strictEqual(first.ok, true);

  const second = await importCreatorSharesCsv(csv + '\r\n', { brandId: brand.id, filename: 'b.csv', actor: 'test' });
  assert.strictEqual(second.ok, false, 'gleicher Inhalt, nur andere Zeilenenden – abgelehnt');
  assert.strictEqual(second.duplicate.id, first.importId);

  const forced = await importCreatorSharesCsv(csv, { brandId: brand.id, filename: 'c.csv', actor: 'test', force: true });
  assert.strictEqual(forced.ok, true);

  const otherBrand = await seedBrand();
  const elsewhere = await importCreatorSharesCsv(csv, { brandId: otherBrand.id, filename: 'd.csv', actor: 'test' });
  assert.strictEqual(elsewhere.ok, true, 'für eine andere Marke ist dieselbe Datei kein Duplikat');
});

dbTest('Zwei Creator mit demselben Namen: die Zeile bleibt unzugeordnet statt beim Falschen zu landen', async () => {
  const brand = await seedBrand();
  await seedCreator('Kim Zwilling', { instagram: 'kim.eins' });
  await seedCreator('Kim Zwilling', { instagram: 'kim.zwei' });
  const r = await importCreatorSharesCsv('Netto;Beteiligung;Creator\n100;30;Kim Zwilling\n50;30;kim.zwei', {
    brandId: brand.id,
    actor: 'test',
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ambiguousNames, [{ name: 'Kim Zwilling', count: 1 }]);
  assert.strictEqual(r.matched.length, 1, 'über den Instagram-Handle ist die zweite Zeile eindeutig');
});

dbTest('Die alte Bestellliste mit Codes funktioniert weiter – gemischt mit dem neuen Export', async () => {
  const brand = await seedBrand();
  const c = await seedCreator('Code Carla', { code: 'CARLA15', brand });
  const today = localDate();

  const orders = await importAnyCsv(`order_ref;code;datum;total;netto;status\n500;CARLA15;${today};120,00;100,00;paid`, {
    brandId: brand.id,
    actor: 'test',
  });
  assert.strictEqual(orders.kind, 'orders');
  assert.strictEqual(orders.inserted, 1);

  const shares = await importAnyCsv('Nettoumsatz;Creatorbeteiligung in %;Creatorname\n200,00;40;Code Carla', {
    brandId: brand.id,
    actor: 'test',
  });
  assert.strictEqual(shares.kind, 'shares');

  await buildSnapshot({ triggeredBy: 'import' });
  const d = await dashboardFor(c.id);
  assert.strictEqual(d.totals.orders_total, 2);
  assert.strictEqual(d.totals.revenue_total, 300);
  assert.strictEqual(d.totals.commission_total, 15 + 80, 'Code-Zeile 15 % vom Code, Export-Zeile 40 % aus der Datei');
});

dbTest('Sicherheitslauf: rechnet nur, wenn seit dem letzten Upload kein Stand erzeugt wurde', async () => {
  const brand = await seedBrand();
  await seedCreator('Sina Sicher');
  const day = localDate();

  await db.run('DELETE FROM snapshot_runs');
  assert.strictEqual((await needsSafetyRun(day)).needed, true, 'ohne Stand heute: laufen');

  await importCreatorSharesCsv('Netto;Beteiligung;Creator\n10;30;Sina Sicher', { brandId: brand.id, actor: 'test' });
  await buildSnapshot({ triggeredBy: 'import' });
  assert.strictEqual((await needsSafetyRun(day)).needed, false, 'Stand ist jünger als der Upload: nichts zu tun');

  await new Promise((r) => setTimeout(r, 20));
  await importCreatorSharesCsv('Netto;Beteiligung;Creator\n20;30;Sina Sicher', { brandId: brand.id, actor: 'test' });
  assert.strictEqual((await needsSafetyRun(day)).needed, true, 'Upload ohne Snapshot: laufen');

  assert.strictEqual(await hasRunForSlot(day, '10:30'), false);
  await buildSnapshot({ triggeredBy: 'cron', slot: '10:30' });
  assert.strictEqual(await hasRunForSlot(day, '10:30'), true);
  assert.strictEqual(await hasRunForSlot(day, '17:30'), false, 'der zweite Slot ist davon unberührt');
  assert.strictEqual((await latestRun()).slot, '10:30');
});

dbTest('Ein Import lässt sich mit allen Zeilen zurücknehmen', async () => {
  const brand = await seedBrand();
  const c = await seedCreator('Rudi Rückgabe');
  const r = await importCreatorSharesCsv('Netto;Beteiligung;Creator\n100;30;Rudi Rückgabe\n50;30;Rudi Rückgabe', {
    brandId: brand.id,
    actor: 'test',
  });
  await db.run('DELETE FROM sales WHERE import_id = $1', [r.importId]);
  await db.run('DELETE FROM imports WHERE id = $1', [r.importId]);
  await buildSnapshot({ triggeredBy: 'import-rollback' });
  const d = await dashboardFor(c.id);
  assert.strictEqual(d.totals, null, 'ohne Umsatz und ohne Code gibt es keinen Stand mehr für diesen Creator');
});

test.after(async () => {
  await db.close().catch(() => {});
});
