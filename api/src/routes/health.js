'use strict';
/**
 * GET /api/health — booleans, counts and a version only. Never a connection
 * string, a secret, or anything that identifies a user.
 *
 * The one number here is how many institutions are active, because "who may
 * register" stopped being a config key and became a collection — and an empty
 * collection is exactly the kind of quietly-broken boot this endpoint exists to
 * catch: the process starts, every route answers, and no student on earth can
 * sign up.
 */

const express = require('express');
const db = require('../db');
const { config } = require('../config');
const Institution = require('../models/Institution');
const mail = require('../services/mail');

const router = express.Router();

router.get('/', async (req, res) => {
  const mongo = db.state();
  const ready = mongo.ready && Boolean(config.session.secret);

  // A count, so a database that is mid-outage degrades this field to null rather
  // than turning the health check itself into a 500.
  let activeInstitutions = null;
  if (mongo.ready) {
    try {
      activeInstitutions = await Institution.countDocuments({ isActive: true });
    } catch {
      activeInstitutions = null;
    }
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    service: 'unmask-api',
    version: '0.1.0',
    readiness: {
      database: mongo.ready,
      sessionSigning: Boolean(config.session.secret),
      emailTransport: mail.transportName(),
      activeInstitutions,
      // A path is never published: this endpoint is unauthenticated.
      photoStore: db.photoStoreWritable(config.photoDir),
      lastDatabaseError: mongo.lastError || null,
    },
  });
});

module.exports = router;
