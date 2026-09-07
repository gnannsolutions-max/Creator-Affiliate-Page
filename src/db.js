'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

// In einer Serverless-Function lebt jede Instanz nur kurz und bearbeitet genau
// eine Anfrage – ein großer Pool bringt nichts und verbraucht nur Verbindungen
// auf der Datenbankseite. Deshalb: eine Verbindung im Serverless-Betrieb,
// ein kleiner Pool beim klassischen Serverstart.
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.isServerless ? 1 : 5,
  idleTimeoutMillis: config.isServerless ? 5_000 : 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => console.error('Postgres-Pool-Fehler:', err.message));

/** Alle Zeilen. */
async function many(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

/** Erste Zeile oder null. */
async function one(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] ?? null;
}

/** Für INSERT/UPDATE/DELETE; liefert rowCount und ggf. RETURNING-Zeilen. */
async function run(text, params = []) {
  const result = await pool.query(text, params);
  return { rowCount: result.rowCount, rows: result.rows };
}

/**
 * Interaktive Transaktion. Der Callback bekommt einen Client mit denselben
 * Hilfsmethoden; bei einem Fehler wird zurückgerollt.
 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const api = {
      many: async (t, p = []) => (await client.query(t, p)).rows,
      one: async (t, p = []) => (await client.query(t, p)).rows[0] ?? null,
      run: async (t, p = []) => {
        const r = await client.query(t, p);
        return { rowCount: r.rowCount, rows: r.rows };
      },
    };
    const result = await fn(api);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Verbindung schon tot – der ursprüngliche Fehler zählt */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Legt fehlende Tabellen an. Idempotent und darf beliebig oft laufen.
 *
 * Der Advisory Lock ist wichtig: Auf Netlify können mehrere kalte
 * Function-Instanzen gleichzeitig starten, und paralleles
 * "CREATE TABLE IF NOT EXISTS" läuft in Postgres in einen Fehler im
 * Systemkatalog. Mit dem Lock migriert immer nur eine Instanz, die anderen
 * warten kurz und finden die Tabellen dann vor.
 */
async function migrate() {
  const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(873214001)');
    await client.query(ddl);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(873214001)');
    } catch {
      /* Verbindung schon weg – der Lock fällt mit der Session ohnehin */
    }
    client.release();
  }
}

/**
 * Stellt sicher, dass das Schema existiert – einmal pro Prozess.
 *
 * Der Normalfall ist eine einzige, sehr billige Abfrage: Wenn die Tabelle
 * `creators` existiert, passiert nichts weiter. Nur beim allerersten Start
 * gegen eine leere Datenbank läuft die Migration. Dadurch kostet das auf
 * Netlify praktisch nichts pro Kaltstart, macht die Anwendung aber
 * selbstheilend, falls die Migration beim Deploy nicht laufen konnte.
 */
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const row = await one("SELECT to_regclass('public.creators') AS t");
      if (!row?.t) await migrate();
    })().catch((err) => {
      schemaReady = null; // beim nächsten Request neu versuchen
      throw err;
    });
  }
  return schemaReady;
}

async function log(actor, action, subject, detail) {
  try {
    await run('INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1, $2, $3, $4)', [
      actor,
      action,
      subject || null,
      detail || null,
    ]);
  } catch (err) {
    // Das Protokoll darf einen fachlichen Vorgang nie zum Scheitern bringen.
    console.error('audit_log fehlgeschlagen:', err.message);
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, many, one, run, tx, migrate, ensureSchema, log, close };
