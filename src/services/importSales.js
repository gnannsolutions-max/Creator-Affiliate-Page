'use strict';

const crypto = require('crypto');
const db = require('../db');
const { parseSalesCsv, parseCreatorSharesCsv, parseCsv, detectFormat, normalizeName } = require('../lib/csv');
const { localDate } = require('../lib/dates');

const BATCH_SIZE = 500;

/** Fingerabdruck einer Datei – unabhängig von Zeilenenden und BOM. */
function contentHash(text) {
  const norm = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

/** Wurde genau dieser Inhalt für diese Marke schon einmal importiert? */
async function findDuplicateImport(hash, brandId) {
  return db.one(
    `SELECT id, filename, created_at FROM imports
      WHERE content_hash = $1 AND brand_id = $2 ORDER BY id DESC LIMIT 1`,
    [hash, brandId]
  );
}

/**
 * Importiert eine Umsatz-CSV in die Rohdaten-Tabelle `sales`.
 * Bestehende Bestellungen werden anhand der Bestellnummer aktualisiert
 * (wichtig für Retouren, die in einem späteren Export als "refunded" kommen).
 *
 * Der Import verändert NICHT, was Creator im Dashboard sehen – das passiert
 * erst beim nächsten Snapshot.
 */
async function importSalesCsv(text, { brandId, filename = 'upload.csv', actor = 'admin' } = {}) {
  if (!brandId) throw new Error('Ohne Marke lässt sich eine Bestellliste nicht zuordnen.');
  const parsed = parseSalesCsv(text);
  if (!parsed.rows.length && parsed.problems.length) {
    return { ok: false, problems: parsed.problems, mapping: parsed.mapping };
  }

  // Nur Codes DIESER Marke gelten. Ein Code aus einem anderen Shop darf hier
  // nicht zufällig treffen – die Shops vergeben ihre Codes unabhängig.
  const known = new Set(
    (
      await db.many('SELECT code_norm FROM creator_codes WHERE brand_id = $1', [brandId])
    ).map((r) => r.code_norm)
  );

  const unknownCodes = new Map();
  for (const row of parsed.rows) {
    if (!known.has(row.code_norm)) {
      unknownCodes.set(row.code_norm, (unknownCodes.get(row.code_norm) || 0) + 1);
    }
  }

  const result = await db.tx(async (t) => {
    const imp = await t.one(
      `INSERT INTO imports (filename, rows_total, uploaded_by, brand_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [filename, parsed.total, actor, brandId]
    );
    const importId = imp.id;

    let inserted = 0;
    let updated = 0;

    // In Blöcken einfügen: eine Anweisung pro 500 Zeilen statt pro Zeile.
    // xmax = 0 kennzeichnet in Postgres eine wirklich neu eingefügte Zeile,
    // alles andere ist ein Update durch ON CONFLICT.
    for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
      const chunk = parsed.rows.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = chunk.map((row, idx) => {
        const b = idx * 6;
        values.push(
          row.order_ref,
          row.code_norm,
          row.order_date,
          row.gross_amount,
          row.net_amount,
          row.status
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${
          chunk.length * 6 + 1
        }, $${chunk.length * 6 + 2})`;
      });
      values.push(importId, brandId);

      const res = await t.many(
        `INSERT INTO sales (order_ref, code_norm, order_date, gross_amount, net_amount, status, import_id, brand_id)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (brand_id, order_ref) DO UPDATE SET
           code_norm    = EXCLUDED.code_norm,
           order_date   = EXCLUDED.order_date,
           gross_amount = EXCLUDED.gross_amount,
           net_amount   = EXCLUDED.net_amount,
           status       = EXCLUDED.status,
           import_id    = EXCLUDED.import_id,
           updated_at   = now()
         RETURNING (xmax = 0) AS is_new`,
        values
      );

      for (const row of res) {
        if (row.is_new) inserted += 1;
        else updated += 1;
      }
    }

    await t.run(
      `UPDATE imports SET rows_inserted = $1, rows_updated = $2, rows_skipped = $3, unknown_codes = $4
        WHERE id = $5`,
      [
        inserted,
        updated,
        parsed.total - parsed.rows.length,
        JSON.stringify([...unknownCodes.entries()].map(([code, count]) => ({ code, count }))),
        importId,
      ]
    );

    return { importId, inserted, updated };
  });

  await db.log(
    actor,
    'import.sales',
    filename,
    `${result.inserted} neu, ${result.updated} aktualisiert (Marke ${brandId})`
  );

  return {
    ok: true,
    importId: result.importId,
    total: parsed.total,
    inserted: result.inserted,
    updated: result.updated,
    skipped: parsed.total - parsed.rows.length,
    problems: parsed.problems,
    mapping: parsed.mapping,
    unknownCodes: [...unknownCodes.entries()].map(([code, count]) => ({ code, count })),
  };
}

/**
 * Importiert den Shop-Export mit Umsatz je Creator (Nettoumsatz, Beteiligung
 * in %, Creatorname). Jede Zeile wird zu einer Bestellung:
 *   - Bestellnummer: U<Import-Nr>-<Zeile>, weil die Datei keine hat
 *   - Datum: der Tag des Uploads (Programm-Zeitzone)
 *   - Creator: über den Namen aufgelöst – erst Klarname, dann Instagram-Handle
 *   - Provisionssatz: aus der Datei, steht an der Zeile
 *
 * Ohne Bestellnummer kann nichts „aktualisiert“ werden – alles ist neu. Genau
 * deshalb wird derselbe Dateiinhalt für dieselbe Marke nicht zweimal
 * angenommen, es sei denn, `force` ist gesetzt.
 */
async function importCreatorSharesCsv(
  text,
  { brandId, filename = 'upload.csv', actor = 'admin', force = false } = {}
) {
  if (!brandId) throw new Error('Ohne Marke lässt sich eine Umsatzliste nicht zuordnen.');
  const parsed = parseCreatorSharesCsv(text);
  if (!parsed.rows.length) {
    return {
      ok: false,
      kind: 'shares',
      problems: parsed.problems.length ? parsed.problems : ['Die Datei enthält keine verwertbaren Zeilen.'],
      mapping: parsed.mapping,
    };
  }

  const hash = contentHash(text);
  const dup = await findDuplicateImport(hash, brandId);
  if (dup && !force) {
    return {
      ok: false,
      kind: 'shares',
      duplicate: dup,
      problems: [
        `Genau diese Datei wurde bereits importiert (Import #${dup.id}, „${dup.filename}“). ` +
          'Ein zweiter Import würde alle Umsätze verdoppeln. Wenn das wirklich gewollt ist, ' +
          'setze beim Hochladen den Haken „Trotzdem importieren“.',
      ],
      mapping: parsed.mapping,
    };
  }

  // Alle Namen auf einmal auflösen. Treffer über den Klarnamen haben Vorrang,
  // dann über das Instagram-Handle. Gibt es zwei Creator mit demselben Namen,
  // bleibt die Zeile unzugeordnet – lieber nachfragen als dem Falschen Geld
  // gutschreiben.
  const creators = await db.many(
    `SELECT id, full_name, instagram, status FROM creators
      WHERE status IN ('approved','paused','pending')`
  );
  const byName = new Map();
  const byHandle = new Map();
  for (const c of creators) {
    const n = normalizeName(c.full_name);
    if (n) byName.set(n, byName.has(n) ? 'ambiguous' : c);
    const h = normalizeName(c.instagram);
    if (h) byHandle.set(h, byHandle.has(h) ? 'ambiguous' : c);
  }

  const unknown = new Map();
  const ambiguous = new Map();
  const matched = new Map();
  for (const row of parsed.rows) {
    const hit = byName.get(row.name_norm) || byHandle.get(row.name_norm) || null;
    if (hit === 'ambiguous') {
      row.creator_id = null;
      ambiguous.set(row.creator_name, (ambiguous.get(row.creator_name) || 0) + 1);
    } else if (hit) {
      row.creator_id = hit.id;
      matched.set(hit.id, { name: hit.full_name, rows: (matched.get(hit.id)?.rows || 0) + 1 });
    } else {
      row.creator_id = null;
      unknown.set(row.creator_name, (unknown.get(row.creator_name) || 0) + 1);
    }
  }

  const today = localDate();
  const result = await db.tx(async (t) => {
    const imp = await t.one(
      `INSERT INTO imports (filename, rows_total, uploaded_by, brand_id, content_hash, import_kind)
       VALUES ($1, $2, $3, $4, $5, 'shares') RETURNING id`,
      [filename, parsed.total, actor, brandId, hash]
    );
    const importId = imp.id;
    let inserted = 0;

    for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
      const chunk = parsed.rows.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = chunk.map((row, idx) => {
        const b = idx * 6;
        values.push(
          `U${importId}-${i + idx + 1}`,
          row.net_amount,
          row.net_amount,
          row.creator_id,
          row.commission_rate,
          row.creator_name
        );
        const n = chunk.length * 6;
        return `($${b + 1}, '', $${n + 1}, $${b + 2}, $${b + 3}, 'confirmed', $${n + 2}, $${n + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
      });
      values.push(today, importId, brandId);
      const res = await t.many(
        `INSERT INTO sales (order_ref, code_norm, order_date, gross_amount, net_amount, status,
                            import_id, brand_id, creator_id, commission_rate, creator_name)
         VALUES ${placeholders.join(', ')}
         RETURNING id`,
        values
      );
      inserted += res.length;
    }

    const unknownList = [...unknown.entries()].map(([name, count]) => ({ name, count }));
    const ambiguousList = [...ambiguous.entries()].map(([name, count]) => ({ name, count, ambiguous: true }));
    await t.run(
      `UPDATE imports SET rows_inserted = $1, rows_updated = 0, rows_skipped = $2, unknown_names = $3
        WHERE id = $4`,
      [inserted, parsed.total - parsed.rows.length, JSON.stringify([...unknownList, ...ambiguousList]), importId]
    );
    return { importId, inserted };
  });

  await db.log(
    actor,
    'import.shares',
    filename,
    `${result.inserted} Umsatzzeilen, ${matched.size} Creator zugeordnet, ${unknown.size} unbekannte Namen (Marke ${brandId})`
  );

  return {
    ok: true,
    kind: 'shares',
    importId: result.importId,
    total: parsed.total,
    inserted: result.inserted,
    updated: 0,
    skipped: parsed.total - parsed.rows.length,
    problems: parsed.problems,
    mapping: parsed.mapping,
    headerless: parsed.headerless,
    day: today,
    matched: [...matched.values()],
    unknownNames: [...unknown.entries()].map(([name, count]) => ({ name, count })),
    ambiguousNames: [...ambiguous.entries()].map(([name, count]) => ({ name, count })),
    unknownCodes: [],
  };
}

/**
 * Erkennt das Format der Datei und ruft den passenden Import auf.
 * Der Shop-Export (Umsatz je Creator) ist der Normalfall; die alte
 * Bestellliste mit Codes bleibt weiter möglich.
 */
async function importAnyCsv(text, opts = {}) {
  const { header } = parseCsv(text);
  const format = detectFormat(header);
  if (format === 'orders') return { ...(await importSalesCsv(text, opts)), kind: 'orders' };
  // Alles andere – auch Dateien ohne Überschriften – versucht der Creator-Import.
  return importCreatorSharesCsv(text, opts);
}

module.exports = { importSalesCsv, importCreatorSharesCsv, importAnyCsv, contentHash };
