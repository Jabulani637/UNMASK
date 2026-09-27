'use strict';
/**
 * One notice for one student. FR-7.1, FR-7.2, FR-7.3.
 *
 * **The body is written here, by the server, and it is the whole message.** A
 * notification is the one place this product can push text at a student when they
 * are not looking, so the same discipline applies as on the chat socket: no name,
 * no email, no account id, and no photo anywhere on this document. What a student
 * who has been told to go and look finds is "someone replied in one of your
 * chats" — the thread's own id, which is meaningless to anybody but them, is the
 * only pointer. Anything richer would be a second, unaudited copy of a conversation
 * sitting in a collection nobody thinks to delete.
 *
 * **Unread is a date, not a counter.** `readAt` means the student has seen this
 * particular notice, so "mark these three read" is one update, a notice they never
 * open stays honestly unread forever, and nothing has to be kept in step with
 * anything else.
 *
 * **Nothing here is a receipt.** A row says the site had something to tell you; it
 * never claims the student read it, and no other student can ever see one.
 */

const mongoose = require('mongoose');

const KINDS = ['suggestion', 'message', 'reveal-request', 'reveal-done'];

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: KINDS, required: true },
    // The thread the notice is about, when there is one. A match id identifies a
    // conversation to its two members and to nobody else, so it is the only
    // pointer allowed out of the chat.
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
    body: { type: String, required: true, maxlength: 300 },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The bell's two queries: what is new, and what is still unread.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

module.exports = mongoose.model('Notification', notificationSchema, 'notifications');
module.exports.KINDS = KINDS;
