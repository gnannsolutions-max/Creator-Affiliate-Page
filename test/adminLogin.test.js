'use strict';

const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/creator_affiliate_test';
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'notzugang-passwort';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { createApp } = require('../src/app');
const adminUsers = require('../src/lib/adminUsers');

let available = true;
let server;
let base;

test.before(async () => {
  try {
    await db.migrate();
    await db.run("DELETE FROM admin_users WHERE email_norm = 'inhaber@test.de'");
    await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'admin-login:%'");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  } catch {
    available = false;
  }
});

async function login(fields) {
  let r = await fetch(`${base}/admin/login`);
  const jar = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const tok = (await r.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
  r = await fetch(`${base}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, _csrf: tok }),
  });
  return r.status;
}

test('Notzugang gilt nur, solange kein Inhaber-Zugang existiert', async (t) => {
  if (!available) return t.skip('kein Postgres');
  await db.run("UPDATE admin_users SET active = false WHERE role = 'owner'");

  assert.strictEqual(await login({ email: '', password: 'notzugang-passwort' }), 302, 'ohne Inhaber: Notzugang funktioniert');

  const { values } = adminUsers.validate({ name: 'Inhaber Test', email: 'inhaber@test.de', role: 'owner', password: 'drei-zufaellige-woerter' });
  await adminUsers.create({ ...values, role: 'owner' }, 'drei-zufaellige-woerter');
  await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'admin-login:%'");

  assert.strictEqual(await login({ email: '', password: 'notzugang-passwort' }), 401, 'mit Inhaber: Notzugang abgeschaltet');
  await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'admin-login:%'");
  assert.strictEqual(await login({ email: 'inhaber@test.de', password: 'drei-zufaellige-woerter' }), 302, 'Inhaber mit E-Mail und Passwort kommt hinein');
  await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'admin-login:%'");
  assert.strictEqual(await login({ email: 'inhaber@test.de', password: 'falsch' }), 401);

  // Aufräumen, damit andere Tests weiter den Notzugang nutzen können
  await db.run("DELETE FROM admin_users WHERE email_norm = 'inhaber@test.de'");
  await db.run("UPDATE admin_users SET active = true WHERE role = 'owner'");
});

test.after(async () => {
  if (server) server.close();
  await db.close().catch(() => {});
});
