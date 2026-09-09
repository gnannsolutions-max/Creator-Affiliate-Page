'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/**
 * Hängt an Stylesheet-Adressen eine Kennung aus dem Dateiinhalt an, also
 * /landing.css?v=6f1a2b3c.
 *
 * Grund: Der Dateiname bleibt bei jeder Änderung gleich. Ein Browser, der die
 * Datei schon einmal geholt hat, benutzt weiter seine Kopie – und zeigt dann
 * neues HTML mit altem Aussehen. Genau das ist passiert: Die Logoleiste stand
 * untereinander in Originalgröße, weil die Regeln dafür in der alten Kopie
 * fehlten. Ändert sich der Inhalt, ändert sich die Kennung, und damit ist es
 * für den Browser eine andere Adresse.
 *
 * Die Kennung wird einmal beim Start berechnet und gemerkt.
 */

// Auf Netlify bündelt esbuild den Quelltext, __dirname zeigt dann nicht mehr
// nach src/. Deshalb dieselbe Suche wie bei den Vorlagen.
const CANDIDATES = [
  path.join(__dirname, '..', '..', 'public'),
  path.join(process.cwd(), 'public'),
  path.join(config.root, 'public'),
  '/var/task/public',
];

const cache = new Map();

function fingerprint(file) {
  for (const dir of CANDIDATES) {
    try {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      return crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 8);
    } catch {
      // Nächsten Ort versuchen.
    }
  }
  return null;
}

/**
 * @param {string} pathname z. B. '/landing.css'
 * @returns {string} dieselbe Adresse mit Kennung, oder unverändert, wenn die
 *   Datei nicht gefunden wurde – dann fehlt nur die Kennung, nichts bricht.
 */
function asset(pathname) {
  if (cache.has(pathname)) return cache.get(pathname);
  const hash = fingerprint(pathname.replace(/^\//, ''));
  const url = hash ? `${pathname}?v=${hash}` : pathname;
  cache.set(pathname, url);
  return url;
}

module.exports = { asset };
