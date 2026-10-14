'use strict';

// WooCommerce REST-API – Bestellungen lesen.
//
// Umgebungsvariablen:
//   WOO_URL              Shop-Adresse, z. B. https://shop.example.de
//   WOO_CONSUMER_KEY     ck_…  (WooCommerce → Einstellungen → Erweitert → REST-API)
//   WOO_CONSUMER_SECRET  cs_…
//   WOO_BRAND_ID         Marke im Portal, der diese Bestellungen gehören
//                        (optional – ohne Angabe wird die einzige aktive Marke genommen)
//
// Nur Lesezugriff: Es werden ausschließlich GET-Aufrufe gemacht.

const API_PREFIX = '/wp-json/wc/v3';
const PER_PAGE = 100;

function settings() {
  return {
    url: String(process.env.WOO_URL || '').trim().replace(/\/+$/, ''),
    key: String(process.env.WOO_CONSUMER_KEY || '').trim(),
    secret: String(process.env.WOO_CONSUMER_SECRET || '').trim(),
    brandId: process.env.WOO_BRAND_ID ? Number(process.env.WOO_BRAND_ID) : null,
  };
}

function isConfigured() {
  const s = settings();
  return Boolean(s.url && s.key && s.secret);
}

function authHeader(s) {
  return 'Basic ' + Buffer.from(`${s.key}:${s.secret}`).toString('base64');
}

/** Ein GET gegen die API. Gibt Body und Header zurück (Seitenzahl steht im Header). */
async function get(path, params = {}) {
  const s = settings();
  if (!s.url || !s.key || !s.secret) {
    throw new Error('WooCommerce nicht konfiguriert: WOO_URL, WOO_CONSUMER_KEY und WOO_CONSUMER_SECRET fehlen.');
  }
  const url = new URL(s.url + API_PREFIX + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: authHeader(s), Accept: 'application/json', 'User-Agent': 'creator-portal/1.0' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Shop nicht erreichbar (${url.origin}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Antwort von ${url.origin} ist kein JSON (HTTP ${res.status}). Ist WOO_URL die Adresse der WordPress-Seite? Antwort beginnt mit: ${text.slice(0, 120)}`
    );
  }
  if (!res.ok) {
    const msg = body && (body.message || body.code) ? `${body.code || ''} ${body.message || ''}`.trim() : `HTTP ${res.status}`;
    throw new Error(`WooCommerce antwortet mit Fehler: ${msg}`);
  }
  return {
    body,
    total: Number(res.headers.get('x-wp-total') || 0),
    totalPages: Number(res.headers.get('x-wp-totalpages') || 0),
  };
}

/** Verbindungstest: Shop-Infos und die Anzahl der Bestellungen. */
async function ping() {
  const sys = await get('/system_status').catch(() => null);
  const orders = await get('/orders', { per_page: 1 });
  return {
    ok: true,
    storeUrl: sys?.body?.environment?.home_url || settings().url,
    wcVersion: sys?.body?.environment?.version || null,
    ordersTotal: orders.total,
  };
}

/**
 * Alle Bestellungen ab einem Zeitpunkt (ISO-String, Shop-Zeitzone) – seitenweise.
 * `modified_after` statt `after`, damit auch nachträglich geänderte Bestellungen
 * (Storno, Erstattung) wieder mitkommen.
 */
async function fetchOrders({ modifiedAfter = null, status = 'any', max = 5000 } = {}) {
  const out = [];
  let page = 1;
  for (;;) {
    const { body, totalPages } = await get('/orders', {
      per_page: PER_PAGE,
      page,
      status,
      orderby: 'date',
      order: 'asc',
      modified_after: modifiedAfter || undefined,
    });
    if (!Array.isArray(body)) break;
    out.push(...body);
    if (out.length >= max || page >= totalPages || body.length < PER_PAGE) break;
    page += 1;
  }
  return out;
}

/** Einzelne Bestellung – für die Diagnose. */
async function fetchOrder(id) {
  return (await get(`/orders/${Number(id)}`)).body;
}

module.exports = { settings, isConfigured, get, ping, fetchOrders, fetchOrder, API_PREFIX };
