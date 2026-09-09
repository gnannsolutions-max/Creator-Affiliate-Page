'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Eigene Datenbank für die Tests – muss vor dem ersten require von src/db stehen.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://postgres@127.0.0.1:5432/creator_affiliate_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'test-passwort';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { buildSnapshot, dashboardFor, latestRun, hasRunToday } = require('../src/services/snapshot');
const { importSalesCsv } = require('../src/services/importSales');
const { codeIssue, codeTaken, normalizeHandle, normalizeCode } = require('../src/lib/validate');
const mailer = require('../src/lib/mailer');
const { localDate, addDays } = require('../src/lib/dates');

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
    console.error(
      `\nDatenbanktests übersprungen – kein Postgres erreichbar (${err.message}).\n` +
        'Zum Ausführen: TEST_DATABASE_URL auf eine leere Testdatenbank setzen.\n'
    );
  }
});


/** Test, der eine erreichbare Datenbank braucht. Ohne Postgres wird er sauber übersprungen. */
function dbTest(name, fn) {
  test(name, async (t) => {
    if (!available) return t.skip('kein Postgres erreichbar');
    await fn(t);
  });
}

/** Eine Marke mit eigener Linkvorlage – jede Marke ist ein eigener Shop. */
async function seedBrand(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return db.one(
    `INSERT INTO brands (name, slug, shop_url, link_template)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, slug, `https://${slug}.test`, `https://${slug}.test/?coupon={CODE}`]
  );
}

/**
 * Ein freigegebener Creator mit genau einem Code für die übergebene Marke.
 * Ohne Marke wird eine angelegt, damit die meisten Tests sich nicht darum
 * kümmern müssen.
 */
async function seedCreator(code, rate, brand) {
  const b = brand || (await seedBrand(`Marke ${code}`));
  const creator = await db.one(
    `INSERT INTO creators (full_name, email, email_norm, instagram, requested_code,
       status, commission_rate, customer_discount, terms_version, terms_accepted_at)
     VALUES ($1,$2,$3,$4,$5,'approved',$6,10,'test', now()) RETURNING *`,
    [`Creator ${code}`, `${code}@test.de`, `${code}@test.de`, code.toLowerCase(), code, rate]
  );
  await db.run(
    `INSERT INTO creator_codes (creator_id, brand_id, code, code_norm, commission_rate, customer_discount)
     VALUES ($1,$2,$3,$3,$4,10)`,
    [creator.id, b.id, code, rate]
  );
  return { ...creator, brand: b, brandId: b.id };
}

dbTest('Provision wird nur auf bestätigte Bestellungen gerechnet', async () => {
  const creator = await seedCreator('AAA10', 10);
  const today = localDate();
  const csv = [
    'order_ref;code;datum;total;netto;status',
    `1;AAA10;${today};120,00;100,00;paid`,
    `2;AAA10;${today};120,00;100,00;refunded`,
    `3;AAA10;${today};120,00;100,00;offen`,
  ].join('\n');

  const result = await importSalesCsv(csv, { brandId: creator.brandId, filename: 'test.csv', actor: 'test' });
  assert.strictEqual(result.inserted, 3);

  await buildSnapshot({ triggeredBy: 'test' });
  const data = await dashboardFor(creator.id);

  assert.strictEqual(data.totals.orders_total, 1, 'nur die bestätigte Bestellung zählt');
  assert.strictEqual(data.totals.revenue_total, 100);
  assert.strictEqual(data.totals.commission_total, 10);
  assert.strictEqual(data.orders.length, 3, 'alle drei stehen in der Liste');
});

dbTest('eine nachgereichte Retoure nimmt die Provision wieder zurück', async () => {
  const creator = await seedCreator('BBB20', 20);
  const today = localDate();
  await importSalesCsv(`order_ref;code;datum;total;status\n10;BBB20;${today};200,00;paid`, { brandId: creator.brandId, actor: 'test' });
  await buildSnapshot({ triggeredBy: 'test' });
  assert.strictEqual((await dashboardFor(creator.id)).totals.commission_total, 40);

  const again = await importSalesCsv(`order_ref;code;datum;total;status\n10;BBB20;${today};200,00;refunded`, {
    brandId: creator.brandId,
    actor: 'test',
  });
  assert.strictEqual(again.updated, 1, 'dieselbe Bestellnummer wird aktualisiert, nicht dupliziert');
  assert.strictEqual(again.inserted, 0);

  await buildSnapshot({ triggeredBy: 'test' });
  assert.strictEqual((await dashboardFor(creator.id)).totals.commission_total, 0);
});

dbTest('das Dashboard ändert sich erst mit dem nächsten Snapshot', async () => {
  const creator = await seedCreator('CCC15', 15);
  const today = localDate();
  await importSalesCsv(`order_ref;code;datum;total;status\n20;CCC15;${today};100,00;paid`, { brandId: creator.brandId, actor: 'test' });
  await buildSnapshot({ triggeredBy: 'test' });
  const before = (await dashboardFor(creator.id)).totals.revenue_total;

  await importSalesCsv(`order_ref;code;datum;total;status\n21;CCC15;${today};500,00;paid`, { brandId: creator.brandId, actor: 'test' });
  const stillBefore = (await dashboardFor(creator.id)).totals.revenue_total;
  assert.strictEqual(stillBefore, before, 'ohne Snapshot bleibt der Stand eingefroren');

  await buildSnapshot({ triggeredBy: 'test' });
  assert.strictEqual((await dashboardFor(creator.id)).totals.revenue_total, 600);
});

dbTest('die Tagesreihe enthält auch Tage ohne Bestellung', async () => {
  const creator = await seedCreator('DDD10', 10);
  const today = localDate();
  await importSalesCsv(`order_ref;code;datum;total;status\n30;DDD10;${addDays(today, -5)};100,00;paid`, {
    brandId: creator.brandId,
    actor: 'test',
  });
  await buildSnapshot({ triggeredBy: 'test' });
  const { days } = await dashboardFor(creator.id);
  assert.strictEqual(days.length, 30);
  assert.strictEqual(days[days.length - 1].day, today);
  assert.strictEqual(days[0].day, addDays(today, -29));
  assert.strictEqual(days.filter((d) => d.revenue > 0).length, 1);
});

dbTest('der Vorperiodenvergleich nutzt die richtigen Zeitfenster', async () => {
  const creator = await seedCreator('FFF10', 10);
  const today = localDate();
  await importSalesCsv(
    [
      'order_ref;code;datum;total;status',
      `60;FFF10;${addDays(today, -5)};100,00;paid`,
      `61;FFF10;${addDays(today, -40)};300,00;paid`,
      `62;FFF10;${addDays(today, -80)};900,00;paid`,
    ].join('\n'),
    { brandId: creator.brandId, actor: 'test' }
  );
  await buildSnapshot({ triggeredBy: 'test' });
  const t = (await dashboardFor(creator.id)).totals;
  assert.strictEqual(t.revenue_30d, 100, 'nur die letzten 30 Tage');
  assert.strictEqual(t.revenue_prev30d, 300, 'nur Tag 31 bis 60');
  assert.strictEqual(t.revenue_total, 1300, 'alles zusammen');
});

dbTest('bereits ausgezahlte Provision senkt den offenen Betrag', async () => {
  const creator = await seedCreator('EEE10', 10);
  const today = localDate();
  await importSalesCsv(`order_ref;code;datum;total;status\n40;EEE10;${today};1000,00;paid`, { brandId: creator.brandId, actor: 'test' });
  await db.run(
    "INSERT INTO payouts (creator_id, period, amount, status, paid_at) VALUES ($1,'2026-08',40,'paid','2026-08-31')",
    [creator.id]
  );
  await buildSnapshot({ triggeredBy: 'test' });
  const t = (await dashboardFor(creator.id)).totals;
  assert.strictEqual(t.commission_total, 100);
  assert.strictEqual(t.commission_paid, 40);
  assert.strictEqual(t.commission_open, 60);
});

dbTest('unbekannte Codes werden gemeldet, aber nicht verworfen', async () => {
  const today = localDate();
  const brand = await seedBrand('Unbekannt');
  const result = await importSalesCsv(`order_ref;code;datum;total;status\n50;GIBTSNICHT;${today};10,00;paid`, {
    brandId: brand.id,
    actor: 'test',
  });
  assert.deepStrictEqual(result.unknownCodes, [{ code: 'GIBTSNICHT', count: 1 }]);
  const row = await db.one("SELECT COUNT(*)::int AS n FROM sales WHERE code_norm = 'GIBTSNICHT'");
  assert.strictEqual(row.n, 1);
});

dbTest('ein Snapshot markiert den Tag als erledigt', async () => {
  await buildSnapshot({ triggeredBy: 'cron' });
  assert.strictEqual(await hasRunToday(localDate()), true);
  assert.strictEqual(await hasRunToday(addDays(localDate(), -3)), false);
});

dbTest('Snapshots werden aufgeräumt statt endlos zu wachsen', async () => {
  const row = await db.one('SELECT COUNT(*)::int AS n FROM snapshot_runs');
  assert.ok(row.n <= 60, `erwartet höchstens 60 Läufe, sind ${row.n}`);
  assert.ok(await latestRun());
});

dbTest('zwei Marken mit derselben Bestellnummer kommen sich nicht ins Gehege', async () => {
  const esn = await seedBrand('ESN Test');
  const rocka = await seedBrand('Rocka Test');
  const creator = await seedCreator('MULTI10', 12, esn);

  // Derselbe Creator bei einer zweiten Marke – anderer Code, andere Provision.
  await db.run(
    `INSERT INTO creator_codes (creator_id, brand_id, code, code_norm, commission_rate, customer_discount)
     VALUES ($1,$2,'MULTIROCKA','MULTIROCKA',20,15)`,
    [creator.id, rocka.id]
  );

  const today = localDate();
  // Beide Shops liefern eine Bestellung "1001" – der Fall, an dem eine globale
  // Eindeutigkeit der Bestellnummer zerbrechen würde.
  await importSalesCsv(`order_ref;code;datum;total;netto;status\n1001;MULTI10;${today};120,00;100,00;paid`, {
    brandId: esn.id,
    actor: 'test',
  });
  await importSalesCsv(`order_ref;code;datum;total;netto;status\n1001;MULTIROCKA;${today};240,00;200,00;paid`, {
    brandId: rocka.id,
    actor: 'test',
  });

  await buildSnapshot({ triggeredBy: 'test' });
  const data = await dashboardFor(creator.id);

  assert.strictEqual(data.totals.orders_total, 2, 'beide Bestellungen zählen');
  assert.strictEqual(data.totals.revenue_total, 300);
  assert.strictEqual(
    data.totals.commission_total,
    12 + 40,
    'je Marke gilt der eigene Satz: 100 x 12 % plus 200 x 20 %'
  );

  const byName = Object.fromEntries(data.brands.map((b) => [b.brand_name, b]));
  assert.strictEqual(byName['ESN Test'].commission_total, 12);
  assert.strictEqual(byName['Rocka Test'].commission_total, 40);
  assert.strictEqual(data.orders.length, 2, 'beide Bestellungen stehen einzeln in der Liste');
});

dbTest('ein Code eines anderen Shops wird nicht versehentlich zugeordnet', async () => {
  const fremd = await seedBrand('Fremd Test');
  const today = localDate();

  // MULTI10 gehört zu ESN, nicht zu dieser Marke. Der Import darf ihn hier
  // nicht kennen – sonst bekäme der falsche Creator das Geld.
  const result = await importSalesCsv(
    `order_ref;code;datum;total;status\n7001;MULTI10;${today};50,00;paid`,
    { brandId: fremd.id, actor: 'test' }
  );
  assert.deepStrictEqual(result.unknownCodes, [{ code: 'MULTI10', count: 1 }]);
});

dbTest('vergebene Codes werden nicht doppelt zugeteilt', async () => {
  assert.strictEqual(await codeTaken('AAA10'), true);
  assert.strictEqual(await codeTaken('GIBTESNICHT99'), false);
});


dbTest('ohne SMTP landet jede Nachricht samt Link im Ausgangspostfach', async () => {
  const creator = await seedCreator('GGG10', 10);
  const link = 'https://example.test/login/abc123';
  const result = await mailer.send({
    to: creator.email,
    ...mailer.templates.approved(creator, link, [
      { brandName: 'Testmarke', code: 'GGG10', rate: 10, discount: 10, link: 'https://shop.test/?c=GGG10' },
    ]),
  });

  assert.strictEqual(mailer.hasSmtp(), false, 'im Test ist bewusst kein SMTP gesetzt');
  assert.strictEqual(result.sent, false, 'ohne SMTP wird nichts verschickt');

  const row = await db.one('SELECT * FROM outbox WHERE id = $1', [result.id]);
  assert.ok(row, 'die Nachricht ist gespeichert');
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.link, link, 'der Login-Link ist separat abrufbar');
  assert.ok(row.body.includes('GGG10'), 'der Volltext enthält den Code');
  assert.ok(row.body.includes('https://shop.test/?c=GGG10'), 'und den Link zum Posten');
});

dbTest('ein Login-Token aus dem Adminbereich funktioniert genau einmal', async () => {
  const creator = await seedCreator('HHH10', 10);
  const auth = require('../src/lib/auth');
  const token = await auth.createLoginToken(creator.id);

  const first = await auth.consumeLoginToken(token);
  assert.strictEqual(String(first), String(creator.id));
  assert.strictEqual(await auth.consumeLoginToken(token), null, 'zweiter Versuch schlägt fehl');
  assert.strictEqual(await auth.consumeLoginToken('unsinn'), null);
});

test('Code-Validierung blockt Format, reservierte und heikle Begriffe', () => {
  assert.strictEqual(codeIssue('LUAN15'), null);
  assert.ok(codeIssue('AB'), 'zu kurz');
  assert.ok(codeIssue('ADMIN'), 'reserviert');
  assert.ok(codeIssue('OZEMPIC10'), 'Arzneimittelbezug');
  assert.ok(codeIssue('HEILUNG5'), 'Heilbezug');
});

test('Handles werden aus URLs und @-Schreibweisen normalisiert', () => {
  assert.strictEqual(normalizeHandle('@luan.skin', 'instagram'), 'luan.skin');
  assert.strictEqual(normalizeHandle('https://www.instagram.com/luan.skin/', 'instagram'), 'luan.skin');
  assert.strictEqual(normalizeHandle('instagram.com/luan.skin?hl=de', 'instagram'), 'luan.skin');
  assert.strictEqual(normalizeHandle('', 'tiktok'), '');
  assert.strictEqual(normalizeCode(' luan-15 '), 'LUAN15');
});

test.after(async () => {
  await db.close().catch(() => {});
});
