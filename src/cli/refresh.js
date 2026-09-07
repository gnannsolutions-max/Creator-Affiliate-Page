'use strict';

// Erzeugt den Dashboard-Stand manuell:  node src/cli/refresh.js

const db = require('../db');
const { buildSnapshot } = require('../services/snapshot');

buildSnapshot({ triggeredBy: 'cli' })
  .then(async (result) => {
    console.log(`Snapshot ${result.runId}: ${result.creators} Creator, ${result.orders} Bestellungen.`);
    await db.close();
  })
  .catch(async (err) => {
    console.error('Snapshot fehlgeschlagen:', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
