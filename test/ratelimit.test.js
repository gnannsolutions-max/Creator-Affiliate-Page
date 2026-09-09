'use strict';

/**
 * Diese Tests laufen gegen ein echtes Postgres, weil die Sperre selbst in SQL
 * steckt: das Zurücksetzen beim Fensterwechsel, das Hochzählen bei Konflikt.
 * Eine Attrappe würde genau den Teil nicht prüfen, auf den es ankommt.
 *
 * Ohne erreichbare Datenbank werden die Tests übersprungen statt zu scheitern.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const rateLimit = require('../src/lib/ratelimit');

let available = false;

test('Vorbereitung: Tabelle anlegen', async (t) => {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS rate_limits (
      bucket       TEXT        PRIMARY KEY,
      hits         INTEGER     NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'test:%'");
    available = true;
  } catch (err) {
    t.skip(`Keine Datenbank erreichbar: ${err.message}`);
  }
});

test('zählt hoch und sperrt ab dem Limit', async (t) => {
  if (!available) return t.skip('keine Datenbank');
  const bucket = `test:zaehlen:${Date.now()}`;
  const opts = { limit: 3, windowSeconds: 60 };

  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await rateLimit.hit(bucket, opts));

  assert.deepStrictEqual(
    results.map((r) => r.allowed),
    [true, true, true, false, false],
    'die ersten drei Anfragen sind erlaubt, danach wird gesperrt'
  );
  assert.deepStrictEqual(results.map((r) => r.hits), [1, 2, 3, 4, 5]);
  assert.ok(results[3].retryAfter > 0 && results[3].retryAfter <= 60);
});

test('das Fenster läuft ab und der Zähler beginnt von vorn', async (t) => {
  if (!available) return t.skip('keine Datenbank');
  const bucket = `test:fenster:${Date.now()}`;
  const opts = { limit: 1, windowSeconds: 60 };

  assert.strictEqual((await rateLimit.hit(bucket, opts)).allowed, true);
  assert.strictEqual((await rateLimit.hit(bucket, opts)).allowed, false);

  // Fensterbeginn künstlich in die Vergangenheit setzen, statt zu warten.
  await db.run(
    "UPDATE rate_limits SET window_start = now() - interval '61 seconds' WHERE bucket = $1",
    [bucket]
  );

  const after = await rateLimit.hit(bucket, opts);
  assert.strictEqual(after.allowed, true, 'nach Ablauf des Fensters wieder erlaubt');
  assert.strictEqual(after.hits, 1, 'der Zähler beginnt bei eins');
});

test('clear() setzt den Zähler zurück', async (t) => {
  if (!available) return t.skip('keine Datenbank');
  const bucket = `test:clear:${Date.now()}`;
  const opts = { limit: 1, windowSeconds: 60 };

  await rateLimit.hit(bucket, opts);
  assert.strictEqual((await rateLimit.hit(bucket, opts)).allowed, false);
  await rateLimit.clear(bucket);
  assert.strictEqual((await rateLimit.hit(bucket, opts)).allowed, true);
});

test('Schlüssel stören sich nicht gegenseitig', async (t) => {
  if (!available) return t.skip('keine Datenbank');
  const stamp = Date.now();
  const opts = { limit: 1, windowSeconds: 60 };

  await rateLimit.hit(`test:a:${stamp}`, opts);
  assert.strictEqual((await rateLimit.hit(`test:a:${stamp}`, opts)).allowed, false);
  assert.strictEqual(
    (await rateLimit.hit(`test:b:${stamp}`, opts)).allowed,
    true,
    'ein anderer Schlüssel hat sein eigenes Fenster'
  );
});

test('gleichzeitige Anfragen werden nicht doppelt gezählt oder verschluckt', async (t) => {
  if (!available) return t.skip('keine Datenbank');
  const bucket = `test:parallel:${Date.now()}`;
  const opts = { limit: 5, windowSeconds: 60 };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => rateLimit.hit(bucket, opts))
  );
  const allowed = results.filter((r) => r.allowed).length;
  assert.strictEqual(allowed, 5, 'genau fünf Anfragen kommen durch, auch bei Gleichzeitigkeit');
  assert.deepStrictEqual(
    results.map((r) => r.hits).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'jede Anfrage bekommt einen eigenen Zählerstand'
  );
});

test('clientIp liest die Adresse aus x-forwarded-for', () => {
  assert.strictEqual(
    rateLimit.clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '10.0.0.1' }),
    '203.0.113.7'
  );
  assert.strictEqual(rateLimit.clientIp({ headers: {}, ip: '198.51.100.3' }), '198.51.100.3');
  assert.strictEqual(rateLimit.clientIp({ headers: {} }), 'unbekannt');
});

test('Aufräumen', async () => {
  if (available) {
    await db.run("DELETE FROM rate_limits WHERE bucket LIKE 'test:%'");
    await db.close();
  }
});
