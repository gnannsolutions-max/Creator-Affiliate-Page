'use strict';

// Import einer Umsatz-CSV von der Kommandozeile:
//   node src/cli/import.js umsaetze-2026-09-04.csv

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { importSalesCsv } = require('../services/importSales');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Aufruf: node src/cli/import.js <datei.csv>');
    process.exit(1);
  }

  const text = fs.readFileSync(file, 'utf8');
  const result = await importSalesCsv(text, { filename: path.basename(file), actor: 'cli' });

  if (!result.ok) {
    console.error('Import fehlgeschlagen:');
    result.problems.forEach((p) => console.error('  -', p));
    process.exit(1);
  }

  console.log(
    `${result.inserted} neu, ${result.updated} aktualisiert, ${result.skipped} übersprungen (${result.total} Zeilen).`
  );
  if (result.unknownCodes.length) {
    console.log('Unbekannte Codes:', result.unknownCodes.map((u) => `${u.code} (${u.count})`).join(', '));
  }
  result.problems.slice(0, 20).forEach((p) => console.log('  !', p));
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error(err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
