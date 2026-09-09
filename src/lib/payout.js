'use strict';

/**
 * Zahlungsempfängerdaten: Prüfung, Normalisierung, Darstellung.
 *
 * Die IBAN wird echt geprüft (Prüfsumme nach ISO 7064, Mod 97-10) und nicht
 * nur auf ihre Länge. Ein Zahlendreher fällt dadurch schon im Formular auf und
 * nicht erst, wenn eine Überweisung zurückkommt oder – schlimmer – bei jemand
 * anderem landet.
 */

const db = require('../db');

// Offizielle IBAN-Längen je Land. Länder ohne Eintrag werden nur über die
// Prüfsumme geprüft; das ist schwächer, aber besser als eine Ablehnung
// gültiger Konten aus Ländern, die hier noch nicht gelistet sind.
const IBAN_LENGTHS = {
  AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26,
  IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15,
  PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
};

const COUNTRIES = {
  DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', NL: 'Niederlande',
  BE: 'Belgien', FR: 'Frankreich', IT: 'Italien', ES: 'Spanien',
  PL: 'Polen', LU: 'Luxemburg', DK: 'Dänemark', SE: 'Schweden',
};

const TAX_STATUS = {
  kleinunternehmer: 'Kleinunternehmer (§ 19 UStG, ohne Umsatzsteuer)',
  regelbesteuert: 'Regelbesteuert (mit Umsatzsteuer)',
  privat: 'Privatperson, keine unternehmerische Tätigkeit',
};

/** Leerzeichen raus, Großbuchstaben – so wird die IBAN gespeichert. */
function normalizeIban(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

/** Prüfsumme nach ISO 7064 (Mod 97-10). Gültig ist genau der Rest 1. */
function ibanChecksumOk(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    // Buchstaben werden zu zwei Ziffern: A = 10 … Z = 35
    const part = code >= 65 && code <= 90 ? String(code - 55) : char;
    for (const digit of part) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Gibt einen Klartextfehler zurück oder null, wenn die IBAN in Ordnung ist. */
function ibanIssue(raw) {
  const iban = normalizeIban(raw);
  if (!iban) return 'Bitte trage deine IBAN ein.';
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return 'Das sieht nicht wie eine IBAN aus. Sie beginnt mit zwei Buchstaben, z. B. DE89…';
  }
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected && iban.length !== expected) {
    return `Eine IBAN aus ${iban.slice(0, 2)} hat ${expected} Zeichen, deine hat ${iban.length}.`;
  }
  if (iban.length < 15 || iban.length > 34) return 'Die IBAN hat eine ungültige Länge.';
  if (!ibanChecksumOk(iban)) {
    return 'Die Prüfziffer stimmt nicht – da hat sich vermutlich ein Zahlendreher eingeschlichen.';
  }
  return null;
}

/** Für Listen und Protokolle: DE89 **** **** **** 3000 */
function maskIban(raw) {
  const iban = normalizeIban(raw);
  if (iban.length < 8) return iban;
  const groups = (iban.slice(0, 4) + iban.slice(4, -4).replace(/./g, '*') + iban.slice(-4)).match(
    /.{1,4}/g
  );
  return groups.join(' ');
}

/** Zum Anzeigen der vollständigen IBAN in Vierergruppen. */
function formatIban(raw) {
  const groups = normalizeIban(raw).match(/.{1,4}/g);
  return groups ? groups.join(' ') : '';
}

function maskEmail(value) {
  const [name, domain] = String(value || '').split('@');
  if (!domain) return value || '';
  const visible = name.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

const text = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Prüft das Formular. Gibt die bereinigten Werte und die Fehler je Feld zurück –
 * dasselbe Muster wie bei der Bewerbung, damit die View gleich aufgebaut ist.
 */
function validatePayout(body) {
  const errors = {};
  const values = {
    method: body.method === 'paypal' ? 'paypal' : 'sepa',
    account_holder: text(body.account_holder, 120),
    iban: normalizeIban(body.iban),
    bic: text(body.bic, 20).toUpperCase().replace(/\s/g, ''),
    paypal_email: text(body.paypal_email, 160).toLowerCase(),
    street: text(body.street, 120),
    postal_code: text(body.postal_code, 12),
    city: text(body.city, 80),
    country: /^[A-Za-z]{2}$/.test(body.country || '') ? String(body.country).toUpperCase() : 'DE',
    tax_status: TAX_STATUS[body.tax_status] ? body.tax_status : 'kleinunternehmer',
    tax_id: text(body.tax_id, 40).toUpperCase(),
  };

  if (values.account_holder.length < 3) {
    errors.account_holder = 'Bitte trage den vollständigen Namen des Kontoinhabers ein.';
  }

  if (values.method === 'sepa') {
    const issue = ibanIssue(values.iban);
    if (issue) errors.iban = issue;
    if (values.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(values.bic)) {
      errors.bic = 'Diese BIC ist nicht gültig. Innerhalb der EU kannst du das Feld leer lassen.';
    }
    values.paypal_email = '';
  } else {
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(values.paypal_email)) {
      errors.paypal_email = 'Bitte trage die E-Mail-Adresse deines PayPal-Kontos ein.';
    }
    values.iban = '';
    values.bic = '';
  }

  if (values.street.length < 3) errors.street = 'Bitte trage Straße und Hausnummer ein.';
  if (!/^[A-Z0-9][A-Z0-9\s-]{2,11}$/i.test(values.postal_code)) {
    errors.postal_code = 'Bitte trage eine gültige Postleitzahl ein.';
  }
  if (values.city.length < 2) errors.city = 'Bitte trage den Ort ein.';

  // Wer Umsatzsteuer ausweist, muss identifizierbar sein – sonst lässt sich
  // die Gutschrift steuerlich nicht verwenden.
  if (values.tax_status === 'regelbesteuert' && values.tax_id.length < 5) {
    errors.tax_id = 'Bei Regelbesteuerung brauchen wir deine USt-IdNr. oder Steuernummer.';
  }
  if (values.tax_status !== 'regelbesteuert') values.tax_id = values.tax_id || '';

  return { values, errors };
}

async function load(creatorId) {
  return db.one('SELECT * FROM payout_details WHERE creator_id = $1', [creatorId]);
}

async function save(creatorId, values) {
  return db.one(
    `INSERT INTO payout_details (
       creator_id, method, account_holder, iban, bic, paypal_email,
       street, postal_code, city, country, tax_status, tax_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (creator_id) DO UPDATE SET
       method = EXCLUDED.method,
       account_holder = EXCLUDED.account_holder,
       iban = EXCLUDED.iban,
       bic = EXCLUDED.bic,
       paypal_email = EXCLUDED.paypal_email,
       street = EXCLUDED.street,
       postal_code = EXCLUDED.postal_code,
       city = EXCLUDED.city,
       country = EXCLUDED.country,
       tax_status = EXCLUDED.tax_status,
       tax_id = EXCLUDED.tax_id,
       updated_at = now()
     RETURNING *`,
    [
      creatorId,
      values.method,
      values.account_holder,
      values.iban || null,
      values.bic || null,
      values.paypal_email || null,
      values.street,
      values.postal_code,
      values.city,
      values.country,
      values.tax_status,
      values.tax_id || null,
    ]
  );
}

/** Kurzform für den Adminbereich – ohne die vollständige Kontonummer. */
function summarize(row) {
  if (!row) return null;
  return {
    method: row.method,
    holder: row.account_holder,
    target: row.method === 'sepa' ? maskIban(row.iban) : maskEmail(row.paypal_email),
    taxStatus: TAX_STATUS[row.tax_status] || row.tax_status,
  };
}

module.exports = {
  COUNTRIES,
  TAX_STATUS,
  normalizeIban,
  ibanIssue,
  ibanChecksumOk,
  maskIban,
  formatIban,
  maskEmail,
  validatePayout,
  load,
  save,
  summarize,
};
