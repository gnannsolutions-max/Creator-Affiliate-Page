'use strict';

// Vermittler: Bewerbungslink, Zuordnung, Beteiligung, Login und Dashboard –
// über die echten HTTP-Routen.

const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/creator_affiliate_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'test-passwort';
process.env.NODE_ENV = 'test';
process.env.COMMISSION_DEDUCTION = '0';

const db = require('../src/db');
const { createApp } = require('../src/app');
const { buildSnapshot, brokerDashboardFor } = require('../src/services/snapshot');
const { importCreatorSharesCsv } = require('../src/services/importSales');
const auth = require('../src/lib/auth');

let available = true;
let server;
let base;

test.before(async () => {
  try {
    await db.migrate();
    await db.run("DELETE FROM creators WHERE email_norm IN ('vermittelt@test.de','direkt@test.de')");
    await db.run("DELETE FROM brokers WHERE email_norm = 'vermittler@test.de'");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  } catch (err) {
    available = false;
  }
});

async function adminSession() {
  let r = await fetch(`${base}/admin/login`);
  const jar = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const tok = (await r.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
  r = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-passwort', _csrf: tok }),
  });
  return [jar, ...(r.headers.getSetCookie() || []).map((c) => c.split(';')[0])].join('; ');
}

test('Vermittler: anlegen, Bewerbung über seinen Link, Beteiligung im Dashboard', async (t) => {
  if (!available) return t.skip('kein Postgres');
  const cookie = await adminSession();

  // 1) Vermittler anlegen (10 %)
  let r = await fetch(`${base}/admin/brokers`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ full_name: 'Vera Vermittler', email: 'vermittler@test.de', share_rate: '10', status: 'active' }),
  });
  assert.strictEqual(r.status, 302);
  const broker = await db.one("SELECT * FROM brokers WHERE email_norm = 'vermittler@test.de'");
  assert.ok(broker, 'Vermittler gespeichert');
  assert.strictEqual(broker.share_rate, 10);

  // 2) Creator bewirbt sich über den Vermittler-Link
  r = await fetch(`${base}/bewerben`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      full_name: 'Vermittelte Person', email: 'vermittelt@test.de', requested_code: 'Creator501',
      instagram: 'vermittelt', accept_terms: '1', accept_privacy: '1', src: `vermittler-${broker.id}`,
    }),
  });
  assert.ok([200, 302].includes(r.status), `Bewerbung angenommen (HTTP ${r.status})`);
  const creator = await db.one("SELECT * FROM creators WHERE email_norm = 'vermittelt@test.de'");
  assert.ok(creator, 'Creator angelegt');
  assert.strictEqual(creator.broker_id, broker.id, 'über den Link dem Vermittler zugeordnet');
  assert.strictEqual(creator.requested_code, 'Creator501');

  // Ein Creator ohne Link hängt an niemandem
  r = await fetch(`${base}/bewerben`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      full_name: 'Direkte Person', email: 'direkt@test.de', requested_code: 'Creator502',
      instagram: 'direkt', accept_terms: '1', accept_privacy: '1',
    }),
  });
  const direct = await db.one("SELECT * FROM creators WHERE email_norm = 'direkt@test.de'");
  assert.strictEqual(direct.broker_id, null);

  // 3) Freigeben mit Code, Umsätze einspielen
  const brand = await db.one(
    `INSERT INTO brands (name, slug, shop_url, link_template) VALUES ('VB', 'vb-test', 'https://vb.test', 'https://vb.test/?c={CODE}')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`
  );
  await db.run("UPDATE creators SET status = 'approved' WHERE id = $1", [creator.id]);
  await db.run(
    `INSERT INTO creator_codes (creator_id, brand_id, code, code_norm, commission_rate, customer_discount)
     VALUES ($1, $2, 'Creator501', 'CREATOR501', 15, 10) ON CONFLICT (creator_id, brand_id) DO NOTHING`,
    [creator.id, brand.id]
  );
  await importCreatorSharesCsv('Netto;Beteiligung;Creator\n200;15;Vermittelte Person\n100;15;Vermittelte Person', {
    brandId: brand.id, actor: 'test', force: true,
  });
  await buildSnapshot({ triggeredBy: 'test' });

  // 4) Vermittler-Dashboard: 300 € Umsatz, 10 % = 30 € Beteiligung
  const data = await brokerDashboardFor(broker.id);
  assert.strictEqual(data.totals.creators_count, 1);
  assert.strictEqual(data.totals.orders_total, 2);
  assert.strictEqual(data.totals.revenue_total, 300);
  assert.strictEqual(data.totals.share_total, 30);
  assert.strictEqual(data.creators.length, 1);
  assert.strictEqual(data.creators[0].full_name, 'Vermittelte Person');
  assert.strictEqual(data.creators[0].share_total, 30);

  // 5) Login per Link führt ins Vermittler-Dashboard, nicht ins Creator-Dashboard
  const token = await auth.createBrokerLoginToken(broker.id);
  r = await fetch(`${base}/login/${token}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/vermittler');
  const bc = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/vermittler`, { headers: { cookie: bc } });
  const html = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(html.includes('Hallo Vera'), 'Begrüßung');
  assert.ok(html.includes('Vermittelte Person'), 'Creator in der Liste');
  assert.ok(html.includes('30,00'), 'Beteiligung sichtbar');
  assert.ok(!html.includes('Direkte Person'), 'fremde Creator nicht sichtbar');

  // 6) Satz ändern → Beteiligung folgt sofort
  r = await fetch(`${base}/admin/brokers`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: String(broker.id), full_name: 'Vera Vermittler', email: 'vermittler@test.de', share_rate: '20', status: 'active' }),
  });
  assert.strictEqual(r.status, 302);
  const after = await brokerDashboardFor(broker.id);
  assert.strictEqual(after.totals.share_total, 60, 'nach Satzänderung sofort neu berechnet');
});

test.after(async () => {
  if (server) server.close();
  await db.close().catch(() => {});
});
