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

function startAdminSession(res) {
  const maxAge = 12 * 60 * 60 * 1000;
  res.cookie(ADMIN_COOKIE, sign({ admin: true, exp: Date.now() + maxAge }), cookieOptions(maxAge));
}

function endAdminSession(res) {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
}

function requireAdmin(req, res, next) {
  const payload = unsign(req.cookies?.[ADMIN_COOKIE]);
  if (!payload?.admin) return res.redirect('/admin/login');
  req.admin = { name: config.adminName };
  next();
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
};
