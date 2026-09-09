'use strict';

const db = require('../db');
const { parseSalesCsv } = require('../lib/csv');

const BATCH_SIZE = 500;

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

module.exports = { importSalesCsv };
