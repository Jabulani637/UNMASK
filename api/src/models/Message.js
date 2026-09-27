'use strict';
/**
 * One message in a matched pair's thread. FR-4.5.
 *
 * There is no `readAt`, no delivery receipt and no typing flag on purpose: the
 * requirements say a student's identity must not be inferable from metadata or
 * timestamps (NFR-3.3), and "was online at 21:14 and read yours 40 seconds
 * later" is exactly the kind of clue that narrows a class of a few hundred
 * students down to one body. The pair's own ids are here because a message has
 * to know who wrote it — nothing that reaches a browser translates them.
 */

const mongoose = require('mongoose');

const MAX_BODY = 1000;

const messageSchema = new mongoose.Schema(
  {
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: MAX_BODY,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The only read this collection serves is "the last N of this thread, in order",
// so it is indexed that way and nothing else.
messageSchema.index({ matchId: 1, createdAt: -1 });

messageSchema.statics.MAX_BODY = MAX_BODY;

module.exports = mongoose.model('Message', messageSchema, 'messages');
