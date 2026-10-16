'use strict';

// Agenten-Bereich: nur das Dashboard – alle Bestellungen mit der eigenen Kennung.

const express = require('express');
const auth = require('../lib/auth');
const { agentDashboardFor } = require('../services/snapshot');
const { barChart } = require('../lib/chart');

const router = express.Router();

router.get('/agent', auth.requireAgent, async (req, res) => {
  const data = await agentDashboardFor(req.agent.id);
  res.render('agent-dashboard', {
    title: 'Agenten-Dashboard',
    nav: 'agent',
    run: data?.run || null,
    totals: data?.totals || null,
    orders: data?.orders || [],
    chartHtml: data?.days?.length ? barChart(data.days) : '',
  });
});

module.exports = router;
