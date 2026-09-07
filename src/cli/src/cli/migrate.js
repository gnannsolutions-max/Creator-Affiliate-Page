'use strict';

// Legt fehlende Tabellen an. Idempotent – läuft bei jedem Netlify-Deploy als
// Build-Command und lässt sich lokal mit `npm run migrate` aufrufen.
//
// Wichtig: Dieses Skript beendet sich IMMER mit Erfolg. Wenn beim Build noch
// keine Datenbank verbunden oder eine Einstellung nicht gesetzt ist, soll der
// Deploy trotzdem durchlaufen – die Anwendung zeigt dann eine Seite, die
// erklärt, was fehlt, und legt das Schema beim ersten Aufruf selbst an.
// Ein abgebrochener Build würde stattdessen gar keine Seite veröffentlichen.

async function main() {
  const config = require('../config');
  if (!config.isConfigured) {
    console.warn('Migration übersprungen – es fehlen noch Einstellungen:');
    config.setupErrors.forEach((e) => console.warn(`  - ${e.name}`));
    console.warn('Die Seite wird trotzdem veröffentlicht und erklärt dort, was zu tun ist.');
    return;
  }

  const db = require('../db');
  try {
    await db.migrate();
    console.log('Schema ist aktuell.');
  } catch (err) {
    console.warn(`Migration übersprungen: ${err.message}`);
    console.warn('Die Tabellen werden beim ersten Aufruf der Anwendung angelegt.');
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch((err) => {
  console.warn(`Migration übersprungen: ${err.message}`);
});
