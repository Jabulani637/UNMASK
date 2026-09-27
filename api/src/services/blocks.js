'use strict';
/**
 * Blocking, and the two rules it has to carry. FR-6.2, and FR-3.4's "never
 * suggested again" seen from the safety side.
 *
 * **A block is placed by one person and enforced on both.** That asymmetry is the
 * whole design: the blocker gets an immediate, total stop — no future suggestion in
 * either direction, no thread that can be written to — and the blocked student gets
 * exactly the signal they would have got had the other student simply walked away.
 * The thread closes through `chat.leave()`, the same function the End-chat button
 * calls, so a block is not distinguishable from a departure and cannot be used to
 * tell someone what you think of them. The product is a matching site for students
 * who share an institution; a block that announces itself is a harassment channel
 * with a safety label on it.
 *
 * **Unblocking is allowed and does not reopen anything.** A panic press on the wrong
 * student — a shared surname, an ex, a misread card — should be liftable. The
 * conversation that was closed stays closed, because reopening it would mean one
 * person silently undoing the other's walk-away, and the block may have been lifted
 * for reasons the other student never asked to be part of.
 */

const AuditEvent = require('../models/AuditEvent');
const Block = require('../models/Block');
const Match = require('../models/Match');
const Profile = require('../models/Profile');
const User = require('../models/User');
const { UserError } = require('../errors');
const institutions = require('./institutions');
const { pairOf, peerIdOf } = require('./pair');
const { unseal } = require('../domain/suggestionToken');
const chat = require('./chat');

/**
 * Every account either side of a block, as one flat set.
 *
 * Both directions belong in one list because the rule is symmetric even though the
 * act is not: a student who blocked somebody must not be suggested to them either.
 * Callers filter or `$nin` this set, so a block cannot be half-enforced.
 */
async function blockedIdsFor(userId) {
  const rows = await Block.find({ $or: [{ userId }, { blockedUserId: userId }] }, { userId: 1, blockedUserId: 1 });
  const ids = new Set();
  for (const row of rows) {
    ids.add(String(row.userId));
    ids.add(String(row.blockedUserId));
  }
  ids.delete(String(userId));
  return [...ids];
}

/** One pair, both directions. The question `connect` and the report form ask. */
async function blockedBetween(a, b) {
  const row = await Block.findOne({
    $or: [
      { userId: a, blockedUserId: b },
      { userId: b, blockedUserId: a },
    ],
  });
  return Boolean(row);
}

/**
 * Whom is this about, addressed the only way a student's browser can address
 * another student: by a thread it is in, or by the sealed card it was just shown.
 * The report form resolves a target the same way, for the same reason — no route in
 * this API has ever handed a client an account id (NFR-3.3).
 */
async function targetOf({ userId, matchId, token }) {
  if (matchId) {
    const match = await pairOf(userId, matchId);
    return peerIdOf(match, userId);
  }
  if (token) {
    const profileId = unseal(userId, token);
    if (!profileId) {
      throw new UserError('That suggestion is no longer on your screen.', { status: 409, code: 'stale_suggestion' });
    }
    const profile = await Profile.findById(profileId, { userId: 1 });
    if (!profile) {
      throw new UserError('That student is no longer on Unmask.', { status: 404, code: 'no_account' });
    }
    return profile.userId;
  }
  throw new UserError('Say which student you mean.', { status: 400, code: 'bad_target' });
}

/**
 * Block a student. Idempotent: pressing it twice, or from two devices, is one block,
 * and the second press says so instead of pretending to have done something.
 *
 * The peer's account is looked up rather than trusted, because a block written
 * against an id that does not exist would be a permanent, unfalsifiable record about
 * nobody, and the student would be told it worked.
 */
async function place({ userId, matchId = null, token = null }) {
  const peerId = await targetOf({ userId, matchId, token });

  if (String(peerId) === String(userId)) {
    throw new UserError('That is your own account. There is nothing here to block.', { status: 400, code: 'block_self' });
  }

  const peer = await User.findById(peerId, { _id: 1 });
  if (!peer) {
    throw new UserError('That student is no longer on Unmask.', { status: 404, code: 'no_account' });
  }

  const existing = await Block.findOne({ userId, blockedUserId: peerId });
  if (!existing) {
    await Block.create({ userId, blockedUserId: peerId });
  }

  // The conversation, if there is one, goes the same way an End-chat goes: closed,
  // with this student recorded as the one who closed it and nobody told why.
  const match = await Match.findOne({ users: Match.pairKey(userId, peerId) });
  let closed = null;
  if (match && match.status === 'open') {
    const result = await chat.leave({ userId, matchId: match._id });
    closed = result.match;
  }

  if (!existing) {
    await AuditEvent.create({
      actorId: userId,
      action: 'block.placed',
      subjectId: peerId,
      targetType: closed ? 'match' : null,
      targetId: closed ? closed._id : null,
      note: 'A student blocked another. The thread, if any, was closed.',
    });
  }

  return { blocked: true, already: Boolean(existing), match: closed };
}

/**
 * Lift a block. The thread it closed stays closed — see the header note.
 *
 * The block is addressed by its own row id, which `mine()` already returned, rather
 * than by the other student's account id: no other response in this API carries an
 * account id to a browser, and a list of people I have blocked is a poor place to
 * start. Scoping the delete to `{ userId }` is what makes an id from somebody else's
 * list worth nothing.
 */
async function lift({ userId, id }) {
  let oid;
  try {
    oid = Block.schema.path('_id').cast(id);
  } catch {
    throw new UserError('That is not one of your blocks.', { status: 409, code: 'not_blocked' });
  }

  const existing = await Block.findOne({ _id: oid, userId });
  if (!existing) throw new UserError('That is not one of your blocks.', { status: 409, code: 'not_blocked' });

  await Block.deleteOne({ _id: oid, userId });

  await AuditEvent.create({
    actorId: userId,
    action: 'block.lifted',
    subjectId: existing.blockedUserId,
    note: 'A student lifted a block they had placed.',
  });

  return { blocked: false, peerId: existing.blockedUserId };
}

/**
 * Who I have blocked, newest first, in the same words a chat row uses.
 *
 * A student is shown the card they were shown at the time — year, faculty,
 * institution — plus the name if the two of them revealed to each other. What they
 * are *not* given is anything that has appeared since: a blocked profile that has
 * been edited to something else should not be re-read through the block list.
 */
async function mine(userId) {
  const rows = await Block.find({ userId }).sort({ createdAt: -1 }).lean();
  const profiles = await Profile.find(
    { userId: { $in: rows.map(row => row.blockedUserId) } },
    { userId: 1, year: 1, faculty: 1, institutionId: 1, revealName: 1 }
  ).lean();
  const byUser = new Map(profiles.map(profile => [String(profile.userId), profile]));
  const places = await institutions.byIds(profiles.map(profile => profile.institutionId));
  const pairs = rows.map(row => Match.pairValue(userId, row.blockedUserId));
  const revealedRows = await Match.find(
    { pair: { $in: pairs } },
    { pair: 1, 'reveal.status': 1 }
  ).lean();
  const revealedPairs = new Set(
    revealedRows
      .filter(match => match.reveal && match.reveal.status === 'revealed')
      .map(match => match.pair)
  );

  const out = [];
  for (const row of rows) {
    const profile = byUser.get(String(row.blockedUserId));
    const revealed = revealedPairs.has(Match.pairValue(userId, row.blockedUserId));
    const institution = profile ? places.get(String(profile.institutionId)) : null;
    out.push({
      id: String(row._id),
      at: row.createdAt,
      peer: profile
        ? {
            name: revealed ? profile.revealName || null : null,
            revealed,
            year: profile.year,
            faculty: profile.faculty,
            institution: institution ? institution.shortName : null,
          }
        : { name: null, revealed: false, year: null, faculty: null, institution: null },
    });
  }
  return out;
}

module.exports = { blockedIdsFor, blockedBetween, place, lift, mine };
