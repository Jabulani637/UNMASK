'use strict';
/**
 * Two students agreeing to stop being anonymous to each other. FR-5.1 to FR-5.6.
 *
 * **Consent is stored as two rows, not one flag.** FR-5.2's wording — *both*
 * participants, *independently* consented — is a claim about two people, and a
 * boolean could not carry it. `match.reveal.consent` holds one timestamped entry
 * per student, so "did they both really say yes, and when" is answerable from the
 * data instead of from an argument.
 *
 * **Asking is itself a consent.** A student who presses "ask to reveal" has said
 * yes to being seen; making them answer a second prompt about their own side
 * would be a form, not a decision. So an ask writes the first consent row, and
 * the other half's answer writes the second. If both press ask at the same moment
 * the second press *is* the answer, and the pair reveals without either of them
 * being asked twice.
 *
 * **No, and taking it back, are both allowed and neither is an ending.** FR-5.4
 * and FR-5.5: declining or revoking returns the pair to "not revealed" and leaves
 * the conversation open with every message in place. Once both have said yes
 * there is no un-reveal — FR-5.6 asks for the identities to stay visible in the
 * same thread, and a reveal that could be withdrawn would leave the other student
 * holding a name they were told to forget.
 *
 * **This is the only door to a name and a photo.** `services/chat.js` will never
 * send either, and `routes/profile.js` only ever serves a student their own
 * picture. The two functions at the bottom of this file are the second door the
 * privacy section promises, and they refuse until the pair's own row says both
 * halves consented.
 */

const Match = require('../models/Match');
const Message = require('../models/Message');
const Profile = require('../models/Profile');
const { UserError } = require('../errors');
const institutions = require('./institutions');
const photos = require('./photos');
const profile = require('./profile');
const { pairOf, peerIdOf } = require('./pair');

/**
 * FR-5.1's "either participant may ask", with the prototype's own floor under it:
 * three of *your own* messages, counted before the mask comes off.
 *
 * It is a backend rule and not just a hidden button, because the whole point of
 * the reveal is that it is a decision two people make about each other — and an
 * ask on an empty thread tells the other student that somebody read a card and
 * pressed a button without saying a word.
 */
const MIN_MESSAGES_BEFORE_ASK = 3;

/**
 * The pair's reveal state, for whoever of the two is reading.
 *
 * Never an id: `askedBy` and `answeredBy` come back as 'me' or 'them', which is
 * all a screen needs and nothing a third party could use. This is the same rule
 * `chat.toWire()` applies to messages, for the same reason.
 */
function revealState(match, userId) {
  const reveal = match.reveal || {};
  const status = reveal.status || 'none';
  const which = id => (String(id) === String(userId) ? 'me' : 'them');

  const askedBy = status === 'pending' && reveal.askedBy ? which(reveal.askedBy) : null;

  // FR-5.4's "not yet" and FR-5.5's "take that back" both leave the pair in
  // 'none', and a screen that says "nobody has asked" at that point is lying
  // about something the two of them both know happened.
  let answeredBy = null;
  if (status === 'none' && reveal.declinedAt) {
    answeredBy = { action: 'declined', by: which(reveal.declinedBy), at: reveal.declinedAt };
  } else if (status === 'none' && reveal.revokedAt && (!reveal.askedAt || reveal.revokedAt > reveal.askedAt)) {
    answeredBy = { action: 'revoked', by: which(reveal.revokedBy), at: reveal.revokedAt };
  }

  return {
    status,
    askedBy,
    answeredBy,
    revealedAt: status === 'revealed' ? reveal.revealedAt || null : null,
  };
}

/** A reveal is a decision about a live conversation, so a closed one is over. */
function assertOpen(match) {
  if (match.status !== 'open') {
    throw new UserError('This conversation is closed, so there is nothing to reveal.', {
      status: 409,
      code: 'thread_closed',
    });
  }
}

/**
 * The state a screen is allowed to act on, for a match row already in hand.
 *
 * `services/chat.js` calls this rather than `stateFor()` because it has already
 * done the pair check that `stateFor()` would repeat — and because a thread read
 * and a reveal read that go through different code paths are two chances to get
 * the same answer wrong in two different ways.
 */
async function stateForMatch(match, userId) {
  const state = revealState(match, userId);

  if (state.status === 'none') {
    const mine = await Message.countDocuments({ matchId: match._id, senderId: userId });
    state.asksIn = Math.max(0, MIN_MESSAGES_BEFORE_ASK - mine);
    state.canAsk = state.asksIn === 0 && match.status === 'open';
    if (!state.canAsk) {
      state.askBlocked =
        match.status !== 'open'
          ? 'This conversation is closed.'
          : `Send ${state.asksIn} more of your own message${state.asksIn === 1 ? '' : 's'} first.`;
    }
  }

  return state;
}

/** As above, from a match id off a URL. */
async function stateFor(userId, matchId) {
  const match = await pairOf(userId, matchId);
  return stateForMatch(match, userId);
}

/** The second yes. Both callers reach the same few lines. */
async function complete(match, userId) {
  const at = new Date();
  const reveal = match.reveal;
  // Idempotent on purpose: two students hammering the accept button must not
  // stack up consent rows for the same person.
  const consent = reveal.consent.filter(row => String(row.userId) !== String(userId)).map(row => ({ userId: row.userId, at: row.at }));
  consent.push({ userId, at });

  match.set({
    'reveal.status': 'revealed',
    'reveal.consent': consent,
    'reveal.revealedAt': at,
  });
  await match.save();

  return {
    threadId: String(match._id),
    event: 'revealed',
    // Both halves, including the one that pressed: each screen flips in the same
    // second, and neither is left wondering whether it worked.
    recipients: match.users.map(id => String(id)),
    message: 'You have both said yes. Your names and photos are open to each other now.',
    state: revealState(match, userId),
  };
}

/**
 * FR-5.1 / FR-5.3 — ask. FR-5.2's other reading: this writes *one* consent, and
 * unlocks nothing on its own.
 */
async function ask({ userId, matchId }) {
  const match = await pairOf(userId, matchId);
  assertOpen(match);
  const reveal = match.reveal;

  if (reveal.status === 'revealed') {
    throw new UserError('You two have already revealed each other.', { status: 409, code: 'already_revealed' });
  }

  if (reveal.status === 'pending') {
    if (String(reveal.askedBy) === String(userId)) {
      throw new UserError('You have already asked. They can answer whenever they like — nothing is waiting on a timer.', {
        status: 409,
        code: 'reveal_pending',
      });
    }
    // They asked, and this press is the second half of the same decision.
    return complete(match, userId);
  }

  const mine = await Message.countDocuments({ matchId: match._id, senderId: userId });
  if (mine < MIN_MESSAGES_BEFORE_ASK) {
    const need = MIN_MESSAGES_BEFORE_ASK - mine;
    throw new UserError(
      `Send ${need} more of your own message${need === 1 ? '' : 's'} first — a reveal is a decision about a conversation, not about a card.`,
      { status: 400, code: 'reveal_too_early' }
    );
  }

  const at = new Date();
  // A fresh request replaces the answer to the last one, so a screen cannot show
  // "they said not yet" underneath a request they have not seen yet. Asking *is*
  // this half's consent — one row, timestamped, and nothing unlocks on it alone.
  match.set({
    'reveal.status': 'pending',
    'reveal.askedBy': userId,
    'reveal.askedAt': at,
    'reveal.consent': [{ userId, at }],
    'reveal.declinedBy': null,
    'reveal.declinedAt': null,
  });
  await match.save();

  return {
    threadId: String(match._id),
    event: 'asked',
    // Only the other half. Being told "you asked" is a way to learn nothing.
    recipients: [String(peerIdOf(match, userId))],
    message: 'Asked. They can say yes or not yet, and either answer keeps this chat open.',
    state: revealState(match, userId),
  };
}

/**
 * FR-5.2's second consent, or FR-5.4's no. Only the student who was asked may
 * answer this, and a no is not a way to end a conversation either.
 */
async function answer({ userId, matchId, accept }) {
  const match = await pairOf(userId, matchId);
  assertOpen(match);
  const reveal = match.reveal;

  if (reveal.status === 'revealed') {
    throw new UserError('You two have already revealed each other.', { status: 409, code: 'already_revealed' });
  }
  if (reveal.status !== 'pending' || !reveal.askedBy || String(reveal.askedBy) === String(userId)) {
    throw new UserError('There is no reveal request here waiting for your answer.', {
      status: 409,
      code: 'no_pending_reveal',
    });
  }

  const askerId = String(reveal.askedBy);

  if (accept) return complete(match, userId);

  const at = new Date();
  // FR-5.4 — the request is withdrawn into "not now", and the one consent on
  // record evaporates with it: a row nobody answered is not agreement.
  match.set({
    'reveal.status': 'none',
    'reveal.consent': [],
    'reveal.declinedBy': userId,
    'reveal.declinedAt': at,
  });
  await match.save();

  return {
    threadId: String(match._id),
    event: 'declined',
    recipients: [askerId],
    message: 'Not now. The chat stays open and nothing else changes.',
    state: revealState(match, userId),
  };
}

/** FR-5.5 — the asker takes the request back before the other half answers. */
async function revoke({ userId, matchId }) {
  const match = await pairOf(userId, matchId);
  assertOpen(match);
  const reveal = match.reveal;

  if (reveal.status === 'revealed') {
    throw new UserError('You have both already said yes. A reveal cannot be taken back.', {
      status: 409,
      code: 'already_revealed',
    });
  }
  if (reveal.status !== 'pending' || String(reveal.askedBy) !== String(userId)) {
    throw new UserError('Only the person who sent the request can take it back.', {
      status: 409,
      code: 'no_pending_reveal',
    });
  }

  const at = new Date();
  match.set({
    'reveal.status': 'none',
    'reveal.consent': [],
    'reveal.revokedBy': userId,
    'reveal.revokedAt': at,
  });
  await match.save();

  return {
    threadId: String(match._id),
    event: 'revoked',
    // The other half is the one who no longer has a decision to make.
    recipients: [String(peerIdOf(match, userId))],
    message: 'Request cancelled. Nothing was revealed.',
    state: revealState(match, userId),
  };
}

/** The one refusal every locked identity route gives: the same, both directions. */
function assertRevealed(match) {
  if (!match.reveal || match.reveal.status !== 'revealed') {
    throw new UserError('You two have not revealed each other yet, so there is nothing here to show.', {
      status: 403,
      code: 'not_revealed',
    });
  }
}

/**
 * FR-5.2 / FR-5.6 — the peer's profile, name included, for the student who has
 * both said yes. Reads through services/profile.js, so the shape a revealed
 * stranger sees is decided in the same file as the shape a signed-in owner sees.
 */
async function revealedProfile({ userId, matchId }) {
  const match = await pairOf(userId, matchId);
  assertRevealed(match);

  const peer = await Profile.findOne({ userId: peerIdOf(match, userId) });
  if (!peer) {
    throw new UserError('That student has deleted their profile, so there is nothing left to show.', {
      status: 404,
      code: 'no_profile',
    });
  }
  return profile.viewRevealed(
    peer,
    (await institutions.byIds([peer.institutionId])).get(String(peer.institutionId)) || null
  );
}

/**
 * The second photo door (FR-2.3, FR-5.2). A filename is never returned, and
 * neither is a byte until the pair's own row carries two consents.
 */
async function revealedPhoto({ userId, matchId }) {
  const match = await pairOf(userId, matchId);
  assertRevealed(match);

  const peer = await Profile.findOne({ userId: peerIdOf(match, userId) }, { 'photo.fileName': 1 });
  const fileName = peer && peer.photo && peer.photo.fileName;
  if (!fileName) {
    throw new UserError('That student never uploaded a photo, so there is nothing to reveal.', {
      status: 404,
      code: 'no_photo',
    });
  }

  const buffer = await photos.read(fileName);
  if (!buffer) {
    throw new UserError('That photo could not be read.', { status: 404, code: 'photo_missing' });
  }

  const format = photos.sniff(buffer);
  return { buffer, mime: format ? format.mime : 'application/octet-stream' };
}

module.exports = {
  stateFor,
  stateForMatch,
  revealState,
  ask,
  answer,
  revoke,
  revealedProfile,
  revealedPhoto,
  MIN_MESSAGES_BEFORE_ASK,
};
