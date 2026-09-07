'use strict';

const db = require('../db');

// Codes, die aus rechtlichen, technischen oder Markengründen gesperrt sind.
const RESERVED_CODES = new Set([
  'ADMIN', 'TEST', 'SHOP', 'SALE', 'RABATT', 'GRATIS', 'FREE', 'GUTSCHEIN',
  'WELCOME', 'NEWSLETTER', 'SUMMER', 'WINTER', 'BLACKFRIDAY', 'CYBERMONDAY',
  'VITALKONTOR', 'SUPPORT', 'PARTNER', 'AFFILIATE', 'CREATOR', 'NULL', 'UNDEFINED',
]);

// Begriffe, die im Code nichts zu suchen haben – Heilversprechen und
// verschreibungspflichtige Wirkstoffe. Ein Code wie "OZEMPIC10" wäre bereits
// für sich genommen Publikumswerbung für ein Rx-Arzneimittel.
const BLOCKED_SUBSTRINGS = [
  'OZEMPIC', 'WEGOVY', 'MOUNJARO', 'SEMAGLUTID', 'TIRZEPATID', 'RETATRUTID',
  'SAXENDA', 'BOTOX', 'HEIL', 'THERAPIE', 'MEDIZIN', 'RECEPT', 'REZEPT', 'RX',
];

const CODE_RE = /^[A-Z0-9]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeEmail(input) {
  return String(input || '').trim().toLowerCase();
}

/**
 * Vereinheitlicht Social-Handles: akzeptiert "@name", "name" und volle URLs
 * und gibt immer "name" zurück (ohne @).
 */
function normalizeHandle(input, platform) {
  let value = String(input || '').trim();
  if (!value) return '';
  value = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const hostPatterns = {
    instagram: /^instagram\.com\//i,
    tiktok: /^tiktok\.com\//i,
    youtube: /^(youtube\.com|youtu\.be)\//i,
  };
  const pattern = hostPatterns[platform];
  if (pattern && pattern.test(value)) {
    value = value.replace(pattern, '');
  }
  value = value.split(/[?#/]/)[0];
  value = value.replace(/^@+/, '');
  return value;
}

function validateHandle(value, platform) {
  if (platform === 'youtube') {
    // YouTube erlaubt Handles (@name) und alte Kanalnamen – großzügiger prüfen.
    return /^[A-Za-z0-9._\- ]{2,60}$/.test(value);
  }
  return /^[A-Za-z0-9._]{2,40}$/.test(value);
}

function codeIssue(codeNorm) {
  if (!codeNorm) return 'Bitte gib einen Wunsch-Code an.';
  if (!CODE_RE.test(codeNorm)) {
    return 'Der Code darf nur Buchstaben und Ziffern enthalten und muss 3 bis 20 Zeichen lang sein.';
  }
  if (RESERVED_CODES.has(codeNorm)) {
    return 'Dieser Code ist reserviert. Bitte wähle einen anderen.';
  }
  for (const blocked of BLOCKED_SUBSTRINGS) {
    if (codeNorm.includes(blocked)) {
      return 'Dieser Code enthält einen nicht zulässigen Begriff (Arzneimittel- oder Heilbezug). Bitte wähle einen anderen.';
    }
  }
  return null;
}

async function codeTaken(codeNorm, exceptCreatorId) {
  const row = await db.one(
    `SELECT id FROM creators
      WHERE (assigned_code_norm = $1 OR (status = 'pending' AND UPPER(requested_code) = $1))
        AND ($2::bigint IS NULL OR id <> $2::bigint)
      LIMIT 1`,
    [codeNorm, exceptCreatorId ?? null]
  );
  return Boolean(row);
}

/**
 * Prüft das komplette Bewerbungsformular.
 * @returns {Promise<{values: object, errors: object}>}
 */
async function validateApplication(body, { ip } = {}) {
  const errors = {};

  const fullName = String(body.full_name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(body.email);
  const codeNorm = normalizeCode(body.requested_code);
  const instagram = normalizeHandle(body.instagram, 'instagram');
  const tiktok = normalizeHandle(body.tiktok, 'tiktok');
  const youtube = normalizeHandle(body.youtube, 'youtube');

  if (fullName.length < 3 || !fullName.includes(' ')) {
    errors.full_name = 'Bitte gib deinen vollständigen Vor- und Nachnamen an.';
  } else if (fullName.length > 120) {
    errors.full_name = 'Der Name ist zu lang.';
  }

  if (!EMAIL_RE.test(email)) {
    errors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
  } else if (await db.one('SELECT id FROM creators WHERE email_norm = $1', [email])) {
    errors.email = 'Für diese E-Mail-Adresse liegt bereits eine Bewerbung vor.';
  }

  const issue = codeIssue(codeNorm);
  if (issue) {
    errors.requested_code = issue;
  } else if (await codeTaken(codeNorm)) {
    errors.requested_code = 'Dieser Code ist bereits vergeben oder reserviert. Bitte wähle einen anderen.';
  }

  if (!instagram) {
    errors.instagram = 'Instagram ist ein Pflichtfeld.';
  } else if (!validateHandle(instagram, 'instagram')) {
    errors.instagram = 'Bitte gib einen gültigen Instagram-Namen an (z. B. @deinname).';
  }

  if (tiktok && !validateHandle(tiktok, 'tiktok')) {
    errors.tiktok = 'Bitte gib einen gültigen TikTok-Namen an oder lass das Feld leer.';
  }
  if (youtube && !validateHandle(youtube, 'youtube')) {
    errors.youtube = 'Bitte gib einen gültigen YouTube-Kanal an oder lass das Feld leer.';
  }

  if (!body.accept_terms) {
    errors.accept_terms = 'Ohne Zustimmung zu den Teilnahme- und Werberegeln können wir keinen Code vergeben.';
  }
  if (!body.accept_privacy) {
    errors.accept_privacy = 'Bitte bestätige die Datenschutzhinweise.';
  }

  return {
    values: {
      full_name: fullName,
      email: String(body.email || '').trim(),
      email_norm: email,
      requested_code: codeNorm,
      instagram,
      tiktok,
      youtube,
      source: String(body.src || '').trim().slice(0, 60) || null,
      ip: ip || null,
    },
    errors,
  };
}

module.exports = {
  RESERVED_CODES,
  BLOCKED_SUBSTRINGS,
  normalizeCode,
  normalizeEmail,
  normalizeHandle,
  codeIssue,
  codeTaken,
  validateApplication,
};
