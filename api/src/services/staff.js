'use strict';
/**
 * The staff side of stage 7 and the statistics of FR-8.1: read the queue, decide,
 * act, count the platform, keep the list of institutions the whole product is
 * built on, and be the person who decides whether somebody is a student at all.
 * FR-6.3, FR-6.4, FR-6.5, FR-8.1, FR-8.2, NFR-SCALE-1.
 *
 * Three rules hold this file together.
 *
 * **A decision is written in three places at once** — on the report (what was
 * decided and by whom), on the thing it touched (a profile's hold, an account's
 * status), and in the audit log (who, whom, when). FR-6.5 asks for a log, and a log
 * that disagrees with the state it produced is worse than no log, so the state
 * change and the audit row are written by the same function and neither is left to a
 * route to remember.
 *
 * **A staff member sees what a student never may, and nothing else.** The queue
 * renders the reported words, the reporter's account, and the reported student's
 * card — three things no student-facing route returns together. What it does not
 * carry is anybody's email address: the queue works entirely on account ids, because
 * an email on every row of a list a person reads on a shared staff room computer is
 * personal data with no job to do. (A moderator who has to contact somebody uses the
 * account route, which is its own audited act.)
 *
 * **A pause is reversible and a face is not looked at for free.** Every status
 * change can be undone — `reinstated` is one of the actions, because the cost of a
 * wrong ban is borne by the student who did nothing — and the photo door exists so a
 * photo report can actually be judged, which makes it the fourth route in the API
 * that serves one person's face to another. It is staff-gated, `no-store`, and it
 * writes an audit row, because "who looked at this face" is a question FR-6.5 asks.
 */

const AuditEvent = require('../models/AuditEvent');
const Block = require('../models/Block');
const Match = require('../models/Match');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Pass = require('../models/Pass');
const Profile = require('../models/Profile');
const Report = require('../models/Report');
const User = require('../models/User');
const { UserError } = require('../errors');
const vocab = require('../domain/vocabulary');
const photos = require('./photos');
const realtime = require('../realtime');
const sessions = require('./sessions');
const institutions = require('./institutions');

/** FR-6.3's four endings to a report. */
const ACTIONS = ['dismissed', 'removed-content', 'suspended', 'banned'];
const STATUSES = ['active', 'suspended', 'banned'];

/** FR-8.2's two staff moves. There is no third value to set by hand: verifying is
 *  how a wrong revocation is undone, and every account starts life `attested`. */
const STUDENT_STATUSES = ['verified', 'revoked'];

/** The card a staff member reads: what a student's own profile screen holds. */
async function cardFor(userId) {
  const [user, profile] = await Promise.all([
    User.findById(userId, { status: 1, statusReason: 1, emailVerifiedAt: 1, createdAt: 1, student: 1 }),
    Profile.findOne({ userId }, { year: 1, faculty: 1, institutionId: 1, revealName: 1, interests: 1, prompts: 1, typeNote: 1, review: 1, 'photo.fileName': 1, createdAt: 1 }),
  ]);
  const institution = profile
    ? (await institutions.byIds([profile.institutionId])).get(String(profile.institutionId)) || null
    : null;
  const held = Boolean(profile && profile.review && profile.review.status === 'held');
  return {
    userId: String(userId),
    account: user
      ? {
          status: user.status,
          reason: user.statusReason || null,
          since: user.createdAt,
          student: user.student ? { status: user.student.status, at: user.student.at || null, note: user.student.note || null } : null,
        }
      : { status: 'deleted', reason: null, since: null, student: null },
    // A filename is never a piece of a response — the same rule every student-facing
    // screen runs by, and the reason the photo door takes an id and not a path.
    hasPhoto: Boolean(profile && profile.photo && profile.photo.fileName),
    held,
    year: profile ? profile.year : null,
    faculty: profile ? profile.faculty : null,
    institution: institution ? { shortName: institution.shortName, name: institution.name } : null,
    prompts: profile ? profile.prompts.map(entry => ({ prompt: entry.prompt, answer: entry.answer })) : [],
    /*
     * The "who I am after" note. It is the second sentence on a profile that a
     * stranger is handed, and a report about it would otherwise be judged by
     * somebody who cannot read it — so it is on this card with the prompt answers,
     * which are the same problem in a longer box.
     *
     * `identity` is deliberately not beside it. A staff card holds what a student
     * wrote that another student can see; a race is not a thing anybody reports,
     * and putting it on the row a shift reads is how it becomes a moderation
     * category. It is on the export a student asks for and nowhere else a staff
     * member will find it.
     */
    typeNote: profile ? profile.typeNote || null : null,
  };
}

/**
 * The queue, oldest first, with everything a decision needs on one row.
 *
 * `open` is the default and the only thing a shift begins with; `actioned` and
 * `dismissed` are read back for FR-6.5's "what did we do about it", not to work
 * through.
 */
async function queue({ status = 'open', limit = 50 } = {}) {
  if (!['open', 'actioned', 'dismissed', 'all'].includes(status)) {
    throw new UserError('Read the queue by one of its own names.', { status: 400, code: 'bad_status' });
  }
  const page = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const filter = status === 'all' ? {} : { status };
  const rows = await Report.find(filter).sort({ createdAt: 1 }).limit(page).lean();

  const reports = [];
  for (const row of rows) {
    const [reporter, reported] = await Promise.all([cardFor(row.reporterId), cardFor(row.reportedUserId)]);
    reports.push({
      id: String(row._id),
      at: row.createdAt,
      kind: row.kind,
      reason: row.reason,
      detail: row.detail,
      excerpt: row.excerpt,
      matchId: row.matchId ? String(row.matchId) : null,
      promptIndex: row.promptIndex,
      status: row.status,
      decision: row.decision,
      decisionNote: row.decisionNote,
      decidedAt: row.decidedAt,
      // The queue counts how often an account has been reported, because that is the
      // one signal that separates a disputed profile from a problematic one.
      openAgainst: await Report.countDocuments({ reportedUserId: row.reportedUserId, status: 'open' }),
      reporter,
      reported,
    });
  }

  return { status, count: reports.length, reports };
}

/**
 * Close a suspended or banned student's conversations, and tell the other halves
 * that the thread is closed.
 *
 * `closedBy` stays empty: a ban is not a student walking away, and recording it as
 * one would tell the other half *who* ended it, which is the fact a leave is built to
 * hide. The peers learn only that it stopped, on the same one-word frame an
 * End-chat sends, because what they need is the screen changing, not the reason.
 */
async function closeThreads(userId, note) {
  const open = await Match.find({ users: userId, status: 'open' });
  for (const match of open) {
    await Match.updateOne({ _id: match._id }, { $set: { status: 'closed', closedBy: null } });
    realtime.announceClosed({ _id: match._id, users: match.users });
  }
  if (open.length) {
    await AuditEvent.create({
      actorId: null,
      automated: true,
      action: 'threads.closed',
      subjectId: userId,
      targetType: 'account',
      note,
      data: { threads: open.length },
    });
  }
  return open.length;
}

/**
 * Change what an account may do. FR-6.3.
 *
 * A suspension and a ban do the same thing to a session and to a set of threads, and
 * differ only in the word a later reader of the audit log sees — which is honest,
 * because v1 has no path back from either except a staff member pressing reinstate,
 * and no waiting period is encoded anywhere.
 */
async function setStatus({ staffId, userId, status, reason = null }) {
  if (!STATUSES.includes(status)) {
    throw new UserError('An account is active, suspended, or banned.', { status: 400, code: 'bad_status' });
  }

  const user = await User.findById(userId, { status: 1, _id: 1 });
  if (!user) throw new UserError('That account is already gone.', { status: 404, code: 'no_account' });
  if (user.status === status) return { changed: false, status, already: true };

  await User.updateOne({ _id: userId }, { $set: { status, statusReason: reason ? String(reason).slice(0, 300) : null } });

  let threads = 0;
  if (status !== 'active') {
    // Sign them out everywhere first: an opaque session list is the one thing that
    // can do it instantly, which is why the tokens are not self-describing.
    await sessions.dropAll(userId);
    realtime.disconnect(userId);
    threads = await closeThreads(userId, `An account was ${status === 'banned' ? 'banned' : 'suspended'} by staff; its open conversations were closed.`);
  }

  await AuditEvent.create({
    actorId: staffId,
    action: status === 'active' ? 'account.reinstated' : `account.${status}`,
    subjectId: userId,
    targetType: 'account',
    targetId: userId,
    note: reason ? String(reason).slice(0, 400) : null,
    data: { status, threads },
  });

  return { changed: true, status, threads, sessionsDropped: status !== 'active' };
}

/**
 * Decide whether this account belongs to a student at a verified institution. FR-8.2.
 *
 * This is the eligibility rule rather than a punishment, so it is recorded on its own
 * field and then borrows the account's `status` to take effect. That is deliberate: a
 * person staff have decided is not a student must stop being suggested, stop matching and
 * be signed out, and every route in the app already asks `status` before it allows any of
 * those. A second field deciding the same thing a second way is how one of them ends up
 * not being checked.
 *
 * The one subtlety is the way back. **Verifying lifts only the pause this tool made.** An
 * account suspended because a report was decided against it stays suspended when somebody
 * confirms they go to this university — those are different questions, and the second one
 * does not answer the first.
 *
 * A revocation cannot be submitted without a sentence, because it is the one staff act
 * whose reason is handed straight to the student: they read it at their own sign-in
 * attempt, which is the only moment a paused account can be reached at all.
 */
async function setStudentStatus({ staffId, userId, status, note = null }) {
  if (!STUDENT_STATUSES.includes(status)) {
    throw new UserError('A student status is either verified or revoked.', { status: 400, code: 'bad_status' });
  }

  const user = await User.findById(userId, { _id: 1, status: 1, 'student.status': 1 });
  if (!user) throw new UserError('That account is already gone.', { status: 404, code: 'no_account' });

  const text = note ? String(note).trim().slice(0, 400) : '';
  if (status === 'revoked' && !text) {
    throw new UserError('Say why — that sentence is what the student is shown when they try to sign in.', {
      status: 400,
      code: 'note_required',
    });
  }

  const at = new Date();
  await User.updateOne(
    { _id: userId },
    { $set: { 'student.status': status, 'student.at': at, 'student.by': staffId, 'student.note': text || null } }
  );

  let effect = { status: user.status, threads: 0 };
  if (status === 'revoked') {
    effect = await setStatus({ staffId, userId, status: 'suspended', reason: text });
  } else if (user.student && user.student.status === 'revoked' && user.status !== 'active') {
    effect = await setStatus({ staffId, userId, status: 'active', reason: 'Student status verified by staff.' });
  }

  await AuditEvent.create({
    actorId: staffId,
    action: `student.${status}`,
    subjectId: userId,
    targetType: 'account',
    targetId: userId,
    note: text || `Student status ${status}.`,
    data: { accountStatus: effect.status, threads: effect.threads },
  });

  return { changed: true, status, at, accountStatus: effect.status, threads: effect.threads };
}

/**
 * Decide a report. The three writes are the point — see the header.
 *
 * A note is optional except when something is being removed from a profile, because
 * FR-6.4's next step is the student reading *why* their profile stopped appearing,
 * and that sentence comes from here.
 */
async function decide({ staffId, reportId, action, note = null }) {
  if (!ACTIONS.includes(action)) {
    throw new UserError('A report ends in one of: ' + ACTIONS.join(', ') + '.', { status: 400, code: 'bad_action' });
  }

  const report = await Report.findById(reportId);
  if (!report) throw new UserError('That report is not one you can decide.', { status: 404, code: 'no_report' });
  if (report.status !== 'open') {
    throw new UserError('That report has already been decided.', { status: 409, code: 'already_decided' });
  }

  const text = note ? String(note).trim().slice(0, 400) : '';
  if (action === 'removed-content' && !text) {
    throw new UserError('Say what was wrong with it — that sentence is what the student will be shown.', {
      status: 400,
      code: 'note_required',
    });
  }

  const at = new Date();
  report.status = action === 'dismissed' ? 'dismissed' : 'actioned';
  report.decision = action;
  report.decidedBy = staffId;
  report.decidedAt = at;
  report.decisionNote = text || null;
  await report.save();

  let effect = null;

  if (action === 'removed-content') {
    // FR-6.4 — the profile stops being suggested, and its owner is told why on their
    // own screen. The reported text itself is not edited by us: a student's profile is
    // theirs to change, and v1 has no business rewriting anybody's sentences.
    await Profile.updateOne(
      { userId: report.reportedUserId },
      { $set: { 'review.status': 'held', 'review.reason': text, 'review.at': at } }
    );
    await AuditEvent.create({
      actorId: staffId,
      action: 'content.removed',
      subjectId: report.reportedUserId,
      targetType: 'report',
      targetId: report._id,
      note: text,
      data: { kind: report.kind },
    });
    effect = { held: true };
  }

  if (action === 'suspended' || action === 'banned') {
    const result = await setStatus({ staffId, userId: report.reportedUserId, status: action, reason: text || report.reason });
    effect = { accountStatus: result.status, threads: result.threads };
  }

  await AuditEvent.create({
    actorId: staffId,
    action: 'report.decided',
    subjectId: report.reportedUserId,
    targetType: 'report',
    targetId: report._id,
    note: text || `Decided: ${action}.`,
    data: { action, kind: report.kind },
  });

  return { report, action, effect };
}

/**
 * Everything staff know about one account: its reports and its own decisions' log.
 * An audit list is ids and sentences, which is what makes it safe to render.
 */
async function account(userId) {
  const [card, reports, events] = await Promise.all([
    cardFor(userId),
    Report.find({ reportedUserId: userId }).sort({ createdAt: -1 }).limit(50).lean(),
    AuditEvent.find({ subjectId: userId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  return {
    ...card,
    reports: reports.map(row => ({
      id: String(row._id),
      at: row.createdAt,
      kind: row.kind,
      reason: row.reason,
      status: row.status,
      decision: row.decision,
      excerpt: row.excerpt,
    })),
    log: events.map(row => ({ at: row.createdAt, action: row.action, by: row.actorId ? String(row.actorId) : null, note: row.note })),
  };
}

const DAY = 24 * 60 * 60 * 1000;
const TREND_DAYS = 14;

/** Run a list of named count queries at once and hand back `{ name: number }`. */
async function tally(queries) {
  const names = Object.keys(queries);
  const values = await Promise.all(names.map(name => queries[name]()));
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

/**
 * A percentage to one decimal — or null.
 *
 * `null` matters: on a database with no chats, "reveal rate: 0%" reads as "students
 * are not revealing", when the truth is that there is nothing to have a rate over
 * yet. A blank on the screen is the honest answer to an empty denominator.
 */
function percent(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : null;
}

/** One count per UTC day for the last fortnight, including the days that scored zero. */
async function perDay(model, { field = 'createdAt', filter = {} } = {}) {
  const since = new Date(Date.now() - (TREND_DAYS - 1) * DAY);
  since.setUTCHours(0, 0, 0, 0);

  const rows = await model.aggregate([
    { $match: { ...filter, [field]: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}` } }, n: { $sum: 1 } } },
  ]);

  const byDay = new Map(rows.map(row => [row._id, row.n]));
  const days = [];
  for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
    days.push({ date: day, n: byDay.get(day) || 0 });
  }
  return days;
}

/**
 * FR-8.1 — the platform's numbers, and nothing that identifies anybody.
 *
 * **Every figure is a count or a rate over counts.** There is no breakdown by
 * faculty, institution or year, which is the shape a statistics page usually reaches
 * for and the one that stops being aggregate on a small cohort: "3 students in
 * Applied Biology were banned this month" names people to anyone who knows the
 * department. A platform-wide number cannot be traced back to a student, and that is
 * why the smallest unit here is a total.
 *
 * **No text leaves.** Not a message body, not a prompt answer, not a report's note,
 * not an email address, not an account id — the response is built out of
 * `countDocuments` results, so there is no code path by which a sentence a student
 * wrote could be assembled into it. That is what FR-8.1's "without exposing
 * individual chat content" asks for, and `test/staff.test.js` checks it by putting a
 * known word into a chat and searching the whole response for it.
 *
 * **The two rates state their own denominators**, in `basis`, because "match rate"
 * without one is a number people believe for the wrong reason. A decline stops being
 * on file when its pass expires (models/Pass.js), so `matchRate` is a rate over the
 * decisions still recorded, not over every card ever shown — and the engine keeps no
 * counter for "Show another", which is the honest limit of what can be measured here.
 */
async function stats() {
  const now = new Date();
  const week = new Date(now - 7 * DAY);
  const month = new Date(now - 30 * DAY);

  const n = await tally({
    accountsTotal: () => User.countDocuments({}),
    accountsActive: () => User.countDocuments({ status: 'active' }),
    accountsSuspended: () => User.countDocuments({ status: 'suspended' }),
    accountsBanned: () => User.countDocuments({ status: 'banned' }),
    staffTotal: () => User.countDocuments({ role: 'admin' }),
    emailVerified: () => User.countDocuments({ emailVerifiedAt: { $ne: null } }),
    attested18: () => User.countDocuments({ over18AttestedAt: { $ne: null } }),
    studentVerified: () => User.countDocuments({ 'student.status': 'verified' }),
    studentRevoked: () => User.countDocuments({ 'student.status': 'revoked' }),
    signedInWeek: () => User.countDocuments({ lastLoginAt: { $gte: week } }),
    signedInMonth: () => User.countDocuments({ lastLoginAt: { $gte: month } }),
    createdWeek: () => User.countDocuments({ createdAt: { $gte: week } }),
    createdMonth: () => User.countDocuments({ createdAt: { $gte: month } }),

    profilesTotal: () => Profile.countDocuments({}),
    profilesWithPhoto: () => Profile.countDocuments({ 'photo.fileName': { $ne: null } }),
    profilesHeld: () => Profile.countDocuments({ 'review.status': 'held' }),
    profilesMatchable: async () => {
      // The same three minimums models/Profile.js applies to a student's own screen,
      // run as one aggregation rather than a loop over every profile.
      const [row] = await Profile.aggregate([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [{ $size: { $ifNull: ['$interests', []] } }, vocab.MIN_INTERESTS] },
                { $gte: [{ $size: { $ifNull: ['$prompts', []] } }, vocab.MIN_PROMPTS] },
                { $ne: ['$review.status', 'held'] },
              ],
            },
          },
        },
        { $count: 'n' },
      ]);
      return row ? row.n : 0;
    },

    chatsTotal: () => Match.countDocuments({}),
    chatsOpen: () => Match.countDocuments({ status: 'open' }),
    chatsEnded: () => Match.countDocuments({ status: 'closed' }),
    declinesOnFile: () => Pass.countDocuments({}),

    revealAsked: () => Match.countDocuments({ 'reveal.askedAt': { $ne: null } }),
    revealRevealed: () => Match.countDocuments({ 'reveal.status': 'revealed' }),
    revealPending: () => Match.countDocuments({ 'reveal.status': 'pending' }),
    revealDeclined: () => Match.countDocuments({ 'reveal.declinedAt': { $ne: null } }),
    revealRevoked: () => Match.countDocuments({ 'reveal.revokedAt': { $ne: null } }),

    messagesTotal: () => Message.countDocuments({}),
    messagesWeek: () => Message.countDocuments({ createdAt: { $gte: week } }),

    reportsTotal: () => Report.countDocuments({}),
    reportsOpen: () => Report.countDocuments({ status: 'open' }),
    reportsWaitingOverAWeek: () => Report.countDocuments({ status: 'open', createdAt: { $lt: week } }),
    reportedProfile: () => Report.countDocuments({ kind: 'profile' }),
    reportedPrompt: () => Report.countDocuments({ kind: 'prompt' }),
    reportedPhoto: () => Report.countDocuments({ kind: 'photo' }),
    reportedMessage: () => Report.countDocuments({ kind: 'message' }),
    decidedDismissed: () => Report.countDocuments({ decision: 'dismissed' }),
    decidedRemoved: () => Report.countDocuments({ decision: 'removed-content' }),
    decidedSuspended: () => Report.countDocuments({ decision: 'suspended' }),
    decidedBanned: () => Report.countDocuments({ decision: 'banned' }),
    blocksTotal: () => Block.countDocuments({}),

    noticesTotal: () => Notification.countDocuments({}),
    noticesUnread: () => Notification.countDocuments({ readAt: null }),
    noticesWeek: () => Notification.countDocuments({ createdAt: { $gte: week } }),
    noticesSuggestion: () => Notification.countDocuments({ kind: 'suggestion' }),
    noticesMessage: () => Notification.countDocuments({ kind: 'message' }),
    noticesRevealAsked: () => Notification.countDocuments({ kind: 'reveal-request' }),
    noticesRevealDone: () => Notification.countDocuments({ kind: 'reveal-done' }),
    emailNoticesOn: () => User.countDocuments({ 'notifications.email': true }),
    suggestionsOff: () => User.countDocuments({ 'notifications.suggestions': false }),
  });

  const [perDayAccounts, perDayChats, perDayMessages, perDayReveals] = await Promise.all([
    perDay(User),
    perDay(Match),
    perDay(Message),
    perDay(Match, { field: 'reveal.revealedAt', filter: { 'reveal.revealedAt': { $ne: null } } }),
  ]);

  const reveals = new Map(perDayReveals.map(row => [row.date, row.n]));
  const messages = new Map(perDayMessages.map(row => [row.date, row.n]));
  const chats = new Map(perDayChats.map(row => [row.date, row.n]));

  return {
    generatedAt: now,
    accounts: {
      total: n.accountsTotal,
      active: n.accountsActive,
      suspended: n.accountsSuspended,
      banned: n.accountsBanned,
      staff: n.staffTotal,
      emailVerified: n.emailVerified,
      over18Attested: n.attested18,
      studentVerified: n.studentVerified,
      studentRevoked: n.studentRevoked,
      signedInLast7Days: n.signedInWeek,
      signedInLast30Days: n.signedInMonth,
      createdLast7Days: n.createdWeek,
      createdLast30Days: n.createdMonth,
      shareActiveThisWeek: percent(n.signedInWeek, n.accountsActive),
    },
    profiles: {
      total: n.profilesTotal,
      matchable: n.profilesMatchable,
      withPhoto: n.profilesWithPhoto,
      onHold: n.profilesHeld,
      shareMatchable: percent(n.profilesMatchable, n.profilesTotal),
    },
    matching: {
      chatsOpened: n.chatsTotal,
      chatsOpen: n.chatsOpen,
      chatsEnded: n.chatsEnded,
      declinesOnFile: n.declinesOnFile,
      matchRate: percent(n.chatsTotal, n.chatsTotal + n.declinesOnFile),
      chatsPerActiveStudent: n.accountsActive ? Math.round((n.chatsTotal / n.accountsActive) * 100) / 100 : null,
    },
    reveal: {
      asked: n.revealAsked,
      waiting: n.revealPending,
      revealed: n.revealRevealed,
      declinedAtLeastOnce: n.revealDeclined,
      revoked: n.revealRevoked,
      revealRate: percent(n.revealRevealed, n.chatsTotal),
      askedPerChat: n.chatsTotal ? Math.round((n.revealAsked / n.chatsTotal) * 100) / 100 : null,
    },
    conversation: {
      messages: n.messagesTotal,
      messagesLast7Days: n.messagesWeek,
      messagesPerChat: n.chatsTotal ? Math.round((n.messagesTotal / n.chatsTotal) * 10) / 10 : null,
    },
    safety: {
      reportsTotal: n.reportsTotal,
      waiting: n.reportsOpen,
      waitingOverAWeek: n.reportsWaitingOverAWeek,
      byKind: {
        profile: n.reportedProfile,
        prompt: n.reportedPrompt,
        photo: n.reportedPhoto,
        message: n.reportedMessage,
      },
      decisions: {
        dismissed: n.decidedDismissed,
        removedContent: n.decidedRemoved,
        suspended: n.decidedSuspended,
        banned: n.decidedBanned,
      },
      blocks: n.blocksTotal,
    },
    notices: {
      total: n.noticesTotal,
      unread: n.noticesUnread,
      last7Days: n.noticesWeek,
      byKind: {
        suggestion: n.noticesSuggestion,
        message: n.noticesMessage,
        revealRequested: n.noticesRevealAsked,
        revealDone: n.noticesRevealDone,
      },
      studentsWithEmailNoticesOn: n.emailNoticesOn,
      studentsWhoPausedSuggestions: n.suggestionsOff,
    },
    /**
     * What the two rates are actually a rate over — including the thing that cannot
     * be measured, so nobody invents it.
     */
    basis: {
      matchRate:
        'Chats opened ÷ (chats opened + declines still on file). A decline stops being on file when its week is up, and the engine keeps no count of "Show another" presses, so this is a rate over the decisions still recorded rather than over every card shown.',
      revealRate:
        'Pairs where both said yes ÷ pairs ever opened. It counts up from zero as chats age, because a reveal needs three messages from each side first.',
      trend: 'Fourteen UTC days, oldest first, including the days that scored nothing.',
    },
    trend: perDayAccounts.map(row => ({
      date: row.date,
      accounts: row.n,
      chats: chats.get(row.date) || 0,
      messages: messages.get(row.date) || 0,
      reveals: reveals.get(row.date) || 0,
    })),
  };
}

/**
 * The fourth face door, and the only one that is not a student's consent.
 *
 * A 'photo' report that nobody can look at is not reviewable, so staff get the
 * student's *current* photo — not a copy taken at report time, which is why a photo
 * report's snapshot row holds only the upload timestamp (models/Report.js). The two
 * consequences are stated where they can be seen: if the student has replaced the
 * picture since, staff are judging the new one, and the audit row below is what
 * records that this face was looked at, by whom, and when.
 */
async function photoOf({ staffId, userId }) {
  const profile = await Profile.findOne({ userId }, { 'photo.fileName': 1 });
  const fileName = profile && profile.photo && profile.photo.fileName;
  if (!fileName) throw new UserError('That student has no photo on file.', { status: 404, code: 'no_photo' });

  const buffer = await photos.read(fileName);
  if (!buffer) throw new UserError('That photo could not be read.', { status: 404, code: 'photo_missing' });

  await AuditEvent.create({
    actorId: staffId,
    action: 'photo.viewed',
    subjectId: userId,
    targetType: 'profile',
    targetId: profile._id,
    note: 'A staff member opened a reported profile photo.',
  });

  const format = photos.sniff(buffer);
  return { buffer, mime: format ? format.mime : 'application/octet-stream' };
}

/**
 * NFR-SCALE-1 — the institutions the whole product is built on, and the five hands
 * that add to that list from a browser.
 *
 * `institutionList` deliberately holds back one number a staff screen would find
 * useful: how many students each institution has. FR-8.1's rule is that no breakdown
 * may be small enough to point at a person, and "the college with one student" is
 * exactly that. The totals live in `stats`, which is aggregate on purpose.
 *
 * `saveInstitution` snapshots before it writes because `institutions.update` mutates
 * the document it was handed — diffing afterwards would compare a row with itself and
 * report that nothing changed, which is the one thing an audit row must never do.
 */
const CHANGE_FIELDS = ['name', 'shortName', 'type', 'city', 'isActive'];
const LIST_FIELDS = ['emailDomains', 'faculties'];

function institutionCard(row) {
  return {
    ...institutions.publicList([row])[0],
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function snapshotInstitution(institution) {
  const plain = {};
  for (const field of [...CHANGE_FIELDS, ...LIST_FIELDS]) {
    plain[field] = Array.isArray(institution[field]) ? [...institution[field]] : institution[field];
  }
  return plain;
}

function describeChanges(before, after) {
  const lines = [];
  for (const field of CHANGE_FIELDS) {
    if (before[field] === after[field]) continue;
    lines.push(
      field === 'isActive'
        ? (after.isActive ? 'reactivated' : 'deactivated — its students stop being suggested and new addresses stop registering')
        : `${field} “${before[field]}” → “${after[field]}”`
    );
  }
  for (const field of LIST_FIELDS) {
    const added = after[field].filter(value => !before[field].includes(value));
    const removed = before[field].filter(value => !after[field].includes(value));
    if (added.length) lines.push(`${field}: +${added.join(', ')}`);
    if (removed.length) lines.push(`${field}: −${removed.join(', ')}`);
  }
  return lines;
}

async function institutionList() {
  const rows = await institutions.staffList();
  return rows.map(institutionCard);
}

async function saveInstitution({ staffId, id = null, body = {} }) {
  const existing = id ? await institutions.get(id) : null;
  const before = existing && snapshotInstitution(existing);

  const institution = existing
    ? await institutions.update(String(existing._id), body)
    : await institutions.create(body);

  const after = snapshotInstitution(institution);
  const changes = before ? describeChanges(before, after) : [`added with ${after.emailDomains.join(', ')}`];

  await AuditEvent.create({
    actorId: staffId,
    action: existing ? 'institution.updated' : 'institution.created',
    subjectId: null,
    targetType: 'institution',
    targetId: institution._id,
    note: `${institution.shortName}: ${changes.join('; ') || 'nothing actually changed'}`.slice(0, 400),
    data: null,
  });

  return { institution: institutionCard(institution), created: !existing, changes };
}

/** "Don't see yours?" — grouped, so the list answers "which college next". */
async function institutionRequests({ limit = 50 } = {}) {
  return { requests: await institutions.requestSummary({ limit }) };
}

/** Test seam: the same list the route builds its buttons from. */
function options() {
  return { actions: ACTIONS, statuses: STATUSES, studentStatuses: STUDENT_STATUSES };
}

module.exports = {
  queue,
  decide,
  setStatus,
  setStudentStatus,
  account,
  stats,
  photoOf,
  institutionList,
  saveInstitution,
  institutionRequests,
  options,
  ACTIONS,
  STATUSES,
  STUDENT_STATUSES,
};
