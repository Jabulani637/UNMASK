'use strict';
/**
 * /api/chats — the threads this student holds, and the words in them.
 * FR-4.1, FR-4.4, FR-4.5, with FR-4.2's live delivery on the WebSocket.
 *
 * This router exists so chat works without a socket. A phone on a bad connection
 * loses its WebSocket and must still be able to send and read; a student who
 * closes the tab and comes back tomorrow needs the history; and FR-4.5's
 * "retain until deleted" is a read, which belongs in a GET.
 *
 * The one thing deliberately *not* duplicated here is the message budget: it
 * lives in services/chat.js, because the WebSocket path writes messages too and
 * a limit that only one of the two doors enforces is not a limit (NFR-2.4). What
 * this file does add is a per-IP ceiling on the write routes, so flooding them
 * costs a client something before it costs the database a write.
 *
 * Every `:id` here is a match id, and it is checked against the signed-in
 * account inside the service — not against a token, not against a referer. A
 * stranger holding a pair-id still gets one refusal, worded the same as the one
 * for an id that was never issued.
 */

const express = require('express');

const chat = require('../services/chat');
const realtime = require('../realtime');
const { loadUser } = require('../middleware/requireUser');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

/** FR-4.1, FR-4.5: this student's threads, most recent activity first. */
router.get('/', loadUser, async (req, res, next) => {
  try {
    const threads = await chat.threadsFor(req.user.id);
    res.json({ count: threads.length, threads });
  } catch (err) {
    next(err);
  }
});

/** One thread's history, oldest first, as this student sees it. */
router.get('/:id', loadUser, async (req, res, next) => {
  try {
    const before = req.query.before ? String(req.query.before) : null;
    const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await chat.openThread(req.user.id, req.params.id, { before, beforeId, limit }));
  } catch (err) {
    next(err);
  }
});

/**
 * Send, without a socket. The service writes the message; this route then pushes
 * it onto the other student's open tabs, so a send from a dropped connection
 * still arrives inside NFR-1.2's two seconds.
 */
router.post(
  '/:id/messages',
  loadUser,
  rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'chat-send' }),
  async (req, res, next) => {
    try {
      const { message, recipientId } = await chat.send({
        userId: req.user.id,
        matchId: req.params.id,
        body: req.body.body,
      });

      // One door for both send paths: the frame out, and the notice if the reader's
      // tabs were not sitting on this thread (FR-4.2, FR-7.2).
      await realtime.deliver(message, recipientId);

      res.status(201).json({ message: chat.toWire(message, req.user.id) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * FR-4.4 — end the conversation. Both halves are told the thread is closed, and
 * neither is told who closed it or why; the answer to the student who pressed it
 * says nothing about the other side either.
 */
router.post('/:id/leave', loadUser, async (req, res, next) => {
  try {
    const { match, already } = await chat.leave({ userId: req.user.id, matchId: req.params.id });
    realtime.announceClosed(match);
    res.json({
      closed: true,
      message: already
        ? 'That conversation was already closed.'
        : 'Conversation closed. You can still read what was said.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-4.5 — delete *my* copy. A DELETE on a thread reads like it removes the
 * thread, and it does not: the other student keeps every word. That is why the
 * response says so out loud instead of answering with a bare 204.
 */
router.delete('/:id', loadUser, async (req, res, next) => {
  try {
    const { at } = await chat.deleteConversation({ userId: req.user.id, matchId: req.params.id });
    res.json({
      cleared: true,
      clearedAt: at,
      message: 'Your copy of this conversation is cleared. The other student still has theirs.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
