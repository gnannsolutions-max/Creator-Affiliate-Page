'use strict';

// Holt Bestellungen aus WooCommerce und schreibt sie als Umsatzzeilen in `sales`.
//
// Jede Bestellung wird einem Creator zugeordnet – auf drei Wegen, in dieser
// Reihenfolge:
//   1. Gutscheincode der Bestellung, der einem Code im Portal entspricht
//      (Marke + Code → Creator, Satz vom Code)
//   2. Ein Zusatzfeld an der Bestellung (meta_data), dessen Name in
//      WOO_CREATOR_META steht, z. B. „_creator“ oder „affiliate_name“ –
//      der Wert wird als Creatorname bzw. Instagram-Handle verstanden
//   3. Ein Zusatzfeld für den Satz (WOO_RATE_META), falls der Shop den
//      Prozentsatz je Bestellung mitliefert; sonst gilt der Satz des Codes
//      bzw. der Standardsatz des Creators
//
// Bestellnummer = WooCommerce-ID (Präfix W), Datum = Bestelldatum, Umsatz =
// Nettobetrag der Bestellung (Gesamt minus Steuer minus Versand). Erstattete
// und stornierte Bestellungen kommen mit Status 'refunded'/'cancelled' und
// nehmen die Provision beim nächsten Snapshot wieder zurück.

const db = require('../db');
const woo = require('../lib/woo');
const { normalizeName, normalizeStatus } = require('../lib/csv');
const brandsLib = require('../lib/brands');

const BATCH = 200;

function metaValue(order, key) {
  if (!key) return null;
  const want = String(key).toLowerCase();
  for (const m of order.meta_data || []) {
    if (String(m.key || '').toLowerCase() === want) {
      const v = m.value;
      return v === null || v === undefined ? null : String(v).trim();
    }
  }
  return null;
}

function orderNet(order) {
  const total = Number(order.total || 0);
  const tax = Number(order.total_tax || 0);
  const shipping = Number(order.shipping_total || 0);
  // total enthält alles; total_tax enthält auch die Versandsteuer; shipping_total ist netto.
  const net = total - tax - shipping;
  return Math.round(net * 100) / 100;
}

function orderDate(order) {
  const s = String(order.date_created || order.date_created_gmt || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function mapStatus(order) {
  const s = String(order.status || '').toLowerCase();
  if (['completed', 'processing'].includes(s)) return 'confirmed';
  if (['refunded'].includes(s)) return 'refunded';
  if (['cancelled', 'failed', 'trash'].includes(s)) return 'cancelled';
  if (['pending', 'on-hold', 'checkout-draft'].includes(s)) return 'pending';
  return normalizeStatus(s);
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

async function resolveBrand() {
  const s = woo.settings();
  if (s.brandId) {
    const b = await brandsLib.byId(s.brandId);
    if (!b) throw new Error(`WOO_BRAND_ID ${s.brandId} gibt es im Portal nicht.`);
    return b;
  }
  const all = await brandsLib.all({ onlyActive: true });
  if (all.length === 1) return all[0];
  // Mehrere Marken: die, deren Shop-Adresse zur WooCommerce-Adresse passt.
  const host = hostOf(s.url);
  const match = all.filter((b) => host && hostOf(b.shop_url) === host);
  if (match.length === 1) return match[0];
  throw new Error(
    all.length
      ? `Mehrere aktive Marken, keine mit der Shop-Adresse ${host || s.url} – bitte WOO_BRAND_ID setzen oder die Adresse bei der Marke eintragen.`
      : 'Keine aktive Marke im Portal. Lege zuerst eine an.'
  );
}

/**
 * Baut die Zuordnungstabellen: Codes der Marke, Creator nach Name und Handle.
 */
async function lookups(brandId) {
  const codes = await db.many(
    `SELECT cc.code_norm, cc.creator_id, cc.commission_rate
       FROM creator_codes cc JOIN creators c ON c.id = cc.creator_id
      WHERE cc.brand_id = $1 AND cc.status = 'active' AND c.status IN ('approved','paused')`,
    [brandId]
  );
  const byCode = new Map(codes.map((r) => [r.code_norm, r]));
  const creators = await db.many(
    `SELECT id, full_name, instagram, commission_rate FROM creators WHERE status IN ('approved','paused','pending')`
  );
  const byName = new Map();
  const byHandle = new Map();
  for (const c of creators) {
    const n = normalizeName(c.full_name);
    if (n) byName.set(n, byName.has(n) ? 'ambiguous' : c);
    const h = normalizeName(c.instagram);
    if (h) byHandle.set(h, byHandle.has(h) ? 'ambiguous' : c);
  }
  return { byCode, byName, byHandle };
}

/** Eine WooCommerce-Bestellung → Zeile für `sales` (oder null mit Grund). */
function mapOrder(order, lk, opts) {
  const net = orderNet(order);
  const date = orderDate(order);
  if (!date) return { skip: `Bestellung ${order.id}: kein Datum` };

  const couponCodes = (order.coupon_lines || [])
    .map((c) => String(c.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean);
  let creatorId = null;
  let rate = null;
  let via = null;
  let codeNorm = '';
  let creatorName = null;

  for (const code of couponCodes) {
    const hit = lk.byCode.get(code);
    if (hit) {
      creatorId = hit.creator_id;
      rate = hit.commission_rate;
      codeNorm = code;
      via = 'code';
      break;
    }
  }

  // Creator-Kennung aus dem Link: utm_source=Creator12. WooCommerce schreibt
  // sie automatisch als _wc_order_attribution_utm_source an die Bestellung.
  // Die Kennung ist zugleich der Code des Creators im Portal.
  if (!creatorId) {
    const utm = metaValue(order, '_wc_order_attribution_utm_source') || metaValue(order, '_wc_order_attribution_utm_campaign');
    const norm = String(utm || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^CREATOR[0-9]+$/.test(norm)) {
      const hit = lk.byCode.get(norm);
      creatorName = utm;
      if (hit) {
        creatorId = hit.creator_id;
        rate = hit.commission_rate;
        codeNorm = norm;
        via = 'utm';
      }
    }
  }

  if (!creatorId && opts.creatorMeta) {
    const raw = metaValue(order, opts.creatorMeta);
    if (raw) {
      creatorName = raw;
      const n = normalizeName(raw);
      const hit = lk.byName.get(n) || lk.byHandle.get(n) || null;
      if (hit && hit !== 'ambiguous') {
        creatorId = hit.id;
        rate = hit.commission_rate;
        via = 'meta';
      }
    }
  }

  if (opts.rateMeta) {
    const r = metaValue(order, opts.rateMeta);
    if (r !== null && r !== '') {
      const n = Number(String(r).replace('%', '').replace(',', '.'));
      if (Number.isFinite(n)) rate = n > 0 && n < 1 ? n * 100 : n;
    }
  }

  return {
    row: {
      order_ref: `W${order.id}`,
      code_norm: codeNorm,
      order_date: date,
      gross_amount: Math.round(Number(order.total || 0) * 100) / 100,
      net_amount: net,
      status: mapStatus(order),
      creator_id: creatorId,
      commission_rate: creatorId ? rate : null,
      creator_name: creatorName || (couponCodes[0] ? `Code ${couponCodes[0]}` : null),
    },
    via,
    coupon: couponCodes[0] || null,
  };
}

/**
 * Abgleich: alle seit dem letzten Lauf geänderten Bestellungen holen und in
 * `sales` einspielen (neu anlegen oder aktualisieren). Gibt eine Zusammenfassung
 * zurück; der Snapshot wird vom Aufrufer gebaut.
 */
async function syncWooOrders({ actor = 'woo', full = false } = {}) {
  if (!woo.isConfigured()) return { ok: false, skipped: true, reason: 'WooCommerce nicht konfiguriert.' };
  const brand = await resolveBrand();
  const opts = {
    creatorMeta: process.env.WOO_CREATOR_META || '',
    rateMeta: process.env.WOO_RATE_META || '',
  };

  // Seit wann? Letzter erfolgreicher Woo-Import minus 2 Tage Puffer, damit
  // verspätete Statuswechsel nicht verloren gehen. Erster Lauf: 90 Tage.
  let since = null;
  if (!full) {
    const last = await db.one(
      `SELECT created_at FROM imports WHERE import_kind = 'woo' AND brand_id = $1 ORDER BY id DESC LIMIT 1`,
      [brand.id]
    );
    const base = last ? new Date(last.created_at) : new Date(Date.now() - 90 * 86400000);
    since = new Date(base.getTime() - 2 * 86400000).toISOString().slice(0, 19);
  }

  const orders = await woo.fetchOrders({ modifiedAfter: since });
  const lk = await lookups(brand.id);

  const rows = [];
  const problems = [];
  const stats = { byCode: 0, byUtm: 0, byMeta: 0, unassigned: 0, unknownNames: new Map() };
  for (const o of orders) {
    const m = mapOrder(o, lk, opts);
    if (m.skip) {
      problems.push(m.skip);
      continue;
    }
    rows.push(m.row);
    if (m.via === 'code') stats.byCode += 1;
    else if (m.via === 'utm') stats.byUtm += 1;
    else if (m.via === 'meta') stats.byMeta += 1;
    else {
      stats.unassigned += 1;
      const key = m.row.creator_name || '(kein Code, kein Feld)';
      stats.unknownNames.set(key, (stats.unknownNames.get(key) || 0) + 1);
    }
  }

  const result = await db.tx(async (t) => {
    const imp = await t.one(
      `INSERT INTO imports (filename, rows_total, uploaded_by, brand_id, import_kind)
       VALUES ($1, $2, $3, $4, 'woo') RETURNING id`,
      [`woocommerce ${since ? 'seit ' + since : 'vollständig'}`, rows.length, actor, brand.id]
    );
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = [];
      const ph = chunk.map((r, idx) => {
        const b = idx * 9;
        values.push(r.order_ref, r.code_norm, r.order_date, r.gross_amount, r.net_amount, r.status, r.creator_id, r.commission_rate, r.creator_name);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${chunk.length * 9 + 1},$${chunk.length * 9 + 2})`;
      });
      values.push(imp.id, brand.id);
      const res = await t.many(
        `INSERT INTO sales (order_ref, code_norm, order_date, gross_amount, net_amount, status, creator_id, commission_rate, creator_name, import_id, brand_id)
         VALUES ${ph.join(',')}
         ON CONFLICT (brand_id, order_ref) DO UPDATE SET
           code_norm = EXCLUDED.code_norm, order_date = EXCLUDED.order_date,
           gross_amount = EXCLUDED.gross_amount, net_amount = EXCLUDED.net_amount,
           status = EXCLUDED.status, creator_id = EXCLUDED.creator_id,
           commission_rate = EXCLUDED.commission_rate, creator_name = EXCLUDED.creator_name,
           import_id = EXCLUDED.import_id, updated_at = now()
         RETURNING (xmax = 0) AS is_new`,
        values
      );
      for (const r of res) (r.is_new ? (inserted += 1) : (updated += 1));
    }
    await t.run(
      `UPDATE imports SET rows_inserted = $1, rows_updated = $2, rows_skipped = $3, unknown_names = $4 WHERE id = $5`,
      [
        inserted,
        updated,
        problems.length,
        JSON.stringify([...stats.unknownNames.entries()].map(([name, count]) => ({ name, count }))),
        imp.id,
      ]
    );
    return { importId: imp.id, inserted, updated };
  });

  await db.log(actor, 'import.woo', brand.name, `${orders.length} Bestellungen, ${result.inserted} neu, ${result.updated} aktualisiert`);

  return {
    ok: true,
    importId: result.importId,
    brand: brand.name,
    since,
    fetched: orders.length,
    inserted: result.inserted,
    updated: result.updated,
    byCode: stats.byCode,
    byUtm: stats.byUtm,
    byMeta: stats.byMeta,
    unassigned: stats.unassigned,
    unknownNames: [...stats.unknownNames.entries()].map(([name, count]) => ({ name, count })),
    problems,
  };
}

module.exports = { syncWooOrders, mapOrder, orderNet, mapStatus };
