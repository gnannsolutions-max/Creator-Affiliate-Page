'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { validateApplication, normalizeEmail } = require('../lib/validate');
const auth = require('../lib/auth');
const mailer = require('../lib/mailer');
const rateLimit = require('../lib/ratelimit');

const router = express.Router();

// Bewusst großzügig: Ein Mensch bewirbt sich einmal und fordert seinen
// Login-Link vielleicht zwei-, dreimal an. Alles darüber ist Automatik.
const LIMITS = {
  apply: { limit: 5, windowSeconds: 60 * 60 },
  loginIp: { limit: 8, windowSeconds: 15 * 60 },
  // Zusätzlich je Adresse, damit niemand über das Login-Formular fremde
  // Postfächer mit Links zuschütten kann.
  loginEmail: { limit: 5, windowSeconds: 60 * 60 },
};

// --- Startseite --------------------------------------------------------------

/**
 * Die Startseite ist die Landingpage, nicht das Formular. Wer über einen
 * Kampagnenlink kommt (`/?src=…`), soll die Kennung trotzdem bis zur Bewerbung
 * behalten – deshalb wird sie an jeden Bewerbungs-Button angehängt.
 */
router.get('/', (req, res) => {
  if (req.creator) return res.redirect(req.creator.status === 'approved' ? '/dashboard' : '/status');
  const src = String(req.query.src || '').slice(0, 60);
  res.render('home', {
    // home.ejs bringt Kopfbereich und Titel selbst mit und bindet die Partials
    // bewusst nicht ein – die Landingpage hat ein eigenes Erscheinungsbild.
    nav: 'home',
    applyUrl: src ? `/bewerben?src=${encodeURIComponent(src)}` : '/bewerben',
  });
});

// --- Bewerbung ---------------------------------------------------------------

router.get('/bewerben', (req, res) => {
  if (req.creator) return res.redirect(req.creator.status === 'approved' ? '/dashboard' : '/status');
  res.render('apply', {
    title: 'Creator-Code beantragen',
    nav: 'apply',
    values: {},
    errors: {},
    src: String(req.query.src || '').slice(0, 60),
  });
});

router.post('/bewerben', async (req, res) => {
  const ip = rateLimit.clientIp(req);

  const gate = await rateLimit.hit(`apply:${ip}`, LIMITS.apply);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).render('apply', {
      title: 'Creator-Code beantragen',
      nav: 'apply',
      values: {},
      errors: {
        form: 'Von dieser Verbindung sind gerade zu viele Bewerbungen eingegangen. Bitte versuche es in einer Stunde noch einmal – oder schreib uns direkt.',
      },
      src: '',
    });
  }

  const { values, errors } = await validateApplication(req.body, { ip });

  if (Object.keys(errors).length) {
    return res.status(400).render('apply', {
      title: 'Creator-Code beantragen',
      nav: 'apply',
      values: {
        ...values,
        accept_terms: req.body.accept_terms,
        accept_privacy: req.body.accept_privacy,
      },
      errors,
      src: values.source || '',
    });
  }

  let creator;
  try {
    creator = await db.one(
      `INSERT INTO creators (
         full_name, email, email_norm, instagram, tiktok, youtube,
         requested_code, status, commission_rate, customer_discount, source,
         terms_version, terms_accepted_at, terms_accepted_ip
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, now(), $12)
       RETURNING *`,
      [
        values.full_name,
        values.email,
        values.email_norm,
        values.instagram,
        values.tiktok || null,
        values.youtube || null,
        values.requested_code,
        config.program.defaultCommissionRate,
        config.program.defaultCustomerDiscount,
        values.source,
        config.termsVersion,
        ip || null,
      ]
    );
  } catch (err) {
    // Zwei Bewerbungen im selben Moment mit derselben Adresse: der eindeutige
    // Index greift, und wir zeigen dieselbe Meldung wie bei der Vorabprüfung.
    if (err.code === '23505') {
      return res.status(400).render('apply', {
        title: 'Creator-Code beantragen',
        nav: 'apply',
        values,
        errors: { email: 'Für diese E-Mail-Adresse liegt bereits eine Bewerbung vor.' },
        src: values.source || '',
      });
    }
    throw err;
  }

  await db.log('creator', 'application.created', creator.email, `Wunsch-Code ${creator.requested_code}`);

  const mail = mailer.templates.applicationReceived(creator);
  await mailer
    .send({ to: creator.email, ...mail })
    .catch((err) => console.error('Mailversand fehlgeschlagen:', err.message));

  // Interne Benachrichtigung. Scheitert sie, ist das für den Creator folgenlos –
  // die Bewerbung ist gespeichert und steht im Adminbereich.
  if (config.notifyEmail) {
    const notice = mailer.templates.newApplication(
      creator,
      `${config.baseUrl}/admin/creators/${creator.id}`
    );
    await mailer
      .send({ to: config.notifyEmail, ...notice })
      .catch((err) => console.error('Benachrichtigung fehlgeschlagen:', err.message));
  }

  res.render('applied', {
    title: 'Bewerbung eingegangen',
    nav: 'apply',
    creatorName: creator.full_name.split(' ')[0],
    requestedCode: creator.requested_code,
    email: creator.email,
  });
});

// --- Login -------------------------------------------------------------------

router.get('/login', (req, res) => {
  if (req.creator) return res.redirect(req.creator.status === 'approved' ? '/dashboard' : '/status');
  res.render('login', { title: 'Login', nav: 'login', sent: false, error: null, hasSmtp: mailer.hasSmtp() });
});

router.post('/login', async (req, res) => {
  const ip = rateLimit.clientIp(req);
  const email = normalizeEmail(req.body.email);

  // Zwei Zähler: einer gegen viele Versuche aus einer Richtung, einer dagegen,
  // dass ein einzelnes Postfach mit Login-Links zugeschüttet wird.
  const byIp = await rateLimit.hit(`login:${ip}`, LIMITS.loginIp);
  const byEmail = email
    ? await rateLimit.hit(`login-mail:${email}`, LIMITS.loginEmail)
    : { allowed: true };

  if (!byIp.allowed || !byEmail.allowed) {
    res.set('Retry-After', String(byIp.retryAfter || byEmail.retryAfter || 900));
    return res.status(429).render('login', {
      title: 'Login',
      nav: 'login',
      sent: false,
      hasSmtp: mailer.hasSmtp(),
      error:
        'Es wurden gerade zu viele Login-Links angefordert. Bitte warte einen Moment und versuche es dann noch einmal.',
    });
  }

  const creator = await db.one('SELECT * FROM creators WHERE email_norm = $1', [email]);

  // Bewusst immer dieselbe Rückmeldung – sonst verrät das Formular,
  // welche Adressen im System sind.
  if (creator) {
    const token = await auth.createLoginToken(creator.id);
    const mail = mailer.templates.loginLink(creator, `${config.baseUrl}/login/${token}`);
    await mailer
      .send({ to: creator.email, ...mail })
      .catch((err) => console.error('Mailversand fehlgeschlagen:', err.message));
  }

  res.render('login', {
    title: 'Login',
    nav: 'login',
    sent: true,
    error: null,
    hasSmtp: mailer.hasSmtp(),
  });
});

router.get('/login/:token', async (req, res) => {
  const creatorId = await auth.consumeLoginToken(req.params.token);
  if (!creatorId) {
    return res.status(400).render('login', {
      title: 'Login',
      nav: 'login',
      sent: false,
      hasSmtp: mailer.hasSmtp(),
      error: 'Dieser Link ist abgelaufen oder wurde schon benutzt. Fordere bitte einen neuen an.',
    });
  }
  auth.startCreatorSession(res, creatorId);
  const creator = await db.one('SELECT status FROM creators WHERE id = $1', [creatorId]);
  res.redirect(creator?.status === 'approved' ? '/dashboard' : '/status');
});

router.get('/logout', (req, res) => {
  auth.endCreatorSession(res);
  res.redirect('/login');
});

// --- Status ------------------------------------------------------------------

router.get('/status', auth.requireCreator, (req, res) => {
  if (req.creator.status === 'approved') return res.redirect('/dashboard');
  res.render('status', { title: 'Status', nav: 'status' });
});

// --- Rechtstexte -------------------------------------------------------------

router.get('/impressum', (req, res) => {
  res.render('imprint', { title: 'Impressum', nav: null });
});

router.get('/teilnahmebedingungen', (req, res) => {
  res.render('terms', { title: 'Teilnahmebedingungen', nav: null });
});

router.get('/datenschutz', (req, res) => {
  res.render('privacy', { title: 'Datenschutz', nav: null });
});

module.exports = router;
