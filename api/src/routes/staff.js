'use strict';
/**
 * /api/staff — the queue, the platform's numbers, and the five hands that can reach
 * into a student's account. FR-6.3, FR-6.4, FR-6.5, FR-8.1, FR-8.2.
 *
 * Every route here is behind `requireStaff`, which answers 404 to anybody who is not
 * an active admin, and every write here goes through services/staff.js, which is the
 * only place that knows a decision has to land on three documents. What this file
 * adds is the door, the `no-store` on the one route that serves a face, and the shape
 * of a response: staff see what a student may never see, and the API keeps those two
 * vocabularies apart by keeping them in different files.
 *
 * There is no route here that reads a *student's* chat history. A moderator judging a
 * reported message already has the message, copied into the report when it was
 * filed; giving staff a way to read an entire anonymous conversation would be a
 * bigger privacy decision than FR-6.3 asks for, and the brief does not ask for it.
 */

const express = require('express');

const staff = require('../services/staff');
const { requireStaff } = require('../middleware/requireStaff');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// All of it, signed-in staff only, before any handler runs.
router.use(requireStaff);

const writeGuard = rateLimit({ limit: 120, windowMs: 60 * 1000, bucket: 'staff-write' });

/** FR-6.3 — the queue. Oldest first, because a report has been waiting. */
router.get('/reports', async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : 'open';
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.set('Cache-Control', 'no-store');
    res.json(await staff.queue({ status, limit }));
  } catch (err) {
    next(err);
  }
});

/** FR-6.5 — one account's whole record as staff hold it. */
router.get('/accounts/:userId', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await staff.account(req.params.userId));
  } catch (err) {
    next(err);
  }
});

/**
 * FR-8.1 — the platform's numbers.
 *
 * Read, not written, so it carries the queue's rate limit rather than the write one,
 * and `no-store` for the same reason every staff response has it: a shared staff-room
 * computer should not be holding last shift's moderation counts in its cache. What
 * makes this route different from the other four is that it is the only one whose
 * entire answer is aggregate — see services/staff.js's `stats` for why there is no
 * breakdown small enough to point at a person.
 */
router.get('/stats', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await staff.stats());
  } catch (err) {
    next(err);
  }
});

/**
 * The photo door. `no-store` for the reason every face route has it, and audited for
 * the reason only this one is: a staff member looking at a student's picture is an
 * act worth being able to ask about later.
 */
router.get('/accounts/:userId/photo', async (req, res, next) => {
  try {
    const { buffer, mime } = await staff.photoOf({ staffId: req.staff.id, userId: req.params.userId });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', mime);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/** FR-6.3, FR-6.4 — end a report: dismiss it, hold the profile, pause or close the account. */
router.post('/reports/:id/decide', writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await staff.decide({
      staffId: req.staff.id,
      reportId: req.params.id,
      action: body.action,
      note: body.note || null,
    });

    res.json({
      decided: true,
      action: result.action,
      status: result.report.status,
      effect: result.effect,
      message:
        result.action === 'dismissed'
          ? 'Closed with no action taken. The reporter is not told that, and the student is not told about the report.'
          : result.action === 'removed-content'
            ? 'That profile is on hold. Its owner will see why the next time they open it.'
            : `That account is ${result.action}.`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-6.3 — the account lever on its own, which is also the way back. A wrong ban has
 * to be liftable by the person who notices, without a report to attach it to.
 */
router.post('/accounts/:userId/status', writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await staff.setStatus({
      staffId: req.staff.id,
      userId: req.params.userId,
      status: body.status,
      reason: body.reason || null,
    });

    res.json({
      changed: result.changed,
      status: result.status,
      threadsClosed: result.threads || 0,
      message: result.already
        ? `That account is already ${result.status}.`
        : result.status === 'active'
          ? 'Reinstated. They can sign in again; the conversations that were closed stay closed.'
          : `That account is ${result.status}. They are signed out everywhere and no longer suggested.`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-8.2 — the eligibility lever. A staff member who has checked a card, a letter or
 * the register can record that decision here, and take it back again.
 *
 * It is a separate route from `/status` on purpose: an account can be paused because
 * somebody reported it, which has nothing to do with whether it belongs to a student,
 * and one person's answer to the second question must not be able to undo the first.
 */
router.post('/accounts/:userId/student', writeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await staff.setStudentStatus({
      staffId: req.staff.id,
      userId: req.params.userId,
      status: body.status,
      note: body.note || null,
    });

    res.json({
      changed: result.changed,
      studentStatus: result.status,
      accountStatus: result.accountStatus,
      threadsClosed: result.threads,
      message:
        result.status === 'revoked'
          ? 'Their student status is revoked. The account is paused, they are signed out everywhere, and the next time they try to sign in they are told why, in your words.'
          : 'Their student status is verified. If a revoked status was the only thing pausing this account, they can sign in again — a pause from a report stays.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * NFR-SCALE-1 — the list the entire product's eligibility rule is built from, and
 * the only screen in the codebase where a person with no server access and no
 * deployment can change who is allowed to register.
 *
 * Deactivated rows are included, because the toggle that turns an institution back on
 * has to be reachable; `/api/meta` gives students the active subset only.
 */
router.get('/institutions', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ institutions: await staff.institutionList() });
  } catch (err) {
    next(err);
  }
});

/** Add a college. Its domains are what make its students eligible from that moment. */
router.post('/institutions', writeGuard, async (req, res, next) => {
  try {
    const { institution, changes } = await staff.saveInstitution({
      staffId: req.staff.id,
      body: req.body || {},
    });
    res.status(201).json({
      created: true,
      institution,
      message: `${institution.shortName} can register now. ${institution.emailDomains.length} domain(s): ${institution.emailDomains.join(', ')}.`,
      changes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Edit one, or switch it off. The body is a patch — a form that sends only
 * `isActive` must not be able to clear the domains and lock out every student there.
 */
router.put('/institutions/:id', writeGuard, async (req, res, next) => {
  try {
    const { institution, changes } = await staff.saveInstitution({
      staffId: req.staff.id,
      id: req.params.id,
      body: req.body || {},
    });
    res.json({
      updated: true,
      institution,
      message: institution.isActive
        ? `${institution.shortName} is saved.`
        : `${institution.shortName} is switched off. Its existing accounts are untouched, but its students are no longer suggested and its addresses can no longer register.`,
      changes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Which college to add next, in the words of the people asking for it. Grouped by
 * the name typed, newest first — see services/institutions.js's `requestSummary`.
 */
router.get('/institution-requests', async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.set('Cache-Control', 'no-store');
    res.json(await staff.institutionRequests({ limit }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
