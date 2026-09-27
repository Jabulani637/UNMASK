'use strict';
/**
 * /api/reveals — the two consents, and the two doors they open. FR-5.1 to FR-5.6.
 *
 * This router is the only way a student reaches another student's name or photo.
 * Stage 3's `/api/profile/photo` serves a person their own picture and nothing
 * else; stage 4's suggestion card and stage 5's chat never carry either. So there
 * is exactly one place to ask "may you see this?" and one answer to give, and the
 * asking happens inside services/reveal.js, which reads the pair's own row rather
 * than a claim made by the caller.
 *
 * The three write routes are the whole of FR-5.1, FR-5.4 and FR-5.5 — ask,
 * answer, take it back — and all three push a word to whoever needs to see the
 * screen change, so a request is not discovered by refreshing.
 *
 * A `:id` here is a match id, and every route re-checks that the signed-in
 * account is one half of that pair. A stranger with a pair-id gets the same
 * sentence an id that was never issued gets, and it is the sentence chat already
 * uses, so the response teaches nobody which threads exist (NFR-3.1).
 */

const express = require('express');

const reveal = require('../services/reveal');
const realtime = require('../realtime');
const { UserError } = require('../errors');
const { loadUser } = require('../middleware/requireUser');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

/** One fan-out for every state change: the service says who, this file sends. */
function announce(result) {
  return realtime.announceReveal(result.threadId, result.event, result.recipients);
}

/** FR-5.1, FR-5.3 — ask the other student whether they are ready. */
router.post('/:id/ask', loadUser, rateLimit({ limit: 40, windowMs: 60 * 60 * 1000, bucket: 'reveal-write' }), async (req, res, next) => {
  try {
    const result = await reveal.ask({ userId: req.user.id, matchId: req.params.id });
    await announce(result);
    res.json({ reveal: result.state, message: result.message });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-5.2's second consent, or FR-5.4's no. Both answers are one press and neither
 * is a way out of the conversation — a student who would rather stay anonymous is
 * not being asked to end a chat to say so.
 */
router.post('/:id/answer', loadUser, rateLimit({ limit: 40, windowMs: 60 * 60 * 1000, bucket: 'reveal-write' }), async (req, res, next) => {
  try {
    const raw = req.body && req.body.accept;
    const accept = raw === true || raw === 'true' || raw === false || raw === 'false' ? String(raw) === 'true' : null;
    if (accept === null) {
      throw new UserError('Answer a reveal request with yes or not yet — an empty answer helps nobody.');
    }

    const result = await reveal.answer({ userId: req.user.id, matchId: req.params.id, accept });
    await announce(result);
    res.json({ reveal: result.state, message: result.message });
  } catch (err) {
    next(err);
  }
});

/** FR-5.5 — take the request back, before the other half has answered. */
router.post('/:id/revoke', loadUser, rateLimit({ limit: 40, windowMs: 60 * 60 * 1000, bucket: 'reveal-write' }), async (req, res, next) => {
  try {
    const result = await reveal.revoke({ userId: req.user.id, matchId: req.params.id });
    await announce(result);
    res.json({ reveal: result.state, message: result.message });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-5.2 / FR-5.6 — the other student's profile, name and all, once the pair's
 * row says both of them said yes. Reads are not rate limited: this is the screen
 * a student looks at, and it is the same one row either way.
 */
router.get('/:id/profile', loadUser, async (req, res, next) => {
  try {
    const shown = await reveal.revealedProfile({ userId: req.user.id, matchId: req.params.id });
    res.set('Cache-Control', 'no-store');
    res.json({ revealed: true, profile: shown });
  } catch (err) {
    next(err);
  }
});

/**
 * The second photo door — the one the privacy section promises, and the only
 * route in the API that serves one person's face to another.
 *
 * `no-store` for the same reason as the owner's own copy: this is a face behind a
 * session cookie on a university computer, and a browser cache would keep it
 * there after the two students stopped being a pair. Nothing about the stored
 * file is ever returned — not its name, not its size, not its type until the
 * bytes are sniffed here.
 */
router.get('/:id/photo', loadUser, async (req, res, next) => {
  try {
    const { buffer, mime } = await reveal.revealedPhoto({ userId: req.user.id, matchId: req.params.id });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', mime);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
