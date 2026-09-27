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
 *
 * The one exception is the confirmation code, which is six digits because a
 * person has to type it. A 32-byte token is safe because it cannot be guessed; a
 * code that short cannot lean on that, so its safety is bought elsewhere — a
 * counter in the database, five wrong entries and it is burned. Anything that
 * prints an answer about a code must therefore print the same answer for "no such
 * account" and "wrong code", or it turns a guessable secret into a way to look up
 * who is registered.
 */

const crypto = require('crypto');

/** A URL-safe secret with 256 bits behind it. */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * A short numeric code — the thing a person reads off an email and types in.
 *
 * `crypto.randomInt` rather than bytes reduced with `%`: a range of 10^n does not
 * divide 256 evenly, so `randomBytes() % 10` makes some codes likelier than others.
 * That bias is small, and this is a secret whose whole defence is that nobody can
 * guess it in five tries, so it is the one place in this file where "small" is not
 * good enough. `randomInt` draws with rejection instead.
 *
 * Padded, because a code that comes out as `81902` is not the same six characters
 * as the one that was emailed.
 */
function randomDigits(n) {
  return String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
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

module.exports = { randomToken, randomDigits, hashToken, tokenMatches, buildLink, minutesFromNow };
