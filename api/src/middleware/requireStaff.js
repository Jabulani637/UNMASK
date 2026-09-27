'use strict';
/**
 * Is this session a staff member's? FR-6.3.
 *
 * The gate reads the account from the database on every request rather than
 * trusting anything the cookie carries, for the same reason sessions are opaque
 * everywhere else in this API: a privilege that lives in a client-side token is a
 * privilege a student can edit. `role` is the only field that decides it, and an
 * admin is otherwise an ordinary account — same email domain, same password rules,
 * same cookie, no separate door into anybody's data.
 *
 * The answer to "no" is the answer to "who?". A 403 would confirm that the route
 * exists and that the caller is a real student with a live session; /api/staff/*
 * therefore answers the same 404 the rest of the unknown API endpoints give, and
 * says nothing about permissions.
 */

const User = require('../models/User');
const sessions = require('../services/sessions');

async function requireStaff(req, res, next) {
  try {
    const token = req.cookies && req.cookies[sessions.cookieName];
    const resolved = await sessions.resolve(token);
    if (!resolved) {
      return res.status(401).json({ error: 'You need to be signed in for that.', code: 'unauthenticated' });
    }

    const user = await User.findById(resolved.userId, { email: 1, role: 1, status: 1, emailVerifiedAt: 1 });
    if (!user || user.status !== 'active' || !user.emailVerifiedAt || user.role !== 'admin') {
      // Not "you are not staff". Somebody probing this route should learn only that
      // there is nothing here for them.
      return res.status(404).json({ error: 'Unknown API endpoint' });
    }

    req.staff = { id: user._id, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireStaff };
