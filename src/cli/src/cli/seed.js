'use strict';

// Legt Demo-Daten an, damit sich der komplette Ablauf anschauen lässt:
//   node src/cli/seed.js
// Nicht in Produktion ausführen.

const config = require('../config');
const db = require('../db');
const { buildSnapshot } = require('../services/snapshot');
const { localDate, addDays } = require('../lib/dates');

const demo = [
  { name: 'Luan Vellucci', email: 'luan@example.de', ig: 'luan.skin', tt: 'luan.skin', yt: null, code: 'LUAN15', rate: 15, status: 'approved' },
  { name: 'Mira Hoffmann', email: 'mira@example.de', ig: 'mirabeauty', tt: null, yt: 'mirabeauty', code: 'MIRA10', rate: 12, status: 'approved' },
  { name: 'Jonas Brandt', email: 'jonas@example.de', ig: 'jonasroutine', tt: 'jonasroutine', yt: null, code: 'JONAS12', rate: 15, status: 'approved' },
  { name: 'Sarah Kern', email: 'sarah@example.de', ig: 'sarah.kern', tt: null, yt: null, code: 'SARAH20', rate: 15, status: 'pending' },
  { name: 'Nico Wagner', email: 'nico@example.de', ig: 'nicowagner', tt: 'nicowagner', yt: null, code: 'NICO', rate: 15, status: 'pending' },
];

async function main() {
  if (config.isProd) {
    console.error('Seed ist in Produktion gesperrt.');
    process.exit(1);
  }

  await db.migrate();

  for (const d of demo) {
    const approved = d.status === 'approved';
    await db.run(
      `INSERT INTO creators (
         full_name, email, email_norm, instagram, tiktok, youtube, requested_code,
         assigned_code, assigned_code_norm, status, commission_rate, customer_discount,
         source, terms_version, terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'seed',$13, now())
       ON CONFLICT (email_norm) DO NOTHING`,
      [
        d.name, d.email, d.email.toLowerCase(), d.ig, d.tt, d.yt, d.code,
        approved ? d.code : null, approved ? d.code : null,
        d.status, d.rate, config.program.defaultCustomerDiscount, config.termsVersion,
      ]
    );
  }

  const today = localDate();
  const patterns = {
    LUAN15: (i) => (i % 7 === 0 ? 4 : i > 30 ? 2 : 1),
    MIRA10: (i) => (i % 3 === 0 ? 2 : 0),
    JONAS12: (i) => (i > 38 ? 3 : i % 5 === 0 ? 1 : 0),
  };

  const rows = [];
  let ref = 5000;
  for (let dayOffset = 44; dayOffset >= 0; dayOffset -= 1) {
    const date = addDays(today, -dayOffset);
    const i = 44 - dayOffset;
    for (const [code, fn] of Object.entries(patterns)) {
      for (let n = 0; n < fn(i); n += 1) {
        ref += 1;
        const gross = Math.round((39 + Math.random() * 120) * 100) / 100;
        rows.push([
          String(ref),
          code,
          date,
          gross,
          Math.round(gross * 0.84 * 100) / 100,
          Math.random() < 0.06 ? 'refunded' : 'confirmed',
        ]);
      }
    }
  }

  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = [];
    const placeholders = chunk.map((r, idx) => {
      const b = idx * 6;
      values.push(...r);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
    });
    await db.run(
      `INSERT INTO sales (order_ref, code_norm, order_date, gross_amount, net_amount, status)
       VALUES ${placeholders.join(',')} ON CONFLICT (order_ref) DO NOTHING`,
      values
    );
  }

  await db.run(
    `INSERT INTO payouts (creator_id, period, amount, status, paid_at)
     SELECT id, $1, 120.50, 'paid', $2 FROM creators WHERE assigned_code_norm = 'LUAN15'
     ON CONFLICT (creator_id, period) DO NOTHING`,
    [addDays(today, -40).slice(0, 7), addDays(today, -25)]
  );

  const result = await buildSnapshot({ triggeredBy: 'seed' });

  console.log(`Demo-Daten angelegt: ${demo.length} Creator, ${rows.length} Bestellungen.`);
  console.log(`Snapshot ${result.runId} erzeugt.`);
  console.log('\nAdmin: /admin/login mit dem Passwort aus ADMIN_PASSWORD.');
  console.log('Creator-Login: /login mit luan@example.de anfordern, den Link');
  console.log('danach unter /admin/mails abholen (oder im Adminbereich direkt erzeugen).');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error(err);
    await db.close().catch(() => {});
    process.exit(1);
  });
