'use strict';
/**
 * /api/matches — one suggested student at a time, and what you do about it.
 * FR-3.1 to FR-3.6, FR-4.1's first half.
 *
 * The screen never learns who it is looking at. `GET /suggestion` answers with
 * year, faculty, institution, one prompt answer, shared interest tags, a score, and
 * a sealed token; the two POSTs hand that token back. There is no route that takes
 * a profile id, so there is no route to enumerate, and two students cannot
 * confirm a suspicion by comparing what they were each shown (NFR-3.3).
 *
 * `waiting` is a count of how many people fit you. It is not a search result and
 * not a list — it exists so the "nobody left" screen can say whether you have
 * seen everyone or whether there is more to come.
 */

const express = require('express');

const matching = require('../services/matching');
const { loadUser } = require('../middleware/requireUser');
const { rateLimit } = require('../middleware/rateLimit');
const { UserError } = require('../errors');

const router = express.Router();

/** FR-3.2. The single best suggestion right now. */
router.get('/suggestion', loadUser, async (req, res, next) => {
  try {
    res.json(await matching.suggest(req.user.id));
  } catch (err) {
    next(err);
  }
});

/** FR-3.3. Decline the one on screen and get the next-best, in one round trip. */
router.post(
  '/suggestion/pass',
  loadUser,
  rateLimit({ limit: 120, windowMs: 10 * 60 * 1000, bucket: 'suggestion-pass' }),
  async (req, res, next) => {
    try {
      res.json(await matching.pass({ userId: req.user.id, token: req.body.token }));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * FR-4.1 / FR-3.4. Both halves of one decision: the pair is recorded, so neither
 * student is ever suggested the other again. The thread it names is read and
 * written under /api/chats.
 */
router.post(
  '/suggestion/connect',
  loadUser,
  rateLimit({ limit: 30, windowMs: 60 * 60 * 1000, bucket: 'suggestion-connect' }),
  async (req, res, next) => {
    try {
      const token = req.body.token;
      if (!token) throw new UserError('Nothing was on your screen to connect with. Refresh the suggestion.');

      const { match, already } = await matching.connect({ userId: req.user.id, token });
      res.status(already ? 200 : 201).json({
        match: { id: String(match._id), connectedAt: match.createdAt },
        message: already
          ? 'You two are already connected.'
          : 'You are connected. Your chat is open — say something.',
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
