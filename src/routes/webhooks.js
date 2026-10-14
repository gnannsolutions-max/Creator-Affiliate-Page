'use strict';

// Webhook-Empfänger für WooCommerce.
//
// Der Shop ruft diese Adresse bei jeder neuen oder geänderten Bestellung auf
// (WooCommerce → Einstellungen → Erweitert → Webhooks, Thema „Bestellung
// erstellt“ und „Bestellung aktualisiert“). Dadurch sind die Dashboards
// sofort aktuell, nicht erst beim nächsten Sicherheitslauf.
//
// Sicherheit: WooCommerce signiert jeden Aufruf mit HMAC-SHA256 über den
// Rohtext des Bodys und dem „Secret“ des Webhooks. Das Secret steht bei uns in
// WOO_WEBHOOK_SECRET. Ohne gültige Signatur passiert nichts.
//
// Die Bestellung aus dem Webhook-Body wird nicht direkt übernommen – der
// Abgleich holt sie über die API noch einmal frisch. So ist egal, in welchem
// Format oder wie vollständig der Webhook liefert, und ein gefälschter Body
// kann keine Zahlen setzen.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const woo = require('../lib/woo');
const { syncWooOrders } = require('../services/syncWoo');
const { buildSnapshot } = require('../services/snapshot');

const router = express.Router();

function secret() {
  return String(process.env.WOO_WEBHOOK_SECRET || '').trim();
}

function signatureValid(rawBody, header) {
  const s = secret();
  if (!s || !header) return false;
  const expected = crypto.createHmac('sha256', s).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Rohtext nötig, weil die Signatur über die exakten Bytes geht.
router.post('/webhooks/woocommerce', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  // WooCommerce schickt beim Anlegen des Webhooks einen Test-Ping ohne
  // Signatur (Body: webhook_id=…). Den quittieren wir, damit der Webhook im
  // Shop auf „aktiv“ springt.
  if (!req.get('x-wc-webhook-signature')) {
    if (/^webhook_id=/.test(raw.toString('utf8'))) return res.status(200).json({ ok: true, ping: true });
    return res.status(401).json({ ok: false, error: 'Signatur fehlt.' });
  }

  if (!secret()) return res.status(503).json({ ok: false, error: 'WOO_WEBHOOK_SECRET ist nicht gesetzt.' });
  if (!signatureValid(raw, req.get('x-wc-webhook-signature'))) {
    return res.status(401).json({ ok: false, error: 'Signatur ungültig.' });
  }
  if (!woo.isConfigured()) return res.status(503).json({ ok: false, error: 'WooCommerce nicht konfiguriert.' });

  let orderId = null;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    orderId = parsed && parsed.id ? Number(parsed.id) : null;
  } catch {
    // kein JSON – egal, der Abgleich holt sich alles Geänderte selbst
  }

  try {
    const sync = await syncWooOrders({ actor: 'webhook' });
    const snap = await buildSnapshot({ triggeredBy: 'import' });
    await db.log('webhook', 'woo.webhook', orderId ? `Bestellung ${orderId}` : req.get('x-wc-webhook-topic') || '-', `${sync.inserted} neu, ${sync.updated} aktualisiert`);
    return res.status(200).json({ ok: true, order: orderId, inserted: sync.inserted, updated: sync.updated, snapshot: snap.runId });
  } catch (err) {
    console.error('Webhook-Abgleich fehlgeschlagen:', err.message);
    // 500 → WooCommerce versucht es später erneut.
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
