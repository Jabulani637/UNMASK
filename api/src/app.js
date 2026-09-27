'use strict';
/**
 * The Express application, without the listen() call, so a test can drive it
 * over real HTTP without occupying a port.
 */

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { config } = require('./config');
const { UserError } = require('./errors');
const { secureHeaders } = require('./middleware/secureHeaders');
const { mountSite } = require('./serveSite');
const healthRouter = require('./routes/health');
const metaRouter = require('./routes/meta');
// NFR-SCALE-1's other half: the way in for a student whose college is not on the
// list yet. Public by necessity — the person asking cannot register, which is the
// whole reason they are asking — so it brings its own limit and its own screen.
const institutionRequestsRouter = require('./routes/institutionRequests');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const matchesRouter = require('./routes/matches');
const chatsRouter = require('./routes/chats');
const revealsRouter = require('./routes/reveals');
const safetyRouter = require('./routes/safety');
const staffRouter = require('./routes/staff');
const notificationsRouter = require('./routes/notifications');

function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  // How far the client's address is believed. See config.trustProxyHops: the
  // limiter in middleware/rateLimit.js keys off req.ip, and with a proxy count of
  // 1 that value comes from a header the caller writes.
  app.set('trust proxy', config.trustProxyHops);

  // First, so a response that never reaches a route still carries them.
  app.use(secureHeaders);

  // The API is called from the web origin only, and with credentials, because
  // the session lives in a cookie. A wildcard would let any page read a logged-in
  // student's profile.
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin, a curl call, or a health probe.
        if (!origin) return callback(null, true);
        // Not allowed: send no CORS headers at all, so the browser blocks the
        // read. An error here would surface as a 500 and look like an outage.
        return callback(null, config.webOrigins.includes(origin));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser(config.session.secret));

  app.use('/api/health', healthRouter);
  app.use('/api/meta', metaRouter);
  app.use('/api/institution-requests', institutionRequestsRouter);
  // Before the /api catch-all, or every auth route would answer 404.
  app.use('/api/auth', authRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/matches', matchesRouter);
  app.use('/api/chats', chatsRouter);
  // Stage 6: the only routes in the API that can hand over a name or a face, and
  // both of them ask the pair's own row first.
  app.use('/api/reveals', revealsRouter);
  // Stage 7: the two things a student does for themself. A staff member's side of
  // the same story is behind its own door, and cannot be reached from here.
  app.use('/api/safety', safetyRouter);
  // Stage 7, staff side: the same story read from the other end. Mounted before the
  // /api catch-all like every other door, and the catch-all is also what a student
  // gets here, because requireStaff answers 404 rather than 403.
  app.use('/api/staff', staffRouter);
  // Stage 8: a student's own notices and their own switches over them. Nothing here
  // takes another account's id, so this is the one collection in the database a
  // student can read in a single sweep without it meaning anything about anybody else.
  app.use('/api/notifications', notificationsRouter);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Unknown API endpoint' });
  });

  // Stage 9d: the site itself, on this same origin. Deliberately after the /api
  // catch-all above, so a wrong API path is still a JSON 404 and never an HTML
  // shell, and deliberately before the error handler, so a missing file 404s
  // through its own route rather than as an exception.
  if (config.serveWeb) mountSite(app);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    // A UserError's message is written for the person reading it — several of
    // them have to stay word-for-word identical across branches, so they are the
    // only client-facing text copied through verbatim.
    if (err instanceof UserError) {
      if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
      return res.status(err.status).json({ error: err.message, code: err.code });
    }

    const raw = Number.isInteger(err.status) ? err.status : err.statusCode;
    const status = raw >= 400 && raw <= 599 ? raw : 500;

    if (status >= 500) {
      // The stack stays here: a 500's message describes our bug, not their problem.
      console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
      return res.status(500).json({ error: 'Something went wrong on our end.' });
    }

    // 4xx from a library (a malformed JSON body, a payload over the limit).
    res.status(status).json({ error: 'That request could not be read.' });
  });

  return app;
}

module.exports = { buildApp };
