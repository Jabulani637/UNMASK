'use strict';
/**
 * The conversation between two matched students. FR-4.1 to FR-4.5.
 *
 * Three rules shape this file.
 *
 * **A thread belongs to a pair, and only the pair.** Every entry point takes the
 * account id from the session and re-reads the match row; no caller ever gets to
 * say "load thread X" and hope X is theirs. A wrong id answers with the same
 * sentence it uses for a thread that never existed, so the response cannot be
 * used to probe which pair-ids are real (NFR-3.1).
 *
 * **Nothing that leaves the server names a person.** `toWire()` is the only
 * shape a message takes on its way out, and it replaces the sender's account id
 * with `'me'` or `'them'` for whoever is reading. That is why the frame is built
 * per recipient instead of once: one serialised payload would have to carry a
 * real id, and the second student would learn the first one's account id — a
 * stable key that every other route is built to refuse.
 *
 * Stage 6 adds exactly one exception, and it has two keys on it: a *chosen* first
 * name may ride along on a thread whose pair row holds both students' consent
 * (FR-5.2). An account id, an email and a photo filename still never do.
 *
 * **The budget is spent here, not in a route.** Messaging goes out over both a
 * REST route and the WebSocket, and a limit written in an Express middleware is
 * a limit one of those two paths can walk around (NFR-2.4). Keeping the counter
 * in the service means the two doors cannot drift apart.
 */

const Match = require('../models/Match');
const Message = require('../models/Message');
const Profile = require('../models/Profile');
const { UserError } = require('../errors');
const institutions = require('./institutions');
const { pairOf, peerIdOf } = require('./pair');
const reveal = require('./reveal');

/** NFR-2.4: a burst is a person typing fast, a flood is a script. */
const WINDOW_MS = 60 * 1000;
const PER_WINDOW = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_DAY = 200;

/** How many messages one read returns. Older ones stay until asked for. */
const HISTORY_PAGE = 100;
const MAX_HISTORY = 500;

// userId -> { minutes: [{n, resetAt}], days: [{n, resetAt}] }
const budgets = new Map();

function spend(userId, table, limit, windowMs, now) {
  const key = `${userId}:${table}`;
  let entry = budgets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    budgets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > limit) {
    const retrySeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    throw new UserError(
      `You have sent ${limit} messages in a minute. Wait ${retrySeconds} seconds — a real conversation does not need more.`,
      { status: 429, code: 'rate_limited', retryAfterSeconds: retrySeconds }
    );
  }
}

/**
 * What one half of a pair has cleared. The marker is per person (FR-4.5): the
 * other student still has every word, so reads for them are unfiltered.
 */
function clearedAtFor(match, userId) {
  const entry = (match.cleared || []).find(row => String(row.userId) === String(userId));
  return entry ? entry.at : null;
}

/** The only shape a message takes on the wire. */
function toWire(message, viewerId) {
  return {
    id: String(message._id),
    from: String(message.senderId) === String(viewerId) ? 'me' : 'them',
    body: message.body,
    at: message.createdAt,
  };
}

/**
 * What the thread list and the header may show about the other student.
 *
 * While they are still anonymous (FR-2.3) it is the same three facts the
 * suggestion card showed before they connected — and `name` stays null, because a
 * card that carries a null name is a card that cannot accidentally carry a real
 * one if this function is ever handed a profile with one.
 *
 * `revealed` is not this function's decision. It is the pair's, read off the
 * match row by services/reveal.js, and passed in — so the one place that knows
 * what two consents unlock is the place that decides whether they happened.
 */
async function peerCardFor(peerUserId, revealed) {
  const profile = await Profile.findOne({ userId: peerUserId }, { year: 1, faculty: 1, institutionId: 1, revealName: 1 });
  if (!profile) return { revealed: Boolean(revealed), name: null, year: null, faculty: null, institution: null };
  const institution =
    (await institutions.byIds([profile.institutionId])).get(String(profile.institutionId)) || null;
  return {
    revealed: Boolean(revealed),
    name: revealed ? profile.revealName || null : null,
    year: profile.year,
    faculty: profile.faculty,
    institution: institution ? institution.shortName : null,
  };
}

/**
 * The rows older than one page's last line, newest first.
 *
 * The cursor is a timestamp *and* the id of the row it was read from: two
 * messages landing in the same millisecond is ordinary between two phones
 * typing fast, and a timestamp-only boundary would lose the second of them
 * between two pages. Sorting on the same pair of keys is what makes that
 * ordering total.
 */
async function messagesUpTo(match, viewerId, { cursor, page }) {
  const cleared = clearedAtFor(match, viewerId);

  const bounds = [];
  // A cleared conversation reads as empty, without deleting the other
  // student's copy of it.
  if (cleared) bounds.push({ createdAt: { $gt: cleared } });
  if (cursor) {
    bounds.push({
      $or: [
        { createdAt: { $lt: cursor.at } },
        { createdAt: cursor.at, _id: { $lt: cursor.id } },
      ],
    });
  }

  // Both bounds constrain createdAt, so they cannot sit side by side in one
  // object — the second would silently replace the first.
  const filter = { matchId: match._id };
  if (bounds.length) filter.$and = bounds;

  return Message.find(filter, { senderId: 1, body: 1, createdAt: 1 }, { sort: { createdAt: -1, _id: -1 }, limit: page });
}

/**
 * The page marker a client gets back with each read, turned around again.
 * A cursor that is not both halves is not a cursor this code wrote.
 */
function parseCursor(before, beforeId) {
  if (!before && !beforeId) return null;
  const at = new Date(String(before));
  const id = String(beforeId || '');
  if (!/^[0-9a-f]{24}$/i.test(id) || !Number.isFinite(at.getTime())) {
    throw new UserError('That page of the conversation is not one I can open.', { status: 400, code: 'bad_cursor' });
  }
  return { at, id: Message.schema.path('_id').cast(id) };
}

/** FR-4.1, FR-4.5: the thread as one student sees it, oldest message first. */
async function openThread(userId, matchId, { before = null, beforeId = null, limit = HISTORY_PAGE } = {}) {
  const match = await pairOf(userId, matchId);
  const page = Math.min(Math.max(Number(limit) || HISTORY_PAGE, 1), MAX_HISTORY);
  const cursor = parseCursor(before, beforeId);

  const rows = await messagesUpTo(match, userId, { cursor, page });
  const peer = peerIdOf(match, userId);
  // FR-5.1 to FR-5.3: the same read that carries the words also says where the
  // pair stands on revealing them, so a screen never has to guess from a button
  // it decides to show itself.
  const revealState = await reveal.stateForMatch(match, userId);

  return {
    thread: {
      id: String(match._id),
      status: match.status,
      connectedAt: match.createdAt,
      peer: await peerCardFor(peer, revealState.status === 'revealed'),
      reveal: revealState,
      // FR-4.4: the other half can close a thread; this says it is closed and
      // stops there, because "who closed it and why" is not this student's news.
      closedNotice: match.status === 'closed'
        ? 'This conversation has been closed. You can still read it.'
        : null,
      // FR-4.5 says this half's view empties while the other keeps its words.
      // Without a marker on every read, a reload of a cleared thread is
      // indistinguishable from a brand-new one and says so.
      clearedNotice: clearedAtFor(match, userId)
        ? 'Your copy of this conversation is cleared. The other student still has theirs.'
        : null,
    },
    messages: rows.reverse().map(row => toWire(row, userId)),
    hasMore: rows.length === page,
  };
}

/** FR-4.2's storage half: write the message, then let the caller fan it out. */
async function send({ userId, matchId, body }) {
  const match = await pairOf(userId, matchId);
  if (match.status !== 'open') {
    throw new UserError('This conversation is closed, so it cannot take new messages.', { status: 409, code: 'thread_closed' });
  }

  const text = String(body == null ? '' : body).replace(/\r\n/g, '\n').trim();
  if (!text) throw new UserError('Write something first.');
  if (text.length > Message.MAX_BODY) {
    throw new UserError(`A message is limited to ${Message.MAX_BODY} characters. This one is ${text.length}.`);
  }

  const now = Date.now();
  spend(userId, 'minute', PER_WINDOW, WINDOW_MS, now);
  spend(userId, 'day', PER_DAY, DAY_MS, now);

  const message = await Message.create({ matchId: match._id, senderId: userId, body: text });
  return { message, recipientId: peerIdOf(match, userId) };
}

/** Every thread this account is in, most recent first. */
async function threadsFor(userId) {
  const matches = await Match.find({ users: userId }).sort({ updatedAt: -1 });

  const threads = [];
  for (const match of matches) {
    const rows = await messagesUpTo(match, userId, { page: 1 });
    const last = rows[0] || null;
    // The same state the thread screen is given, so a list row can say "they asked"
    // or "revealed" without the student opening every conversation to find out.
    const state = reveal.revealState(match, userId);
    threads.push({
      id: String(match._id),
      status: match.status,
      connectedAt: match.createdAt,
      // A thread with no messages yet stays at the top of the list on the moment
      // it opened, which is when a student is looking for it.
      lastActivity: last ? last.createdAt : match.createdAt,
      last: last ? { from: String(last.senderId) === String(userId) ? 'me' : 'them', body: last.body.slice(0, 90) } : null,
      peer: await peerCardFor(peerIdOf(match, userId), state.status === 'revealed'),
      reveal: state,
    });
  }

  return threads.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
}

/**
 * FR-4.4 — leave. The pair's row closes; the other student is told the thread is
 * closed and nothing more, and neither side is told who pressed it.
 */
async function leave({ userId, matchId }) {
  const match = await pairOf(userId, matchId);
  if (match.status === 'closed') return { already: true, match };
  match.status = 'closed';
  match.closedBy = userId;
  await match.save();
  return { already: false, match };
}

/**
 * FR-4.5 — delete *my* conversation. Not a delete of documents: the other
 * student's copy is theirs to keep. The marker is what makes my reads come back
 * empty, and it moves forward in time every time it is pressed.
 */
async function deleteConversation({ userId, matchId }) {
  const match = await pairOf(userId, matchId);
  const at = new Date();

  await Match.updateOne(
    { _id: match._id, 'cleared.userId': { $ne: userId } },
    { $addToSet: { cleared: { userId, at } } }
  );

  // Already cleared, so the marker has to be pushed to now: a message sent
  // before the first delete must not reappear under a second one.
  await Match.updateOne({ _id: match._id, 'cleared.userId': userId }, { $set: { 'cleared.$.at': at } });

  return { at };
}

/** Test seam: the counters are module state, so a suite needs them empty. */
function resetBudget() {
  budgets.clear();
}

module.exports = {
  openThread,
  send,
  threadsFor,
  leave,
  deleteConversation,
  // Opened for the tests and for realtime.js, which must send the same bytes the
  // REST route sends rather than a second, slightly different idea of a message.
  toWire,
  _internal: { clearedAtFor, peerCardFor, resetBudget, PER_WINDOW, PER_DAY, HISTORY_PAGE },
};
