'use strict';
/**
 * Opaque tokens for email links and session cookies.
 *
 * Deliberately not JWTs. A JWT would have to be revoked by hand on every
 * password change, suspension or account deletion (FR-1.6, FR-6.3), so a
 * self-describing token would either outlive the account or need a denylist —
 * which is exactly the stateless-token problem the session table here avoids.
 *
 * The browser and the emailed link see 32 random bytes. The database only ever
 * stores SHA-256 of them, so a dump of the users collection cannot be used to
 * sign in or to confirm anyone's address.
 */

const crypto = require('crypto');

/** A URL-safe secret with 256 bits behind it. */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Timing-safe compare of a candidate against a stored hash.
 * Returns false for a missing candidate rather than throwing, so callers cannot
 * turn a lookup miss into a 500 that tells an attacker anything.
 */
function tokenMatches(candidate, storedHash) {
  if (!candidate || !storedHash) return false;
  const a = Buffer.from(hashToken(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The path a link or a cookie carries. The token is never written to a log or
 * a file that outlives the request — the mailer is the only reader.
 */
function buildLink(baseUrl, route, token) {
  return `${baseUrl}${route}?token=${encodeURIComponent(token)}`;
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

module.exports = { randomToken, hashToken, tokenMatches, buildLink, minutesFromNow };
