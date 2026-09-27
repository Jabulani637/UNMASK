'use strict';
/**
 * Reporting content to a staff member. FR-6.1, and read by FR-6.3's queue.
 *
 * **The reporter never names the person they report, and never supplies the
 * words being reported.** A student's browser knows a thread id, a message id, or
 * the sealed suggestion token it was handed — not an account id, because nothing
 * in stages 3 to 6 ever sends one to a client (NFR-3.3). So `file()` resolves the
 * reported account from those, by re-checking the caller's own pair row or by
 * decrypting the caller's own token, and the excerpt is re-read from the database
 * at this moment rather than typed into the request. A client that invents a
 * message body, or aims a report at somebody it has never met, fails here rather
 * than storing a lie about a student.
 *
 * **The snapshot is the point.** Once a staff member is going to judge this, the
 * text has to be the text that was on the screen when the button was pressed: the
 * sender can clear their copy, and a profile's author can edit an answer, which is
 * exactly what people do when they have been reported. See models/Report.js.
 *
 * **A report is not a block, and this file does not close anything.** The two are
 * different decisions with different consequences: a report asks a person to look,
 * a stop is something the student can do for themself right now. So the answer to
 * a filed report says which one happened and offers the other.
 */

const AuditEvent = require('../models/AuditEvent');
const Match = require('../models/Match');
const Message = require('../models/Message');
const Profile = require('../models/Profile');
const Report = require('../models/Report');
const User = require('../models/User');
const { UserError } = require('../errors');
const institutions = require('./institutions');
const { pairOf, peerIdOf } = require('./pair');
const vocab = require('../domain/vocabulary');
const { unseal } = require('../domain/suggestionToken');

/** A report has to be about one of the four things the brief lists. */
const KINDS = ['profile', 'prompt', 'photo', 'message'];

/**
 * NFR-2.5 names mass reporting as an abuse of the moderation queue, and the unique
 * index on Report is only half the answer: fifty presses at fifty *different* items
 * is fifty rows. These are the same two windows services/chat.js uses, and the same
 * honest caveat — the counter is one process's memory, so it slows a script down,
 * which is all it claims to do.
 */
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_DAY = 20;

// userId -> { 'window'|'day': { count, resetAt } }
const budget = new Map();

function spend(userId, table, limit, windowMs, now) {
  const key = `${userId}:${table}`;
  let entry = budget.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    budget.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > limit) {
    const retrySeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    throw new UserError(
      'You have filed several reports already. Give a staff member a moment to read them, then report anything else.',
      { status: 429, code: 'rate_limited', retryAfterSeconds: retrySeconds }
    );
  }
}

/**
 * Whom is this report about, and how do we know the reporter is allowed to say?
 *
 * Three doors, in the order a screen would reach them:
 *   - a message the reporter can read;
 *   - the other half of a thread the reporter is in;
 *   - a suggestion card the reporter was just shown, addressed by its sealed token.
 * The third is what lets "this person is not a student at a verified institution"
 * be reported *before* anybody has agreed to chat with them, which is the report
 * that matters most and the one a thread-only design would make impossible.
 */
async function resolveTarget({ userId, kind, matchId, messageId, token }) {
  if (kind === 'message') {
    const id = String(messageId || '');
    if (!/^[0-9a-f]{24}$/i.test(id)) {
      throw new UserError('Report a message by pointing at the message, not at the conversation.', {
        status: 400,
        code: 'bad_target',
      });
    }
    const message = await Message.findById(id);
    if (!message) {
      throw new UserError('That message is not one you can report.', { status: 404, code: 'no_target' });
    }
    // pairOf() is the only check: it proves the thread is the reporter's, so a
    // message id guessed from anywhere else never gets read.
    await pairOf(userId, message.matchId);
    if (String(message.senderId) === String(userId)) {
      throw new UserError('That is something you said. A staff member cannot act on a report about you.', {
        status: 400,
        code: 'self_report',
      });
    }
    return { reportedUserId: message.senderId, matchId: message.matchId, message };
  }

  if (matchId) {
    const match = await pairOf(userId, matchId);
    return { reportedUserId: peerIdOf(match, userId), matchId: match._id };
  }

  if (token) {
    const profileId = unseal(userId, token);
    if (!profileId) {
      throw new UserError('That suggestion is no longer on your screen.', { status: 409, code: 'stale_suggestion' });
    }
    const profile = await Profile.findById(profileId);
    if (!profile) {
      throw new UserError('That student is no longer on Unmask.', { status: 404, code: 'no_target' });
    }
    return { reportedUserId: profile.userId, matchId: null, profile };
  }

  throw new UserError('Say which profile, message or photo you are reporting.', { status: 400, code: 'bad_target' });
}

/**
 * The words a staff member judges, copied now.
 *
 * A profile report takes the whole public frame — the three facts on a card and
 * every answer on it — because "this is not a real student" is a judgement about
 * the set of it, and one line out of context reads differently. It is capped
 * because a report is not a backup of a profile.
 */
function snapshot({ kind, message, profile, promptIndex, institution }) {
  if (kind === 'message') return message.body;

  if (kind === 'prompt') {
    const entry = profile.prompts[promptIndex];
    return `${entry.prompt} ${entry.answer}`;
  }

  if (kind === 'photo') {
    const at = profile.photo && profile.photo.uploadedAt ? new Date(profile.photo.uploadedAt).toISOString() : null;
    return at ? `Profile photo as uploaded at ${at}.` : 'A profile with no photo on file was reported.';
  }

  const lines = [institutions.labelFor(institution, profile).join(', ')];
  // The card a reporter pressed "report" on now carries these five answers and that
  // sentence, so a judgement about the whole profile is a judgement about them too.
  const about = [profile.bodyType, profile.height, profile.drinks, profile.smokes, profile.gym].filter(Boolean);
  if (about.length) lines.push(`About them: ${about.join(', ')}`);
  if (profile.typeNote) lines.push(`Who they are after: ${profile.typeNote}`);
  // `identity` is not copied here, in any branch. Everywhere else in this file the
  // excerpt follows the card, and this one field is on no card: writing a student's
  // race into a report record would make this queue the only place on Unmask where a
  // third party is handed one, which is the thing the describe-only rule is for.
  for (const entry of profile.prompts) lines.push(`${entry.prompt} ${entry.answer}`);
  return lines.join('\n').slice(0, 2000);
}

/**
 * File a report. Idempotent in the way that matters: the same student reporting
 * the same item twice is one open report, and the second press is told so rather
 * than being counted as evidence that something is wrong.
 */
async function file({ userId, kind, matchId = null, messageId = null, token = null, promptIndex = null, reason, detail = null }) {
  if (!KINDS.includes(kind)) {
    throw new UserError(`Report one of: ${KINDS.join(', ')}.`, { status: 400, code: 'bad_kind' });
  }
  if (!vocab.REPORT_REASONS.includes(reason)) {
    throw new UserError('Choose one of the listed reasons — a staff member reads hundreds of these.', {
      status: 400,
      code: 'bad_reason',
    });
  }

  const now = Date.now();
  spend(userId, 'window', PER_WINDOW, WINDOW_MS, now);
  spend(userId, 'day', PER_DAY, DAY_MS, now);

  const target = await resolveTarget({ userId, kind, matchId, messageId, token });
  const reported = await User.findById(target.reportedUserId, { _id: 1, status: 1 });
  if (!reported) {
    throw new UserError('That student is no longer on Unmask.', { status: 404, code: 'no_target' });
  }

  // Every kind but a message reports something written *on a profile*, so the
  // profile is read here, once, and it is the copy the snapshot comes from.
  let profile = target.profile || null;
  if (!profile && kind !== 'message') {
    profile = await Profile.findOne({ userId: target.reportedUserId });
  }
  if (!profile && kind !== 'message') {
    throw new UserError('That student no longer has a profile to report.', { status: 404, code: 'no_target' });
  }

  // A report about a face that is not there would sit in a queue forever, so the
  // mistake gets named now instead of being staff's problem later.
  if (kind === 'photo' && !(profile.photo && profile.photo.fileName)) {
    throw new UserError('That student has no photo on file, so there is nothing here to report.', {
      status: 400,
      code: 'no_photo',
    });
  }

  let index = null;
  if (kind === 'prompt') {
    index = Number(promptIndex);
    if (!Number.isInteger(index) || index < 0 || index >= profile.prompts.length) {
      throw new UserError('Say which answer you are reporting.', { status: 400, code: 'bad_target' });
    }
  }

  // The evidence is a sentence about a person, and the third part of it is the
  // institution's own short name — read from the row that holds it, not from a
  // string copied off the profile.
  let institution = null;
  if (profile) {
    institution = (await institutions.byIds([profile.institutionId])).get(String(profile.institutionId)) || null;
  }

  const excerpt = snapshot({ kind, message: target.message, profile, promptIndex: index, institution });

  const fields = {
    reporterId: userId,
    reportedUserId: target.reportedUserId,
    kind,
    matchId: target.matchId || null,
    promptIndex: index,
    excerpt,
    reason,
    detail: detail ? String(detail).trim().slice(0, 600) : null,
    status: 'open',
  };

  let report;
  try {
    report = await Report.create(fields);
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await Report.findOne({
        reporterId: userId,
        reportedUserId: target.reportedUserId,
        kind,
        matchId: fields.matchId,
        promptIndex: fields.promptIndex,
        status: 'open',
      });
      return {
        already: true,
        report: existing || null,
        message: 'You have already reported this, and it is still in the queue.',
      };
    }
    throw err;
  }

  await AuditEvent.create({
    actorId: userId,
    action: 'report.filed',
    subjectId: target.reportedUserId,
    targetType: target.matchId ? 'match' : 'profile',
    targetId: target.matchId || (profile ? profile._id : null),
    note: `A student reported ${kind} content.`,
    data: { kind, reason },
  });

  return {
    already: false,
    report,
    // Blocking is offered, never assumed: a report asks staff to look, and only a
    // block stops the other student from reaching this one. See services/blocks.js.
    message: 'Your report is with a staff member. If you want them to stop contacting you, block them.',
  };
}

/** Test seam, for the same reason chat.js has one. */
function resetBudget() {
  budget.clear();
}

module.exports = { file, KINDS, PER_WINDOW, PER_DAY, _internal: { resolveTarget, snapshot, resetBudget } };
