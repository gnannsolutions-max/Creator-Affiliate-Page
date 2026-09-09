'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { dashboardFor } = require('../services/snapshot');
const { barChart } = require('../lib/chart');
const payout = require('../lib/payout');
const brandsLib = require('../lib/brands');

const router = express.Router();

router.get('/dashboard', auth.requireApprovedCreator, async (req, res) => {
  const [data, payouts, bank, codes] = await Promise.all([
    dashboardFor(req.creator.id),
    db.many('SELECT * FROM payouts WHERE creator_id = $1 ORDER BY period DESC', [req.creator.id]),
    payout.load(req.creator.id),
    brandsLib.codesFor(req.creator.id),
  ]);

  // Zahlen je Marke aus dem Snapshot an den jeweiligen Code hängen, damit die
  // Karte im Dashboard Link und Umsatz zusammen zeigt.
  const byBrand = Object.fromEntries((data?.brands || []).map((b) => [String(b.brand_id), b]));
  const brandCards = codes
    .filter((row) => row.status === 'active')
    .map((row) => ({ ...row, totals: byBrand[String(row.brand_id)] || null }));

  res.render('dashboard', {
    title: 'Dashboard',
    nav: 'dashboard',
    run: data?.run || null,
    totals: data?.totals || null,
    orders: data?.orders || [],
    payouts,
    brandCards,
    hasPayoutDetails: Boolean(bank),
    chartHtml: data?.days?.length ? barChart(data.days) : '',
  });
});

// --- Zahlungsempfänger -------------------------------------------------------

/** Baut die Formularwerte aus einem gespeicherten Datensatz. */
function formValues(row) {
  if (!row) return { method: 'sepa', country: 'DE', tax_status: 'kleinunternehmer' };
  return {
    method: row.method,
    account_holder: row.account_holder,
    iban: payout.formatIban(row.iban),
    bic: row.bic || '',
    paypal_email: row.paypal_email || '',
    street: row.street,
    postal_code: row.postal_code,
    city: row.city,
    country: row.country,
    tax_status: row.tax_status,
    tax_id: row.tax_id || '',
  };
}

router.get('/auszahlung', auth.requireApprovedCreator, async (req, res) => {
  const row = await payout.load(req.creator.id);
  res.render('payout', {
    title: 'Auszahlung',
    nav: 'payout',
    values: formValues(row),
    errors: {},
    saved: Boolean(req.query.ok),
    updatedAt: row?.updated_at || null,
    countries: payout.COUNTRIES,
    taxStatus: payout.TAX_STATUS,
  });
});

router.post('/auszahlung', auth.requireApprovedCreator, async (req, res) => {
  const { values, errors } = payout.validatePayout(req.body);

  if (Object.keys(errors).length) {
    return res.status(400).render('payout', {
      title: 'Auszahlung',
      nav: 'payout',
      values: { ...values, iban: req.body.iban || '' },
      errors,
      saved: false,
      updatedAt: null,
      countries: payout.COUNTRIES,
      taxStatus: payout.TAX_STATUS,
    });
  }

  await payout.save(req.creator.id, values);

  // Bewusst ohne Kontodaten im Protokoll – dort steht nur, dass sich etwas
  // geändert hat, nicht was.
  await db.log(
    'creator',
    'payout.details.saved',
    req.creator.email,
    `Auszahlungsweg ${values.method === 'sepa' ? 'Überweisung' : 'PayPal'}`
  );

  res.redirect('/auszahlung?ok=1');
});

router.get('/regeln', auth.requireApprovedCreator, (req, res) => {
  res.render('rules', { title: 'Werberegeln', nav: 'rules' });
});

module.exports = router;
