'use strict';

const express = require('express');
const auth = require('../lib/auth');
const { dashboardFor } = require('../services/snapshot');
const { barChart } = require('../lib/chart');
const { nextRefreshLabel } = require('../lib/dates');

const router = express.Router();

router.get('/dashboard', auth.requireApprovedCreator, async (req, res) => {
  const data = await dashboardFor(req.creator.id);

  // Link und Code zeigt das Dashboard bewusst nicht – die werden über
  // WhatsApp geteilt und ändern sich schneller, als das Portal sie pflegt.
  // Je Marke stehen hier nur die Zahlen der letzten 30 Tage.
  const brandCards = (data?.brands || []).map((b) => ({ brand_id: b.brand_id, brand_name: b.brand_name, totals: b }));

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
