'use strict';
/**
 * NFR-2.4 — rate limiting on the endpoints worth hammering.
 *
 * A fixed window per IP in process memory, which is the right size for this:
 * one API instance today, no Redis to run, and the failure mode people actually
 * need stopping is a scripted guesser, not a botnet. Behind more than one
 * instance each keeps its own count — that is a known, stated limit, and the
 * account lockout in services/auth.js is what still bites, because that lives in
 * the database and is shared by definition.
 */

const crypto = require('crypto');

const windows = new Map();

// NFR-2.5 — "log suspicious behaviour", with the smallest amount of personal data
// that still makes the line worth reading. The salt lives for the length of the
// process, so the same address hashes differently tomorrow: enough to tell "this
// one client did it twice" apart from "two different clients did it", not enough
// to build a dossier, and nothing here keeps an address the way a log file would.
const salt = crypto.randomBytes(16).toString('hex');

function fingerprint(ip) {
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 12);
}

function prune(now) {
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
  }
}

function clientKey(req) {
  // req.ip is the connection address unless trust proxy is set, which it is in
  // app.js for a deployment behind TLS termination. A client-supplied
  // X-Forwarded-For is never read directly: it is the easiest header to forge.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * @param {number} limit  requests per window
 * @param {number} windowMs
 * @param {string} bucket so a login hammer does not spend the register budget
 */
function rateLimit({ limit, windowMs, bucket }) {
  return function limitRequests(req, res, next) {
    const now = Date.now();
    const key = `${bucket}:${clientKey(req)}`;

    let entry = windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
      if (windows.size > 5000) prune(now);
    }

    entry.count += 1;

    if (entry.count > limit) {
      // Once per window, not once per rejected request: a client hammering this
      // endpoint should not be able to use the log as a write amplifier.
      if (entry.count === limit + 1) {
        console.warn(
          `[security] ${bucket} limit of ${limit} per ${Math.round(windowMs / 1000)}s reached by client ${fingerprint(clientKey(req))}.`
        );
      }
      const retrySeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retrySeconds));
      return res.status(429).json({
        error: `Too many attempts. Wait ${retrySeconds} seconds before trying again.`,
        code: 'rate_limited',
        retrySeconds,
      });
    }

    next();
  };
}

/** Test seam: the counters are module state, so a suite needs them empty. */
function reset() {
  windows.clear();
}

function stats() {
  return { buckets: windows.size };
}

module.exports = { rateLimit, reset, stats };
