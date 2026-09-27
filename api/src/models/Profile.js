'use strict';
/**
 * The profile a student is matched on. FR-2.1, FR-2.4, FR-2.7.
 *
 * One per account, and `userId` is unique so a second profile cannot exist even
 * if a client races its own Save button.
 *
 * What is *not* here matters more than what is: no legal name, no surname, no
 * student number, no phone number, no link to the account's email (FR-2.6). Every
 * field is something a student chooses to be judged on, and the email that ties
 * this to a person lives on the User document, which no other student will ever
 * read. `revealName` is the one exception the requirements ask for (FR-5.2), and
 * it is a name the student invents for this screen, not one a registrar holds.
 *
 * The photo is stored as a filename only, and that filename points into
 * api\storage\photos\ — outside anything the web server publishes. Nothing here
 * is a URL. The only way to the bytes is a route that has already decided the
 * caller is allowed them.
 */

const mongoose = require('mongoose');
const vocab = require('../domain/vocabulary');

const profileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    /**
     * Which institution this student belongs to — and the only honest answer to
     * that question is one the server worked out from their verified email
     * address. `services/profile.js` writes this field and no client route reads
     * it from a body, because a student choosing their own institution is a
     * student registering at `northlink.ac.za` and presenting as somebody else's
     * campus. It replaced a free-text `campus` string that could only ever name a
     * CPUT campus, which meant a student at any other institution had to lie to
     * finish a form.
     */
    institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },

    /**
     * v2 §4 — who this student wants to be matched with, in their own order. Up
     * to three, ranked by position in the array; the rank number is written here
     * so a card can say "your first choice" without re-reading the order.
     *
     * Empty is a real answer and means *any institution*, which is why it is not
     * in `missingForMatching()`. A student who would rather not say is not asked
     * to name three schools to be allowed to meet somebody.
     *
     * This is deliberately a separate thing from `institutionId` above: whose
     * students you are and whose students you want are not the same question, and
     * the old engine assumed they were.
     */
    preferredInstitutions: {
      type: [
        {
          _id: false,
          institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
          rank: { type: Number, required: true, min: 1, max: 3 },
        },
      ],
      default: [],
    },

    /**
     * An institution's faculty or school. A fixed list is used when the student's
     * own institution document carries one; otherwise this is free text, because
     * guessing another university's faculty names and then *refusing* the real
     * ones would be a worse invention than accepting what its own student typed.
     * Either way it goes through the same contact guard as a prompt answer.
     */
    faculty: { type: String, required: true, trim: true, maxlength: 80 },
    year: { type: String, required: true, enum: vocab.YEARS },
    gender: { type: String, required: true, enum: vocab.GENDERS },
    lookingFor: { type: String, required: true, enum: vocab.LOOKING_FOR },
    age: { type: Number, required: true, min: vocab.AGE_MIN, max: vocab.AGE_MAX },

    /**
     * The look-like block, FR-2.1's "what a student chooses to be judged on" taken
     * one step further than the five required fields.
     *
     * `identity` is a student describing *themselves*, and it is the one field in
     * this file that matching is forbidden to read. There is no `seekIdentity`, and
     * there must never be one: a list of races a card may appear for is a racial
     * filter wearing a preference label, and on a product where every account is
     * tied to a verified student address it is not a thing that can be shipped and
     * explained afterwards. The field is not in the matching projection in
     * `services/matching.js` for exactly that reason — the scorer cannot use what it
     * cannot see — and `test/match.test.js` is the belt on the claim.
     *
     * Everything below it is optional in the same strong sense as `revealName`:
     * leaving a field out of a save clears it, so "I would rather not say" is one
     * press and not a support ticket, and none of it appears in
     * `missingForMatching()`. A student who answers none of it is as matchable as
     * one who answers all of it.
     */
    identity: { type: String, default: null, enum: vocab.IDENTITY },
    bodyType: { type: String, default: null, enum: vocab.BODY_TYPES },
    height: { type: String, default: null, enum: vocab.HEIGHTS },
    drinks: { type: String, default: null, enum: vocab.DRINKS },
    smokes: { type: String, default: null, enum: vocab.SMOKES },
    gym: { type: String, default: null, enum: vocab.GYM },

    /**
     * What this student would like to meet, as opposed to what they are. Three
     * picks per list, and an empty list is the "open to anything" answer — which is
     * why each of these scores *towards* a candidate rather than filtering them
     * out: a student who would quite like somebody tall is not asking to be the
     * only person in the app who never sees a short one.
     *
     * `seekGym` is deliberately not called `seekFitness`: `gym` is the word on the
     * chip, and one name for the answer and another for the question is how a
     * staff screen and a student screen end up disagreeing about what was saved.
     */
    seekBodyTypes: { type: [{ type: String, enum: vocab.BODY_TYPES }], default: [] },
    seekHeights: { type: [{ type: String, enum: vocab.HEIGHTS }], default: [] },
    seekDrinks: { type: [{ type: String, enum: [...vocab.DRINKS, vocab.EITHER] }], default: [] },
    seekSmokes: { type: [{ type: String, enum: [...vocab.SMOKES, vocab.EITHER] }], default: [] },
    seekGym: { type: [{ type: String, enum: [...vocab.GYM, vocab.EITHER] }], default: [] },

    /**
     * The thing no fixed list can hold. Free text, so it carries the same contact
     * guard as a prompt answer and the same length rule reads: a sentence a stranger
     * is handed is not allowed to be a phone number.
     */
    typeNote: { type: String, default: null, trim: true, maxlength: 200 },

    /**
     * FR-5.2 says a reveal unlocks "a name". This is it — and it is the only name
     * the database holds, because nothing here is a legal name, a student number
     * or the account's email address (FR-1.4, FR-2.6). A student types what they
     * want to be called, optionally, and the field takes part in no matching
     * arithmetic at all: it is not in the suggestion projection, and a profile
     * that changes only this stays exactly as matchable as it was.
     *
     * Empty is a real answer. Two students can reveal to each other and still be
     * "the 3rd year from Informatics" to one another, and the screens say so
     * rather than inventing a placeholder that reads like a person.
     */
    revealName: { type: String, default: null, trim: true, maxlength: 30 },

    // Chosen from the fixed list, so matching compares like with like instead of
    // trying to reconcile "gym" and "the gym" and "working out".
    interests: {
      type: [{ type: String, enum: vocab.INTERESTS }],
      default: [],
    },

    // The prompt text is stored alongside the answer because the list may be
    // edited later, and a card must show the question its answer belongs to.
    prompts: [
      {
        _id: false,
        prompt: { type: String, required: true, enum: vocab.PROMPTS },
        answer: { type: String, required: true, trim: true, minlength: 10, maxlength: 220 },
      },
    ],

    // FR-2.2 optional, FR-2.3 hidden, FR-2.5 replaceable.
    photo: {
      fileName: { type: String, default: null },
      uploadedAt: { type: Date, default: null },
      // What the upload was before the browser flattened it. Shown to the owner
      // only, as "your 4 MB selfie became this", and never to a match.
      bytes: { type: Number, default: null },
    },

    /**
     * FR-6.4 and FR-8.3 — whether this profile may be shown to a match at all.
     *
     * `clean` is the normal state. `held` is written by staff when they remove
     * something from a profile after a report: the profile stops being suggested
     * and stops being able to start a chat, and it stays that way until the owner
     * edits and saves it, which re-runs the same screen every other save runs.
     *
     * It is a *state* and not a deleted field because a student has to be able to
     * see why they have stopped appearing. A profile that quietly vanished from
     * everyone's suggestions would look like a bug, and the honest fix for that is
     * a sentence on their own profile screen, which is what `missingForMatching`
     * below turns this into.
     */
    review: {
      status: { type: String, enum: ['clean', 'held'], default: 'clean' },
      reason: { type: String, default: null, maxlength: 300 },
      at: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// Matching filters on these two before it scores anything.
profileSchema.index({ institutionId: 1, lookingFor: 1 });

/**
 * FR-2.7 — the minimum that makes a profile worth suggesting. Answered here
 * rather than stored, so editing a field and becoming ineligible cannot drift
 * out of sync with a flag nobody remembered to update.
 */
profileSchema.methods.missingForMatching = function missingForMatching() {
  const missing = [];
  if (this.review && this.review.status === 'held') {
    missing.push(
      `a staff member paused this profile${this.review.reason ? `: ${this.review.reason}` : ''}. Edit it and save to be shown again`
    );
  }
  if (this.interests.length < vocab.MIN_INTERESTS) {
    missing.push(`pick at least ${vocab.MIN_INTERESTS} interests (you have ${this.interests.length})`);
  }
  if (this.prompts.length < vocab.MIN_PROMPTS) {
    missing.push(`finish at least ${vocab.MIN_PROMPTS} prompt (you have ${this.prompts.length})`);
  }
  return missing;
};

profileSchema.methods.isMatchable = function isMatchable() {
  return this.missingForMatching().length === 0;
};

module.exports = mongoose.model('Profile', profileSchema, 'profiles');
