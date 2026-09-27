'use strict';
/**
 * A student saying "this content should not be here". FR-6.1, and read by the
 * staff queue (FR-6.3).
 *
 * **The reported words are copied into this row, not referenced.** A report that
 * points at a message id is useless the moment the sender clears their copy or the
 * pair's thread is deleted, and a report about a prompt answer is useless the
 * moment the student edits it — which is exactly what a person does when they are
 * reported. So the text a staff member needs to judge is stored here, once, as it
 * was when the button was pressed. `targetId` is kept alongside it so the two can
 * be reconciled when the original still exists.
 *
 * **A snapshot is not a licence to store anything.** Only the reported item is
 * copied: one message body, one prompt answer, or "this profile / this photo".
 * A report never carries the whole thread, and the free-text `detail` is read by
 * staff and by nobody else — no route returns it to the reported student, and none
 * returns a report to the reporter after the queue has it.
 *
 * **One open report per person per item.** The unique index below is what lets
 * "we already have this one" be a fact rather than a polite lie, and it is the
 * cheapest defence against the mass-reporting NFR-2.5 names: fifty presses produce
 * fifty rows only if they name fifty different items.
 */

const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // FR-6.1's four things a student may report. 'profile' is the whole card,
    // which in practice means "this person should not be on Unmask at all".
    kind: { type: String, enum: ['profile', 'prompt', 'photo', 'message'], required: true },

    // The thing itself, where one exists: a match id for a message, the index of a
    // prompt answer. Null for a profile or the current photo.
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
    promptIndex: { type: Number, default: null },

    // The copy a staff member judges, taken at report time. See the header note.
    excerpt: { type: String, default: null },

    reason: { type: String, required: true, maxlength: 60 },
    detail: { type: String, default: null, maxlength: 600 },

    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    // What staff actually did, in their words plus the action taken: 'removed-content',
    // 'suspended', 'banned', 'dismissed'. Kept because FR-6.5 asks for the log and
    // because "we looked at it" without a decision is not an audit trail.
    decision: { type: String, enum: ['dismissed', 'removed-content', 'suspended', 'banned'], default: null },
    decisionNote: { type: String, default: null, maxlength: 400 },
  },
  { timestamps: true }
);

// The queue is read oldest-first, and a duplicate check runs on every report.
reportSchema.index({ status: 1, createdAt: 1 });
reportSchema.index({ reportedUserId: 1, createdAt: -1 });
reportSchema.index(
  { reporterId: 1, reportedUserId: 1, kind: 1, matchId: 1, promptIndex: 1, status: 1 },
  { unique: true }
);

module.exports = mongoose.model('Report', reportSchema, 'reports');
