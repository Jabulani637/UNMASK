'use strict';
/**
 * The one way this API answers "is this thread yours?".
 *
 * Two services need it. Chat (stage 5) reads and writes messages inside a pair;
 * the reveal (stage 6) asks for consent, and then hands over a name and a photo.
 * The second of those is the one a stranger will try hardest to fake, so it is
 * the same function rather than a copy that could drift: one id-check, one
 * wording, one refusal.
 *
 * That refusal is deliberately identical for "not yours" and "does not exist", so
 * a response cannot be used to find out which pair-ids are real (NFR-3.1).
 */

const Match = require('../models/Match');
const { UserError } = require('../errors');

const NO_THREAD = 'That conversation is not one you can open.';

/**
 * The pair's row, checked against the signed-in account — or nothing at all
 * beyond this point.
 *
 * The id is cast rather than validated by hand: a match id arrives as text from a
 * URL, and an ObjectId that cannot be cast is the same answer as a thread that
 * was never issued.
 */
async function pairOf(userId, matchId) {
  let oid;
  try {
    if (!matchId) throw new Error('no id');
    oid = Match.schema.path('users').caster.cast(matchId);
  } catch {
    throw new UserError(NO_THREAD, { status: 404, code: 'no_thread' });
  }

  const match = await Match.findById(oid);
  if (!match || !match.users.some(id => String(id) === String(userId))) {
    throw new UserError(NO_THREAD, { status: 404, code: 'no_thread' });
  }
  return match;
}

/** The other half of the pair. `pairOf` has already proved there is one. */
function peerIdOf(match, userId) {
  const other = match.users.find(id => String(id) !== String(userId));
  if (!other) throw new UserError(NO_THREAD, { status: 404, code: 'no_thread' });
  return other;
}

module.exports = { NO_THREAD, pairOf, peerIdOf };
