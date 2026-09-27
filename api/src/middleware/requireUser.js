'use strict';
/**
 * Who is asking? Every route that touches another student's data goes through
 * here, because "who may see this" is the whole product.
 *
 * The cookie is an opaque session id; services/sessions.js resolves it by hash
 * and revokes it if the account stopped being active. A request with no cookie,
 * an expired one, or one belonging to a suspended account all arrive at the same
 * 401, and none of them say which — the response must not help an outsider find
 * a live session.
 */

const User = require('../models/User');
const sessions = require('../services/sessions');

async function loadUser(req, res, next) {
  try {
    const token = req.cookies && req.cookies[sessions.cookieName];
    const resolved = await sessions.resolve(token);
    if (!resolved) {
      // Clearing the cookie stops a dead one being replayed on every request.
      if (token) res.clearCookie(sessions.cookieName, { path: '/' });
      return res.status(401).json({ error: 'You need to be signed in for that.', code: 'unauthenticated' });
    }

    const user = await User.findById(resolved.userId, { email: 1, notifications: 1, emailVerifiedAt: 1, status: 1 });
    if (!user || user.status !== 'active' || !user.emailVerifiedAt) {
      return res.status(401).json({ error: 'That session is no longer valid.', code: 'unauthenticated' });
    }

    req.user = { id: user._id, email: user.email, notifications: user.notifications };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * FR-2.7 — a profile has to exist and be complete before it can be matched.
 * Routes that need more than an account ask for it here rather than each
 * remembering to check, because forgetting this is how an unfinished profile
 * ends up in front of someone.
 */
function requireProfile(builder) {
  return async function gate(req, res, next) {
    try {
      const profile = await builder(req.user.id);
      if (!profile) {
        return res.status(428).json({
          error: 'Fill in your profile first — that is what a match is built from.',
          code: 'profile_incomplete',
        });
      }
      req.profile = profile;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { loadUser, requireProfile };
