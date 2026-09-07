'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const auth = require('./lib/auth');
const format = require('./lib/format');
const dates = require('./lib/dates');

/**
 * Baut die Express-App. Bewusst ohne listen() und ohne Scheduler, damit
 * dieselbe App sowohl lokal als Server als auch auf Netlify als Function läuft.
 */
function createApp({ serveStatic = true, autoMigrate = true } = {}) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
    );
    next();
  });

  // Auf Netlify liefert das CDN /styles.css direkt aus dem publish-Verzeichnis.
  if (serveStatic) {
    app.use(express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  }

  // Grundvariablen für alle Views – bewusst ganz früh, damit auch die Fehler-
  // und Einrichtungsseite sie hat, wenn später etwas schiefgeht.
  app.use((req, res, next) => {
    res.locals.program = config.program;
    res.locals.baseUrl = config.baseUrl;
    res.locals.termsVersion = config.termsVersion;
    res.locals.creator = null;
    res.locals.admin = null;
    res.locals.nav = null;
    res.locals.title = '';
    res.locals.money = format.money;
    res.locals.moneyShort = format.moneyShort;
    res.locals.num = format.num;
    res.locals.percent = format.percent;
    res.locals.delta = format.delta;
    res.locals.statusLabel = format.statusLabel;
    res.locals.formatDateDe = dates.formatDateDe;
    res.locals.formatDateTimeDe = dates.formatDateTimeDe;
    next();
  });

  // Solange Pflichteinstellungen fehlen, beantwortet die Anwendung jede Anfrage
  // mit einer Seite, die genau benennt, was noch einzutragen ist. Das ist
  // deutlich hilfreicher als eine Absturzmeldung der Plattform.
  app.use((req, res, next) => {
    if (config.isConfigured || req.path === '/healthz') return next();
    res.status(503).render('setup', { errors: config.setupErrors });
  });

  app.get('/healthz', async (req, res) => {
    if (!config.isConfigured) {
      return res.status(503).json({
        ok: false,
        missing: config.setupErrors.map((e) => e.name),
        hint: 'Einstellungen fehlen – Details stehen auf der Startseite.',
      });
    }
    try {
      await db.one('SELECT 1 AS ok');
      res.json({ ok: true, time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // Schema beim ersten Aufruf einer kalten Instanz sicherstellen.
  if (autoMigrate && process.env.AUTO_MIGRATE !== 'false') {
    app.use(async (req, res, next) => {
      try {
        await db.ensureSchema();
        next();
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(auth.loadCreator);

  app.use((req, res, next) => {
    res.locals.creator = req.creator || null;
    next();
  });

  app.use('/admin', (req, res, next) => {
    res.locals.admin = { name: config.adminName };
    res.locals.creator = null;
    next();
  });

  app.use('/admin', require('./routes/admin'));
  app.use('/', require('./routes/creator'));
  app.use('/', require('./routes/public'));

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Seite nicht gefunden',
      heading: 'Seite nicht gefunden',
      message: 'Diese Adresse gibt es hier nicht.',
    });
  });

  app.use((err, req, res, _next) => {
    console.error(err);

    const isSize = err && (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large');
    // Verbindungsprobleme zur Datenbank sind der häufigste Betriebsfehler und
    // verdienen eine Meldung, mit der man etwas anfangen kann.
    const isDb = err && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '28P01', '3D000'].includes(err.code);

    // Die Fehlerseite darf niemals selbst scheitern, auch wenn der Fehler
    // auftrat, bevor die View-Variablen gesetzt waren.
    res.locals.program = res.locals.program || config.program;
    res.locals.creator = res.locals.creator || null;
    res.locals.admin = res.locals.admin || null;
    res.locals.nav = res.locals.nav || null;

    const view = {
      title: 'Fehler',
      heading: 'Da ist etwas schiefgegangen',
      message: 'Der Fehler wurde protokolliert. Bitte versuche es noch einmal.',
    };
    if (isSize) {
      view.heading = 'Datei zu groß';
      view.message = 'Die Datei ist größer als 10 MB. Bitte teile den Export auf.';
    } else if (isDb) {
      view.heading = 'Keine Verbindung zur Datenbank';
      view.message =
        'Die Anwendung läuft, erreicht aber die Datenbank nicht. Prüfe im Netlify-Projekt unter Project configuration → Database, ob eine Datenbank verbunden ist.';
    }

    res.status(isSize ? 413 : isDb ? 503 : 500).render('error', view, (renderErr, html) => {
      if (renderErr) {
        console.error('Fehlerseite konnte nicht gerendert werden:', renderErr.message);
        return res.type('text/plain').send(`${view.heading}\n\n${view.message}`);
      }
      res.send(html);
    });
  });

  return app;
}

module.exports = { createApp };
