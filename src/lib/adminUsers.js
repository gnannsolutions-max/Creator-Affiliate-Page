'use strict';

const crypto = require('crypto');
const db = require('../db');
const { normalizeEmail } = require('./validate');

/**
 * Zugänge zum Adminbereich.
 *
 * Passwörter werden mit scrypt abgelegt, nicht mit einem einfachen Hash.
 * scrypt ist absichtlich langsam und speicherhungrig – wer die Datenbank
 * erbeutet, kann die Passwörter damit nicht in vertretbarer Zeit durchprobieren.
 * scrypt steckt in Node selbst, das Portal braucht dafür kein weiteres Paket.
 */

const ROLES = [
  {
    key: 'owner',
    label: 'Inhaber',
    hint: 'Alles: Marken, Umsätze, Auszahlungen, Nachrichten, Zugänge.',
  },
  {
    key: 'manager',
    label: 'Creator Success',
    hint: 'Akquise und Creator. Keine Kontodaten, keine Login-Links, keine Abrechnung.',
  },
];

const ROLE_KEYS = ROLES.map((r) => r.key);
const roleLabel = (key) => (ROLES.find((r) => r.key === key) || {}).label || key;

// Kosten bewusst am oberen Rand dessen, was eine Anmeldung verträgt (~100 ms).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Vergleicht in konstanter Zeit – sonst verrät die Dauer, wie weit man kam. */
function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(plain), salt, expected.length, SCRYPT);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Prüft, ob ein Passwort als Zugangspasswort taugt. Bewusst nur Länge – Regeln
 * über Sonderzeichen führen erfahrungsgemäß zu „Sommer2026!“ auf einem Zettel
 * am Monitor, nicht zu besseren Passwörtern.
 */
function passwordIssue(plain) {
  const value = String(plain || '');
  if (value.length < 12) return 'Mindestens 12 Zeichen. Nimm lieber drei Wörter als ein kurzes Kunstwort.';
  if (value.length > 200) return 'Höchstens 200 Zeichen.';
  return null;
}

function validate(body = {}, { requirePassword = true } = {}) {
  const values = {
    name: String(body.name || '').trim().slice(0, 120),
    email: String(body.email || '').trim().slice(0, 200),
    role: ROLE_KEYS.includes(body.role) ? body.role : 'manager',
  };
  const errors = {};

  if (values.name.length < 2) errors.name = 'Bitte einen Namen eintragen.';
  values.email_norm = normalizeEmail(values.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(values.email_norm)) {
    errors.email = 'Diese E-Mail-Adresse sieht nicht richtig aus.';
  }

  if (requirePassword || body.password) {
    const issue = passwordIssue(body.password);
    if (issue) errors.password = issue;
  }

  return { values, errors };
}

async function all() {
  return db.many(
    `SELECT id, name, email, role, active, created_at, last_login_at
       FROM admin_users ORDER BY active DESC, role, name`
  );
}

async function byId(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return db.one('SELECT * FROM admin_users WHERE id = $1', [numeric]);
}

async function emailTaken(emailNorm, exceptId = null) {
  const row = await db.one(
    'SELECT id FROM admin_users WHERE email_norm = $1 AND ($2::bigint IS NULL OR id <> $2)',
    [emailNorm, exceptId]
  );
  return Boolean(row);
}

async function create(values, plainPassword) {
  return db.one(
    `INSERT INTO admin_users (name, email, email_norm, password_hash, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role`,
    [values.name, values.email, values.email_norm, hashPassword(plainPassword), values.role]
  );
}

async function setPassword(id, plainPassword) {
  await db.run('UPDATE admin_users SET password_hash = $2 WHERE id = $1', [
    Number(id),
    hashPassword(plainPassword),
  ]);
}

async function setActive(id, active) {
  await db.run('UPDATE admin_users SET active = $2 WHERE id = $1', [Number(id), Boolean(active)]);
}

/**
 * Sucht den Zugang zur Adresse und prüft das Passwort.
 *
 * Bei unbekannter Adresse wird trotzdem ein Vergleich gerechnet. Sonst
 * antwortet das Formular auf existierende Adressen messbar langsamer und
 * verrät damit, wer im System ist.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));

async function authenticate(email, plainPassword) {
  const emailNorm = normalizeEmail(email);
  const user = emailNorm
    ? await db.one('SELECT * FROM admin_users WHERE email_norm = $1', [emailNorm])
    : null;

  const ok = verifyPassword(plainPassword, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.active) return null;

  await db
    .run('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id])
    .catch(() => {});

  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

module.exports = {
  ROLES,
  ROLE_KEYS,
  roleLabel,
  hashPassword,
  verifyPassword,
  passwordIssue,
  validate,
  all,
  byId,
  emailTaken,
  create,
  setPassword,
  setActive,
  authenticate,
};
