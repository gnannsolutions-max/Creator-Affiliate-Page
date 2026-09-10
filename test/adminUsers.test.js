'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const users = require('../src/lib/adminUsers');

test('Ein Passwort lässt sich prüfen, steht aber nirgends im Klartext', () => {
  const stored = users.hashPassword('drei zufaellige woerter');
  assert.ok(stored.startsWith('scrypt$'));
  assert.ok(!stored.includes('drei zufaellige woerter'));
  assert.equal(users.verifyPassword('drei zufaellige woerter', stored), true);
  assert.equal(users.verifyPassword('Drei zufaellige woerter', stored), false);
  assert.equal(users.verifyPassword('', stored), false);
});

test('Zweimal dasselbe Passwort ergibt zwei verschiedene Speicherwerte', () => {
  // Wegen des Zufallssalzes – sonst verrät die Datenbank, wer dasselbe
  // Passwort benutzt.
  const a = users.hashPassword('gleiches passwort hier');
  const b = users.hashPassword('gleiches passwort hier');
  assert.notEqual(a, b);
  assert.equal(users.verifyPassword('gleiches passwort hier', a), true);
  assert.equal(users.verifyPassword('gleiches passwort hier', b), true);
});

test('Kaputte oder fehlende Speicherwerte führen nicht zum Absturz', () => {
  for (const junk of ['', null, undefined, 'quatsch', 'scrypt$nurzwei', 'md5$aa$bb']) {
    assert.equal(users.verifyPassword('irgendwas', junk), false);
  }
});

test('Zu kurze Passwörter werden abgelehnt', () => {
  assert.ok(users.passwordIssue('kurz'));
  assert.ok(users.passwordIssue('elfzeichen'));
  assert.equal(users.passwordIssue('zwoelfzeiche'), null);
  assert.ok(users.passwordIssue('x'.repeat(201)));
});

test('Die Eingabeprüfung fängt Name, Adresse und Passwort ab', () => {
  const { values, errors } = users.validate({ name: 'A', email: 'keine-adresse', password: 'kurz' });
  assert.ok(errors.name);
  assert.ok(errors.email);
  assert.ok(errors.password);
  // Unbekannte Rollen fallen auf die harmlosere zurück, nicht auf owner.
  assert.equal(values.role, 'manager');
});

test('Eine gültige Eingabe kommt ohne Fehler durch', () => {
  const { values, errors } = users.validate({
    name: 'Jana Beispiel',
    email: 'Jana@Beispiel.DE',
    role: 'manager',
    password: 'drei zufaellige woerter',
  });
  assert.deepEqual(errors, {});
  assert.equal(values.email_norm, 'jana@beispiel.de');
  assert.equal(values.email, 'Jana@Beispiel.DE');
});

test('Die Rolle owner lässt sich nur ausdrücklich setzen', () => {
  assert.equal(users.validate({ name: 'X Y', email: 'a@b.de', password: 'zwoelfzeichen' }).values.role, 'manager');
  assert.equal(
    users.validate({ name: 'X Y', email: 'a@b.de', role: 'owner', password: 'zwoelfzeichen' }).values.role,
    'owner'
  );
  assert.equal(
    users.validate({ name: 'X Y', email: 'a@b.de', role: 'superadmin', password: 'zwoelfzeichen' }).values.role,
    'manager'
  );
});

test('Rollen sind beschriftet', () => {
  assert.deepEqual(users.ROLE_KEYS, ['owner', 'manager']);
  assert.equal(users.roleLabel('manager'), 'Creator Success');
  assert.equal(users.roleLabel('unbekannt'), 'unbekannt');
});
