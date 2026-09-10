'use strict';

const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const CREATOR_COOKIE = 'ca_session';
const ADMIN_COOKIE = 'ca_admin';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function unsign(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [data, mac] = value.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    maxAge: maxAgeMs,
    path: '/',
  };
}

// --- Magic-Link für Creator --------------------------------------------------

async function createLoginToken(creatorId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.loginTokenTtlMinutes * 60_000);
  await db.run('INSERT INTO login_tokens (creator_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    creatorId,
    hash(token),
    expires.toISOString(),
  ]);
  return token;
}

/**
 * Löst den Token ein. Das UPDATE mit `used_at IS NULL` in der WHERE-Klausel
 * macht das atomar: Zwei gleichzeitige Aufrufe mit demselben Link können nicht
 * beide eine Session bekommen.
 */
async function consumeLoginToken(token) {
  if (!token) return null;
  const row = await db.one(
    `UPDATE login_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING creator_id`,
    [hash(String(token))]
  );
  if (!row) return null;
  await db.run('UPDATE creators SET last_login_at = now() WHERE id = $1', [row.creator_id]);
  return row.creator_id;
}

function startCreatorSession(res, creatorId) {
  const maxAge = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  res.cookie(
    CREATOR_COOKIE,
    sign({ cid: String(creatorId), exp: Date.now() + maxAge }),
    cookieOptions(maxAge)
  );
}

function endCreatorSession(res) {
  res.clearCookie(CREATOR_COOKIE, { path: '/' });
}

/** Hängt req.creator an, wenn eine gültige Session existiert. */
async function loadCreator(req, _res, next) {
  try {
    const payload = unsign(req.cookies?.[CREATOR_COOKIE]);
    if (payload?.cid) {
      req.creator = await db.one('SELECT * FROM creators WHERE id = $1', [payload.cid]);
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireCreator(req, res, next) {
  if (!req.creator) return res.redirect('/login');
  next();
}

function requireApprovedCreator(req, res, next) {
  if (!req.creator) return res.redirect('/login');
  if (req.creator.status !== 'approved') return res.redirect('/status');
  next();
}

// --- Admin -------------------------------------------------------------------

function checkAdminPassword(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(config.adminPassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Startet die Adminsitzung. `user` ist entweder ein Datensatz aus admin_users
 * oder null – dann meldet sich der Inhaber über ADMIN_PASSWORD an, den
 * Notzugang, der auch ohne Einträge in der Tabelle funktioniert.
 */
function startAdminSession(res, user = null) {
  const maxAge = 12 * 60 * 60 * 1000;
  const payload = {
    admin: true,
    uid: user ? user.id : null,
    role: user ? user.role : 'owner',
    name: user ? user.name : config.adminName,
    exp: Date.now() + maxAge,
  };
  res.cookie(ADMIN_COOKIE, sign(payload), cookieOptions(maxAge));
}

function endAdminSession(res) {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
}

async function requireAdmin(req, res, next) {
  const payload = unsign(req.cookies?.[ADMIN_COOKIE]);
  if (!payload?.admin) return res.redirect('/admin/login');

  // Bei jedem Aufruf nachsehen, ob der Zugang noch gilt. Ohne das würde eine
  // Sperre erst greifen, wenn die Sitzung von selbst abläuft – im schlechtesten
  // Fall zwölf Stunden später. Genau in diesen zwölf Stunden will man aber
  // jemanden aussperren. Kostet eine kleine Abfrage je Seitenaufruf.
  //
  // Rolle und Name kommen ebenfalls frisch aus der Datenbank: Wer jemanden
  // herabstuft, will nicht warten, bis dessen Sitzung endet.
  if (payload.uid) {
    const user = await db
      .one('SELECT id, name, role, active FROM admin_users WHERE id = $1', [payload.uid])
      .catch(() => null);

    if (!user || !user.active) {
      endAdminSession(res);
      return res.redirect('/admin/login');
    }
    req.admin = { id: user.id, name: user.name, role: user.role };
    res.locals.admin = req.admin;
    return next();
  }

  // Ohne uid: der Inhaber über ADMIN_PASSWORD. Ebenso Sitzungen aus der Zeit
  // vor den Rollen – die gehörten zwangsläufig ihm, sonst gäbe es sie nicht.
  req.admin = {
    id: null,
    name: payload.name || config.adminName,
    role: payload.role || 'owner',
  };
  // Damit die Vorlagen wissen, wer angemeldet ist – die Navigation blendet
  // danach aus, was diese Rolle nicht sehen darf.
  res.locals.admin = req.admin;
  next();
}

/**
 * Sperrt eine Route für alle Rollen außer den genannten.
 *
 * Bewusst eine Weiche am Server und nicht nur ein ausgeblendeter Menüpunkt:
 * Wer die Adresse kennt, tippt sie sonst einfach ein.
 */
function requireRole(...roles) {
  return function roleGate(req, res, next) {
    if (roles.includes(req.admin?.role)) return next();
    res.status(403).render('error', {
      title: 'Kein Zugriff',
      heading: 'Dafür fehlt dir die Berechtigung',
      message: 'Dieser Bereich ist dem Inhaber vorbehalten. Wende dich an ihn, wenn du hier etwas brauchst.',
    });
  };
}

module.exports = {
  createLoginToken,
  consumeLoginToken,
  startCreatorSession,
  endCreatorSession,
  loadCreator,
  requireCreator,
  requireApprovedCreator,
  checkAdminPassword,
  startAdminSession,
  endAdminSession,
  requireAdmin,
  requireRole,
};
