'use strict';

// Die komplette Express-App als eine Netlify Function.
// Alle Anfragen außer den statischen Dateien aus public/ landen hier
// (siehe Redirect in netlify.toml).

const serverless = require('serverless-http');
const { createApp } = require('../../src/app');

// Statische Dateien liefert das Netlify-CDN aus, nicht Express.
// Die Schemaprüfung kostet pro Kaltstart eine einzige Abfrage und legt die
// Tabellen nur an, wenn sie fehlen – falls die Migration beim Deploy nicht
// laufen konnte, heilt sich die Anwendung damit selbst.
const app = createApp({
  serveStatic: false,
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
});

const handler = serverless(app, {
  request(request, event) {
    // Netlify liefert die echte Client-IP nur im Header mit.
    request.headers['x-forwarded-for'] =
      request.headers['x-forwarded-for'] || event.headers?.['x-nf-client-connection-ip'] || '';
  },
});

exports.handler = handler;
