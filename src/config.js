'use strict';

const path = require('path');
require('dotenv').config();

const root = path.resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

// Netlify setzt NETLIFY=true in Builds und Functions.
const isServerless = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Fehlende oder unbrauchbare Einstellungen werden gesammelt statt sofort
// geworfen. Ein Absturz beim Start wäre auf Netlify eine nichtssagende
// Fehlerseite; stattdessen zeigt die Anwendung eine Seite, die genau benennt,
// was noch fehlt. Der Build soll daran ebenfalls nicht scheitern.
const setupErrors = [];

function required(name, fallback, hint) {
  const value = process.env[name] || fallback;
  if (!value) {
    setupErrors.push({ name, hint });
    return '';
  }
  return value;
}

// Verbindung zur Datenbank.
//
// Die von Netlify verwaltete Datenbank stellt KEINE Umgebungsvariable bereit –
// die Zugangsdaten kommen zur Laufzeit über das Paket `@netlify/database`
// (siehe src/db.js). Eine ausdrücklich gesetzte Variable hat trotzdem Vorrang,
// damit die Anwendung auch gegen jeden anderen Postgres läuft.
const databaseUrl =
  process.env.NETLIFY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  (isProd || isServerless ? '' : 'postgres://postgres@127.0.0.1:5433/creator_affiliate');

// Nur wenn weder eine Variable gesetzt ist noch Netlify die Datenbank stellt,
// fehlt wirklich etwas.
if (!databaseUrl && !isServerless) {
  setupErrors.push({
    name: 'DATABASE_URL',
    hint: 'Verbindungszeichenfolge zu einem Postgres eintragen. Auf Netlify wird sie nicht gebraucht – dort liefert die eingebaute Datenbank sie selbst.',
  });
}

const config = {
  root,
  isProd,
  isServerless,
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || process.env.URL || 'http://localhost:3000').replace(/\/+$/, ''),

  databaseUrl,
  // Neon und die meisten gehosteten Anbieter verlangen TLS, ein lokales Postgres nicht.
  databaseSsl:
    process.env.DATABASE_SSL === 'true' ||
    (process.env.DATABASE_SSL !== 'false' && /neon\.tech|sslmode=require/.test(databaseUrl)),

  sessionSecret: required(
    'SESSION_SECRET',
    isProd ? '' : 'dev-secret-nicht-fuer-produktion',
    'Zufallswert mit mindestens 32 Zeichen. Erzeugen z. B. auf einer Passwort-Generator-Seite oder mit: openssl rand -hex 32'
  ),
  adminPassword: required(
    'ADMIN_PASSWORD',
    isProd ? '' : 'admin',
    'Dein Passwort für den Adminbereich, mindestens 12 Zeichen.'
  ),
  adminName: process.env.ADMIN_NAME || 'Admin',
  // Adresse für interne Benachrichtigungen (neue Bewerbung). Ohne Eintrag
  // verschickt das Portal keine – die Bewerbung steht dann nur im Adminbereich.
  notifyEmail: process.env.NOTIFY_EMAIL || '',

  program: {
    name: process.env.PROGRAM_NAME || 'Creator Programm',
    brand: process.env.PROGRAM_BRAND || 'Creator Programm',
    supportEmail: process.env.SUPPORT_EMAIL || 'partner@example.de',
    defaultCommissionRate: Number(process.env.DEFAULT_COMMISSION_RATE || 15),
    defaultCustomerDiscount: Number(process.env.DEFAULT_CUSTOMER_DISCOUNT || 10),
    currency: process.env.CURRENCY || 'EUR',
  },

  refresh: {
    // Stunde und Minute in der Programm-Zeitzone. Auf Netlify läuft der
    // Scheduler stündlich in UTC und prüft gegen diese Werte – dadurch bleibt
    // die Uhrzeit über die Sommerzeitumstellung hinweg korrekt.
    hour: Number(process.env.REFRESH_HOUR ?? 11),
    minute: Number(process.env.REFRESH_MINUTE ?? 0),
    timezone: process.env.REFRESH_TIMEZONE || 'Europe/Berlin',
    // Schutz gegen unbefugtes Auslösen von /api/refresh-snapshot
    secret: process.env.REFRESH_SECRET || '',
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Creator Programm <noreply@example.de>',
    // Ohne SMTP: lokal in eine Datei, serverless nur in die Konsole
    outbox: path.join(root, 'data', 'outbox'),
  },

  // Version der Teilnahmebedingungen. Bei jeder inhaltlichen Änderung hochzählen –
  // die zugestimmte Version wird pro Creator gespeichert.
  termsVersion: '2026-09-01',

  loginTokenTtlMinutes: 30,
  sessionTtlDays: 30,
};

config.refresh.label = `${String(config.refresh.hour).padStart(2, '0')}:${String(
  config.refresh.minute
).padStart(2, '0')} Uhr`;

if (isProd) {
  if (config.sessionSecret && config.sessionSecret.length < 32) {
    setupErrors.push({
      name: 'SESSION_SECRET',
      hint: 'Zu kurz – im Livebetrieb sind mindestens 32 Zeichen nötig.',
    });
  }
  if (config.adminPassword && config.adminPassword.length < 12) {
    setupErrors.push({
      name: 'ADMIN_PASSWORD',
      hint: 'Zu kurz – im Livebetrieb sind mindestens 12 Zeichen nötig.',
    });
  }
}

config.setupErrors = setupErrors;
config.isConfigured = setupErrors.length === 0;

module.exports = config;
