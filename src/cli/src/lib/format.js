'use strict';

const config = require('../config');

const currencyFmt = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: config.program.currency,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const currencyShortFmt = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: config.program.currency,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const numberFmt = new Intl.NumberFormat('de-DE');

const money = (n) => currencyFmt.format(Number(n) || 0);
const moneyShort = (n) => currencyShortFmt.format(Number(n) || 0);
const num = (n) => numberFmt.format(Number(n) || 0);

function percent(n, digits = 0) {
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(n) || 0)} %`;
}

/** Veränderung gegenüber Vorperiode, als Objekt für die Kennzahlkachel. */
function delta(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) {
    if (cur === 0) return { text: 'keine Vorperiode', direction: 'flat' };
    return { text: 'neu', direction: 'up' };
  }
  const change = ((cur - prev) / prev) * 100;
  const direction = change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'flat';
  const sign = change > 0 ? '+' : '';
  return {
    text: `${sign}${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(change)} %`,
    direction,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_LABELS = {
  confirmed: 'Bestätigt',
  pending: 'Offen',
  refunded: 'Retoure',
  cancelled: 'Storniert',
  approved: 'Freigegeben',
  rejected: 'Abgelehnt',
  paused: 'Pausiert',
  open: 'Offen',
  paid: 'Ausgezahlt',
};

const statusLabel = (s) => STATUS_LABELS[s] || s;

module.exports = { money, moneyShort, num, percent, delta, escapeHtml, statusLabel };
