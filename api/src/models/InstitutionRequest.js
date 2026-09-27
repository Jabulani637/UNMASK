'use strict';
/**
 * "Don't see yours? Request it."
 *
 * The one honest way to decide which college to add next. A curated whitelist is
 * a promise that somebody reads the requests, and without this collection that
 * promise is a sentence on a page pointing at nothing.
 *
 * **It holds no link to the person who sent it.** No account id, no email
 * address, no session hash. A request is a claim about an institution, not about
 * a student, and keeping it that way means this collection has nothing to delete
 * when a person exercises NFR-3.5 — which is the only reason it can be written by
 * someone who has not finished registering. The route that creates these is
 * rate-limited instead of deduplicated: a fingerprint of the sender would be
 * personal data invented for the purpose of counting people.
 */

const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema(
  {
    institutionName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    city: { type: String, default: null, trim: true, maxlength: 60 },
    /** Free text, screened by the same contact guard a profile answer is. */
    detail: { type: String, default: null, trim: true, maxlength: 240 },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

requestSchema.index({ institutionName: 1, createdAt: -1 });

module.exports = mongoose.model('InstitutionRequest', requestSchema, 'institutionRequests');
