'use strict';
/**
 * Login sessions.
 *
 * A session is a random token the browser keeps in an httpOnly cookie, and a
 * hash of that token in the user's `sessions` array. The lookup is by hash, so
 * nobody has to be able to read the cookie to find the row — and the row is
 * gone the instant we want the cookie to stop working.
 *
 * That is the whole reason this is not a JWT. A signed token is valid until it
 * expires no matter what the database says, so signing someone out early — after
 * they change their password (FR-1.5), or after staff suspend them (FR-6.3), or
 * when they delete their account (FR-1.6) — means maintaining a denylist. A
 * denylist is a session table wearing a different name, so this is the session
 * table, written once, instead.
 */

const crypto = require('crypto');

const User = require('../models/User');
const { config } = require('../config');

const MAX_SESSIONS = 5;
const EXPIRY_MS = config.session.maxAgeMs;

function hashId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

/** Issues a session and returns the only value that ever leaves the server. */
async function start(userId, { userAgent = '' } = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  await User.updateOne(
    { _id: userId },
    {
      $push: {
        sessions: {
          $each: [{ idHash: hashId(id), createdAt: now, expiresAt: new Date(now.getTime() + EXPIRY_MS), userAgent: String(userAgent).slice(0, 200) }],
          // Newest first, and never more than MAX_SESSIONS of them.
          $sort: { createdAt: -1 },
          $slice: MAX_SESSIONS,
        },
      },
      $set: { lastLoginAt: now },
    }
  );

  return { id, expiresAt: new Date(now.getTime() + EXPIRY_MS) };
}

/** Resolves a cookie to a user id, dropping the session if it has run out. */
async function resolve(id) {
  if (!id) return null;
  const idHash = hashId(id);

  const user = await User.findOne(
    { 'sessions.idHash': idHash, 'sessions.expiresAt': { $gt: new Date() } },
    { status: 1, emailVerifiedAt: 1, lockedUntil: 1 }
  );

  // Suspended, banned or unverified since the cookie was issued: the session is
  // revoked, not merely ignored, so it cannot come back.
  if (!user || user.status !== 'active' || !user.emailVerifiedAt) {
    if (user) await drop(id);
    return null;
  }

  return { userId: user._id, status: user.status };
}

async function drop(id) {
  if (!id) return;
  await User.updateOne({ 'sessions.idHash': hashId(id) }, { $pull: { sessions: { idHash: hashId(id) } } });
}

/** Used by password change, reset, suspension and account deletion. */
async function dropAll(userId) {
  await User.updateOne({ _id: userId }, { $set: { sessions: [] } });
}

/** The cookie both the routes and the WebSocket handshake read. */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: EXPIRY_MS,
  };
}

module.exports = { start, resolve, drop, dropAll, cookieOptions, cookieName: config.session.cookieName, MAX_SESSIONS };
