'use strict';

/**
 * Die IBAN-Prüfung ist der Teil, bei dem ein Fehler richtig weh tut: Eine
 * durchgewinkte falsche IBAN heißt im besten Fall Rückläufer, im schlechtesten
 * Geld beim Falschen. Deshalb hier echte Beispiele statt Formfragen.
 */

const test = require('node:test');
const assert = require('node:assert');

const payout = require('../src/lib/payout');

test('gültige IBANs werden angenommen', () => {
  const valid = [
    'DE89370400440532013000',
    'DE89 3704 0044 0532 0130 00',
    'de89-3704-0044-0532-0130-00',
    'AT611904300234573201',
    'CH9300762011623852957',
    'NL91ABNA0417164300',
    'FR1420041010050500013M02606',
    'GB29NWBK60161331926819',
  ];
  for (const iban of valid) {
    assert.strictEqual(payout.ibanIssue(iban), null, `${iban} sollte gültig sein`);
  }
});

test('ein Zahlendreher fällt über die Prüfziffer auf', () => {
  // Zwei Ziffern vertauscht: DE89 3704 0044 0532 0130 00 -> ...0310 00
  const issue = payout.ibanIssue('DE89370400440532031000');
  assert.ok(issue, 'ein Zahlendreher muss auffallen');
  assert.match(issue, /Prüfziffer/);
});

test('falsche Länge wird konkret benannt', () => {
  const issue = payout.ibanIssue('DE8937040044053201300');
  assert.match(issue, /22 Zeichen/);
  assert.match(issue, /21/);
});

test('offensichtlicher Unsinn wird abgewiesen', () => {
  assert.match(payout.ibanIssue(''), /Bitte trage deine IBAN/);
  assert.match(payout.ibanIssue('meine Bank'), /sieht nicht wie eine IBAN/);
  assert.match(payout.ibanIssue('1234567890'), /sieht nicht wie eine IBAN/);
});

test('die IBAN wird für Listen maskiert, für die Zahlung aber vollständig gezeigt', () => {
  assert.strictEqual(payout.maskIban('DE89370400440532013000'), 'DE89 **** **** **** **30 00');
  assert.strictEqual(payout.formatIban('DE89370400440532013000'), 'DE89 3704 0044 0532 0130 00');
  assert.strictEqual(payout.maskEmail('vorname.nachname@example.de'), 'vo**************@example.de');
});

test('SEPA: vollständiges Formular geht durch, Felder werden normalisiert', () => {
  const { values, errors } = payout.validatePayout({
    method: 'sepa',
    account_holder: '  Marco   Vellucci ',
    iban: 'de89 3704 0044 0532 0130 00',
    bic: 'cobadeff370',
    street: 'Musterweg 4',
    postal_code: '88471',
    city: 'Laupheim',
    country: 'de',
    tax_status: 'kleinunternehmer',
  });

  assert.deepStrictEqual(errors, {});
  assert.strictEqual(values.account_holder, 'Marco Vellucci', 'doppelte Leerzeichen fliegen raus');
  assert.strictEqual(values.iban, 'DE89370400440532013000');
  assert.strictEqual(values.bic, 'COBADEFF370');
  assert.strictEqual(values.country, 'DE');
});

test('PayPal: die IBAN-Felder werden geleert statt mitgeschleppt', () => {
  const { values, errors } = payout.validatePayout({
    method: 'paypal',
    account_holder: 'Marco Vellucci',
    iban: 'DE89370400440532013000',
    bic: 'COBADEFF370',
    paypal_email: 'Marco@Example.DE',
    street: 'Musterweg 4',
    postal_code: '88471',
    city: 'Laupheim',
    tax_status: 'kleinunternehmer',
  });

  assert.deepStrictEqual(errors, {});
  assert.strictEqual(values.paypal_email, 'marco@example.de');
  assert.strictEqual(values.iban, '', 'bei PayPal wird keine IBAN gespeichert');
  assert.strictEqual(values.bic, '');
});

test('bei PayPal ohne Adresse gibt es einen Fehler am richtigen Feld', () => {
  const { errors } = payout.validatePayout({
    method: 'paypal',
    account_holder: 'Marco Vellucci',
    street: 'Musterweg 4',
    postal_code: '88471',
    city: 'Laupheim',
  });
  assert.ok(errors.paypal_email);
  assert.ok(!errors.iban, 'die IBAN darf bei PayPal nicht bemängelt werden');
});

test('Regelbesteuerung ohne Steuernummer wird abgelehnt', () => {
  const base = {
    method: 'sepa',
    account_holder: 'Marco Vellucci',
    iban: 'DE89370400440532013000',
    street: 'Musterweg 4',
    postal_code: '88471',
    city: 'Laupheim',
  };

  const ohne = payout.validatePayout({ ...base, tax_status: 'regelbesteuert' });
  assert.ok(ohne.errors.tax_id, 'ohne Nummer lässt sich keine Gutschrift schreiben');

  const mit = payout.validatePayout({ ...base, tax_status: 'regelbesteuert', tax_id: 'DE123456789' });
  assert.deepStrictEqual(mit.errors, {});
  assert.strictEqual(mit.values.tax_id, 'DE123456789');

  const klein = payout.validatePayout({ ...base, tax_status: 'kleinunternehmer' });
  assert.deepStrictEqual(klein.errors, {}, 'Kleinunternehmer brauchen keine Nummer');
});

test('Anschrift ist Pflicht, weil sie auf die Abrechnung muss', () => {
  const { errors } = payout.validatePayout({
    method: 'sepa',
    account_holder: 'Marco Vellucci',
    iban: 'DE89370400440532013000',
  });
  assert.ok(errors.street);
  assert.ok(errors.postal_code);
  assert.ok(errors.city);
});

test('unbekannte Werte fallen auf sichere Vorgaben zurück', () => {
  const { values } = payout.validatePayout({
    method: 'bitcoin',
    tax_status: 'egal',
    country: 'Deutschland',
    account_holder: 'Marco Vellucci',
    iban: 'DE89370400440532013000',
    street: 'Musterweg 4',
    postal_code: '88471',
    city: 'Laupheim',
  });
  assert.strictEqual(values.method, 'sepa');
  assert.strictEqual(values.tax_status, 'kleinunternehmer');
  assert.strictEqual(values.country, 'DE');
});
