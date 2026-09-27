'use strict';
/**
 * Accounts. FR-1.1 to FR-1.6, FR-6.3, FR-7.4, FR-8.2.
 *
 * Two things are deliberately absent from this document, and their absence is
 * the product:
 *   - no name field of any kind. FR-1.4 forbids collecting one at signup and
 *     FR-2.6 forbids displaying one, so there is nothing here to leak.
 *   - no secret stored in plaintext. Session cookies and the reset link are random
 *     256-bit values and the emailed confirmation code is hashed the same way, so a
 *     dump of this collection cannot sign in as anyone, reset anyone's password, or
 *     confirm anyone's address. The code is short enough to be guessed, which is why
 *     what protects it is the attempt counter beside it and not its length.
 *
 * The email is still personal data under POPIA (NFR-3.1): it is the one thing
 * that identifies this account to the world, which is why deletion has to reach
 * it and every collection that references it.
 */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    passwordHash: { type: String, required: true, select: false },

    // FR-1.2. Nothing works until this is set: no profile, no matching, no chat.
    emailVerifiedAt: { type: Date, default: null },

    // FR-1.3. Self-attested, dated. There is no document check in v1, and the
    // age is never displayed to another user before a reveal.
    over18AttestedAt: { type: Date, default: null },

    // FR-1.2 — the six digits emailed to prove the address. Hashed like every other
    // secret here, and cleared the moment they are used.
    //
    // `verifyCodeAttempts` is the field this design rests on. A 256-bit link token is
    // safe because nobody can guess it; a six-digit code is not, so its safety has to
    // come from somewhere else — the count is raised in the database on every wrong
    // entry and the code is burned at five, which is the only thing standing between
    // a stranger and a million possible codes. `verifyCodeSentAt` is the other half:
    // without it, one address could ask for a new code in a loop and spend the mail
    // quota of the whole institution.
    verifyCodeHash: { type: String, default: null, select: false },
    verifyCodeExpiresAt: { type: Date, default: null, select: false },
    verifyCodeSentAt: { type: Date, default: null, select: false },
    verifyCodeAttempts: { type: Number, default: 0, select: false },

    // One-shot link tokens. Hashed, and cleared the moment they are used.
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpiresAt: { type: Date, default: null, select: false },

    // Opaque session ids (see services/sessions.js). Deleting this array is how
    // a password change, a suspension or an account deletion signs the user out
    // everywhere at once — which a self-describing token cannot do.
    sessions: [
      {
        _id: false,
        idHash: { type: String, required: true },
        createdAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        userAgent: { type: String, default: '' },
      },
    ],

    // NFR-2.4/2.5 — a slow, brute-force login attempt costs the attacker a lock.
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    // FR-6.3. A suspended account keeps its data (a ban is not a deletion) but
    // cannot sign in, be matched, or message.
    status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
    statusReason: { type: String, default: null },

    // FR-6.3. The only privilege split in the product: an admin is a student who can
    // also read the report queue and change an account's status. Nothing about a
    // staff member's identity is special — same kind of address, same password
    // rules — so a leaked admin cookie is a session to revoke, not a different kind
    // of door.
    role: { type: String, enum: ['student', 'admin'], default: 'student' },

    // FR-8.2. Being a student at an institution Unmask has verified is the one rule
    // everything else sits on (NFR-8.1), and a staff member can be the person who
    // decides it. `attested` is what a confirmed institution address gives you,
    // `verified` is a staff member having checked, and `revoked` is a staff member
    // having decided you are not one. Revoking does not invent a second kind of door
    // — it pauses the account through `status` above, so there is still exactly one
    // field the app asks when it decides whether you may be here. `note` is the
    // sentence the owner is told, because a decision nobody can read the reason for is
    // not one they can contest (NFR-3.2).
    student: {
      status: { type: String, enum: ['attested', 'verified', 'revoked'], default: 'attested' },
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, default: null },
      note: { type: String, default: null },
    },

    // FR-7.4. The two channels. A reply in a chat and an answer to a reveal are
    // things another student is waiting on, so they travel whichever channel the
    // student has switched on; email is off by default because a student's inbox is
    // not our channel to fill.
    notifications: {
      inApp: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
      // The one notice that is not an answer to something a person did: "there is
      // somebody new who fits you". Non-essential in FR-7.4's sense, so it is the
      // one that can be switched off on its own.
      suggestions: { type: Boolean, default: true },
    },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Sessions find their owner by hash, and expire on their own.
userSchema.index({ 'sessions.idHash': 1 });
userSchema.index({ 'sessions.expiresAt': 1 }, { expireAfterSeconds: 0 });

userSchema.virtual('isVerified').get(function isVerified() {
  return Boolean(this.emailVerifiedAt);
});

/**
 * Whether this account may be given a session. Kept next to the fields that
 * decide it, so no caller has to remember which of the three matter.
 */
userSchema.methods.canSignIn = function canSignIn() {
  if (this.status !== 'active') return false;
  if (this.lockedUntil && this.lockedUntil > new Date()) return false;
  return Boolean(this.emailVerifiedAt);
};

/**
 * NFR-3.5: deleting an account means deleting the person's data, not hiding it.
 * These are the collections that hold anything about them. One function reads this
 * list — `eraseDataFor` in services/auth.js — and both the deletion route and
 * `npm run seed -- --reset` go through it, so neither can fall behind the other.
 */
userSchema.statics.dataCollections = [
  'profiles',
  'passes',
  'matches',
  'messages',
  'blocks',
  'reports',
  'auditEvents',
  'notifications',
];

module.exports = mongoose.model('User', userSchema, 'users');
