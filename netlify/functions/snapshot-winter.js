'use strict';

// Zweiter Termin für die tägliche Aktualisierung (10:00 UTC = 11:00 Uhr in der
// Winterzeit). Gleicher Ablauf wie snapshot.js – die Function prüft selbst, ob
// in Europe/Berlin gerade die konfigurierte Stunde ist, und tut sonst nichts.
// Erklärung der zwei Termine in netlify.toml.

module.exports = require('./snapshot');
