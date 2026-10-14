'use strict';

// Verbindung zur Datenbank des Shops (MariaDB/MySQL).
//
// Der Shop stellt einen direkten Lesezugriff auf seine Datenbank. Daraus holt
// das Portal die Bestellungen selbst, statt auf CSV-Uploads zu warten. Die
// Zugangsdaten liegen ausschließlich in den Umgebungsvariablen
// SHOP_DB_HOST / SHOP_DB_PORT / SHOP_DB_USER / SHOP_DB_PASSWORD / SHOP_DB_NAME.
//
// Jede Verbindung wird nur für einen Aufruf geöffnet und danach geschlossen –
// eine Netlify Function lebt nicht lange genug, um einen Pool zu lohnen.

const mysql = require('mysql2/promise');

function settings() {
  return {
    host: process.env.SHOP_DB_HOST || '',
    port: Number(process.env.SHOP_DB_PORT || 3306),
    user: process.env.SHOP_DB_USER || '',
    password: process.env.SHOP_DB_PASSWORD || '',
    database: process.env.SHOP_DB_NAME || '',
  };
}

function isConfigured() {
  const s = settings();
  return Boolean(s.host && s.user && s.password);
}

async function withConnection(fn, { database } = {}) {
  const s = settings();
  if (!s.host || !s.user || !s.password) {
    throw new Error('Shop-Datenbank nicht konfiguriert: SHOP_DB_HOST, SHOP_DB_USER und SHOP_DB_PASSWORD fehlen.');
  }
  const conn = await mysql.createConnection({
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: database || s.database || undefined,
    connectTimeout: 8000,
    dateStrings: true,
    // Shop-Server liefern oft kein TLS; mysql2 verhandelt nur, wenn ssl gesetzt ist.
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Nur lesen: alles, was kein SELECT/SHOW/DESCRIBE/EXPLAIN ist, wird abgewiesen. */
function assertReadOnly(sql) {
  if (!/^\s*(select|show|describe|desc|explain)\b/i.test(sql)) {
    throw new Error('Nur Leseabfragen sind erlaubt.');
  }
}

async function query(sql, params = [], opts = {}) {
  assertReadOnly(sql);
  return withConnection(async (conn) => {
    const [rows] = await conn.query(sql, params);
    return rows;
  }, opts);
}

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

/**
 * Überblick für die Diagnose-Seite: Datenbanken, Tabellen mit Zeilenzahl,
 * Spalten und ein paar Beispielzeilen – genug, um die Bestelltabelle und die
 * Spalten für Creator, Prozentsatz und Nettoumsatz zu erkennen.
 */
async function inspect({ database = null, sampleRows = 3, maxTables = 60 } = {}) {
  const s = settings();
  return withConnection(async (conn) => {
    const [dbRows] = await conn.query('SHOW DATABASES');
    const databases = dbRows.map((r) => Object.values(r)[0]).filter((d) => !SYSTEM_DBS.has(d));
    const target = database || s.database || (databases.length === 1 ? databases[0] : null);
    if (!target) return { databases, database: null, tables: [] };

    const [tableRows] = await conn.query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS approx_rows, TABLE_COMMENT AS comment
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [target]
    );
    const tables = [];
    for (const t of tableRows.slice(0, maxTables)) {
      const [cols] = await conn.query(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS keytype
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [target, t.name]
      );
      let sample = [];
      let sampleError = null;
      try {
        const [rows] = await conn.query(
          `SELECT * FROM \`${target}\`.\`${t.name}\` ORDER BY 1 DESC LIMIT ${Number(sampleRows)}`
        );
        sample = rows;
      } catch (err) {
        sampleError = err.message;
      }
      tables.push({ ...t, columns: cols, sample, sampleError });
    }
    return { databases, database: target, tables, truncated: tableRows.length > maxTables };
  });
}

module.exports = { settings, isConfigured, withConnection, query, inspect };
