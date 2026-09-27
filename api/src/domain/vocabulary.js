'use strict';
/**
 * The single source of truth for every fixed list in the product.
 *
 * These values came from PLAN/DESIGN/unmask-v2.html. They live here rather than
 * in the React app because the API has to reject a profile that claims a year of
 * study that does not exist — validating only in the browser would let a crafted
 * request write anything into the database.
 *
 * /api/meta hands the same arrays to the front end so the two never drift.
 *
 * **What used to be here and is not any more:** `CAMPUSES` and `FACULTIES`. Both
 * were CPUT's lists wearing the word "the product's". Campuses went out with the
 * multi-institution change (a profile names an institution, not a campus), and a
 * faculty list now lives on the `Institution` document that owns it, so a college
 * with four schools is not asked to pick from another university's six faculties.
 * The rule this leaves behind is the one NFR-SCALE-1 states: if a list has an
 * institution's name in it, it belongs in the database, not in this file.
 */

const YEARS = ['1st year', '2nd year', '3rd year', '4th year / Hons', 'Postgrad'];

const GENDERS = ['Woman', 'Man', 'Non-binary', 'Prefer not to say'];

/** What a user selects as their own gender is a narrower list than who they may seek. */
const LOOKING_FOR = ['Men', 'Women', 'Everyone'];

const INTERESTS = [
  'Amapiano',
  'Gym',
  'Res life',
  'Anime',
  'Gaming',
  'Taxi stories',
  'Coffee runs',
  'Thrifting',
  'Photography',
  "Hiking Lion's Head",
  'Studying together',
  'Side hustles',
  'Football',
  'Netball',
  'Poetry & spoken word',
  'Braai culture',
  'Clubbing',
  'Church/faith',
  'Coding side projects',
  'Loadshedding jokes',
];

/**
 * Open-ended prompts a user finishes. FR-2.1 requires at least one completed
 * answer before a profile is matchable; the prototype showed one, and three
 * gives someone something to say that is not "I like music".
 */
const PROMPTS = [
  'Honestly, res life / home life has taught me…',
  'The thing I would argue about happily at 11pm is…',
  'My idea of a good Saturday on campus is…',
];

const AGE_MIN = 18;
const AGE_MAX = 30;

/**
 * FR-6.1 — why a student is telling us about something.
 *
 * A fixed list rather than a free box, because a queue of one person reading it
 * has to be groupable: "four reports this week say nudity" is a fact you can act
 * on, and fifty sentences of prose is not. `Something else` is there because a
 * reason list that forces a lie is worse than a reason list with a gap in it.
 *
 * The strings are what gets stored, so they read as a sentence in the queue and
 * not as a code somebody has to look up.
 */
const REPORT_REASONS = [
  'Harassment, threats or bullying',
  'Nudity or sexual content',
  'Someone pretending to be me or another person',
  'Trying to move me off Unmask (money, links, another app)',
  'Not a student at a verified institution, or under 18',
  'Something else',
];

/** FR-2.7 — a profile is not matchable below this completion. */
const MIN_INTERESTS = 2;
const MIN_PROMPTS = 1;

/**
 * What a student says about their own appearance, in their own words. This is a
 * self-description and nothing else: `services/matching.js` never reads it, a
 * student cannot filter on it, and no card can be sorted or excluded because of
 * it. It exists because somebody who wants to say "I am a black woman" on their
 * own profile should be able to, and because the alternative — the same list
 * offered as a *filter* — is the version that turns a campus dating product into
 * a racial preference engine with a student number attached. The difference is
 * enforced in code and not just in this comment: the field is absent from the
 * matching projection, so a scorer that wanted to read it finds `undefined` for
 * every candidate, and test/match.test.js proves two students who differ in
 * nothing else carry the same score.
 */
const IDENTITY = ['Black', 'Coloured', 'Indian', 'White', 'African', 'Something else'];

/** How a student describes their own body, and how they would describe one they like. */
const BODY_TYPES = ['Slender', 'Athletic', 'Curvy', 'Average', 'Chubby', 'Muscular'];

/** Height bands, worded rather than numbered, so a profile is not a measuring tape. */
const HEIGHTS = ['Under 5\u2032 2\u2033', '5\u2032 2\u2033 to 5\u2032 6\u2033', '5\u2032 7\u2033 to 5\u2032 10\u2033', 'Over 5\u2032 10\u2033'];

/**
 * The three lifestyle questions. The seek lists below each carry a "never mind
 * either way" answer, because a preference you cannot opt out of is a preference
 * people lie on.
 */
const DRINKS = ['Don\u2019t drink', 'Socially', 'Most weekends'];
const SMOKES = ['Don\u2019t smoke', 'Socially', 'Vape'];
const GYM = ['Don\u2019t go', 'Once in a while', 'A few times a week', 'Nearly every day'];

/** The one answer that means "I am not asking this question about you". */
const EITHER = 'Never mind either way';

/**
 * How many picks one "what I am after" list may carry. Three, because the
 * institution preference already taught the shape: one is an answer, three is a
 * preference, and eight is a way of saying you never thought about it.
 */
const MAX_PREF_PICKS = 3;

const isOneOf = (list, value) => list.includes(value);

module.exports = {
  YEARS,
  GENDERS,
  LOOKING_FOR,
  INTERESTS,
  PROMPTS,
  REPORT_REASONS,
  IDENTITY,
  BODY_TYPES,
  HEIGHTS,
  DRINKS,
  SMOKES,
  GYM,
  EITHER,
  MAX_PREF_PICKS,
  AGE_MIN,
  AGE_MAX,
  MIN_INTERESTS,
  MIN_PROMPTS,
  isOneOf,
};
