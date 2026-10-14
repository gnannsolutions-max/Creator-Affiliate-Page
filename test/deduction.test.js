'use strict';

// Fester Abzug je Bestellung vor der Provision (COMMISSION_DEDUCTION).

const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/creator_affiliate_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'test-passwort';
process.env.NODE_ENV = 'test';
process.env.COMMISSION_DEDUCTION = '10';

const db = require('../src/db');
const { buildSnapshot, dashboardFor } = require('../src/services/snapshot');
const { importCreatorSharesCsv } = require('../src/services/importSales');

let available = true;
test.before(async () => {
  try {
    await db.migrate();
  } catch (err) {
    available = false;
  }
});

test('10 € werden je Bestellung abgezogen, bevor der Prozentsatz greift – nie unter 0', async (t) => {
  if (!available) return t.skip('kein Postgres');
  const brand = await db.one(
    `INSERT INTO brands (name, slug, shop_url, link_template) VALUES ('Abzug', 'abzug-test', 'https://abzug.test', 'https://abzug.test/?c={CODE}')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING *`
  );
  await db.run("DELETE FROM creators WHERE email_norm = 'abzug@test.de'");
  const c = await db.one(
    `INSERT INTO creators (full_name, email, email_norm, instagram, requested_code, status, commission_rate, customer_discount, terms_version, terms_accepted_at)
     VALUES ('Abzug Test', 'abzug@test.de', 'abzug@test.de', 'abzugtest', 'CREATOR77', 'approved', 15, 10, 't', now()) RETURNING id`
  );
  // 100 € → Basis 90 € → 30 % = 27 €; 50 € → Basis 40 € → 12 €; 6 € → Basis 0 → 0 €
  const r = await importCreatorSharesCsv(
    'Netto;Beteiligung;Creator\n100;30;Abzug Test\n50;30;Abzug Test\n6;30;Abzug Test',
    { brandId: brand.id, actor: 'test', force: true }
  );
  assert.strictEqual(r.inserted, 3);
  await buildSnapshot({ triggeredBy: 'test' });
  const d = await dashboardFor(c.id);
  assert.strictEqual(d.totals.revenue_total, 130, 'Umsatz = Netto minus 10 € je Bestellung: 90 + 40 + 0');
  assert.strictEqual(d.orders.find((o) => o.commission === 27).revenue, 90, 'auch in der Bestellliste steht der bereinigte Betrag');
  assert.strictEqual(d.totals.commission_total, 39, '27 + 12 + 0');
});

test.after(async () => {
  await db.close().catch(() => {});
});
