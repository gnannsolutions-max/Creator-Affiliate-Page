'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { dashboardFor } = require('../services/snapshot');
const { barChart } = require('../lib/chart');

const router = express.Router();

router.get('/dashboard', auth.requireApprovedCreator, async (req, res) => {
  const [data, payouts] = await Promise.all([
    dashboardFor(req.creator.id),
    db.many('SELECT * FROM payouts WHERE creator_id = $1 ORDER BY period DESC', [req.creator.id]),
  ]);

  res.render('dashboard', {
    title: 'Dashboard',
    nav: 'dashboard',
    run: data?.run || null,
    totals: data?.totals || null,
    orders: data?.orders || [],
    payouts,
    chartHtml: data?.days?.length ? barChart(data.days) : '',
  });
});

router.get('/regeln', auth.requireApprovedCreator, (req, res) => {
  res.render('rules', { title: 'Werberegeln', nav: 'rules' });
});

module.exports = router;
