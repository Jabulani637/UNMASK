'use strict';
/**
 * Account rules — registration, verification, sign-in, recovery, deletion.
 * (FR-1.1 to FR-1.6, and the privacy rules in NFR-3.3 that shape how they answer.)
 *
 * The one design decision worth reading twice: **nothing here tells the caller
 * whether an address is already registered.** When the platform verifies an
 * address by its domain, the email *is* the identity, so "that address already has
 * an account" is a way to walk a list of a university's addresses and find out
 * which of them are dating students. Every branch that could reveal that answers
 * with the same sentence and, where useful, sends an email instead of showing one.
 *
 * The second thing worth noticing: this file no longer knows what any institution
 * is called. "May this address register" is a question asked of the `Institution`
 * collection (see services/institutions.js), which is what lets a sixth college be
 * added without editing anything here — and what keeps a sentence in this file from
 * becoming a claim about the product's scope.
 */

const bcrypt = require('bcryptjs');

const User = require('../models/User');
const { config } = require('../config');
const { UserError } = require('../errors');
const institutions = require('./institutions');
const mail = require('./mail');
const sessions = require('./sessions');
const photos = require('./photos');
const personalData = require('./personal-data');
const { randomToken, hashToken, tokenMatches, buildLink, minutesFromNow } = require('../utils/tokens');

const VERIFY_TTL_MINUTES = 24 * 60;
const RESET_TTL_MINUTES = 30;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;
const PASSWORD_MIN = 10;
// bcrypt reads 72 bytes of a password and ignores the rest, so a longer "secure"
// passphrase would silently authenticate on its first 72 bytes. Saying no is
// honest; truncating is not.
const PASSWORD_MAX_BYTES = 72;

/**
 * FR-1.1 — an exact domain match, against the institutions on record.
 *
 * Not `endsWith(domain)`: that accepts `myinstitution.ac.za.attacker.example`. Not
 * a regex over the whole address either; the domain is the part after the last @,
 * and it has to equal one of an institution's listed domains in full.
 */
function emailDomain(email) {
  const at = String(email).lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).toLowerCase();
}

/**
 * FR-1.1's second half: the address has to belong to an institution this platform
 * has been told about.
 *
 * Returns the document rather than a boolean, because the caller is about to
 * create an account that *is* a member of that institution, and a second lookup
 * later would be a second chance for the two answers to disagree — the window
 * where a staff member deactivates the college between the check and the write.
 */
async function assertInstitution(email) {
  const institution = await institutions.forEmail(email);
  if (!institution) {
    const domain = emailDomain(email);
    throw new UserError(
      `Unmask is for students at institutions we have verified, and “${domain || 'that address'}” is not one yet. Sign up with the address your institution gave you, or ask for your institution to be added.`
    );
  }
  return institution;
}

function assertShape({ email, password }) {
  const value = String(email || '').trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new UserError('That does not look like an email address. Check the spelling and try again.');
  }
  if (value.length > 254) throw new UserError('That email address is too long to be valid.');
  if (typeof password !== 'string') throw new UserError('A password is required.');
  if (password.length < PASSWORD_MIN) {
    throw new UserError(`Use at least ${PASSWORD_MIN} characters. A short phrase you can remember is stronger than a complex one you will reuse.`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UserError(`Passwords are limited to ${PASSWORD_MAX_BYTES} bytes.`);
  }
  return value;
}

/**
 * The sentence every already-registered branch answers with. Deliberately
 * identical to the successful one, and deliberately not promising delivery.
 */
const CHECK_YOUR_EMAIL =
  'Check your inbox. If that address is one your institution gave you, a confirmation link is on its way — it expires in 24 hours.';

/** What the same screen says when DEV_AUTO_VERIFY confirmed the address instead of
 *  mailing a link. It cannot be the sentence above, because nothing is on its way
 *  anywhere — and it says out loud that this box skipped a step a real server will
 *  not skip, so nobody mistakes what they just saw on their laptop for the product. */
const DEV_AUTO_VERIFIED =
  'DEV_AUTO_VERIFY is on: this address was confirmed without a link, so there is nothing to open in an inbox. Turn the switch off to see the real sign-up.';

/** FR-1.4's version of the same trick: a reset link is only ever mailed to an
 *  address that already has an account, so the on-screen sentence cannot say
 *  whether one was found. */
const RESET_SENT = 'If that address has an account, a reset link is on its way. It expires in 30 minutes.';

async function issueVerificationLink(email, institution) {
  const token = randomToken();
  await User.updateOne(
    { email },
    {
      $set: {
        verifyTokenHash: hashToken(token),
        verifyTokenExpiresAt: minutesFromNow(VERIFY_TTL_MINUTES),
      },
    }
  );

  const link = buildLink(config.appUrl, '/verify', token);
  // Named from the document, not from this file: the person reading the mail
  // should see the institution that gave them the address, and the only honest
  // source for that sentence is the row that decided they may register.
  const where = institution ? institution.name : 'the institution that gave you this address';

  return mail.send({
    to: email,
    subject: institution ? `Confirm your ${institution.shortName} email — Unmask` : 'Confirm your student email — Unmask',
    text: [
      `Someone asked to create an Unmask account with an address at ${where}.`,
      '',
      'Unmask matches verified students on their interests and what they write, not on their photos. Your name is never collected, and nothing is shown to another student until you both agree to reveal.',
      '',
      'Confirm it is you by opening this link within 24 hours:',
      link,
      '',
      `If you did not ask for this, nothing happens: the address stays unregistered and you can ignore this email. The link only works once.`,
    ].join('\n'),
  });
}

/**
 * FR-1.1, FR-1.2, FR-1.3.
 *
 * Returns the same string whether or not the account now exists. A caller who
 * wanted to know which happened would have to read the email — which is the
 * point.
 */
async function register({ email, password, over18Attested }) {
  const normalized = assertShape({ email, password });

  // FR-1.3 — attestation, not a guess. There is no default for "did they say yes".
  if (over18Attested !== true) {
    throw new UserError('You must confirm you are 18 or older. Unmask is only for adult students.');
  }

  const institution = await assertInstitution(normalized);
  const existing = await User.findOne({ email: normalized });

  // Every exit path below returns this, and nothing else, so that what the screen
  // says cannot depend on whether the address already had an account (FR-1.1,
  // NFR-3.3). That is why the switch has to move the *answer* rather than only the
  // new-account branch: a shortcut that said one thing for a fresh address and
  // "check your inbox" for a member's would hand anyone who types an address a
  // working test for whether it is registered.
  const answer = () =>
    config.devAutoVerify ? { message: DEV_AUTO_VERIFIED, devAutoVerified: true } : { message: CHECK_YOUR_EMAIL };

  if (existing && existing.emailVerifiedAt) {
    // Already a member. Told by email, not on screen — see the note at the top.
    await mail
      .send({
        to: normalized,
        subject: 'Someone tried to register on Unmask',
        text: [
          'An attempt was made to create an Unmask account with this address today.',
          '',
          'Your account already exists and is unaffected. If you have forgotten your password, use "Forgot password" on the sign-in page.',
          '',
          'If it was not you, you do not need to do anything — no change was made.',
        ].join('\n'),
      })
      .catch(() => {
        /* A failed warning email must not turn into a signal about the account. */
      });
    return answer();
  }

  // DEV_AUTO_VERIFY, and why it is safe even here: this branch cannot hand out a
  // session, because /api/auth/register never signs anybody in and never changes an
  // existing password. Marking the address confirmed therefore lets a stranger do
  // nothing they could not do by clicking the link in somebody else's inbox folder —
  // they still need the password, and the password is what /api/auth/login checks.
  if (existing) {
    if (config.devAutoVerify) {
      await User.updateOne({ _id: existing._id }, { $set: { emailVerifiedAt: new Date(), verifyTokenHash: null, verifyTokenExpiresAt: null } });
    } else {
      // Unverified and still pending: re-send the link rather than create a second
      // account for the same person.
      await issueVerificationLink(normalized, institution);
    }
    return answer();
  }

  const hash = await bcrypt.hash(password, 12);

  try {
    await User.create({
      email: normalized,
      passwordHash: hash,
      over18AttestedAt: new Date(),
      // The one difference the switch makes to a *new* account: the address is
      // confirmed at the moment it is created, so no link exists to be clicked.
      ...(config.devAutoVerify ? { emailVerifiedAt: new Date() } : {}),
      sessions: [],
    });
  } catch (err) {
    // Two tabs for the same address: the unique index decides, and the loser
    // gets the sentence it would have got anyway.
    if (err && err.code === 11000) return answer();
    throw err;
  }

  if (!config.devAutoVerify) await issueVerificationLink(normalized, institution);

  // NFR-2.5 — a burst of accounts from one client is what a farm looks like. The
  // institution's short name is the useful aggregate; the domain would be personal
  // data, and a log file is the one place in this project with no deletion path.
  console.log(`[auth] account created at ${institution.shortName}`);

  return answer();
}

/** FR-1.2 — the link. One use, then the token is gone. */
async function verifyEmailToken(token) {
  const candidate = String(token || '');
  if (!candidate) throw new UserError('That link is missing its token.', { status: 400 });

  // The token is looked up by its hash, so this cannot be widened by a crafted
  // string; it either matches one row or none.
  const user = await User.findOne(
    { verifyTokenHash: hashToken(candidate), verifyTokenExpiresAt: { $gt: new Date() } },
    { email: 1, emailVerifiedAt: 1, status: 1 }
  ).select('+verifyTokenHash +verifyTokenExpiresAt');

  if (!user || !tokenMatches(candidate, user.verifyTokenHash)) {
    throw new UserError('That link no longer works. It has been used, or it expired after 24 hours.', {
      status: 410,
      code: 'bad_token',
    });
  }

  if (user.status !== 'active') {
    throw new UserError('This account is not active. Contact Unmask support if you believe that is wrong.', {
      status: 403,
    });
  }

  await User.updateOne(
    { _id: user._id },
    {
      $set: { emailVerifiedAt: new Date(), verifyTokenHash: null, verifyTokenExpiresAt: null },
    }
  );

  return { email: user.email, verified: true };
}

/**
 * The confirmation link expired, so ask for another.
 *
 * Same shape as register on purpose: this cannot say "that address has no
 * account" or "that address is already verified", because both are answers about
 * someone else's registration. A signed-out visitor learns nothing here, and the
 * owner of the address gets the link in their own inbox.
 */
async function resendVerification(email) {
  const normalized = String(email || '').trim().toLowerCase();

  const institution = await institutions.forEmail(normalized);
  if (!institution) {
    throw new UserError(
      `Unmask is for students at institutions we have verified, and “${emailDomain(normalized) || 'that address'}” is not one yet. Sign up with the address your institution gave you, or ask for your institution to be added.`
    );
  }

  const pending = await User.findOne({ email: normalized, emailVerifiedAt: null, status: 'active' });
  if (pending) await issueVerificationLink(normalized, institution);

  return CHECK_YOUR_EMAIL;
}

async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new UserError('That account is no longer here.', { status: 404 });

  const ok = await bcrypt.compare(String(currentPassword || ''), user.passwordHash);
  if (!ok) throw new UserError('That is not your current password, so nothing was changed.', { status: 403 });

  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN) {
    throw new UserError(`The new password needs at least ${PASSWORD_MIN} characters.`);
  }
  if (Buffer.byteLength(newPassword, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UserError(`Passwords are limited to ${PASSWORD_MAX_BYTES} bytes.`);
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new UserError('That is the password you are already using.');
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.sessions = [];
  await user.save();

  return { email: user.email };
}

/** FR-1.5 — sign in. */
async function login({ email, password, userAgent }) {
  const normalized = String(email || '').trim().toLowerCase();
  const user = await User.findOne({ email: normalized }).select('+passwordHash');

  // A wrong address and a wrong password give the same answer, for the same
  // reason register does. bcrypt runs even when there is no user, so the two do
  // not differ by how long they take either.
  const hash = user ? user.passwordHash : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(String(password || ''), hash);

  if (!user || !ok) {
    if (user && ok === false) {
      const count = (user.failedLoginCount || 0) + 1;
      const lock = count >= MAX_FAILED_LOGINS ? minutesFromNow(LOCK_MINUTES) : null;
      await User.updateOne(
        { _id: user._id },
        { $set: { failedLoginCount: lock ? 0 : count, lockedUntil: lock || user.lockedUntil } }
      );
      if (lock) {
        throw new UserError('Too many failed attempts. Try again in 15 minutes, or reset your password.', {
          status: 429,
          code: 'locked',
          retryAfterSeconds: LOCK_MINUTES * 60,
        });
      }
    }
    throw new UserError('That email and password do not match an active account.', {
      status: 401,
      code: 'bad_credentials',
    });
  }

  if (!user.emailVerifiedAt) {
    if (!config.devAutoVerify) {
      // Their password is right, so telling them to check it would be a lie. This
      // names the actual blocker without confirming the account exists to a third
      // party, who would not know the password.
      throw new UserError('Confirm your student email first. Use the link we sent you, or ask for another.', {
        status: 403,
        code: 'email_unverified',
      });
    }
    // The same convenience, on the other door: an address left pending from before
    // the switch was turned on is confirmed by the person who just proved the
    // password. Without that proof this line is unreachable, so the switch never
    // weakens the one check that matters.
    await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date(), verifyTokenHash: null, verifyTokenExpiresAt: null } });
    user.emailVerifiedAt = new Date();
  }

  if (user.status !== 'active') {
    // FR-8.2's other half. A revoked student status is not a punishment, so it must not
    // be delivered as one: the person is told which decision was taken and why, in the
    // words of whoever took it. Only the account owner reaches this line — the password
    // has already compared good by this point — so passing the staff note here leaks
    // nothing to anybody probing addresses.
    if (user.student && user.student.status === 'revoked') {
      throw new UserError(
        'Our records no longer show you as a student at your institution, so this account is paused.' +
          (user.student.note ? ` Said by staff: “${user.student.note}”` : '') +
          ' Open a support request if that is wrong.',
        { status: 403, code: 'not_a_student' }
      );
    }
    throw new UserError(
      user.status === 'banned'
        ? 'This account has been closed for breaking the guidelines.'
        : 'This account is paused. Open a support request if you believe that is wrong.',
      { status: 403, code: 'account_inactive' }
    );
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new UserError('Too many failed attempts recently. Try again in a few minutes.', {
      status: 429,
      code: 'locked',
      retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
    });
  }

  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockedUntil: null } });

  const session = await sessions.start(user._id, { userAgent });
  return { userId: user._id, email: user.email, session };
}

async function logout(token) {
  await sessions.drop(token);
}

/**
 * FR-1.5 — "forgot password". Same answer whether or not the address exists.
 * A live reset link is never sent to an address that has no account, because the
 * email would itself be the disclosure.
 */
async function requestPasswordReset(email) {
  const normalized = String(email || '').trim().toLowerCase();

  if (!(await institutions.forEmail(normalized))) {
    throw new UserError(
      `Unmask is for students at institutions we have verified, and “${emailDomain(normalized) || 'that address'}” is not one yet. Sign up with the address your institution gave you, or ask for your institution to be added.`
    );
  }

  const user = await User.findOne({ email: normalized, emailVerifiedAt: { $ne: null } });
  if (!user) return RESET_SENT;

  const token = randomToken();
  await User.updateOne(
    { _id: user._id },
    { $set: { resetTokenHash: hashToken(token), resetTokenExpiresAt: minutesFromNow(RESET_TTL_MINUTES) } }
  );

  await mail.send({
    to: normalized,
    subject: 'Reset your Unmask password',
    text: [
      'Someone asked to reset the password on this Unmask account.',
      '',
      buildLink(config.appUrl, '/reset', token),
      '',
      `The link works once and expires in ${RESET_TTL_MINUTES} minutes. If you did not ask for it, ignore this email — your password has not changed.`,
    ].join('\n'),
  });

  return RESET_SENT;
}

async function resetPassword({ token, password }) {
  const candidate = String(token || '');
  const user = await User.findOne(
    { resetTokenHash: hashToken(candidate), resetTokenExpiresAt: { $gt: new Date() } },
    { email: 1 }
  ).select('+resetTokenHash +resetTokenExpiresAt');

  if (!user || !tokenMatches(candidate, user.resetTokenHash)) {
    throw new UserError('That reset link no longer works. Ask for a new one.', { status: 410, code: 'bad_token' });
  }

  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new UserError(`Use at least ${PASSWORD_MIN} characters.`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UserError(`Passwords are limited to ${PASSWORD_MAX_BYTES} bytes.`);
  }

  const hash = await bcrypt.hash(password, 12);

  await User.updateOne(
    { _id: user._id },
    {
      $set: { passwordHash: hash, resetTokenHash: null, resetTokenExpiresAt: null, sessions: [], failedLoginCount: 0, lockedUntil: null },
    }
  );

  // Any other device still holding a cookie is now signed out, which is the
  // reason a stolen password cannot keep a stolen session.
  await sessions.dropAll(user._id);

  return { email: user.email };
}

/**
 * Every row that is about these accounts, gone — and a tally of what went,
 * including the profile photo file, which is not a row.
 *
 * `models/User.js` owns the list of collections, and `services/personal-data.js`
 * owns the shape each one names a person with, so there is one place that has to
 * be right. Two callers come through this: a student deleting their own account,
 * and `npm run seed -- --reset` winding the demo data up. A second list of
 * collections somewhere else is a list that quietly stops matching the first one,
 * and the rows it misses are personal data that outlived the promise to delete it.
 */
async function eraseDataFor(userIds) {
  const mongoose = require('mongoose');
  const db = mongoose.connection;

  // The filters come from `personal-data.js`, which the access request reads too:
  // the list of what we can hand a person and the list of what we can take away
  // are the same list, so neither can drift behind the other.
  //
  // The photo is a file, not a row, so no collection delete below will touch it.
  // Its name has to be read while the profile still exists.
  const { filters, photoFileNames } = await personalData.ownData(userIds);

  // A collection `ownData` has never been told about would match on `userId`, find
  // nothing, and leave personal data behind that this promise said was gone.
  const byUser = {
    $or: [{ userId: { $in: userIds } }, { userA: { $in: userIds } }, { userB: { $in: userIds } }],
  };

  const removed = {};
  for (const name of User.dataCollections) {
    const result = await db.collection(name).deleteMany(filters[name] || byUser);
    removed[name] = result.deletedCount;
  }

  let files = 0;
  for (const fileName of photoFileNames) {
    if (await photos.unlink(fileName)) files += 1;
  }
  removed.photoFile = files;
  return removed;
}

/**
 * FR-1.6 — delete the account and all associated data.
 *
 * The caller must present the current password and an active session. A cookie
 * alone is not enough consent to erase a person, and this is the one route that
 * cannot be undone.
 */
async function deleteAccount({ userId, password, confirmText }) {
  if (confirmText !== 'DELETE') {
    throw new UserError('Type DELETE to confirm. This removes your account and everything about it.');
  }

  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new UserError('That account is already gone.', { status: 404 });

  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) throw new UserError('That password is not correct, so nothing was deleted.', { status: 403 });

  const removed = await eraseDataFor([userId]);

  await User.deleteOne({ _id: userId });
  await sessions.dropAll(userId);

  return { email: user.email, removed };
}

/**
 * NFR-3.1 — the right of access: hand a person their own record, as a file.
 *
 * The password check is not paranoia about a download. This document holds an
 * address, an age, everything written on the profile, every message in every
 * thread, and every moderation decision about the account — which is what an
 * attacker wants, and what a stolen laptop with a warm cookie already has open in
 * the browser. Deletion asks for the password because it cannot be undone; access
 * asks for it because the secret on the other side of that door is the same size.
 *
 * Nothing here writes. No row is touched, no "you exported your data" event is
 * recorded, because an access log that stores the moment a person asked would be
 * personal data created by the act of asking them for their data.
 */
async function exportData({ userId, password }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new UserError('That account is already gone.', { status: 404 });

  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) throw new UserError('That password is not correct, so nothing was released.', { status: 403 });

  return personalData.collectFor(userId);
}

module.exports = {
  CHECK_YOUR_EMAIL,
  DEV_AUTO_VERIFIED,
  RESET_SENT,
  assertShape,
  emailDomain,
  register,
  verifyEmailToken,
  resendVerification,
  login,
  logout,
  changePassword,
  requestPasswordReset,
  resetPassword,
  deleteAccount,
  exportData,
  eraseDataFor,
  PASSWORD_MIN,
};
