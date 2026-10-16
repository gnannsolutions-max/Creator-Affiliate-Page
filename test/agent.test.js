'use strict';

// Agenten: Kennung aus utm_campaign, Bewerbung, Freigabe mit Provision,
// Übernahme bereits eingegangener Bestellungen, Login und Dashboard.

const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/creator_affiliate_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'test-passwort';
process.env.NODE_ENV = 'test';
process.env.COMMISSION_DEDUCTION = '0';

const db = require('../src/db');
const { createApp } = require('../src/app');
const { buildSnapshot, agentDashboardFor, dashboardFor } = require('../src/services/snapshot');
const { mapOrder } = require('../src/services/syncWoo');
const auth = require('../src/lib/auth');

let available = true;
let server;
let base;

test('Kennung A12 / Agent12 in utm_campaign wird erkannt, Creator in utm_source bleibt davon unberührt', () => {
  const lk = { byCode: new Map([['CREATOR1', { creator_id: 1, commission_rate: 15 }]]), byName: new Map(), byHandle: new Map(), byAgent: new Map([['A12', { id: 9, commission_rate: 20 }]]) };
  const base = { id: 1, status: 'completed', date_created: '2026-10-14T10:00:00', total: '100', total_tax: '0', shipping_total: '0', coupon_lines: [], meta_data: [] };
  const both = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'Creator1' }, { key: '_wc_order_attribution_utm_campaign', value: 'Agent12' }] }, lk, {});
  assert.strictEqual(both.row.creator_id, 1);
  assert.strictEqual(both.row.agent_id, 9);
  assert.strictEqual(both.row.agent_code, 'A12');
  const onlyAgent = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_utm_campaign', value: 'a-3' }] }, lk, {});
  assert.strictEqual(onlyAgent.row.creator_id, null);
  assert.strictEqual(onlyAgent.row.agent_id, null, 'A3 ist noch kein Agent');
  assert.strictEqual(onlyAgent.row.agent_code, 'A3', 'Kennung wird trotzdem gemerkt');
});

test('Kennungen werden auch in anderen utm-Feldern und in der Einstiegs-URL gefunden', () => {
  const lk = { byCode: new Map([['CREATOR1', { creator_id: 1, commission_rate: 15 }]]), byName: new Map(), byHandle: new Map(), byAgent: new Map([['A1', { id: 9, commission_rate: 20 }]]) };
  const base = { id: 1, status: 'completed', date_created: '2026-10-14T10:00:00', total: '100', total_tax: '0', shipping_total: '0', coupon_lines: [], meta_data: [] };
  // A1 im utm_source statt utm_campaign
  const srcOnly = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'A1' }] }, lk, {});
  assert.strictEqual(srcOnly.row.agent_id, 9);
  // beides nur in der Einstiegs-URL (kein utm-Feld befüllt)
  const entry = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_session_entry', value: 'https://shop.test/produkt/?ref=Creator1&agent=A1#top' }] }, lk, {});
  assert.strictEqual(entry.row.creator_id, 1);
  assert.strictEqual(entry.row.agent_id, 9);
  // utm_medium=social darf nichts auslösen
  const none = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_utm_medium', value: 'social' }, { key: '_wc_order_attribution_source_type', value: 'typein' }] }, lk, {});
  assert.strictEqual(none.row.creator_id, null);
  assert.strictEqual(none.row.agent_code, null);
});

test.before(async () => {
  try {
    await db.migrate();
    await db.run("DELETE FROM agents WHERE email_norm = 'agent@test.de'");
    await db.run("DELETE FROM sales WHERE agent_code = 'A77'");
    await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'apply:%' OR bucket LIKE 'login%' OR bucket LIKE 'admin-login:%'");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  } catch {
    available = false;
  }
});

async function adminSession() {
  let r = await fetch(`${base}/admin/login`);
  const jar = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const tok = (await r.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
  r = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'test-passwort', _csrf: tok }) });
  return [jar, ...(r.headers.getSetCookie() || []).map((c) => c.split(';')[0])].join('; ');
}

test('Agent: Bestellungen vor der Bewerbung, Bewerbung mit Kennung, Freigabe mit 20 %, Dashboard', async (t) => {
  if (!available) return t.skip('kein Postgres');
  const brand = await db.one(`INSERT INTO brands (name, slug, shop_url, link_template) VALUES ('AG', 'ag-test', 'https://ag.test', 'https://ag.test/?c={CODE}') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`);

  // 1) Zwei Bestellungen mit A77 liegen schon im Portal, Agent existiert noch nicht
  await db.run(
    `INSERT INTO sales (order_ref, code_norm, order_date, gross_amount, net_amount, status, brand_id, agent_code)
     VALUES ('WAG1', '', '2026-10-14', 100, 100, 'confirmed', $1, 'A77'), ('WAG2', '', '2026-10-15', 50, 50, 'confirmed', $1, 'A77'), ('WAG3', '', '2026-10-15', 30, 30, 'refunded', $1, 'A77')`,
    [brand.id]
  );

  // 2) Bewerbung mit Kennung – Schreibweise egal
  let r = await fetch(`${base}/agent-werden`);
  assert.ok((await r.text()).includes('Deine Agentenkennung'));
  r = await fetch(`${base}/agent-werden`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ full_name: 'Anna Agentin', email: 'agent@test.de', agent_code: 'agent 77', accept_terms: '1', accept_privacy: '1' }) });
  assert.strictEqual(r.status, 200);
  const a = await db.one("SELECT * FROM agents WHERE email_norm = 'agent@test.de'");
  assert.strictEqual(a.status, 'pending');
  assert.strictEqual(a.agent_code, 'A77');

  // Vor Freigabe: kein Login, keine Zahlen
  await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'agent@test.de' }) });
  assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM login_tokens WHERE agent_id = $1', [a.id])).n, 0);

  // 3) Freigabe mit 20 %
  const cookie = await adminSession();
  r = await fetch(`${base}/admin/agents`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: String(a.id), full_name: a.full_name, email: a.email, agent_code: 'A77', commission_rate: '20', status: 'active' }) });
  assert.strictEqual(r.status, 302);
  assert.ok(decodeURIComponent(r.headers.get('location')).includes('3 bereits eingegangene'), 'alte Bestellungen übernommen');

  // 4) Dashboard: 150 € bestätigt (Retoure raus), 20 % = 30 €
  const d = await agentDashboardFor(a.id);
  assert.strictEqual(d.totals.orders_total, 2);
  assert.strictEqual(d.totals.revenue_total, 150);
  assert.strictEqual(d.totals.commission_total, 30);
  assert.strictEqual(d.orders.length, 3, 'Retoure steht in der Liste, zählt aber nicht');

  // 5) Login-Link führt ins Agenten-Dashboard
  const token = await auth.createAgentLoginToken(a.id);
  r = await fetch(`${base}/login/${token}`, { redirect: 'manual' });
  assert.strictEqual(r.headers.get('location'), '/agent');
  const ac = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/agent`, { headers: { cookie: ac } });
  const html = await r.text();
  assert.ok(html.includes('Hallo Anna') && html.includes('A77') && html.includes('30,00'), 'Dashboard zeigt Kennung und Provision');

  // 6) Satz ändern wirkt sofort
  r = await fetch(`${base}/admin/agents`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: String(a.id), full_name: a.full_name, email: a.email, agent_code: 'A77', commission_rate: '10', status: 'active' }) });
  assert.strictEqual((await agentDashboardFor(a.id)).totals.commission_total, 15);
});

test.after(async () => {
  if (server) server.close();
  await db.close().catch(() => {});
});
