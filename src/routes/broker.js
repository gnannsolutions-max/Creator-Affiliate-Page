'use strict';

// Vermittler-Bereich: nur das Dashboard. Zeigt die bereinigten Nettoumsätze
// aller vermittelten Creator und die eigene Beteiligung.

const express = require('express');
const auth = require('../lib/auth');
const { brokerDashboardFor } = require('../services/snapshot');
const { barChart } = require('../lib/chart');

const router = express.Router();

router.get('/vermittler', auth.requireBroker, async (req, res) => {
  const data = await brokerDashboardFor(req.broker.id);
  res.render('broker-dashboard', {
    title: 'Vermittler-Dashboard',
    nav: 'broker',
    run: data?.run || null,
    totals: data?.totals || null,
    creators: data?.creators || [],
    chartHtml: data?.days?.length ? barChart(data.days) : '',
  });
});

module.exports = router;
