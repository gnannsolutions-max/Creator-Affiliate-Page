'use strict';

// Rendert die öffentlichen Seiten ohne Anmeldung einmal beim Build als
// statische HTML-Dateien nach public/. Netlify liefert vorhandene Dateien
// direkt vom CDN aus, bevor der Catch-all-Redirect zur Function greift –
// die Startseite, die Rechtstexte und jeder Bot-Aufruf dieser Adressen kosten
// dadurch keine Function-Laufzeit und keine Datenbankverbindung mehr.
//
// Bewusst NICHT vorgerendert: alles mit Formular, Login-Zustand oder Daten
// (Bewerbung, Login, Dashboard, Admin). Diese Seiten laufen weiter über die
// Function.
//
// Läuft nach der Migration als Build-Command (siehe netlify.toml) und lokal
// mit `npm run prerender`. Beendet sich wie migrate.js immer mit Erfolg,
// damit ein Deploy nicht an der Vorschau scheitert – dann übernimmt einfach
// die Function wie bisher.

const fs = require('fs');
const path = require('path');
const http = require('http');

const PAGES = [
  { route: '/', file: 'index.html' },
  { route: '/impressum', file: 'impressum/index.html' },
  { route: '/datenschutz', file: 'datenschutz/index.html' },
  { route: '/teilnahmebedingungen', file: 'teilnahmebedingungen/index.html' },
];

async function main() {
  const config = require('../config');
  if (!config.isConfigured) {
    console.warn('Vorrendern übersprungen – es fehlen noch Einstellungen:');
    config.setupErrors.forEach((e) => console.warn(`  - ${e.name}`));
    return;
  }

  const { createApp } = require('../app');
  // Ohne Schemaprüfung: Diese Seiten brauchen keine Datenbank, und der Build
  // soll auch dann durchlaufen, wenn sie gerade nicht erreichbar ist.
  const app = createApp({ serveStatic: false, autoMigrate: false });

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const publicDir = path.join(config.root, 'public');

  let written = 0;
  try {
    for (const page of PAGES) {
      const html = await fetchText(`http://127.0.0.1:${port}${page.route}`);
      if (!html) continue;
      const target = path.join(publicDir, page.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, html);
      written += 1;
      console.log(`Vorgerendert: ${page.route} -> public/${page.file} (${html.length} Bytes)`);
    }
  } finally {
    server.close();
  }
  console.log(`${written} von ${PAGES.length} Seiten statisch abgelegt.`);
}

function fetchText(url) {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`Übersprungen: ${url} antwortete mit ${res.statusCode}.`);
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', (err) => {
        console.warn(`Übersprungen: ${url} (${err.message}).`);
        resolve(null);
      });
  });
}

main().catch((err) => {
  console.warn('Vorrendern fehlgeschlagen – die Function liefert die Seiten weiter aus:', err.message);
});
