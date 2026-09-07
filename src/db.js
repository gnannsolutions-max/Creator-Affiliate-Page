'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

/**
 * Woher die Verbindungszeichenfolge kommt.
 *
 * 1. NETLIFY_DATABASE_URL oder DATABASE_URL, falls von Hand gesetzt.
 * 2. Sonst über das Paket `@netlify/database`. Die von Netlify verwaltete
 *    Datenbank stellt keine Umgebungsvariable bereit, sondern liefert die
 *    Zugangsdaten zur Laufzeit – und zwar automatisch passend zum jeweiligen
 *    Zweig (Produktion beim Produktions-Deploy, eine Kopie bei Vorschauen).
 *
 * Der Import passiert absichtlich erst beim ersten Zugriff und asynchron:
 * So startet die Anwendung auch dann, wenn das Paket fehlt, und meldet den
 * Fehler dort, wo er hingehört – bei der Datenbankabfrage.
 */
async function resolveConnectionString() {
  if (config.databaseUrl) return config.databaseUrl;

  let mod;
  try {
    mod = await import('@netlify/database');
  } catch (err) {
    throw new Error(
      `Keine Datenbankverbindung: weder NETLIFY_DATABASE_URL/DATABASE_URL gesetzt noch @netlify/database verfügbar (${err.message}).`
    );
  }
  const get = mod.getConnectionString || (mod.default && mod.default.getConnectionString);
  if (typeof get !== 'function') {
    throw new Error('@netlify/database liefert kein getConnectionString().');
  }
  const value = await get();
  if (!value) throw new Error('@netlify/database lieferte eine leere Verbindungszeichenfolge.');
  return value;
}

// In einer Serverless-Function lebt jede Instanz nur kurz und bearbeitet genau
// eine Anfrage – ein großer Pool bringt nichts und verbraucht nur Verbindungen
// auf der Datenbankseite. Deshalb: eine Verbindung im Serverless-Betrieb,
// ein kleiner Pool beim klassischen Serverstart.
let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = resolveConnectionString()
      .then((connectionString) => {
        const ssl =
          process.env.DATABASE_SSL === 'true' ||
          (process.env.DATABASE_SSL !== 'false' &&
            /neon\.tech|netlify|sslmode=require/.test(connectionString));
        const p = new Pool({
          connectionString,
          max: config.isServerless ? 1 : 5,
          idleTimeoutMillis: config.isServerless ? 5_000 : 30_000,
          connectionTimeoutMillis: 10_000,
          ssl: ssl ? { rejectUnauthorized: false } : undefined,
        });
        p.on('error', (err) => console.error('Postgres-Pool-Fehler:', err.message));
        return p;
      })
      .catch((err) => {
        poolPromise = null; // beim nächsten Versuch neu auflösen
        throw err;
      });
  }
  return poolPromise;
}

async function query(text, params) {
  const pool = await getPool();
  return pool.query(text, params);
}

/** Alle Zeilen. */
async function many(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/** Erste Zeile oder null. */
async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] ?? null;
}

/** Für INSERT/UPDATE/DELETE; liefert rowCount und ggf. RETURNING-Zeilen. */
async function run(text, params = []) {
  const result = await query(text, params);
  return { rowCount: result.rowCount, rows: result.rows };
}

/**
 * Interaktive Transaktion. Der Callback bekommt einen Client mit denselben
 * Hilfsmethoden; bei einem Fehler wird zurückgerollt.
 */
async function tx(fn) {
  const pool = await getPool();
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
 * Findet schema.sql. Auf Netlify bündelt esbuild den Quelltext zu einer Datei
 * unter netlify/functions/, wodurch __dirname nicht mehr auf src/ zeigt – die
 * Datei selbst kommt über `included_files` nach /var/task/src/.
 */
function schemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(process.cwd(), 'src', 'schema.sql'),
    path.join(config.root, 'src', 'schema.sql'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
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
  const ddl = fs.readFileSync(schemaPath(), 'utf8');
  const pool = await getPool();
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
  if (!poolPromise) return;
  const pending = poolPromise;
  poolPromise = null;
  try {
    const pool = await pending;
    await pool.end();
  } catch {
    /* Verbindung kam nie zustande – nichts zu schließen */
  }
}

module.exports = { getPool, many, one, run, tx, migrate, ensureSchema, log, close };
