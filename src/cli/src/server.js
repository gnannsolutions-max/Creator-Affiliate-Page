'use strict';

// Klassischer Serverstart – für die lokale Entwicklung und für jeden Host,
// der einen dauerhaften Prozess ausführt. Auf Netlify wird stattdessen
// netlify/functions/app.js verwendet.

const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { buildSnapshot } = require('./services/snapshot');

async function main() {
  await db.migrate();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`${config.program.name} läuft auf ${config.baseUrl}`);
    console.log(`Tägliche Aktualisierung: ${config.refresh.label} (${config.refresh.timezone})`);
    if (!config.mail.host) {
      console.log('Kein SMTP konfiguriert – Nachrichten stehen im Adminbereich unter /admin/mails.');
    }
  });

  const expression = `${config.refresh.minute} ${config.refresh.hour} * * *`;
  cron.schedule(
    expression,
    async () => {
      try {
        const result = await buildSnapshot({ triggeredBy: 'cron' });
        console.log(
          `[${new Date().toISOString()}] Snapshot ${result.runId}: ${result.creators} Creator, ${result.orders} Bestellungen.`
        );
      } catch (err) {
        console.error('Snapshot fehlgeschlagen:', err);
      }
    },
    { timezone: config.refresh.timezone }
  );

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(async () => {
        await db.close().catch(() => {});
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});
