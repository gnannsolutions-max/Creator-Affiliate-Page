'use strict';

// Zweiter UTC-Termin für den Vormittags-Slot (09:30 UTC = 10:30 Uhr in der
// Winterzeit). Gleicher Ablauf wie snapshot.js – die Function prüft selbst,
// ob in Europe/Berlin gerade ein Slot ist, und tut sonst nichts.
// Erklärung der Termine in netlify.toml.

module.exports = require('./snapshot');
