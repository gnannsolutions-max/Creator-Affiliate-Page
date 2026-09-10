'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leads = require('../src/lib/leads');

test('Handles werden aus Zeilen, Kommas, @ und Profiladressen gelesen', () => {
  const input = `@lena.trains
marcofitness, kraft_jana
https://instagram.com/kraftraum.jana/
www.instagram.com/tim_lauf?hl=de`;

  assert.deepEqual(leads.parseHandles(input), [
    'lena.trains',
    'marcofitness',
    'kraft_jana',
    'kraftraum.jana',
    'tim_lauf',
  ]);
});

test('Doppelte Eingaben werden zusammengefasst', () => {
  const input = '@sarah\nsarah\ninstagram.com/sarah';
  assert.deepEqual(leads.parseHandles(input), ['sarah']);
});

test('Unbrauchbare Eingaben fallen weg', () => {
  // Zu kurz, zu lang, verbotene Zeichen – und eine leere Eingabe.
  const input = 'a\n' + 'x'.repeat(41) + '\nhat leerzeichen\nokay_name';
  const out = leads.parseHandles(input);
  assert.ok(out.includes('okay_name'));
  assert.ok(!out.includes('a'));
  assert.ok(!out.some((h) => h.length > 40));
  assert.deepEqual(leads.parseHandles(''), []);
  assert.deepEqual(leads.parseHandles(null), []);
});

test('Groß- und Kleinschreibung bleibt erhalten, zählt aber als derselbe Name', () => {
  // Angezeigt wird die Schreibweise der Eingabe; eindeutig ist die Kleinschreibung.
  const out = leads.parseHandles('LenaTrains');
  assert.deepEqual(out, ['LenaTrains']);
  assert.equal(out[0].toLowerCase(), 'lenatrains');
});

test('Profiladresse zeigt auf Instagram und ist maskiert', () => {
  assert.equal(leads.profileUrl('lena.trains'), 'https://instagram.com/lena.trains');
  assert.equal(leads.profileUrl('a b'), 'https://instagram.com/a%20b');
});

test('Der Bewerbungslink trägt die Lead-Kennung', () => {
  assert.equal(
    leads.applyUrl('https://supernaturalcreators.com', { id: 17 }),
    'https://supernaturalcreators.com/bewerben?src=lead-17'
  );
});

test('Stufen sind vollständig und beschriftet', () => {
  assert.deepEqual(leads.STATUS_KEYS, ['contacted', 'meeting', 'won', 'lost']);
  assert.equal(leads.statusLabel('meeting'), 'Termin');
  // Unbekannte Werte werden durchgereicht statt zu einem Absturz zu führen.
  assert.equal(leads.statusLabel('quatsch'), 'quatsch');
});

test('Offen sind nur angeschriebene und terminierte Leads', () => {
  assert.deepEqual(leads.OPEN, ['contacted', 'meeting']);
  assert.ok(!leads.OPEN.includes('won'));
  assert.ok(!leads.OPEN.includes('lost'));
});
