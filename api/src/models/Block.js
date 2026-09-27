'use strict';
/**
 * One student blocking another. FR-6.2.
 *
 * **Directional, on purpose.** A match is a pair and is stored as a sorted array
 * because "me and you" is one conversation. A block is not: A can block B while B
 * has never heard of A, and collapsing the two into one row would either lose who
 * acted or force the passive half to agree to something about themselves. So this
 * is one row per (blocker, blocked), and the *rule* it enforces is symmetric:
 * neither half may be suggested to the other, in either direction.
 *
 * Nothing here is visible to the blocked student. The thread they shared is closed
 * through the same `matches.status` field that "end this chat" writes, so a block
 * and a walk-away look identical from the outside — which is the point decided for
 * this stage: a signal that says "you were blocked" is a message, and a block that
 * can carry a message is a way to harass somebody.
 */

const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blockedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One block per direction per pair, and the lookup every chat and match read needs.
blockSchema.index({ userId: 1, blockedUserId: 1 }, { unique: true });
blockSchema.index({ blockedUserId: 1 });

module.exports = mongoose.model('Block', blockSchema, 'blocks');
