'use strict';

// Tägliche Aktualisierung des Creator-Dashboards.
//
// Netlify führt Scheduled Functions ausschließlich nach UTC aus. Ein fester
// UTC-Zeitpunkt würde durch die Sommerzeit zweimal im Jahr um eine Stunde
// verrutschen. Deshalb läuft diese Function stündlich und prüft selbst, ob in
// der Programm-Zeitzone gerade die konfigurierte Stunde ist. Zusätzlich wird
// geprüft, ob heute schon ein Lauf stattgefunden hat – so bleibt ein doppelter
// Aufruf folgenlos.

const config = require('../../src/config');
const db = require('../../src/db');
const { buildSnapshot, hasRunToday } = require('../../src/services/snapshot');
const { localDate, localHourMinute } = require('../../src/lib/dates');

exports.handler = async () => {
  const now = new Date();
  const { hour } = localHourMinute(now);
  const day = localDate(now);

  if (hour !== config.refresh.hour) {
    return json(200, {
      skipped: true,
      reason: `Aktuell ${hour}:00 in ${config.refresh.timezone}, geplant ist ${config.refresh.label}.`,
    });
  }

  await db.ensureSchema();

  if (await hasRunToday(day)) {
    return json(200, { skipped: true, reason: `Für ${day} liegt bereits ein Lauf vor.` });
  }

  try {
    const result = await buildSnapshot({ triggeredBy: 'cron' });
    console.log(`Snapshot ${result.runId}: ${result.creators} Creator, ${result.orders} Bestellungen.`);
    return json(200, { ok: true, day, ...result });
  } catch (err) {
    console.error('Snapshot fehlgeschlagen:', err);
    return json(500, { ok: false, error: err.message });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
