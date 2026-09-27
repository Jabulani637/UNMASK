'use strict';
/**
 * "Not this one." FR-3.3, and the reason FR-3.3 says *next-best* rather than
 * "another".
 *
 * A declined suggestion has to be remembered, or the next press of the button
 * returns the same person and the whole screen becomes a loop. So each pass
 * writes one row naming who passed whom.
 *
 * It expires. `until` is a TTL index, which means MongoDB deletes the row by
 * itself — a student who passed someone eight months ago, then changed three
 * interests last week, should meet that profile again. Nothing in this product
 * should hold a rejection forever, and nothing here holds it past 30 days.
 *
 * `profileId` not `userId`: what was declined was the thing on screen, and the
 * person may rewrite their profile into someone else entirely.
 */

const mongoose = require('mongoose');

const DAY_MS = 24 * 60 * 60 * 1000;
const PASS_LIFETIME_DAYS = 30;

const passSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', required: true },
    until: { type: Date, required: true },
  },
  { timestamps: true }
);

passSchema.index({ userId: 1, profileId: 1 }, { unique: true });
// Documents are removed once their `until` is in the past, with no job to run.
passSchema.index({ until: 1 }, { expireAfterSeconds: 0 });

passSchema.statics.expiresAt = function expiresAt(now = new Date()) {
  return new Date(now.getTime() + PASS_LIFETIME_DAYS * DAY_MS);
};

passSchema.statics.LIFETIME_DAYS = PASS_LIFETIME_DAYS;

module.exports = mongoose.model('Pass', passSchema, 'passes');
