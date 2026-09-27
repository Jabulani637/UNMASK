'use strict';
/**
 * /api/safety — the two things a student does for themself: report, and block.
 * FR-6.1 and FR-6.2. A staff member's side of the same story is /api/staff.
 *
 * Both routes take a *target* the caller already holds — a thread id, a message id,
 * or the sealed token of the card on screen — and never an account id, because that
 * is the shape every previous stage settled on and this one is not going to break
 * it to be convenient (NFR-3.3). What the services behind them do about it, and why
 * a block makes no sound, is written out in services/blocks.js and
 * services/reports.js; this file adds only the door and the per-IP ceiling.
 *
 * A report and a block are deliberately separate presses. A student who is being
 * harassed should not have to trust a staff member, in advance, to make it stop, and
 * a student who reports something they want looked at should not silently cut
 * somebody off. The response to the first says the second exists.
 */

const express = require('express');

const blocks = require('../services/blocks');
const reports = require('../services/reports');
const realtime = require('../realtime');
const { UserError } = require('../errors');
const { loadUser } = require('../middleware/requireUser');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Per account these are rare; per IP, a script is the thing being priced. The
// service keeps its own, tighter count per account, because that is what a
// mass-report actually is.
const writeGuard = rateLimit({ limit: 30, windowMs: 10 * 60 * 1000, bucket: 'safety-write' });

/** FR-6.1 — report a profile, a prompt answer, a photo, or one message. */
router.post('/reports', loadUser, writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await reports.file({
      userId: req.user.id,
      kind: body.kind,
      matchId: body.matchId || null,
      messageId: body.messageId || null,
      token: body.token || null,
      promptIndex: body.promptIndex == null ? null : Number(body.promptIndex),
      reason: body.reason,
      detail: body.detail || null,
    });

    res.status(result.already ? 200 : 201).json({
      reported: true,
      already: result.already,
      // Never an id, a status, or what happens next: a reporter is not a staff
      // member, and a queue position is information about another student.
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-6.2 — block. The thread closes as an End-chat closes, so the *other* student's
 * screen changes exactly the way it would have if nobody had pressed anything, and
 * the response here says nothing about them either.
 */
router.post('/blocks', loadUser, writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await blocks.place({
      userId: req.user.id,
      matchId: body.matchId || null,
      token: body.token || null,
    });

    if (result.match) {
      // The same one-word frame an ordinary departure sends. Nobody is told that
      // what closed their conversation was a block.
      realtime.announceClosed(result.match);
    }

    res.json({
      blocked: true,
      already: result.already,
      closedThread: Boolean(result.match),
      message: result.already
        ? 'You have already blocked that student.'
        : 'Blocked. You will not be shown each other, and the conversation is closed.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The student's own list, so a panic press can be undone. Names appear here only for
 * a pair that revealed to each other — the same rule every other screen runs by.
 */
router.get('/blocks', loadUser, async (req, res, next) => {
  try {
    const blocked = await blocks.mine(req.user.id);
    res.json({ count: blocked.length, blocked });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-6.2's escape hatch: unblocking is allowed. What it does *not* do is reopen the
 * thread, which the service explains — one student cannot silently undo the other
 * student's walk-away.
 */
router.delete('/blocks/:id', loadUser, writeGuard, async (req, res, next) => {
  try {
    if (!req.params.id) throw new UserError('Say which block you mean.');
    await blocks.lift({ userId: req.user.id, id: req.params.id });
    res.json({
      blocked: false,
      message: 'Block lifted. The conversation that closed stays closed — you would have to be suggested to each other again.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
