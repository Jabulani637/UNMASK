'use strict';
/**
 * "Who did what to whom, and when." FR-6.5 — reports, blocks, suspensions and the
 * staff decisions that end them.
 *
 * **Ids only, never content.** An audit row says that staff member X suspended
 * account Y for reason Z on this date. It does not copy a message, a profile or a
 * photo, because the evidence for a decision already lives on the report row, and a
 * second copy of a student's words in a log nobody reads is a second thing to leak.
 *
 * **Deleted with the person it names.** NFR-3.5 gives a student the right to have
 * their data gone, and a row that says "user 6ab7… was suspended for…" is data about
 * them. So `services/auth.js` purges these on deletion, which means the log answers
 * "what did staff do while this account existed" and not "what did we once know about
 * a person who is gone". A moderation system that cannot show its own decisions is a
 * worse trade; one that keeps them past a deletion is a POPIA problem, so the two
 * deletion-side effects below are part of the model, not an afterthought in a route.
 */

const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema(
  {
    // Who acted. Null only for an automated entry, which is the system speaking.
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    automated: { type: Boolean, default: false },

    // Dot-namespaced so a reader can grep for 'report.' or 'account.' and get the
    // whole family: report.filed, block.placed, block.lifted, content.removed,
    // account.suspended, account.banned, account.reinstated.
    action: { type: String, required: true, maxlength: 60 },

    // The account the action is about, and what it happened on, where one exists.
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    targetType: { type: String, default: null, maxlength: 30 },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // A short human sentence, and the machine-readable extras (a reason, a status,
    // a count). Never a message body or a profile field.
    note: { type: String, default: null, maxlength: 400 },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditSchema.index({ subjectId: 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AuditEvent', auditSchema, 'auditEvents');
