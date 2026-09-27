'use strict';
/**
 * Two students who chose to start talking. FR-3.4.
 *
 * One row per *pair*, not per viewer: `pair` is the two account ids sorted and
 * joined, so "me and you" and "you and me" compute to the same string and hit the
 * same unique index. That is what stops a pair being suggested to each other twice
 * — and it is a row-level rule, not one on either person, because a student is
 * allowed to hold more than one conversation.
 *
 * Stage 5 hangs messages off this row. Nothing here identifies a person: there
 * is no name, no photo, and the two ObjectIds are account ids, which no other
 * route will translate into anything a stranger could read. Stage 6 adds the
 * reveal state to the same row, and it is still only ObjectIds and timestamps —
 * the name lives on the profile and the picture on disk, and neither is
 * reachable until two consents are present.
 */

const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema(
  {
    users: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      length: 2,
      required: true,
    },
    /**
     * The two ids sorted and joined, so "me and you" and "you and me" are one
     * string — and one row.
     *
     * This is what the one-pair rule is enforced on. It used to sit on `users`,
     * which is an array, and a unique index over an array is a rule about its
     * *elements*: the second student who ever tried to start a chat with somebody
     * already in a thread got a duplicate-key error instead of a conversation. A
     * scalar the database can compare whole is the only shape that means "this
     * pair, once".
     */
    pair: {
      type: String,
      required: true,
      default() {
        return matchSchema.statics.pairValue(this.users[0], this.users[1]);
      },
    },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The profile that was on screen when the button was pressed. Kept because a
    // profile is edited over time, and "what did we each agree to start on" is
    // worth having when a report is read (stage 7).
    openedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', default: null },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    // FR-4.4. Who pressed "end this chat" — recorded so the other half can be
    // told the thread is closed without being told who closed it or why.
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // FR-4.5, read per person rather than per pair: deleting *your* copy of a
    // conversation must not erase the words the other student still has. Each
    // half stores the moment its own view was cleared, and a read hides
    // everything older than the caller's marker.
    cleared: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, required: true } }],

    /**
     * FR-5.1 to FR-5.6 — the reveal.
     *
     * It lives on the pair rather than in a collection of its own because a
     * reveal has exactly the same cardinality as this row: one pair, one
     * decision, and the unique index on `pair` is already what stops a second
     * one existing. A second collection would add a join to every chat read and a
     * second place for the same pair to disagree with itself.
     *
     * `consent` is the whole point of the document: two rows, each with its own
     * timestamp, written by two different people. FR-5.2's "both participants
     * have independently consented" is a fact this array either holds or does
     * not, which means a later argument about who agreed is answerable from data.
     *
     * The three action timestamps are kept after the state moves on, so a student
     * who declined and was asked again can be told that honestly, and so stage
     * 9's POPIA summary can say what was stored without re-deriving it.
     */
    reveal: {
      status: { type: String, enum: ['none', 'pending', 'revealed'], default: 'none' },
      askedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      askedAt: { type: Date, default: null },
      consent: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, required: true } }],
      revealedAt: { type: Date, default: null },
      declinedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      declinedAt: { type: Date, default: null },
      revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      revokedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// `users` stays indexed rather than unique — it is an array, and a unique index on
// one is a rule that an account may appear in exactly one thread ever. The pair
// itself is what may only exist once, and `pair` is the scalar that says so.
matchSchema.index({ pair: 1 }, { unique: true });
matchSchema.index({ users: 1 });
matchSchema.index({ users: 1, status: 1 });

/** One pair has one shape, whichever half of it writes it. */
matchSchema.statics.pairKey = function pairKey(a, b) {
  return [String(a), String(b)].sort();
};

/** ...and one stored string, which is what the unique index compares. */
matchSchema.statics.pairValue = function pairValue(a, b) {
  return matchSchema.statics.pairKey(a, b).join(':');
};

module.exports = mongoose.model('Match', matchSchema, 'matches');
