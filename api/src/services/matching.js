'use strict';
/**
 * Who gets suggested to whom, and in what order. FR-3.1 to FR-3.6.
 *
 * Two decisions shape this file.
 *
 * **Nothing is stored about a suggestion.** The list is recomputed on every
 * request from the two profiles as they are right now, so FR-3.5 — refresh when
 * a profile changes — is true by construction rather than by a cache invalidation
 * somebody has to remember. The cost is a scan of the candidate pool, which at the
 * size of a few thousand students is nothing; the day it is not nothing, the answer
 * is a stored shortlist, not more cleverness here.
 *
 * **A candidate's identity never travels through the client.** The screen gets a
 * sealed token and hands it back to say "not this one" or "start chatting". It is
 * AES-256-GCM with the viewer's own account id as additional authenticated data,
 * so a token is unreadable to anyone who did not sign in as that student, useless
 * to a different student, and cannot be edited into pointing at somebody else —
 * the profile id is never in the open, so a pair of students cannot compare notes
 * and work out who the other one is (NFR-3.3).
 */

const Profile = require('../models/Profile');
const Match = require('../models/Match');
const Pass = require('../models/Pass');
const User = require('../models/User');
const { UserError } = require('../errors');
const blocks = require('./blocks');
const institutions = require('./institutions');
const { seal, unseal } = require('../domain/suggestionToken');

/** How far apart in years of age two suggestions may be, before scoring. */
const MAX_AGE_GAP = 5;
/**
 * v2 §5. They add to 100 at the top of the institution tier.
 *
 * Two of the old five tiers are gone: `faculty` and `year`. Both were comparisons
 * between strings a student picked off a list that belonged to one institution, and
 * a "same faculty" point between a CPUT student and a UWC one was a comparison
 * between two different organisations' ideas of what a faculty is. The institution
 * tier replaced them, and it is worth less than the interests a card is actually
 * read for — a school is a reason to think you will have the same Tuesday, not a
 * reason to like the same music.
 */
const WEIGHTS = { interests: 60, age: 20, city: 6 };
/** What each rank of the viewer's own preference list is worth, in order. */
const PREFERENCE_WEIGHTS = [14, 9, 5];
/**
 * The appearance nudge, worth at most eight on top of the hundred above.
 *
 * Deliberately small and deliberately not a filter. A student who would quite like
 * somebody tall gets a taller candidate a little higher up their list; a student
 * who said nothing gets a *neutral* zero, not a penalty, and is still suggested to
 * anybody. The list a score is read from is the viewer's own `seek…` picks — a
 * candidate's wishes never move the candidate — and `identity` is not in this
 * function, not in the projection below, and not on offer as a pick list anywhere
 * in the product.
 */
const LOOK_WEIGHTS = { bodyType: 3, height: 2, lifestyle: 1 };
/** A perfect score is not on offer, and a hopeless one is not worth showing. */
const SCORE_CEILING = 97;
const SCORE_FLOOR = 20;

const MAX_CANDIDATES = 500;

/**
 * The only fields of a candidate this file is allowed to see — one constant rather
 * than two literals, because `suggestionsFor()` and the `audienceFor()` sweep must
 * read exactly the same document. A field present in one and missing from the
 * other is a rule that works on /api/match and silently does not in the
 * notification sweep, which is the kind of drift no test notices until a student
 * describes it.
 *
 * `isMatchable()` runs on the fields below, so this list is part of that rule too:
 * leave `interests` or `prompts` out and the check reads them as absent and passes.
 *
 * `identity` is not here, and that is the load-bearing line of the whole
 * describe-only decision: the scorer cannot rank on what it was never given, and a
 * card cannot quote back a race it cannot read. The two students who differ in
 * nothing else provably score the same because of this line, and adding
 * `identity: 1` here is the change that would break that — so it is written down
 * where somebody would be about to make it.
 */
const READ_FIELDS = {
  institutionId: 1,
  faculty: 1,
  year: 1,
  gender: 1,
  lookingFor: 1,
  age: 1,
  interests: 1,
  prompts: 1,
  review: 1,
  // The five scored appearance answers, and the viewer's own pick lists, which
  // `lookPoints` reads from the *viewer* side of the same projection.
  bodyType: 1,
  height: 1,
  drinks: 1,
  smokes: 1,
  gym: 1,
  seekBodyTypes: 1,
  seekHeights: 1,
  seekDrinks: 1,
  seekSmokes: 1,
  seekGym: 1,
  // Card text, not score input: no line of `lookPoints` reads this one.
  typeNote: 1,
};

/**
 * Men/Women/Everyone against Woman/Man/Non-binary/Prefer not to say.
 *
 * "Everyone" is the only answer that includes a non-binary student or one who
 * would rather not say — nobody's gender is guessed to fill a box. That is a
 * conservative reading and it shrinks those students' pools, which is the
 * honest cost of a three-value list; widening it would mean deciding who counts
 * as "Men" on someone else's behalf.
 */
function wants(gender, lookingFor) {
  if (lookingFor === 'Everyone') return true;
  if (lookingFor === 'Men') return gender === 'Man';
  if (lookingFor === 'Women') return gender === 'Woman';
  return false;
}

function compatible(mine, theirs) {
  return wants(theirs.gender, mine.lookingFor) && wants(mine.gender, theirs.lookingFor);
}

function sharedInterests(mine, theirs) {
  const theirsSet = new Set(theirs);
  // Mine, in my own order, so two students with the same overlap in a different
  // order see the same tags in the same sequence.
  return mine.filter(interest => theirsSet.has(interest));
}

/**
 * v2 §5's preference tier: 14 for a first choice, 9 for a second, 5 for a third,
 * nothing for a candidate outside the list — and nothing for a student who named no
 * list at all, which is the "open to any institution" answer rather than a
 * zero-effort one. Rank, not array position, because the rank is what
 * `normalizePreferences` wrote and what a card would quote back.
 */
function preferencePoints(preferred, candidateInstitutionId) {
  const wanted = String(candidateInstitutionId);
  for (const entry of preferred || []) {
    if (String(entry.institutionId) === wanted) {
      return PREFERENCE_WEIGHTS[entry.rank - 1] || 0;
    }
  }
  return 0;
}

/**
 * How much of the viewer's own "who I am after" list this candidate fits.
 *
 * Three rules make this a nudge and not a filter, and all three fall out of the
 * shape of the code rather than a special case: an empty pick list earns nothing
 * (so saying nothing costs you nobody), a candidate who left a field blank earns
 * nothing there (so a blank is not a negative — it is a student who declined to
 * answer, and `includes(undefined)` is false for every list), and there is no
 * branch here that can subtract points. A candidate can only ever be lifted by
 * this function, never pushed below where their interests and age already put them.
 */
function lookPoints(mine, theirs) {
  let points = 0;
  if ((mine.seekBodyTypes || []).includes(theirs.bodyType)) points += LOOK_WEIGHTS.bodyType;
  if ((mine.seekHeights || []).includes(theirs.height)) points += LOOK_WEIGHTS.height;
  // One point each, because "does the gym" and "smokes" are smaller questions than
  // the two above, and three points for agreeing about a timetable would be a
  // strange thing for a profile of a stranger to be worth.
  if ((mine.seekDrinks || []).includes(theirs.drinks)) points += LOOK_WEIGHTS.lifestyle;
  if ((mine.seekSmokes || []).includes(theirs.smokes)) points += LOOK_WEIGHTS.lifestyle;
  if ((mine.seekGym || []).includes(theirs.gym)) points += LOOK_WEIGHTS.lifestyle;
  return points;
}

/**
 * "Same city" is a comparison between two institutions' own fields, so it is
 * case- and space-insensitive on purpose: a staff member who types "Cape Town "
 * into a form should not silently cost that college's students six points against
 * everybody. An institution with no city is not in the same city as anything.
 */
function sameCity(mine, theirs) {
  if (!mine || !theirs || !mine.city || !theirs.city) return false;
  return String(mine.city).trim().toLowerCase() === String(theirs.city).trim().toLowerCase();
}

function score(mine, theirs, shared, places) {
  const smaller = Math.min(mine.interests.length, theirs.interests.length) || 1;
  let points = (shared.length / smaller) * WEIGHTS.interests;

  const ageGap = Math.abs(mine.age - theirs.age);
  points += Math.max(0, 1 - ageGap / (MAX_AGE_GAP + 1)) * WEIGHTS.age;

  points += preferencePoints(mine.preferredInstitutions, theirs.institutionId);
  if (sameCity(places.get(String(mine.institutionId)), places.get(String(theirs.institutionId)))) {
    points += WEIGHTS.city;
  }
  points += lookPoints(mine, theirs);

  return Math.max(SCORE_FLOOR, Math.min(SCORE_CEILING, Math.round(points)));
}

/**
 * Highest first; on a tie, by stored id, which never changes. Without that last
 * key the same two students could be shown in one order today and another order
 * after a database restart, and a "passed" person could reappear.
 */
function ranked(results) {
  return results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (b.sharedCount !== a.sharedCount) return b.sharedCount - a.sharedCount;
    return String(a._id) < String(b._id) ? -1 : 1;
  });
}

// seal() and unseal() — the AES-256-GCM token a card is addressed by — live in
// domain/suggestionToken.js, because stage 7's report and block routes have to
// answer the same question with the same cipher.

const STALE = 'That suggestion is no longer the one on your screen. Here is the current one.';

/** The pool, in order, with everything this student should not see taken out. */
async function suggestionsFor(viewer) {
  const userId = String(viewer.userId);

  const [alreadyMatched, passed, blocked, inactive] = await Promise.all([
    // FR-3.4 — matched or chatting already. One row covers both directions, and
    // its status is not consulted: a pair that has talked and then closed the
    // thread is still a pair that has matched, so re-suggesting them would make
    // "end this chat" a way to meet the same person again next week.
    Match.find({ users: userId }, { users: 1 }),
    Pass.find({ userId: viewer.userId }, { profileId: 1 }),
    // FR-6.2 — a block stops being suggested *and* stops suggesting, in both
    // directions, from the moment it is placed. Nothing here tells the blocked
    // student why the same person they walked away from is gone: services/blocks.js
    // closes their thread through the ordinary End-chat, so a block and a
    // departure look identical from the outside, which is the point of it.
    blocks.blockedIdsFor(userId),
    // FR-6.3 — a suspended or banned account keeps its data but loses its
    // audience. This is the filter that makes a suspension real: the session
    // check stops the account signing in, and this one stops it being shown to
    // the students it would have been suggested to.
    User.distinct('_id', { status: { $ne: 'active' } }),
  ]);

  const notUsers = alreadyMatched
    .flatMap(match => (match.users || []).map(id => String(id)))
    .filter(id => id !== userId)
    .concat(blocked, inactive.map(id => String(id)));

  const candidates = await Profile.find(
    {
      // A student is never suggested to themselves, and a profile they declined
      // inside the last 30 days stays out (FR-3.3).
      _id: { $ne: viewer._id, $nin: passed.map(row => row.profileId) },
      userId: { $nin: notUsers },
      age: { $gte: viewer.age - MAX_AGE_GAP, $lte: viewer.age + MAX_AGE_GAP },
    },
    // The one projection this file reads candidates through — see READ_FIELDS.
    READ_FIELDS
  ).limit(MAX_CANDIDATES * 2);

  // One query for the whole page, rather than one per candidate. The map is what
  // turns two `institutionId`s into "same city, yes or no".
  const places = await institutions.byIds([
    viewer.institutionId,
    ...candidates.map(candidate => candidate.institutionId),
  ]);

  const scored = [];
  for (const candidate of candidates) {
    if (!candidate.isMatchable()) continue;

    // An institution switched off by staff stops being *suggested* — its students
    // keep their accounts and their profiles, and get their eligibility back the
    // moment it is switched on again. A deleted college would be a punishment that
    // outlives the decision.
    const theirs = places.get(String(candidate.institutionId));
    if (!theirs || !theirs.isActive) continue;

    if (!compatible(viewer, candidate)) continue;
    const shared = sharedInterests(viewer.interests, candidate.interests);
    scored.push({
      candidate,
      shared,
      institution: theirs,
      matchScore: score(viewer, candidate, shared, places),
      sharedCount: shared.length,
    });
  }

  return ranked(scored);
}

/**
 * Who can be shown this profile right now. FR-7.1's trigger: a profile that has
 * just finished, or just changed who it fits, is new to somebody's list.
 *
 * **It asks the real question, not a copy of it.** The honest answer to "is this
 * student in that student's pool" is `suggestionsFor()`, because that is where the
 * passes, the matches, the blocks, the inactive accounts and the held profiles are
 * taken out. Writing the same filters again here would be a second rule to keep in
 * step, and the day it drifted the notification would describe a suggestion that
 * `/match` would never show — which is worse than sending nothing.
 *
 * So the cheap filter runs first in the database (age window and mutual
 * `compatible()`, which between them remove most of the file), and the full pool
 * only runs for the handful of viewers left. `cap` bounds the work: past it, some
 * students simply are not told today, and the log says so, because a nudge nobody
 * is waiting on is not worth an unbounded scan.
 */
async function audienceFor(profile, { cap = 60 } = {}) {
  if (!profile.isMatchable()) return { userIds: [], truncated: false };

  const nearby = await Profile.find(
    {
      userId: { $ne: profile.userId },
      age: { $gte: profile.age - MAX_AGE_GAP, $lte: profile.age + MAX_AGE_GAP },
    },
    // `userId` is not one of `isMatchable()`'s fields, but it is the key every
    // exclusion in `suggestionsFor()` runs on: without it a viewer's passes, blocks
    // and existing threads are looked up under `undefined`, and the pool that comes
    // back describes nobody.
    // The same fields suggestionsFor() reads — see READ_FIELDS — plus the account
    // id, which is the one thing this sweep needs and that sweep does not: every
    // exclusion in suggestionsFor() is looked up by userId, so a viewer read
    // without it has its passes, blocks and threads fetched under `undefined`.
    { userId: 1, ...READ_FIELDS }
  ).limit(cap * 2);

  // A student whose own college has been switched off has no pool to be told
  // about, and `suggestionsFor()` would not have found one: it drops candidates at
  // an inactive institution, including the one this sweep is about to look for.
  // Asking here saves running the whole pool for somebody who will be shown
  // nothing, and says the same thing earlier.
  const places = await institutions.byIds(nearby.map(row => row.institutionId));
  const viewers = nearby.filter(
    candidate =>
      candidate.isMatchable() &&
      compatible(candidate, profile) &&
      Boolean((places.get(String(candidate.institutionId)) || {}).isActive)
  );
  const truncated = viewers.length > cap;
  const userIds = [];

  for (const viewer of viewers.slice(0, cap)) {
    const pool = await suggestionsFor(viewer);
    if (pool.some(entry => String(entry.candidate._id) === String(profile._id))) {
      userIds.push(viewer.userId);
    }
  }

  return { userIds, truncated };
}

/**
 * One prompt answer, chosen the same way every time: the first of *theirs* that
 * shares a word with one of *mine*, else their first. A card shows one answer
 * because the design shows one, and because a wall of their writing is closer to
 * reading a diary than reading a profile.
 */
function pickPrompt(mine, theirs) {
  if (!theirs.prompts.length) return null;
  const myWords = new Set(
    mine.prompts
      .flatMap(entry => entry.answer.toLowerCase().split(/[^a-z0-9']+/))
      .filter(word => word.length > 4)
  );
  for (const entry of theirs.prompts) {
    const words = entry.answer.toLowerCase().split(/[^a-z0-9']+/);
    if (words.some(word => word.length > 4 && myWords.has(word))) {
      return { prompt: entry.prompt, answer: entry.answer };
    }
  }
  return { prompt: theirs.prompts[0].prompt, answer: theirs.prompts[0].answer };
}

/** What the screen is allowed to know. FR-3.6, NFR-3.3. */
function cardFor(profile, viewer, shared, matchScore, institution) {
  const prompt = pickPrompt(viewer, profile);
  return {
    year: profile.year,
    faculty: profile.faculty,
    // The short name, not the full one: a card is read in a second, and "Cape
    // Peninsula University of Technology" is a sentence where a badge wants a word.
    institution: institution ? institution.shortName : null,
    prompt,
    sharedInterests: shared.slice(0, 5),
    /*
     * What this student said about themselves, and the shorter list of what they
     * are after. Both are the reason a card is a card and not a lottery: the
     * nudge above moves somebody you would have liked anyway, and this says so in
     * words. `identity` cannot appear here, and not because this function forgot
     * it — it is not in READ_FIELDS, so the field is `undefined` by the time a card
     * is written. A race on an anonymous card is a sorting rule the moment
     * somebody notices it is there.
     */
    look: {
      bodyType: profile.bodyType || null,
      height: profile.height || null,
      drinks: profile.drinks || null,
      smokes: profile.smokes || null,
      gym: profile.gym || null,
    },
    after: {
      bodyTypes: profile.seekBodyTypes || [],
      heights: profile.seekHeights || [],
      drinks: profile.seekDrinks || [],
      smokes: profile.seekSmokes || [],
      gym: profile.seekGym || [],
      note: profile.typeNote || null,
    },
    // Deliberately absent: age, gender, the city either of them studies in, their
    // full interest list, their other prompt answers, and any form of photo. The
    // badge is the only number.
    score: matchScore,
  };
}

async function suggest(userId) {
  const viewer = await Profile.findOne({ userId });
  if (!viewer) {
    throw new UserError('Fill in your profile first — that is what a match is built from.', { status: 428, code: 'profile_incomplete' });
  }
  const missing = viewer.missingForMatching();
  if (missing.length) {
    throw new UserError(`Your profile is not ready to match yet: ${missing.join('; ')}.`, { status: 428, code: 'profile_incomplete' });
  }

  // The pool below drops a candidate at an institution staff has switched off, and
  // it drops this student's own the same way — which on its own would read as "nobody
  // fits what you two have asked for", a sentence about other people's profiles. So
  // the case is checked here and said out loud, because the alternative is a student
  // editing a profile that is already finished to fix a thing that is not theirs.
  const own = (await institutions.byIds([viewer.institutionId])).get(String(viewer.institutionId));
  if (!own || !own.isActive) {
    return {
      suggestion: null,
      exhausted: true,
      message: own
        ? `${own.shortName} is not taking students on Unmask right now, so nobody can be suggested to you. Staff can switch it back on; nothing about your profile is wrong.`
        : 'Your account no longer points at an institution on Unmask, so nobody can be suggested to you. Open a support request if that is wrong.',
    };
  }

  const rankedList = await suggestionsFor(viewer);
  if (!rankedList.length) {
    return {
      suggestion: null,
      exhausted: true,
      // There is no age-range control on a profile — the window is the engine's
      // ±5 — so the message cannot tell a student to widen one.
      message: 'Nobody else fits what you two have asked for right now. Edit your profile, or come back tomorrow.',
    };
  }

  const top = rankedList[0];
  return {
    suggestion: {
      ...cardFor(top.candidate, viewer, top.shared, top.matchScore, top.institution),
      token: seal(userId, top.candidate._id),
    },
    waiting: rankedList.length,
    exhausted: false,
  };
}

/** The token's profile, still here and still someone this student may see. */
async function openedCandidate({ userId, token, viewer }) {
  const profileId = unseal(userId, token);
  if (!profileId) throw new UserError(STALE, { status: 409, code: 'stale_suggestion' });

  const candidate = await Profile.findById(profileId);
  if (!candidate || !candidate.isMatchable()) {
    throw new UserError('That person is no longer on Unmask, or has changed what they are looking for.', { status: 409, code: 'stale_suggestion' });
  }
  // A card can sit open on a screen while a block is placed elsewhere, so this is
  // the belt to `suggestionsFor`'s braces. The sentence is the stale-token one on
  // purpose: "not available to you" that reads differently depending on which of
  // the two students blocked the other would tell somebody something, and a block
  // that announces itself is a harassment channel with a safety label on it.
  if (await blocks.blockedBetween(userId, candidate.userId)) {
    throw new UserError(STALE, { status: 409, code: 'stale_suggestion' });
  }
  if (!compatible(viewer, candidate)) {
    throw new UserError(STALE, { status: 409, code: 'stale_suggestion' });
  }
  return candidate;
}

/** FR-3.3 — decline this one; the caller answers with the next. */
async function pass({ userId, token }) {
  const viewer = await Profile.findOne({ userId });
  if (!viewer) throw new UserError('Fill in your profile first.', { status: 428, code: 'profile_incomplete' });

  const candidate = await openedCandidate({ userId, token, viewer });
  await Pass.updateOne(
    { userId, profileId: candidate._id },
    { $set: { until: Pass.expiresAt() }, $setOnInsert: { userId, profileId: candidate._id } },
    { upsert: true }
  );

  const next = await suggest(userId);
  return { passed: true, ...next };
}

/**
 * FR-4.1's first half: the pair is created here so it can never be suggested
 * again (FR-3.4). The row this returns is the thread — services/chat.js writes
 * messages against its id, and neither student is asked to agree again.
 */
async function connect({ userId, token }) {
  const viewer = await Profile.findOne({ userId });
  if (!viewer) throw new UserError('Fill in your profile first.', { status: 428, code: 'profile_incomplete' });

  const candidate = await openedCandidate({ userId, token, viewer });
  const other = await User.findById(candidate.userId, { _id: 1, status: 1 });
  // The pool has already dropped an account staff paused, but a suggestion can be
  // minutes old and a suspension is not something a student should be able to walk
  // into by pressing a card they opened before it. Same sentence, same code.
  if (!other || other.status !== 'active') {
    throw new UserError('That person is no longer on Unmask.', { status: 409, code: 'stale_suggestion' });
  }

  const users = Match.pairKey(userId, candidate.userId);
  const existing = await Match.findOne({ users });
  if (existing) {
    if (existing.status === 'closed') {
      // FR-4.4 lets either half end a conversation, and a student who pressed it
      // meant it. If the same button opened the thread again, "leave" would be a
      // pause, and the other student would be re-openable to whoever left them.
      throw new UserError('That conversation has been closed. It cannot be reopened from here.', {
        status: 409,
        code: 'thread_closed',
      });
    }
    return { match: existing, already: true };
  }

  try {
    const match = await Match.create({ users, openedBy: userId, openedFrom: viewer._id });
    return { match, already: false };
  } catch (err) {
    // Two students pressing "start chatting" at each other at the same moment is
    // the success case, not a failure: the pair exists either way.
    if (err && err.code === 11000) {
      const winner = await Match.findOne({ users });
      if (winner) return { match: winner, already: true };
    }
    throw err;
  }
}

module.exports = {
  suggest,
  pass,
  connect,
  audienceFor,
  // Opened for the tests, which must be able to prove the rules without
  // re-implementing them and drifting from what the routes actually run.
  _internal: {
    compatible,
    score,
    sharedInterests,
    preferencePoints,
    lookPoints,
    sameCity,
    seal,
    unseal,
    pickPrompt,
    MAX_AGE_GAP,
    WEIGHTS,
    PREFERENCE_WEIGHTS,
    LOOK_WEIGHTS,
    READ_FIELDS,
  },
};
