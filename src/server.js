'use strict';

// Klassischer Serverstart – für die lokale Entwicklung und für jeden Host,
// der einen dauerhaften Prozess ausführt. Auf Netlify wird stattdessen
// netlify/functions/app.js verwendet.

const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { buildSnapshot, needsSafetyRun } = require('./services/snapshot');
const { localDate } = require('./lib/dates');
const woo = require('./lib/woo');
const { syncWooOrders } = require('./services/syncWoo');

async function main() {
  await db.migrate();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`${config.program.name} läuft auf ${config.baseUrl}`);
    console.log(`Sicherheitsläufe: ${config.refresh.label} (${config.refresh.timezone})`);
    if (!config.mail.host) {
      console.log('Kein SMTP konfiguriert – Nachrichten stehen im Adminbereich unter /admin/mails.');
    }
  });

  // Ein Cron-Eintrag je Slot. Wie auf Netlify läuft der Sicherheitslauf nur,
  // wenn seit dem letzten Upload kein Stand erzeugt wurde.
  for (const slot of config.refresh.slots) {
    cron.schedule(
      `${slot.minute} ${slot.hour} * * *`,
      async () => {
        try {
          let synced = false;
          if (woo.isConfigured()) {
            try {
              const r = await syncWooOrders({ actor: 'cron' });
              synced = r.ok;
            } catch (err) {
              console.error('WooCommerce-Abgleich fehlgeschlagen:', err.message);
            }
          }
          const check = synced ? { needed: true, reason: 'WooCommerce' } : await needsSafetyRun(localDate());
          if (!check.needed) {
            console.log(`[${new Date().toISOString()}] Sicherheitslauf ${slot.label} übersprungen: ${check.reason}`);
            return;
          }
          const result = await buildSnapshot({ triggeredBy: 'cron', slot: slot.label });
          console.log(
            `[${new Date().toISOString()}] Snapshot ${result.runId} (${slot.label}): ${result.creators} Creator, ${result.orders} Bestellungen.`
          );
        } catch (err) {
          console.error('Snapshot fehlgeschlagen:', err);
        }
      },
      { timezone: config.refresh.timezone }
    );
  }

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
