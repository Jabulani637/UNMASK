'use strict';
/**
 * Telling a student something happened. Stage 8: FR-7.1, FR-7.2, FR-7.3, and the
 * switches that let them say less (FR-7.4).
 *
 * **One door, because there are four callers.** A message arrives on a WebSocket
 * frame, or over HTTP, or from a test that opens neither. A reveal is asked on a
 * route and completed by whichever of the two yeses lands second. A new suggestion
 * is discovered while somebody else is saving their profile. If each of those worked
 * out for itself whether this student wanted to be told, the answer would drift, and
 * it would drift towards sending mail nobody asked for. So every caller says only
 * `notify({ userId, kind, threadId })` and nothing else.
 *
 * **The caller cannot supply the words.** This is the security property of the file:
 * the sentences live in `TEXT` below, and there is no argument through which a route
 * could pass a string into a notification. A notification is the one place this
 * product pushes text at someone who is not looking, and the moment its wording is
 * an input, "who was told what about whom" stops being answerable. What a student
 * gets is "a new message is waiting in one of your chats" — not a quote, not a name,
 * not the other student's email. There is no name to send anyway: a notice fires
 * before any reveal has happened, and it stays true afterwards.
 *
 * **The thread id is the only pointer, and it points nowhere for a stranger.** A
 * `threadId` on a notice is a pair's own match id, which is the same address the
 * chat screen already uses; `services/chat.js` refuses it from anybody who is not
 * half of that pair. So a notice can be turned into a link without inventing a new
 * capability, and a leaked notification collection still shows nobody's conversation.
 *
 * **FR-7.4's switches are read at the moment of sending**, per event, from the
 * account that is being notified — not cached and not inherited from the caller,
 * because a student who has just switched email off must not get one more mail.
 * `suggestions` is the non-essential switch: "there is somebody new who fits you"
 * is a nudge nobody is waiting on, unlike the other two, which answer something a
 * person did.
 *
 * **A failed notice never fails the thing it notifies about.** The caller has
 * already stored the message, the consent, or the profile; the event is real whether
 * or not anybody is told. So a mail server that is down, or an account deleted mid-
 * flight, is logged and swallowed here rather than thrown back into a chat send.
 */

const { config } = require('../config');
const Notification = require('../models/Notification');
const User = require('../models/User');
const mail = require('./mail');

/** The three FR-7 triggers, in the reader's own words. */
const TEXT = {
  suggestion: 'Someone new fits what you are looking for. Open Match to see them.',
  message: 'A new message is waiting in one of your chats.',
  'reveal-request': 'Someone in one of your chats has asked to reveal themselves to you.',
  'reveal-done': 'You both said yes — your reveal is ready to open.',
};

const SUBJECT = {
  suggestion: 'Someone new fits you — Unmask',
  message: 'A new message on Unmask',
  'reveal-request': 'Someone asked to reveal — Unmask',
  'reveal-done': 'Your reveal is ready — Unmask',
};

const KINDS = Object.keys(TEXT);

function emailText(kind) {
  return [
    TEXT[kind],
    '',
    'This email names nobody. Unmask keeps your name, your photo and your address',
    'hidden from every other student until you both agree to a reveal, and it sends',
    'nothing to your inbox that it would not show you on your own screen.',
    '',
    `Open it here: ${config.webOrigins[0]}/chats`,
    '',
    'Switch these emails off any time on your account screen.',
  ].join('\n');
}

/**
 * What this account wants to hear, right now. Null for anybody who cannot be told:
 * a deleted account, or one that staff have suspended or banned — a paused student
 * has lost their audience, and their inbox is not where we tell them about it.
 */
async function channelsFor(userId) {
  const user = await User.findById(userId, { email: 1, notifications: 1, status: 1 });
  if (!user || user.status !== 'active') return null;
  return {
    email: user.email,
    inApp: user.notifications.inApp,
    byEmail: user.notifications.email,
    // The one kind that can be refused on its own, in either channel.
    suggestions: user.notifications.suggestions,
  };
}

/**
 * @param {object} event
 * @param {string} event.userId  who is being told — never the other student
 * @param {string} event.kind   one of KINDS
 * @param {object} [event.threadId]  the pair's match id, if the notice is about a chat
 * @returns {Promise<{inApp: boolean, email: boolean, skipped: string|null}>}
 */
async function notify({ userId, kind, threadId = null }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown notification kind: ${kind}`);

  let channels;
  try {
    channels = await channelsFor(userId);
  } catch (err) {
    console.error(`[notify] could not read settings for an account: ${err.message}`);
    return { inApp: false, email: false, skipped: 'unreadable' };
  }
  if (!channels) return { inApp: false, email: false, skipped: 'not-notifiable' };
  if (kind === 'suggestion' && !channels.suggestions) {
    return { inApp: false, email: false, skipped: 'suggestions-off' };
  }

  const written = { inApp: false, email: false, skipped: null };

  if (channels.inApp) {
    try {
      await Notification.create({ userId, kind, threadId, body: TEXT[kind] });
      written.inApp = true;
    } catch (err) {
      console.error(`[notify] could not store a ${kind} notice: ${err.message}`);
    }
  }

  if (channels.byEmail) {
    try {
      await mail.send({ to: channels.email, subject: SUBJECT[kind], text: emailText(kind) });
      written.email = true;
    } catch (err) {
      // The notice is already in their bell; a mail server refusing the copy is not
      // a reason to fail the message send that started all of this.
      console.error(`[notify] ${kind} email not sent: ${err.message}`);
      written.skipped = 'email-failed';
    }
  }

  if (!channels.inApp && !channels.byEmail) written.skipped = 'both-off';
  return written;
}

/** The bell and its list: newest first, and how many of them are unread. */
async function mine(userId, { limit = 30 } = {}) {
  const [rows, unread] = await Promise.all([
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(limit),
    Notification.countDocuments({ userId, readAt: null }),
  ]);
  return {
    notifications: rows.map(row => ({
      id: String(row._id),
      kind: row.kind,
      threadId: row.threadId ? String(row.threadId) : null,
      body: row.body,
      at: row.createdAt,
      readAt: row.readAt,
    })),
    unread,
  };
}

/** The bell's badge, on its own, for a caller that wants nothing else. */
async function unreadCount(userId) {
  return Notification.countDocuments({ userId, readAt: null });
}

/**
 * Mark read. `ids: 'all'` is the bell's "read everything" press; anything else is a
 * list of ids, and an id belonging to somebody else matches nothing here, so it
 * cannot be used to mark a stranger's notice seen.
 */
async function markRead(userId, ids = 'all') {
  const filter =
    ids === 'all'
      ? { userId, readAt: null }
      : { userId, readAt: null, _id: { $in: readableIds(ids) } };
  const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}

/** 24-hex strings only: an id that cannot exist matches nothing, rather than 500ing. */
function readableIds(ids) {
  return (Array.isArray(ids) ? ids : [ids])
    .map(String)
    .filter(id => /^[0-9a-f]{24}$/.test(id))
    .slice(0, 100);
}

/**
 * Whether to pile on another "someone new" notice. One is enough: the sentence does
 * not count what it is pointing at, so a second row would be a duplicate of the first
 * and the bell would fill with nudges.
 */
async function hasUnreadSuggestion(userId) {
  const one = await Notification.findOne({ userId, kind: 'suggestion', readAt: null }).select('_id');
  return Boolean(one);
}

module.exports = { notify, mine, unreadCount, markRead, hasUnreadSuggestion, KINDS, TEXT };
