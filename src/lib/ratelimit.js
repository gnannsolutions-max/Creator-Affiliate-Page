'use strict';

const db = require('../db');

/**
 * Zähler gegen automatisierte Versuche auf den Formularen.
 *
 * Warum in der Datenbank und nicht im Arbeitsspeicher: Auf Netlify läuft die
 * Anwendung als Function. Jede Anfrage kann auf einer anderen Instanz landen,
 * und Instanzen werden ständig neu gestartet. Ein Zähler im Speicher wäre
 * dadurch wirkungslos – er würde bei jedem Kaltstart wieder bei null anfangen.
 * Die Datenbank ist der einzige Ort, den alle Instanzen gemeinsam sehen.
 *
 * Das Fenster ist bewusst fest (nicht gleitend): einfach, ohne zusätzliche
 * Tabellenzeilen pro Anfrage und für diesen Zweck genau genug.
 */

/** Ein Treffer auf den Zähler. Gibt zurück, ob die Anfrage durchgelassen wird. */
async function hit(bucket, { limit, windowSeconds }) {
  try {
    const row = await db.one(
      `INSERT INTO rate_limits (bucket, hits, window_start)
       VALUES ($1, 1, now())
       ON CONFLICT (bucket) DO UPDATE SET
         hits = CASE
           WHEN rate_limits.window_start < now() - make_interval(secs => $2::double precision)
           THEN 1 ELSE rate_limits.hits + 1 END,
         window_start = CASE
           WHEN rate_limits.window_start < now() - make_interval(secs => $2::double precision)
           THEN now() ELSE rate_limits.window_start END
       RETURNING hits, window_start`,
      [bucket, windowSeconds]
    );

    const hits = Number(row.hits);
    const started = new Date(row.window_start).getTime();
    const retryAfter = Math.max(1, Math.ceil((started + windowSeconds * 1000 - Date.now()) / 1000));
    return { allowed: hits <= limit, hits, retryAfter };
  } catch (err) {
    // Ist die Datenbank kurz nicht erreichbar, darf das Formular nicht komplett
    // ausfallen. Die Sperre ist ein Schutz vor Masse, keine Zugangskontrolle –
    // im Zweifel wird durchgelassen und der Vorfall protokolliert.
    console.error('Rate-Limit nicht prüfbar:', err.message);
    return { allowed: true, hits: 0, retryAfter: 0, degraded: true };
  }
}

/** Setzt den Zähler zurück – nach einem erfolgreichen Login sinnvoll. */
async function clear(bucket) {
  await db.run('DELETE FROM rate_limits WHERE bucket = $1', [bucket]).catch(() => {});
}

/**
 * Die Adresse des Anfragenden. Hinter dem Netlify-CDN steht die echte Adresse
 * im ersten Eintrag von x-forwarded-for; express liefert sie über req.ip,
 * weil in app.js `trust proxy` gesetzt ist. Der Rückfallwert verhindert nur,
 * dass der Schlüssel leer wird.
 */
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unbekannt';
}

/** Aufräumen: alte Zeilen verfallen ohnehin, sollen die Tabelle aber nicht füllen. */
async function prune(maxAgeHours = 24) {
  await db
    .run(
      `DELETE FROM rate_limits
        WHERE window_start < now() - make_interval(hours => $1::double precision)`,
      [maxAgeHours]
    )
    .catch(() => {});
}

module.exports = { hit, clear, clientIp, prune };
