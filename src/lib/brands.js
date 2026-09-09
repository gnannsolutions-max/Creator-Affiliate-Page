'use strict';

/**
 * Marken und die Links, die Creator posten.
 *
 * Ein Link entsteht aus der Vorlage der Marke, in die der persönliche Code
 * eingesetzt wird – zum Beispiel:
 *
 *   https://esn.com/?coupon={CODE}   →   https://esn.com/?coupon=MARCO15
 *
 * Bewusst ein direkter Link in den Shop und keine Weiterleitung über dieses
 * Portal: Es gibt damit keine Klickprotokolle, nichts zusätzlich zu erklären
 * und keinen weiteren Punkt, der ausfallen kann. Der Preis dafür ist, dass wir
 * keine Klickzahlen sehen und ein geänderter Shop-Link alte Posts ins Leere
 * laufen lässt.
 *
 * Zugeordnet wird das Geld weiterhin über den Rabattcode aus dem CSV-Import,
 * nicht über den Link. Der Link ist der bequeme Weg dorthin, nicht der Beleg.
 */

const db = require('../db');

const PLACEHOLDER = '{CODE}';

const text = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Aus dem Namen einen kurzen, stabilen Bezeichner machen. */
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Prüft eine Linkvorlage. Sie muss eine vollständige https-Adresse sein und den
 * Platzhalter genau einmal enthalten – sonst entstehen stillschweigend Links,
 * die auf die Startseite zeigen und nichts zuordnen.
 */
function templateIssue(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'Bitte trage die Linkvorlage ein.';
  if (!value.includes(PLACEHOLDER)) {
    return `Die Vorlage muss ${PLACEHOLDER} enthalten – dort wird der Code des Creators eingesetzt.`;
  }
  if (value.split(PLACEHOLDER).length > 2) {
    return `${PLACEHOLDER} darf nur einmal vorkommen.`;
  }
  let url;
  try {
    url = new URL(value.replace(PLACEHOLDER, 'PLATZHALTER'));
  } catch {
    return 'Das ist keine vollständige Adresse. Sie muss mit https:// beginnen.';
  }
  if (url.protocol !== 'https:') return 'Bitte eine https-Adresse verwenden.';
  return null;
}

/** Setzt den Code in die Vorlage ein. Der Code wird dabei URL-sicher kodiert. */
function buildLink(template, code) {
  if (!template || !code) return '';
  return String(template).replace(PLACEHOLDER, encodeURIComponent(code));
}

function validateBrand(body, { existingSlug = null } = {}) {
  const errors = {};
  const values = {
    name: text(body.name, 60),
    slug: slugify(body.slug || body.name),
    shop_url: text(body.shop_url, 200),
    link_template: text(body.link_template, 300),
    default_commission_rate: Number(String(body.default_commission_rate).replace(',', '.')),
    default_customer_discount: Number(String(body.default_customer_discount).replace(',', '.')),
    note: text(body.note, 300),
    active: body.active !== 'false' && body.active !== '0',
  };

  if (values.name.length < 2) errors.name = 'Bitte trage den Namen der Marke ein.';
  if (!values.slug) errors.slug = 'Aus dem Namen lässt sich kein Kürzel bilden. Bitte eines eintragen.';

  if (!values.shop_url) {
    errors.shop_url = 'Bitte trage die Adresse des Shops ein.';
  } else {
    try {
      const u = new URL(values.shop_url);
      if (u.protocol !== 'https:') errors.shop_url = 'Bitte eine https-Adresse verwenden.';
    } catch {
      errors.shop_url = 'Das ist keine vollständige Adresse. Sie muss mit https:// beginnen.';
    }
  }

  const templateProblem = templateIssue(values.link_template);
  if (templateProblem) errors.link_template = templateProblem;

  for (const [field, label] of [
    ['default_commission_rate', 'Provision'],
    ['default_customer_discount', 'Rabatt'],
  ]) {
    const n = values[field];
    if (!Number.isFinite(n) || n < 0 || n > 90) {
      errors[field] = `${label} muss zwischen 0 und 90 % liegen.`;
    }
  }

  // existingSlug erlaubt das Speichern einer Marke unter ihrem eigenen Kürzel.
  values.checkSlugAgainst = existingSlug;
  return { values, errors };
}

async function slugTaken(slug, exceptId = null) {
  const row = await db.one(
    exceptId
      ? 'SELECT id FROM brands WHERE slug = $1 AND id <> $2'
      : 'SELECT id FROM brands WHERE slug = $1',
    exceptId ? [slug, exceptId] : [slug]
  );
  return Boolean(row);
}

async function all({ onlyActive = false } = {}) {
  return db.many(
    `SELECT * FROM brands ${onlyActive ? 'WHERE active' : ''} ORDER BY sort_order, name`
  );
}

async function byId(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return db.one('SELECT * FROM brands WHERE id = $1', [numeric]);
}

/** Alle Codes eines Creators samt Marke und fertigem Link. */
async function codesFor(creatorId) {
  const rows = await db.many(
    `SELECT cc.id, cc.brand_id, cc.code, cc.code_norm, cc.commission_rate,
            cc.customer_discount, cc.status,
            b.name AS brand_name, b.slug AS brand_slug, b.shop_url, b.link_template,
            b.active AS brand_active
       FROM creator_codes cc
       JOIN brands b ON b.id = cc.brand_id
      WHERE cc.creator_id = $1
      ORDER BY b.sort_order, b.name`,
    [creatorId]
  );
  return rows.map((row) => ({ ...row, link: buildLink(row.link_template, row.code) }));
}

module.exports = {
  PLACEHOLDER,
  slugify,
  templateIssue,
  buildLink,
  validateBrand,
  slugTaken,
  all,
  byId,
  codesFor,
};
