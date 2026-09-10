'use strict';

const db = require('../db');
const { normalizeHandle } = require('./validate');
const { localDate, TZ } = require('./dates');

/**
 * Akquise: Creator, die angeschrieben wurden, aber noch keine Bewerbung
 * abgeschickt haben.
 *
 * Bewusst kurz gehalten. Vier Stufen, ein Termin, eine Wiedervorlage, eine
 * Notiz. Ein Werkzeug, das man nach jedem Instagram-Chat in zehn Sekunden
 * nachzieht, wird benutzt; eines mit fünfzehn Feldern nicht.
 */

const STATUS = [
  { key: 'contacted', label: 'Angeschrieben' },
  { key: 'meeting', label: 'Termin' },
  { key: 'won', label: 'Zugesagt' },
  { key: 'lost', label: 'Abgesagt' },
];

const STATUS_KEYS = STATUS.map((s) => s.key);
const statusLabel = (key) => (STATUS.find((s) => s.key === key) || {}).label || key;

/** Offen heißt: steht noch an. Zu- und Abgesagte sind abgeschlossen. */
const OPEN = ['contacted', 'meeting'];

/**
 * Zerlegt eine Eingabe mit mehreren Handles. Erlaubt ist alles, was beim
 * Kopieren aus Instagram anfällt: eine Zeile pro Konto, Kommas, @-Zeichen,
 * ganze Profiladressen.
 */
function parseHandles(raw) {
  return [
    ...new Set(
      String(raw || '')
        .split(/[\s,;]+/)
        .map((part) => normalizeHandle(part, 'instagram'))
        .filter((h) => /^[A-Za-z0-9._]{2,40}$/.test(h))
        .map((h) => h)
    ),
  ];
}

/** Instagram-Adresse zum Antippen – öffnet am Handy direkt die App. */
const profileUrl = (handle) => `https://instagram.com/${encodeURIComponent(handle)}`;

/**
 * Legt mehrere Leads auf einmal an. Bereits vorhandene Handles werden nicht
 * überschrieben und nicht doppelt angelegt, sondern gezählt und gemeldet.
 */
async function addMany(raw) {
  const handles = parseHandles(raw);
  if (!handles.length) return { added: 0, skipped: 0, handles: [] };

  let added = 0;
  for (const handle of handles) {
    const row = await db.one(
      `INSERT INTO leads (instagram, instagram_norm, status)
       VALUES ($1, $2, 'contacted')
       ON CONFLICT (instagram_norm) DO NOTHING
       RETURNING id`,
      [handle, handle.toLowerCase()]
    );
    if (row) added += 1;
  }
  return { added, skipped: handles.length - added, handles };
}

/**
 * Alle Leads, offene zuerst, innerhalb dessen nach Dringlichkeit.
 *
 * Datum und Termin kommen bewusst als Text aus der Datenbank und nicht als
 * Date-Objekt: So lassen sie sich ohne Umrechnung direkt in <input type="date">
 * bzw. <input type="datetime-local"> setzen und mit Zeichenketten vergleichen.
 * Beim Umweg über ein Date-Objekt verschiebt die Zeitzone sonst gern um einen Tag.
 */
async function all() {
  return db.many(
    `SELECT l.id, l.instagram, l.instagram_norm, l.full_name, l.status, l.note,
            l.creator_id, l.created_at, l.updated_at,
            to_char(l.follow_up_on, 'YYYY-MM-DD')                        AS follow_up_on,
            to_char(l.meeting_at AT TIME ZONE $1, 'YYYY-MM-DD"T"HH24:MI') AS meeting_local,
            l.meeting_at,
            c.full_name AS creator_name, c.status AS creator_status
       FROM leads l
       LEFT JOIN creators c ON c.id = l.creator_id
      ORDER BY
        CASE l.status WHEN 'meeting' THEN 0 WHEN 'contacted' THEN 1
                      WHEN 'won' THEN 2 ELSE 3 END,
        l.follow_up_on NULLS LAST,
        l.meeting_at NULLS LAST,
        l.created_at DESC`,
    [TZ]
  );
}

async function byId(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return db.one('SELECT * FROM leads WHERE id = $1', [numeric]);
}

/**
 * Speichert die Felder eines Leads. Leere Eingaben löschen den jeweiligen
 * Wert – ein Termin, den es nicht mehr gibt, soll auch verschwinden können.
 */
async function save(id, body = {}) {
  const status = STATUS_KEYS.includes(body.status) ? body.status : 'contacted';
  const meeting = String(body.meeting_at || '').trim();
  const followUp = String(body.follow_up_on || '').trim();

  // Das Terminfeld liefert Ortszeit ohne Zeitzone („2026-09-15T14:00“). Erst als
  // timestamp lesen und dann mit AT TIME ZONE einordnen – ein direkter Cast auf
  // timestamptz würde die Angabe als UTC verstehen und den Termin verschieben.
  await db.run(
    `UPDATE leads SET
       full_name    = NULLIF($2, ''),
       status       = $3,
       meeting_at   = CASE WHEN $4 = '' THEN NULL
                           ELSE ($4::timestamp AT TIME ZONE $7) END,
       follow_up_on = CASE WHEN $5 = '' THEN NULL ELSE $5::date END,
       note         = NULLIF($6, ''),
       updated_at   = now()
     WHERE id = $1`,
    [
      Number(id),
      String(body.full_name || '').trim().slice(0, 120),
      status,
      meeting,
      followUp,
      String(body.note || '').trim().slice(0, 2000),
      TZ,
    ]
  );
}

async function remove(id) {
  await db.run('DELETE FROM leads WHERE id = $1', [Number(id)]);
}

/**
 * Verknüpft einen Lead mit der eingegangenen Bewerbung. Wird aus dem
 * Bewerbungsformular aufgerufen, wenn jemand über seinen persönlichen Link
 * gekommen ist (`?src=lead-17`). Schlägt das fehl, ist das folgenlos: Die
 * Bewerbung steht trotzdem im Adminbereich.
 */
async function linkFromSource(source, creatorId) {
  const match = /^lead-(\d+)$/.exec(String(source || '').trim());
  if (!match) return false;
  const row = await db.one(
    `UPDATE leads SET creator_id = $2, status = 'won', updated_at = now()
      WHERE id = $1 AND creator_id IS NULL
      RETURNING id`,
    [Number(match[1]), creatorId]
  );
  return Boolean(row);
}

/** Der persönliche Bewerbungslink für einen Lead. */
const applyUrl = (baseUrl, lead) => `${baseUrl}/bewerben?src=lead-${lead.id}`;

/**
 * Zahlen für die Übersichtsseite: was heute ansteht und was überfällig ist.
 * Ohne diese Zahl auf der Startseite des Adminbereichs vergisst man die
 * Wiedervorlage – und genau daran sterben die meisten Gespräche.
 */
async function summary() {
  const today = localDate();
  return db.one(
    `SELECT
       COUNT(*) FILTER (WHERE status = ANY($2))                                   AS open,
       COUNT(*) FILTER (WHERE status = ANY($2) AND follow_up_on <= $1::date)      AS due,
       COUNT(*) FILTER (WHERE status = 'meeting' AND meeting_at >= now())         AS upcoming,
       COUNT(*) FILTER (WHERE status = 'won' AND creator_id IS NULL)              AS awaiting
     FROM leads`,
    [today, OPEN]
  );
}

module.exports = {
  STATUS,
  STATUS_KEYS,
  OPEN,
  statusLabel,
  parseHandles,
  profileUrl,
  applyUrl,
  addMany,
  all,
  byId,
  save,
  remove,
  linkFromSource,
  summary,
};
