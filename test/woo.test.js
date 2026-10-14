'use strict';

// Zuordnung von WooCommerce-Bestellungen zu Creatorn – reine Funktionstests.

const test = require('node:test');
const assert = require('node:assert');
process.env.SESSION_SECRET = 'test-secret-0123456789-0123456789';
process.env.ADMIN_PASSWORD = 'test-passwort';
process.env.NODE_ENV = 'test';

const { mapOrder, orderNet, mapStatus } = require('../src/services/syncWoo');

const lk = {
  byCode: new Map([['MAX15', { creator_id: 1, commission_rate: 15 }]]),
  byName: new Map([['mirabeispiel', { id: 2, commission_rate: 20 }]]),
  byHandle: new Map([['mirab', { id: 2, commission_rate: 20 }]]),
};

const base = {
  id: 501,
  status: 'completed',
  date_created: '2026-10-14T09:12:00',
  total: '119.00',
  total_tax: '19.00',
  shipping_total: '0.00',
  shipping_tax: '0.00',
  coupon_lines: [],
  meta_data: [],
};

test('Netto = Gesamt minus Steuer minus Versand', () => {
  assert.strictEqual(orderNet(base), 100);
  // 100 netto + 19 Steuer + 4,90 Versand + 0,93 Versandsteuer = 124,83; total_tax = 19,93
  assert.strictEqual(orderNet({ ...base, shipping_total: '4.90', shipping_tax: '0.93', total: '124.83', total_tax: '19.93' }), 100);
});

test('Status: processing/completed zählen, refunded und cancelled nehmen zurück', () => {
  assert.strictEqual(mapStatus({ status: 'processing' }), 'confirmed');
  assert.strictEqual(mapStatus({ status: 'completed' }), 'confirmed');
  assert.strictEqual(mapStatus({ status: 'refunded' }), 'refunded');
  assert.strictEqual(mapStatus({ status: 'cancelled' }), 'cancelled');
  assert.strictEqual(mapStatus({ status: 'on-hold' }), 'pending');
});

test('Zuordnung über Gutscheincode, Satz vom Code', () => {
  const m = mapOrder({ ...base, coupon_lines: [{ code: 'max15' }] }, lk, {});
  assert.strictEqual(m.via, 'code');
  assert.strictEqual(m.row.creator_id, 1);
  assert.strictEqual(m.row.commission_rate, 15);
  assert.strictEqual(m.row.order_ref, 'W501');
  assert.strictEqual(m.row.net_amount, 100);
  assert.strictEqual(m.row.code_norm, 'MAX15');
});

test('Zuordnung über Zusatzfeld (Name oder Handle), Satz optional aus Zusatzfeld', () => {
  const o = { ...base, meta_data: [{ key: '_affiliate', value: 'Mira Beispiel' }, { key: '_affiliate_rate', value: '35 %' }] };
  const m = mapOrder(o, lk, { creatorMeta: '_affiliate', rateMeta: '_affiliate_rate' });
  assert.strictEqual(m.via, 'meta');
  assert.strictEqual(m.row.creator_id, 2);
  assert.strictEqual(m.row.commission_rate, 35);

  const h = mapOrder({ ...base, meta_data: [{ key: '_affiliate', value: '@mira.b' }] }, lk, { creatorMeta: '_affiliate' });
  assert.strictEqual(h.row.creator_id, 2);
  assert.strictEqual(h.row.commission_rate, 20, 'ohne Satz-Feld gilt der Satz des Creators');
});

test('Ohne Treffer bleibt die Bestellung gespeichert, aber niemandem zugeordnet', () => {
  const m = mapOrder({ ...base, coupon_lines: [{ code: 'FREMD' }] }, lk, {});
  assert.strictEqual(m.via, null);
  assert.strictEqual(m.row.creator_id, null);
  assert.strictEqual(m.row.creator_name, 'Code FREMD');
});

test('Zuordnung über utm_source=CreatorN aus dem Link', () => {
  const lk2 = { byCode: new Map([['CREATOR12', { creator_id: 7, commission_rate: 30 }]]), byName: new Map(), byHandle: new Map() };
  const o = { ...base, meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'Creator12' }, { key: '_wc_order_attribution_utm_campaign', value: 'Agent1' }] };
  const m = mapOrder(o, lk2, {});
  assert.strictEqual(m.via, 'utm');
  assert.strictEqual(m.row.creator_id, 7);
  assert.strictEqual(m.row.commission_rate, 30);
  assert.strictEqual(m.row.code_norm, 'CREATOR12');

  const unknown = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'Creator99' }] }, lk2, {});
  assert.strictEqual(unknown.via, null);
  assert.strictEqual(unknown.row.creator_name, 'Creator99', 'unbekannte Kennung wird gemerkt, damit sie im Import auffällt');

  const tiktok = mapOrder({ ...base, meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'tiktok.com' }] }, lk2, {});
  assert.strictEqual(tiktok.via, null, 'eine normale Herkunft ist keine Creator-Kennung');
});
