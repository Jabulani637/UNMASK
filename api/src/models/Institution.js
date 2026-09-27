'use strict';
/**
 * The institutions whose students Unmask accepts.
 *
 * This document *is* the eligibility rule. Before it, the answer to "may this
 * address register" was one comma-separated environment variable
 * (`ALLOWED_EMAIL_DOMAINS`) and the answer to "which campus" was a free-text
 * string on the profile — so adding a college meant editing `.env` and
 * redeploying, and a UWC student had to pick a CPUT campus to finish a form.
 * Now the collection holds both facts and NFR-SCALE-1 is literally true: one new
 * document here, with its own domains, and its students can register, be matched
 * and be shown, with no code change and no migration.
 *
 * `type` exists because a TVET college is in scope alongside universities, and
 * the copy that talks about them ("students and TVET learners") may need to
 * differ. It carries no weight in matching: a university and a college score
 * identically, on purpose.
 *
 * Nothing here is a claim about a region. `city` is one field on one document,
 * used for one scoring tier, and is not written into any sentence a student
 * reads.
 */

const mongoose = require('mongoose');

const TYPES = ['university', 'tvet'];

/**
 * A domain is stored the way it is compared: lowercased, no leading dot, no
 * surrounding space. Normalising at save time rather than at match time means a
 * staff member typing `@CPUT.ac.za ` into the Institutions screen writes the
 * same string the login path looks up, and the two can never disagree by case.
 */
function normalizeDomain(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^\.+/, '').replace(/@/g, '');
}

const institutionSchema = new mongoose.Schema(
  {
    /** "Cape Peninsula University of Technology" — what a person reads once. */
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * "CPUT" — what a card, a chat header and a reveal row show, because a
     * fifteen-letter name does not fit a badge. Uppercased on save so the five
     * places it is rendered cannot disagree about who looks like shouting.
     */
    shortName: { type: String, required: true, trim: true, maxlength: 24, uppercase: true },

    type: { type: String, enum: TYPES, required: true },

    city: { type: String, required: true, trim: true, maxlength: 60 },

    /**
     * The only thing that decides whether an address belongs to this
     * institution. Unique across the whole collection — Mongo enforces that on
     * an array field per element — so one domain can never be claimed twice and
     * "which institution does this person belong to" has exactly one answer even
     * after a staff member adds a college in a hurry.
     */
    emailDomains: {
      type: [{ type: String, trim: true, lowercase: true }],
      default: [],
      set: list => (Array.isArray(list) ? list.map(normalizeDomain).filter(Boolean) : []),
    },

    /**
     * An optional list of faculties/schools this institution's students choose
     * from. Empty is a real answer and means "we have not been told": the
     * profile then takes faculty as free text instead of refusing a school that
     * genuinely exists. This is why the field is here rather than one global
     * list — the old fixed list was CPUT's, and applying it to a college in
     * Mowbray would have been a guess.
     */
    faculties: {
      type: [{ type: String, trim: true, maxlength: 80 }],
      default: [],
    },

    /**
     * Turning an institution off stops its *students being matched and its new
     * addresses registering*; it does not delete anybody. A row is soft-disabled
     * rather than removed because the accounts that point at it hold personal
     * data and a deleted institution would leave them describing nowhere.
     */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

institutionSchema.index({ shortName: 1 }, { unique: true });
institutionSchema.index({ emailDomains: 1 }, { unique: true, sparse: true });

institutionSchema.statics.TYPES = TYPES;
institutionSchema.statics.normalizeDomain = normalizeDomain;

/** The one question the rest of the product asks of this collection. */
institutionSchema.statics.forEmail = async function forEmail(email) {
  const domain = normalizeDomain(String(email || '').slice(String(email || '').lastIndexOf('@') + 1));
  if (!domain) return null;
  return this.findOne({ emailDomains: domain, isActive: true });
};

module.exports = mongoose.model('Institution', institutionSchema, 'institutions');
