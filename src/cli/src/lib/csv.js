'use strict';

/**
 * Kleiner, abhängigkeitsfreier CSV-Parser für die täglichen Umsatzlisten.
 * Kann mit dem umgehen, was Shopsysteme und Excel im deutschen Raum ausspucken:
 *   - Trennzeichen , ; oder Tab (wird automatisch erkannt)
 *   - Anführungszeichen inkl. verdoppelter Quotes ("" innerhalb eines Feldes)
 *   - UTF-8-BOM
 *   - Zahlen als 1.234,56 oder 1234.56
 *   - Datum als YYYY-MM-DD, DD.MM.YYYY oder ISO-Zeitstempel
 */

function detectDelimiter(firstLine) {
  const candidates = [';', ',', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === c && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

function parseCsv(text) {
  let input = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!input.trim()) return { header: [], rows: [] };

  const firstLineEnd = input.indexOf('\n');
  const delimiter = detectDelimiter(firstLineEnd === -1 ? input : input.slice(0, firstLineEnd));

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  record.push(field);
  if (record.length > 1 || record[0].trim() !== '') records.push(record);

  const header = (records.shift() || []).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const rows = records
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((key, idx) => {
        obj[key] = (r[idx] ?? '').trim();
      });
      return obj;
    });

  return { header, rows, delimiter };
}

const COLUMN_ALIASES = {
  order_ref: ['order_ref', 'bestellnummer', 'bestell-nr', 'bestellnr', 'order', 'order_id', 'order id', 'order_number', 'bestellung', 'auftragsnummer', 'id', 'name'],
  code: ['code', 'rabattcode', 'gutscheincode', 'gutschein', 'discount_code', 'discount code', 'coupon', 'coupon_code', 'affiliate_code', 'creator_code'],
  order_date: ['order_date', 'datum', 'bestelldatum', 'date', 'created_at', 'erstellt_am', 'zeitpunkt'],
  gross_amount: ['gross_amount', 'brutto', 'bruttoumsatz', 'gesamt', 'gesamtbetrag', 'total', 'total_price', 'umsatz', 'betrag'],
  net_amount: ['net_amount', 'netto', 'nettoumsatz', 'subtotal', 'zwischensumme', 'provisionsbasis', 'net'],
  status: ['status', 'bestellstatus', 'financial_status', 'zahlungsstatus'],
};

function mapColumns(header) {
  const mapping = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = header.find((h) => aliases.includes(h));
    if (found) mapping[field] = found;
  }
  return mapping;
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // deutsches Format: 1.234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // englisches Format: 1,234.56
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

const STATUS_MAP = {
  paid: 'confirmed', bezahlt: 'confirmed', confirmed: 'confirmed', abgeschlossen: 'confirmed',
  fulfilled: 'confirmed', complete: 'confirmed', completed: 'confirmed', versendet: 'confirmed',
  pending: 'pending', offen: 'pending', authorized: 'pending', reserviert: 'pending',
  refunded: 'refunded', erstattet: 'refunded', retoure: 'refunded', storniert: 'cancelled',
  cancelled: 'cancelled', canceled: 'cancelled', voided: 'cancelled',
};

function normalizeStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return 'confirmed';
  return STATUS_MAP[s] || 'confirmed';
}

/**
 * Wandelt eine CSV in geprüfte Bestellzeilen um.
 * @returns {{rows: Array, problems: Array<string>, mapping: object, total: number}}
 */
function parseSalesCsv(text) {
  const { header, rows } = parseCsv(text);
  const mapping = mapColumns(header);
  const problems = [];

  for (const required of ['order_ref', 'code', 'order_date', 'gross_amount']) {
    if (!mapping[required]) {
      problems.push(
        `Pflichtspalte fehlt: ${required} (erkannte Spalten: ${header.join(', ') || 'keine'})`
      );
    }
  }
  if (problems.length) return { rows: [], problems, mapping, total: rows.length };

  const out = [];
  rows.forEach((raw, index) => {
    const line = index + 2; // +1 Header, +1 auf 1 basierend
    const orderRef = String(raw[mapping.order_ref] || '').trim();
    const code = String(raw[mapping.code] || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const orderDate = parseDate(raw[mapping.order_date]);
    const gross = parseNumber(raw[mapping.gross_amount]);
    const net = mapping.net_amount ? parseNumber(raw[mapping.net_amount]) : null;
    const status = normalizeStatus(mapping.status ? raw[mapping.status] : '');

    if (!orderRef) return problems.push(`Zeile ${line}: Bestellnummer fehlt – übersprungen.`);
    if (!code) return problems.push(`Zeile ${line}: kein Code – übersprungen.`);
    if (!orderDate) return problems.push(`Zeile ${line}: Datum nicht lesbar – übersprungen.`);
    if (gross === null) return problems.push(`Zeile ${line}: Betrag nicht lesbar – übersprungen.`);

    out.push({
      order_ref: orderRef,
      code_norm: code,
      order_date: orderDate,
      gross_amount: Math.round(gross * 100) / 100,
      net_amount: Math.round((net === null ? gross : net) * 100) / 100,
      status,
    });
  });

  return { rows: out, problems, mapping, total: rows.length };
}

module.exports = { parseCsv, parseSalesCsv, parseNumber, parseDate, normalizeStatus };
