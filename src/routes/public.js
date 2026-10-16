'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { validateApplication, normalizeEmail } = require('../lib/validate');
const auth = require('../lib/auth');
const mailer = require('../lib/mailer');
const rateLimit = require('../lib/ratelimit');
const partners = require('../lib/partners');
const leads = require('../lib/leads');

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
 * Die Startseite ist die Landingpage, nicht das Formular. Alle Bewerbungs-
 * Buttons führen auf den eigenen Bewerbungsbogen /bewerben. Über APPLY_URL
 * lässt sich das auf eine andere Adresse umbiegen, falls nötig.
 */
const APPLY_URL = process.env.APPLY_URL || '/bewerben';

router.get('/', (req, res) => {
  if (req.creator) return res.redirect(req.creator.status === 'approved' ? '/dashboard' : '/status');
  res.render('home', {
    // home.ejs bringt Kopfbereich und Titel selbst mit und bindet die Partials
    // bewusst nicht ein – die Landingpage hat ein eigenes Erscheinungsbild.
    nav: 'home',
    applyUrl: APPLY_URL,
    partners: partners.all(),
  });
});

// --- Bewerbung ---------------------------------------------------------------

router.get('/bewerben', (req, res) => {
  if (req.creator) return res.redirect(req.creator.status === 'approved' ? '/dashboard' : '/status');
  res.render('apply', {
    title: 'Als Creator bewerben',
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
      title: 'Als Creator bewerben',
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
      title: 'Als Creator bewerben',
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
        title: 'Als Creator bewerben',
        nav: 'apply',
        values,
        errors: { email: 'Für diese E-Mail-Adresse liegt bereits eine Bewerbung vor.' },
        src: values.source || '',
      });
    }
    throw err;
  }

  await db.log('creator', 'application.created', creator.email, `Wunsch-Code ${creator.requested_code}`);

  // Kam die Bewerbung über den persönlichen Link aus der Akquise (?src=lead-17),
  // hängt sie ab jetzt an diesem Eintrag. Scheitert das, ist es folgenlos – die
  // Bewerbung steht so oder so im Adminbereich.
  await leads
    .linkFromSource(values.source, creator.id)
    .catch((err) => console.error('Lead nicht verknüpfbar:', err.message));

  // Kam die Bewerbung über den Link eines Vermittlers (?src=vermittler-7),
  // hängt der Creator ab jetzt an ihm. Nur aktive Vermittler zählen.
  const viaBroker = /^vermittler-(\d+)$/.exec(String(values.source || '').trim());
  if (viaBroker) {
    await db
      .run(
        `UPDATE creators SET broker_id = b.id FROM brokers b
          WHERE creators.id = $1 AND b.id = $2 AND b.status = 'active'`,
        [creator.id, Number(viaBroker[1])]
      )
      .catch((err) => console.error('Vermittler nicht verknüpfbar:', err.message));
  }

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

// --- Vermittler-Bewerbung ----------------------------------------------------

function renderBrokerApply(res, { values = {}, errors = {}, sent = false, status = 200 } = {}) {
  return res.status(status).render('broker-apply', { title: 'Als Vermittler bewerben', nav: 'broker-apply', values, errors, sent });
}

router.get('/vermittler-werden', (req, res) => renderBrokerApply(res));

router.post('/vermittler-werden', async (req, res) => {
  const ip = rateLimit.clientIp(req);
  const gate = await rateLimit.hit(`apply:${ip}`, LIMITS.apply);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfter));
    return renderBrokerApply(res, {
      status: 429,
      errors: { form: 'Von dieser Verbindung sind gerade zu viele Bewerbungen eingegangen. Bitte versuche es in einer Stunde noch einmal.' },
    });
  }

  const values = {
    full_name: String(req.body.full_name || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    email: String(req.body.email || '').trim().slice(0, 200),
    phone: String(req.body.phone || '').trim().slice(0, 60) || null,
    instagram: String(req.body.instagram || '').trim().replace(/^@/, '').slice(0, 60) || null,
    message: String(req.body.message || '').trim().slice(0, 2000) || null,
    accept_terms: req.body.accept_terms,
    accept_privacy: req.body.accept_privacy,
  };
  const errors = {};
  if (values.full_name.length < 3 || !values.full_name.includes(' ')) errors.full_name = 'Bitte gib deinen vollständigen Vor- und Nachnamen an.';
  const emailNorm = normalizeEmail(values.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) errors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
  else if (await db.one('SELECT id FROM brokers WHERE email_norm = $1', [emailNorm])) errors.email = 'Für diese E-Mail-Adresse liegt bereits eine Bewerbung vor.';
  if (!values.accept_terms) errors.accept_terms = 'Ohne Zustimmung zu den Teilnahmebedingungen können wir dich nicht aufnehmen.';
  if (!values.accept_privacy) errors.accept_privacy = 'Bitte bestätige die Datenschutzhinweise.';
  if (Object.keys(errors).length) return renderBrokerApply(res, { values, errors, status: 400 });

  const broker = await db.one(
    `INSERT INTO brokers (full_name, email, email_norm, share_rate, status, phone, instagram, message)
     VALUES ($1, $2, $3, 0, 'pending', $4, $5, $6) RETURNING *`,
    [values.full_name, values.email, emailNorm, values.phone, values.instagram, values.message]
  );
  await db.log('broker', 'broker.application', broker.email, broker.full_name);

  if (config.notifyEmail) {
    await mailer
      .send({
        to: config.notifyEmail,
        kind: 'notification',
        link: `${config.baseUrl}/admin/brokers/${broker.id}`,
        subject: `Neue Vermittler-Bewerbung: ${broker.full_name}`,
        text: `Neue Vermittler-Bewerbung im Portal.\n\nName:   ${broker.full_name}\nE-Mail: ${broker.email}${broker.phone ? `\nTelefon: ${broker.phone}` : ''}${broker.instagram ? `\nInstagram: @${broker.instagram}` : ''}${broker.message ? `\n\n${broker.message}` : ''}\n\nFreigeben: ${config.baseUrl}/admin/brokers/${broker.id}`,
      })
      .catch((err) => console.error('Benachrichtigung fehlgeschlagen:', err.message));
  }

  return renderBrokerApply(res, { sent: true });
});

// --- Agenten-Bewerbung -------------------------------------------------------

const { normalizeAgentCode } = require('../services/syncWoo');

function renderAgentApply(res, { values = {}, errors = {}, sent = false, status = 200 } = {}) {
  return res.status(status).render('agent-apply', { title: 'Als Agent bewerben', nav: 'agent-apply', values, errors, sent });
}

router.get('/agent-werden', (req, res) => renderAgentApply(res));

router.post('/agent-werden', async (req, res) => {
  const ip = rateLimit.clientIp(req);
  const gate = await rateLimit.hit(`apply:${ip}`, LIMITS.apply);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfter));
    return renderAgentApply(res, { status: 429, errors: { form: 'Von dieser Verbindung sind gerade zu viele Bewerbungen eingegangen. Bitte versuche es in einer Stunde noch einmal.' } });
  }
  const values = {
    full_name: String(req.body.full_name || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    email: String(req.body.email || '').trim().slice(0, 200),
    agent_code: String(req.body.agent_code || '').trim().slice(0, 20),
    phone: String(req.body.phone || '').trim().slice(0, 60) || null,
    instagram: String(req.body.instagram || '').trim().replace(/^@/, '').slice(0, 60) || null,
    message: String(req.body.message || '').trim().slice(0, 2000) || null,
    accept_terms: req.body.accept_terms,
    accept_privacy: req.body.accept_privacy,
  };
  const errors = {};
  if (values.full_name.length < 3 || !values.full_name.includes(' ')) errors.full_name = 'Bitte gib deinen vollständigen Vor- und Nachnamen an.';
  const emailNorm = normalizeEmail(values.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) errors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
  else if (await db.one('SELECT id FROM agents WHERE email_norm = $1', [emailNorm])) errors.email = 'Für diese E-Mail-Adresse liegt bereits eine Bewerbung vor.';
  const codeNorm = normalizeAgentCode(values.agent_code);
  if (!values.agent_code) errors.agent_code = 'Bitte gib die Agentenkennung ein, die du von uns bekommen hast (z. B. A12).';
  else if (!codeNorm) errors.agent_code = 'Die Kennung besteht aus „A“ und deiner Nummer, z. B. A12. Bitte genau so eingeben, wie du sie von uns bekommen hast.';
  else if (await db.one('SELECT id FROM agents WHERE agent_code_norm = $1', [codeNorm])) errors.agent_code = 'Diese Agentenkennung ist bereits vergeben. Bitte prüfe deine Nummer oder melde dich bei uns.';
  if (!values.accept_terms) errors.accept_terms = 'Ohne Zustimmung zu den Teilnahmebedingungen können wir dich nicht aufnehmen.';
  if (!values.accept_privacy) errors.accept_privacy = 'Bitte bestätige die Datenschutzhinweise.';
  if (Object.keys(errors).length) return renderAgentApply(res, { values, errors, status: 400 });

  const agent = await db.one(
    `INSERT INTO agents (full_name, email, email_norm, agent_code, agent_code_norm, commission_rate, status, phone, instagram, message)
     VALUES ($1, $2, $3, $4, $4, 0, 'pending', $5, $6, $7) RETURNING *`,
    [values.full_name, values.email, emailNorm, codeNorm, values.phone, values.instagram, values.message]
  );
  await db.log('agent', 'agent.application', agent.email, `${agent.full_name} (${agent.agent_code})`);
  if (config.notifyEmail) {
    await mailer
      .send({
        to: config.notifyEmail, kind: 'notification', link: `${config.baseUrl}/admin/agents/${agent.id}`,
        subject: `Neue Agenten-Bewerbung: ${agent.full_name} (${agent.agent_code})`,
        text: `Neue Agenten-Bewerbung im Portal.\n\nName:    ${agent.full_name}\nKennung: ${agent.agent_code}\nE-Mail:  ${agent.email}${agent.phone ? `\nTelefon: ${agent.phone}` : ''}${agent.message ? `\n\n${agent.message}` : ''}\n\nFreigeben: ${config.baseUrl}/admin/agents/${agent.id}`,
      })
      .catch((err) => console.error('Benachrichtigung fehlgeschlagen:', err.message));
  }
  return renderAgentApply(res, { sent: true });
});

// --- Login -------------------------------------------------------------------

router.get('/login', (req, res) => {
  if (req.broker) return res.redirect('/vermittler');
  if (req.agent) return res.redirect('/agent');
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
  const broker = creator ? null : await db.one("SELECT * FROM brokers WHERE email_norm = $1 AND status IN ('active','paused')", [email]);
  const agent = creator || broker ? null : await db.one("SELECT * FROM agents WHERE email_norm = $1 AND status IN ('active','paused')", [email]);

  // Bewusst immer dieselbe Rückmeldung – sonst verrät das Formular,
  // welche Adressen im System sind.
  if (creator) {
    const token = await auth.createLoginToken(creator.id);
    const mail = mailer.templates.loginLink(creator, `${config.baseUrl}/login/${token}`);
    await mailer
      .send({ to: creator.email, ...mail })
      .catch((err) => console.error('Mailversand fehlgeschlagen:', err.message));
  } else if (broker) {
    const token = await auth.createBrokerLoginToken(broker.id);
    const mail = mailer.templates.loginLink(broker, `${config.baseUrl}/login/${token}`);
    await mailer
      .send({ to: broker.email, ...mail })
      .catch((err) => console.error('Mailversand fehlgeschlagen:', err.message));
  } else if (agent) {
    const token = await auth.createAgentLoginToken(agent.id);
    const mail = mailer.templates.loginLink(agent, `${config.baseUrl}/login/${token}`);
    await mailer
      .send({ to: agent.email, ...mail })
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
  const hit = await auth.consumeAnyLoginToken(req.params.token);
  if (hit && hit.broker_id) {
    auth.startBrokerSession(res, hit.broker_id);
    return res.redirect('/vermittler');
  }
  if (hit && hit.agent_id) {
    auth.startAgentSession(res, hit.agent_id);
    return res.redirect('/agent');
  }
  const creatorId = hit ? hit.creator_id : null;
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
  auth.endBrokerSession(res);
  auth.endAgentSession(res);
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
