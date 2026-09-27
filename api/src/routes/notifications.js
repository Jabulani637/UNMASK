'use strict';
/**
 * /api/notifications — a student's own bell, and the switches over it.
 * FR-7.1 to FR-7.4.
 *
 * Three doors, all of them about one account: read yours, mark yours read, change
 * your own settings. There is no route here that takes a user id, and no route here
 * that sends anything — a notice is written by the event behind it, in
 * services/notifications.js, never on request. That is what makes the collection
 * safe to read in one sweep: it holds sentences the site wrote to the person they
 * describe, at the moment something happened to them.
 *
 * The settings are the FR-7.4 half of the stage, and they are the only part of this
 * product where a student can say "less". They take effect on the next event,
 * because services/notifications.js reads them per send rather than caching them: a
 * switch thrown in the last second has to count.
 */

const express = require('express');

const User = require('../models/User');
const notifications = require('../services/notifications');
const { UserError } = require('../errors');
const { loadUser } = require('../middleware/requireUser');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const writeGuard = rateLimit({ limit: 60, windowMs: 10 * 60 * 1000, bucket: 'notifications-write' });

/** The bell: what arrived, newest first, and how many of them you have not seen. */
router.get('/', loadUser, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    res.json(await notifications.mine(req.user.id, { limit }));
  } catch (err) {
    next(err);
  }
});

/**
 * "I have seen these." `all: true` is the bell's one press; otherwise a list of ids
 * from the list above. An id that is not yours matches nothing, so this cannot be
 * used to mark another student's notices seen — the filter is by account first.
 */
router.post('/read', loadUser, writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const marked = await notifications.markRead(req.user.id, body.all === true ? 'all' : body.ids);
    res.json({ marked, unread: await notifications.unreadCount(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** FR-7.4 — the three switches, as the account has them right now. */
router.get('/settings', loadUser, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id, { notifications: 1 });
    if (!user) throw new UserError('Your account could not be read.');
    res.json({ notifications: user.notifications });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-7.4 — and changing them. Booleans only, because a partly-set switch is not a
 * thing: an absent key keeps whatever the account already had.
 */
router.put('/settings', loadUser, writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const field of ['inApp', 'email', 'suggestions']) {
      if (typeof body[field] === 'boolean') patch[`notifications.${field}`] = body[field];
    }
    if (!Object.keys(patch).length) {
      throw new UserError('Nothing to change — tell me which switch to move.');
    }

    const user = await User.findByIdAndUpdate(req.user.id, { $set: patch }, { new: true }).select(
      'notifications'
    );
    if (!user) throw new UserError('Your account could not be changed.');

    res.json({
      notifications: user.notifications,
      message: 'Saved. It takes effect from the next thing that happens to you.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
