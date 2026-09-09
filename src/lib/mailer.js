'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');

let transport = null;
if (config.mail.host) {
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
}

const hasSmtp = () => Boolean(transport);

/**
 * Legt die Nachricht immer im Ausgangspostfach ab und verschickt sie, wenn ein
 * SMTP-Zugang konfiguriert ist.
 *
 * Ohne SMTP ist das kein Fehlerfall: Der Adminbereich zeigt die Nachricht unter
 * /admin/mails samt Login-Link an, und ihr schickt sie dem Creator auf dem Weg,
 * über den ihr ohnehin schon schreibt. Dadurch ist das Portal auch ohne einen
 * zusätzlichen Maildienst vollständig benutzbar.
 */
async function send({ to, subject, text, kind = 'info', link = null }) {
  const row = await db
    .one(
      `INSERT INTO outbox (recipient, subject, body, kind, link, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [to, subject, text, kind, link]
    )
    .catch((err) => {
      console.error('Ausgangspostfach nicht beschreibbar:', err.message);
      return null;
    });

  if (!transport) {
    console.log(`[Mail ohne SMTP] an ${to}: ${subject}${link ? ` – ${link}` : ''}`);
    return { sent: false, id: row?.id ?? null };
  }

  try {
    await transport.sendMail({ from: config.mail.from, to, subject, text });
    if (row) await db.run("UPDATE outbox SET status = 'sent' WHERE id = $1", [row.id]);
    return { sent: true, id: row?.id ?? null };
  } catch (err) {
    console.error('Mailversand fehlgeschlagen:', err.message);
    if (row) {
      await db
        .run("UPDATE outbox SET status = 'failed', error = $1 WHERE id = $2", [
          String(err.message).slice(0, 500),
          row.id,
        ])
        .catch(() => {});
    }
    return { sent: false, id: row?.id ?? null, error: err.message };
  }
}

const templates = {
  applicationReceived(creator) {
    return {
      kind: 'application',
      subject: `${config.program.name}: Bewerbung eingegangen`,
      text: `Hallo ${creator.full_name},

danke für deine Bewerbung als Creator bei ${config.program.brand}.

Dein Wunsch-Code: ${creator.requested_code}
Instagram: @${creator.instagram}

Wir prüfen deine Bewerbung und melden uns per E-Mail, sobald dein Code
freigeschaltet ist. Erst danach darfst du mit der Bewerbung starten.

Deinen Status kannst du jederzeit hier abrufen:
${config.baseUrl}/login

Viele Grüße
${config.program.brand}`,
    };
  },

  /**
   * `assignments` sind die freigegebenen Marken mit Code, Konditionen und
   * fertigem Link – genau das, was der Creator zum Loslegen braucht.
   */
  approved(creator, loginUrl, assignments = []) {
    const blocks = assignments
      .map(
        (a) => `${a.brandName}
  Dein Link:  ${a.link}
  Dein Code:  ${a.code}
  Provision:  ${a.rate} %
  Rabatt für deine Community: ${a.discount} %`
      )
      .join('\n\n');

    const subject =
      assignments.length === 1
        ? `${config.program.name}: Dein Link für ${assignments[0].brandName} ist da`
        : `${config.program.name}: Deine Links sind da (${assignments.length} Marken)`;

    return {
      kind: 'approval',
      link: loginUrl,
      subject,
      text: `Hallo ${creator.full_name},

du bist freigeschaltet – du kannst ab sofort loslegen.

${blocks}

Poste den Link, nicht nur den Code: Wer darüber kauft, bekommt den Rabatt
gleich im Warenkorb, und du musst niemandem erklären, wo er ihn eintippt.
Zugeordnet wird deine Provision trotzdem über den Code – falls jemand ihn von
Hand eingibt, zählt das genauso.

Dein Dashboard (Login ohne Passwort, Link 30 Minuten gültig):
${loginUrl}

Deine Sales werden dort jeden Tag um ${config.refresh.label} aktualisiert.

Bitte lies vor dem ersten Post die Werberegeln in deinem Dashboard.
Die wichtigsten drei Punkte:
  1. Jeder Beitrag mit deinem Code wird als Werbung gekennzeichnet.
  2. Keine Heil-, Therapie- oder Krankheitsversprechen.
  3. Keine Verlinkung auf andere Shops oder Produkte in derselben Kategorie.

Viele Grüße
${config.program.brand}`,
    };
  },

  /** Interne Benachrichtigung an den Adminbereich, nicht an den Creator. */
  newApplication(creator, adminUrl) {
    return {
      kind: 'notification',
      link: adminUrl,
      subject: `Neue Bewerbung: ${creator.full_name} (${creator.requested_code})`,
      text: `Neue Creator-Bewerbung im Portal.

Name:       ${creator.full_name}
E-Mail:     ${creator.email}
Wunsch-Code: ${creator.requested_code}
Instagram:  @${creator.instagram}${creator.tiktok ? `\nTikTok:     @${creator.tiktok}` : ''}${
        creator.youtube ? `\nYouTube:    @${creator.youtube}` : ''
      }

Prüfen und freigeben:
${adminUrl}

Diese Nachricht geht nur an euch, nicht an den Creator.`,
    };
  },

  rejected(creator) {
    return {
      kind: 'rejection',
      subject: `${config.program.name}: Rückmeldung zu deiner Bewerbung`,
      text: `Hallo ${creator.full_name},

danke für dein Interesse an ${config.program.brand}. Wir können dir aktuell
leider keinen Creator-Code vergeben.

${creator.decision_reason ? `Grund: ${creator.decision_reason}\n\n` : ''}Bei Fragen erreichst du uns unter ${config.program.supportEmail}.

Viele Grüße
${config.program.brand}`,
    };
  },

  loginLink(creator, loginUrl) {
    return {
      kind: 'login',
      link: loginUrl,
      subject: `${config.program.name}: Dein Login-Link`,
      text: `Hallo ${creator.full_name},

hier ist dein Login-Link für das Creator-Dashboard. Er ist 30 Minuten gültig
und lässt sich nur einmal verwenden:

${loginUrl}

Wenn du diesen Link nicht angefordert hast, ignoriere diese E-Mail einfach.

Viele Grüße
${config.program.brand}`,
    };
  },
};

module.exports = { send, templates, hasSmtp };
