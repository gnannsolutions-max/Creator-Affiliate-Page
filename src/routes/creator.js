'use strict';

const express = require('express');
const auth = require('../lib/auth');
const { dashboardFor } = require('../services/snapshot');
const { barChart } = require('../lib/chart');
const brandsLib = require('../lib/brands');
const { nextRefreshLabel } = require('../lib/dates');

const router = express.Router();

router.get('/dashboard', auth.requireApprovedCreator, async (req, res) => {
  const [data, codes] = await Promise.all([
    dashboardFor(req.creator.id),
    brandsLib.codesFor(req.creator.id),
  ]);

  // Eine Karte je Marke. Hat der Creator einen Code, stehen Link und Code auf
  // der Karte; Umsätze können aber auch ohne Code da sein, weil der Shop-Export
  // über den Namen zuordnet – dann zeigt die Karte nur die Zahlen.
  const byBrand = Object.fromEntries((data?.brands || []).map((b) => [String(b.brand_id), b]));
  const brandCards = codes
    .filter((row) => row.status === 'active')
    .map((row) => ({ ...row, totals: byBrand[String(row.brand_id)] || null }));
  const covered = new Set(brandCards.map((c) => String(c.brand_id)));
  for (const b of data?.brands || []) {
    if (!covered.has(String(b.brand_id))) {
      brandCards.push({ brand_id: b.brand_id, brand_name: b.brand_name, code: null, link: null, totals: b });
    }
  }

  res.render('dashboard', {
    nextRefresh: nextRefreshLabel(),
    title: 'Dashboard',
    nav: 'dashboard',
    run: data?.run || null,
    totals: data?.totals || null,
    orders: data?.orders || [],
    brandCards,
    chartHtml: data?.days?.length ? barChart(data.days) : '',
  });
});

// Der Creator-Bereich besteht bewusst nur aus dem Dashboard. Auszahlungsdaten
// und Regeln werden außerhalb des Portals geklärt; alte Links landen hier.
router.get(['/auszahlung', '/regeln'], auth.requireApprovedCreator, (req, res) => res.redirect('/dashboard'));
router.post('/auszahlung', auth.requireApprovedCreator, (req, res) => res.redirect('/dashboard'));

module.exports = router;
