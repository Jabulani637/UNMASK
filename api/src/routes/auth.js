'use strict';
/**
 * /api/auth/* — the only routes an anonymous visitor can reach, so they are the
 * ones that must leak least. FR-1.1 to FR-1.6, NFR-2.4.
 *
 * Every response here is worded so that it reads the same whether the address
 * exists or not. The rules that produce that wording live in services/auth.js;
 * this file only moves bytes between HTTP and that module.
 */

const express = require('express');

const auth = require('../services/auth');
const sessions = require('../services/sessions');
const { rateLimit } = require('../middleware/rateLimit');
const { loadUser } = require('../middleware/requireUser');
const User = require('../models/User');

const router = express.Router();

// NFR-2.4. Generous enough for a student who mistypes their password twice,
// tight enough that a scripted guesser is stopped inside a minute.
const perIp = (bucket, limit, windowMs) => rateLimit({ bucket, limit, windowMs });

router.post(
  '/register',
  perIp('register', 6, 15 * 60 * 1000),
  async (req, res, next) => {
    try {
      const { message, devAutoVerified } = await auth.register({
        email: req.body.email,
        password: req.body.password,
        over18Attested: req.body.over18Attested,
      });
      // `devAutoVerified` is the only reason a client ever learns this address is
      // already usable: the sign-in still has to happen at /api/auth/login, with the
      // password, through the same lock and rate-limit budget as anybody else's.
      res.json(devAutoVerified ? { message, devAutoVerified: true } : { message });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/verify',
  perIp('verify', 20, 15 * 60 * 1000),
  async (req, res, next) => {
    try {
      await auth.verifyEmailToken(req.body.token);
      // The address is now proven, but that is not a login: no session cookie is
      // set here, so an attacker who guesses a link cannot inherit a session.
      res.json({ message: 'Your email is confirmed. Sign in to continue.' });
    } catch (err) {
      next(err);
    }
  }
);

/** FR-7.4's sibling: the link expired, so ask for another. Rate limited for the
 *  same reason register is — it sends mail. */
router.post(
  '/resend-verification',
  perIp('resend', 4, 30 * 60 * 1000),
  async (req, res, next) => {
    try {
      // The service answers the same sentence either way; a caller who is not
      // signed in cannot use this to test addresses.
      await auth.resendVerification(req.body.email);
      res.json({ message: auth.CHECK_YOUR_EMAIL });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  perIp('login', 10, 15 * 60 * 1000),
  async (req, res, next) => {
    try {
      const result = await auth.login({
        email: req.body.email,
        password: req.body.password,
        userAgent: req.get('user-agent') || '',
      });

      res.cookie(sessions.cookieName, result.session.id, sessions.cookieOptions());
      res.json({
        signedIn: true,
        email: result.email,
        expiresAt: result.session.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/logout', async (req, res, next) => {
  try {
    await auth.logout(req.cookies[sessions.cookieName]);
    res.clearCookie(sessions.cookieName, { path: '/' });
    res.json({ signedIn: false });
  } catch (err) {
    next(err);
  }
});

/** Whether this browser is signed in, and as whom. The profile screens ask this
 *  once on load instead of guessing from a stored token. */
router.get('/me', loadUser, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id, { email: 1, emailVerifiedAt: 1, notifications: 1, role: 1 });
    res.json({
      signedIn: true,
      email: user.email,
      notifications: user.notifications,
      // Whether *this* account is staff — one boolean about the caller's own record,
      // which is what a nav link needs before it can offer a door it cannot open. The
      // staff routes themselves still answer 404 to anybody who is not one, so a
      // forged `true` here buys a broken link and nothing else.
      staff: user.role === 'admin',
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/forgot',
  perIp('forgot', 5, 60 * 60 * 1000),
  async (req, res, next) => {
    try {
      const message = await auth.requestPasswordReset(req.body.email);
      res.json({ message });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/reset',
  perIp('reset', 10, 30 * 60 * 1000),
  async (req, res, next) => {
    try {
      await auth.resetPassword({ token: req.body.token, password: req.body.password });
      res.clearCookie(sessions.cookieName, { path: '/' });
      res.json({ message: 'Your password is changed. Sign in with it.' });
    } catch (err) {
      next(err);
    }
  }
);

/** Changing a password from inside the app signs every device out, which is the
 *  point of changing it. */
router.post('/password', loadUser, perIp('password', 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    await auth.changePassword({
      userId: req.user.id,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
    });
    res.clearCookie(sessions.cookieName, { path: '/' });
    res.json({ message: 'Password changed. Everyone, including you, is signed out — sign in again.' });
  } catch (err) {
    next(err);
  }
});

/**
 * NFR-3.1 — the right of access, as a file.
 *
 * It downloads instead of rendering because that is what a person takes to a
 * lawyer, a parent or a complaint: `attachment` means the browser writes it to
 * disk under a name that says whose it is, rather than painting a wall of JSON
 * that has to be copy-pasted. The body is the shaped document the service builds
 * — no raw rows, no other student's id, no hashes.
 *
 * Six an hour is not so much anti-abuse as anti-accident: the request needs the
 * password, and a route that hands out a person's whole record is not one to
 * leave unlimited behind a stolen cookie.
 */
router.post('/export', loadUser, perIp('export', 6, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const data = await auth.exportData({ userId: req.user.id, password: req.body.password });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="unmask-my-data-${stamp}.json"`);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

/**
 * FR-1.6. Immediate and irreversible: the account, the profile, the matches,
 * the messages and the photo are gone from this moment, not after 30 days.
 * NFR-3.5's 30 days is the ceiling for backups and logs, which is stage 9's
 * deletion job — this route is the user-facing half.
 */
router.delete('/account', loadUser, perIp('delete', 3, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const result = await auth.deleteAccount({
      userId: req.user.id,
      password: req.body.password,
      confirmText: req.body.confirmText,
    });
    res.clearCookie(sessions.cookieName, { path: '/' });
    res.json({
      message: 'Your account and everything in it has been deleted.',
      removed: result.removed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
