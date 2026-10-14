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

  const rawHeader = (records.shift() || []).map((h) => String(h).trim());
  const header = rawHeader.map((h) => h.toLowerCase().replace(/^"|"$/g, ''));
  const rows = records
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((key, idx) => {
        obj[key] = (r[idx] ?? '').trim();
      });
      return obj;
    });

  return { header, rawHeader, rows, delimiter };
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

// =============================================================================
//  Zweites Format: der Shop-Export mit Umsatz je Creator
//
//  Drei Spalten, keine Bestellnummer, kein Datum, kein Code:
//    Nettoumsatz ; Creatorbeteiligung in % ; Creatorname
//  Jede Zeile ist eine Bestellung. Wer sie verkauft hat, steht als Name drin,
//  und wie viel davon dem Creator zusteht, liefert der Shop gleich mit.
// =============================================================================

const SHARE_ALIASES = {
  net_amount: [
    'nettoumsatz', 'netto-umsatz', 'netto umsatz', 'umsatz netto', 'umsatz (netto)', 'netto',
    'net_amount', 'net amount', 'net', 'net revenue', 'revenue', 'umsatz', 'betrag', 'summe',
    'bestellwert', 'subtotal', 'zwischensumme', 'provisionsbasis',
  ],
  commission_rate: [
    'creatorbeteiligung', 'creatorbeteiligung in %', 'creatorbeteiligung (%)', 'creator-beteiligung',
    'creator beteiligung', 'beteiligung', 'beteiligung in %', 'beteiligung (%)', 'beteiligung %',
    'provision', 'provision in %', 'provision (%)', 'provision %', 'provisionssatz', 'satz',
    'anteil', 'anteil in %', 'commission', 'commission_rate', 'commission rate', 'rate', 'share', '%',
  ],
  creator_name: [
    'creatorname', 'creator-name', 'creator name', 'creator', 'name', 'creatorin', 'influencer',
    'partner', 'partnername', 'affiliate', 'vermittler', 'verkäufer', 'verkaufer', 'verkauft über',
    'verkauft ueber', 'verkauft durch',
  ],
};

function cleanHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Ordnet Spaltenüberschriften den drei Feldern zu. Erst exakte Aliase, dann
 * Schlüsselwörter im Text („Netto“, „Beteiligung“, „Creator“) – Shops
 * schreiben gern Varianten wie „Netto-Umsatz (EUR)“.
 */
function mapShareColumns(header) {
  const clean = header.map(cleanHeader);
  const mapping = {};
  const taken = new Set();

  for (const [field, aliases] of Object.entries(SHARE_ALIASES)) {
    const idx = clean.findIndex((h, i) => !taken.has(i) && aliases.includes(h));
    if (idx !== -1) {
      mapping[field] = header[idx];
      taken.add(idx);
    }
  }

  const keyword = (field, test) => {
    if (mapping[field]) return;
    const idx = clean.findIndex((h, i) => !taken.has(i) && test(h));
    if (idx !== -1) {
      mapping[field] = header[idx];
      taken.add(idx);
    }
  };
  keyword('commission_rate', (h) => /beteilig|provision|anteil|commission|%|prozent|satz/.test(h));
  keyword('net_amount', (h) => /netto|umsatz|betrag|revenue|amount|summe|wert/.test(h));
  keyword('creator_name', (h) => /creator|name|influencer|partner|affiliate/.test(h));

  return mapping;
}

/**
 * Erkennt, welches der beiden Formate eine Datei hat.
 *   'orders' – Bestellliste mit Bestellnummer und Rabattcode (bisheriger Weg)
 *   'shares' – Umsatz je Creator mit Name und Beteiligung
 *   null     – keins von beiden
 */
function detectFormat(header) {
  const orders = mapColumns(header);
  if (orders.order_ref && orders.code && orders.order_date) return 'orders';
  const shares = mapShareColumns(header);
  if (shares.net_amount && shares.commission_rate && shares.creator_name) return 'shares';
  return null;
}

/** Prozentsatz lesen: „30 %“, „30“, „0,3“ → 30 */
function parseRate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = parseNumber(raw);
  if (n === null) return null;
  // Ohne Prozentzeichen und kleiner als 1 ist es ein Bruch (0,3 = 30 %).
  if (!raw.includes('%') && n > 0 && n < 1) return Math.round(n * 10000) / 100;
  return Math.round(n * 100) / 100;
}

/**
 * Creatornamen so vereinheitlichen, dass „Max Mustermann“, „max-mustermann“
 * und „MAXMUSTERMANN“ dieselbe Person treffen. Umlaute werden aufgelöst,
 * damit „Jörg“ und „Joerg“ beide zum selben Eintrag führen.
 */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Hat die Datei keine Überschriften, sondern fängt direkt mit Daten an? Dann
 * raten wir die Spalten am Inhalt: Die Textspalte ist der Name, von den
 * beiden Zahlenspalten ist die mit Prozentzeichen oder ganzzahligen Werten
 * bis 100 die Beteiligung, die andere der Umsatz.
 */
function guessHeaderlessShares(records) {
  if (!records.length || records[0].length !== 3) return null;
  const sample = records.slice(0, 25);
  const isNumeric = (v) => parseNumber(v) !== null && /^[\s\d.,%€$-]+$/.test(String(v));
  const cols = [0, 1, 2].map((i) => ({
    i,
    numeric: sample.every((r) => isNumeric(r[i])),
    pct: sample.some((r) => String(r[i]).includes('%')),
    maxVal: Math.max(...sample.map((r) => Math.abs(parseNumber(r[i]) ?? 0))),
    integerish: sample.every((r) => Number.isInteger(parseNumber(r[i]) ?? 0.5)),
  }));
  const text = cols.filter((c) => !c.numeric);
  const nums = cols.filter((c) => c.numeric);
  if (text.length !== 1 || nums.length !== 2) return null;

  let rate = nums.find((c) => c.pct);
  if (!rate) rate = nums.find((c) => c.integerish && c.maxVal <= 100 && !nums.every((n) => n.integerish && n.maxVal <= 100));
  if (!rate) rate = nums.reduce((a, b) => (a.maxVal <= b.maxVal ? a : b));
  const net = nums.find((c) => c !== rate);
  return { net_amount: net.i, commission_rate: rate.i, creator_name: text[0].i };
}

/**
 * Wandelt den Shop-Export in Umsatzzeilen um.
 * @returns {{rows: Array, problems: Array<string>, mapping: object, total: number, headerless: boolean}}
 */
function parseCreatorSharesCsv(text) {
  const { header, rawHeader, rows } = parseCsv(text);
  const problems = [];
  let mapping = mapShareColumns(header);
  let headerless = false;
  let records = rows.map((r) => header.map((h) => r[h]));

  if (!(mapping.net_amount && mapping.commission_rate && mapping.creator_name)) {
    // Vielleicht gibt es gar keine Überschriftszeile.
    const all = [rawHeader, ...records].filter((r) => r.some((v) => String(v ?? '').trim() !== ''));
    const guess = guessHeaderlessShares(all);
    if (!guess) {
      problems.push(
        `Spalten nicht erkannt – erwartet werden Nettoumsatz, Creatorbeteiligung in % und Creatorname (erkannte Spalten: ${
          header.join(', ') || 'keine'
        }).`
      );
      return { rows: [], problems, mapping, total: rows.length, headerless: false };
    }
    headerless = true;
    records = all;
    mapping = {
      net_amount: `Spalte ${guess.net_amount + 1}`,
      commission_rate: `Spalte ${guess.commission_rate + 1}`,
      creator_name: `Spalte ${guess.creator_name + 1}`,
    };
    problems.push('Keine Überschriften erkannt – die Spalten wurden anhand des Inhalts zugeordnet. Bitte das Ergebnis prüfen.');
    const idx = guess;
    return finish(records.map((r) => [r[idx.net_amount], r[idx.commission_rate], r[idx.creator_name]]));
  }

  const hi = {
    net: header.indexOf(mapping.net_amount),
    rate: header.indexOf(mapping.commission_rate),
    name: header.indexOf(mapping.creator_name),
  };
  return finish(records.map((r) => [r[hi.net], r[hi.rate], r[hi.name]]));

  function finish(triples) {
    const out = [];
    triples.forEach(([netRaw, rateRaw, nameRaw], index) => {
      const line = index + (headerless ? 1 : 2);
      const name = String(nameRaw ?? '').trim();
      const net = parseNumber(netRaw);
      const rate = parseRate(rateRaw);
      if (!name) return problems.push(`Zeile ${line}: kein Creatorname – übersprungen.`);
      if (net === null) return problems.push(`Zeile ${line}: Umsatz nicht lesbar – übersprungen.`);
      if (rate === null) return problems.push(`Zeile ${line}: Beteiligung nicht lesbar – übersprungen.`);
      if (rate < 0 || rate > 100) return problems.push(`Zeile ${line}: Beteiligung ${rate} % ist unplausibel – übersprungen.`);
      out.push({
        creator_name: name,
        name_norm: normalizeName(name),
        net_amount: Math.round(net * 100) / 100,
        commission_rate: rate,
      });
    });
    return { rows: out, problems, mapping, total: triples.length, headerless };
  }
}

module.exports = {
  parseCsv,
  parseSalesCsv,
  parseCreatorSharesCsv,
  detectFormat,
  mapShareColumns,
  parseNumber,
  parseDate,
  parseRate,
  normalizeStatus,
  normalizeName,
};
