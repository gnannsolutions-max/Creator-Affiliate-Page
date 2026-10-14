'use strict';

// Sicherheitslauf für das Creator-Dashboard.
//
// Der eigentliche Stand entsteht seit dem Umbau direkt nach jedem Upload im
// Adminbereich. Dieser Lauf ist das Netz darunter: Er läuft zu den
// konfigurierten Zeiten (Standard 10:30 und 17:30 Uhr Europe/Berlin) und
// rechnet nur dann, wenn seit dem letzten Upload kein Stand erzeugt wurde oder
// heute noch gar keiner existiert.
//
// Netlify plant ausschließlich in UTC. Deshalb hängen an jedem Slot zwei
// Termine (Sommer- und Winterzeit, siehe netlify.toml); die Function prüft
// selbst, ob in der Programm-Zeitzone gerade ein Slot ist, und beendet sich
// sonst, bevor sie die Datenbank anfasst. Ein doppelter Aufruf im selben
// Slot bleibt durch hasRunForSlot() folgenlos.

const config = require('../../src/config');
const db = require('../../src/db');
const { buildSnapshot, hasRunForSlot, needsSafetyRun } = require('../../src/services/snapshot');
const { localDate, localHourMinute } = require('../../src/lib/dates');
const woo = require('../../src/lib/woo');
const { syncWooOrders } = require('../../src/services/syncWoo');

// Wie weit darf der Aufruf vom Slot entfernt sein? Netlify trifft die Minute
// nicht immer exakt, und ein Slot wie 10:30 soll den Aufruf um 10:31 noch
// annehmen – aber nicht den um 11:30.
const TOLERANCE_MINUTES = 20;

function matchSlot(now) {
  const { hour, minute } = localHourMinute(now);
  const current = hour * 60 + minute;
  return config.refresh.slots.find((s) => Math.abs(s.hour * 60 + s.minute - current) <= TOLERANCE_MINUTES) || null;
}

exports.handler = async () => {
  const now = new Date();
  const day = localDate(now);
  const slot = matchSlot(now);

  if (!slot) {
    const { hour, minute } = localHourMinute(now);
    return json(200, {
      skipped: true,
      reason: `Aktuell ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} in ${
        config.refresh.timezone
      }, geplant sind ${config.refresh.label}.`,
    });
  }

  await db.ensureSchema();

  if (await hasRunForSlot(day, slot.label)) {
    return json(200, { skipped: true, reason: `Für ${day} ${slot.label} liegt bereits ein Lauf vor.` });
  }

  // Ist WooCommerce angebunden, holt der Lauf zuerst die Bestellungen – dann
  // ist der anschließende Snapshot auf jeden Fall nötig.
  let sync = null;
  if (woo.isConfigured()) {
    try {
      sync = await syncWooOrders({ actor: 'cron' });
      console.log(`WooCommerce: ${sync.fetched} Bestellungen, ${sync.inserted} neu, ${sync.updated} aktualisiert.`);
    } catch (err) {
      console.error('WooCommerce-Abgleich fehlgeschlagen:', err.message);
      sync = { ok: false, error: err.message };
    }
  }

  const check = sync && sync.ok ? { needed: true, reason: 'Bestellungen aus WooCommerce geholt.' } : await needsSafetyRun(day);
  if (!check.needed) {
    // Nichts zu rechnen. Der zweite UTC-Termin desselben Slots landet hier
    // ebenfalls – das sind zwei kurze Abfragen, kein Snapshot.
    return json(200, { skipped: true, slot: slot.label, reason: check.reason });
  }

  try {
    const result = await buildSnapshot({ triggeredBy: 'cron', slot: slot.label });
    console.log(`Snapshot ${result.runId} (${slot.label}): ${result.creators} Creator, ${result.orders} Bestellungen.`);
    return json(200, { ok: true, day, slot: slot.label, woo: sync, ...result });
  } catch (err) {
    console.error('Snapshot fehlgeschlagen:', err);
    return json(500, { ok: false, error: err.message });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
