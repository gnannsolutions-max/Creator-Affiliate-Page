'use strict';

const config = require('../config');
const TZ = config.refresh.timezone;

/** YYYY-MM-DD in der Programm-Zeitzone (Europe/Berlin), nicht in UTC. */
function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Stunde und Minute in der Programm-Zeitzone – Basis für den Snapshot-Zeitpunkt. */
function localHourMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .split(':');
  return { hour: Number(parts[0]), minute: Number(parts[1]) };
}

function addDays(isoDate, days) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Liste von YYYY-MM-DD, aufsteigend, inklusive beider Enden. */
function dateRange(fromIso, toIso) {
  const out = [];
  let cur = fromIso;
  let guard = 0;
  while (cur <= toIso && guard < 5000) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

function formatDateDe(isoDate) {
  if (!isoDate) return '–';
  const value = isoDate instanceof Date ? isoDate.toISOString() : String(isoDate);
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** Akzeptiert ISO-String und Date – Postgres liefert TIMESTAMPTZ als Date. */
function formatDateTimeDe(value) {
  if (!value) return '–';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '–';
  return (
    new Intl.DateTimeFormat('de-DE', {
      timeZone: TZ,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d) + ' Uhr'
  );
}

function monthKey(isoDate) {
  return String(isoDate).slice(0, 7);
}

module.exports = {
  TZ,
  localDate,
  localHourMinute,
  addDays,
  dateRange,
  formatDateDe,
  formatDateTimeDe,
  monthKey,
};
