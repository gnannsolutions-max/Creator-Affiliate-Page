'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, parseSalesCsv, parseNumber, parseDate } = require('../src/lib/csv');

test('erkennt Semikolon als Trennzeichen', () => {
  const { header, rows } = parseCsv('a;b;c\n1;2;3');
  assert.deepStrictEqual(header, ['a', 'b', 'c']);
  assert.strictEqual(rows[0].b, '2');
});

test('erkennt Komma als Trennzeichen', () => {
  const { rows } = parseCsv('a,b\nx,y');
  assert.strictEqual(rows[0].b, 'y');
});

test('kommt mit Anführungszeichen und eingebettetem Trennzeichen klar', () => {
  const { rows } = parseCsv('a;b\n"eins;zwei";drei');
  assert.strictEqual(rows[0].a, 'eins;zwei');
});

test('kommt mit verdoppelten Anführungszeichen klar', () => {
  const { rows } = parseCsv('a\n"sagt ""hallo"""');
  assert.strictEqual(rows[0].a, 'sagt "hallo"');
});

test('entfernt BOM und Windows-Zeilenenden', () => {
  const { header, rows } = parseCsv('﻿a;b\r\n1;2\r\n');
  assert.deepStrictEqual(header, ['a', 'b']);
  assert.strictEqual(rows.length, 1);
});

test('liest deutsche und englische Zahlen', () => {
  assert.strictEqual(parseNumber('1.234,56'), 1234.56);
  assert.strictEqual(parseNumber('1,234.56'), 1234.56);
  assert.strictEqual(parseNumber('89,90 €'), 89.9);
  assert.strictEqual(parseNumber('45'), 45);
  assert.strictEqual(parseNumber(''), null);
});

test('liest verschiedene Datumsformate', () => {
  assert.strictEqual(parseDate('2026-09-04'), '2026-09-04');
  assert.strictEqual(parseDate('4.9.2026'), '2026-09-04');
  assert.strictEqual(parseDate('04.09.2026'), '2026-09-04');
  assert.strictEqual(parseDate('2026-09-04T14:22:01Z'), '2026-09-04');
  assert.strictEqual(parseDate('unlesbar'), null);
});

test('mappt deutsche Spaltennamen und normalisiert Codes', () => {
  const csv = [
    'Bestellnummer;Rabattcode;Bestelldatum;Brutto;Netto;Status',
    '9001;luan15;04.09.2026;89,90;75,55;bezahlt',
  ].join('\n');
  const { rows, problems } = parseSalesCsv(csv);
  assert.strictEqual(problems.length, 0);
  assert.deepStrictEqual(rows[0], {
    order_ref: '9001',
    code_norm: 'LUAN15',
    order_date: '2026-09-04',
    gross_amount: 89.9,
    net_amount: 75.55,
    status: 'confirmed',
  });
});

test('nutzt den Bruttobetrag, wenn keine Netto-Spalte da ist', () => {
  const { rows } = parseSalesCsv('order_ref;code;datum;total\n1;ABC;2026-01-01;50,00');
  assert.strictEqual(rows[0].net_amount, 50);
});

test('meldet fehlende Pflichtspalten statt stillschweigend zu importieren', () => {
  const { rows, problems } = parseSalesCsv('foo;bar\n1;2');
  assert.strictEqual(rows.length, 0);
  assert.ok(problems.some((p) => p.includes('order_ref')));
});

test('überspringt unbrauchbare Zeilen einzeln', () => {
  const csv = [
    'order_ref;code;datum;total',
    '1;ABC;2026-01-01;10,00',
    '2;;2026-01-01;10,00',
    '3;ABC;kaputt;10,00',
  ].join('\n');
  const { rows, problems } = parseSalesCsv(csv);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(problems.length, 2);
});

test('erkennt Retouren und Stornos', () => {
  const csv = [
    'order_ref;code;datum;total;status',
    '1;ABC;2026-01-01;10,00;refunded',
    '2;ABC;2026-01-01;10,00;storniert',
    '3;ABC;2026-01-01;10,00;offen',
  ].join('\n');
  const { rows } = parseSalesCsv(csv);
  assert.deepStrictEqual(rows.map((r) => r.status), ['refunded', 'cancelled', 'pending']);
});
