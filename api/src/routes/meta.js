'use strict';
/**
 * GET /api/meta — the vocabularies the forms offer.
 *
 * Served from the API rather than hard-coded in React so the form's options and
 * the server's validation can never disagree.
 *
 * The institutions are in this response and not in the bundle, which is what makes
 * NFR-SCALE-1 visible to a student as well as true in the database: a college added
 * at /staff appears in the landing page's list without a rebuild, and the only cost
 * is the short cache below.
 */

const express = require('express');
const vocab = require('../domain/vocabulary');
const { config } = require('../config');
const Message = require('../models/Message');
const institutions = require('../services/institutions');
const profileService = require('../services/profile');
const revealService = require('../services/reveal');
const reportsService = require('../services/reports');
const { PASSWORD_MIN } = require('../services/auth');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const list = institutions.publicList(await institutions.activeList());

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      // Every fixed list that used to sit here is now a row: campuses went out with
      // the multi-institution change, and the faculties each college offers are on
      // its own document, because one university's "Informatics & Design" is not
      // another's. An institution with no faculties means its students type one.
      institutions: list,
      years: vocab.YEARS,
      genders: vocab.GENDERS,
      lookingFor: vocab.LOOKING_FOR,
      interests: vocab.INTERESTS,
      prompts: vocab.PROMPTS,
      // Stage 7's report form offers exactly these reasons and nothing else, so the
      // list the student picks from is the list services/reports.js accepts.
      reportReasons: vocab.REPORT_REASONS,
      reportKinds: reportsService.KINDS,
      /*
       * The look-like block. These are in the response for the same reason the
       * interests list is: the form's options and the server's `validateLook` have
       * to be one list, not two that drift.
       *
       * `identity` is here with a warning attached by its shape — it is a single
       * self-description with no partner list under it. There is no
       * `seekIdentity`, no `identitys`-shaped thing a form could offer as a
       * preference, and the only code path it has is onto a profile and into the
       * revealed copy. Someone reading this response should not have to trust a
       * comment in vocabulary.js to work that out.
       */
      identity: vocab.IDENTITY,
      bodyTypes: vocab.BODY_TYPES,
      heights: vocab.HEIGHTS,
      lifestyle: {
        drinks: vocab.DRINKS,
        smokes: vocab.SMOKES,
        gym: vocab.GYM,
        // The one answer that may be picked about somebody else and not about
        // yourself, so the form adds it to its seek lists rather than inventing a
        // sixth thing to be.
        either: vocab.EITHER,
      },
      ageRange: { min: vocab.AGE_MIN, max: vocab.AGE_MAX },
      minimums: {
        interests: vocab.MIN_INTERESTS,
        prompts: vocab.MIN_PROMPTS,
        maxInterests: profileService.MAX_INTERESTS,
        // The form counts characters against this, so a student is never told the
        // answer is too long after typing it.
        promptAnswerMax: profileService.MAX_PROMPT_ANSWER,
        // A free-text faculty — the answer for an institution that has not been
        // given a list — counts against this one.
        facultyMax: profileService.MAX_FACULTY,
        // The preference picker stops offering boxes at this number, which is the
        // number services/institutions.js refuses a save past.
        maxPreferredInstitutions: institutions.MAX_PREFERENCES,
        // The five "who I am after" lists stop offering chips at this number, which
        // is the number services/profile.js refuses a save past, and the note about
        // your type counts against this ceiling.
        maxPicks: vocab.MAX_PREF_PICKS,
        typeNoteMax: profileService.MAX_TYPE_NOTE,
        // Same reason on the other side of the product: the composer counts down
        // against the number Message.js actually enforces.
        messageMax: Message.MAX_BODY,
        // The reveal name field counts against this, and services/profile.js is the
        // one place that decides whether what was typed fits.
        revealNameMax: profileService.MAX_REVEAL_NAME,
        // The chat screen says "send two more of your own messages" using the
        // service's own number, so a button cannot appear before the API would
        // allow the press.
        revealMessagesBeforeAsk: revealService.MIN_MESSAGES_BEFORE_ASK,
      },
      // The browser shrinks a photo before uploading; this is the ceiling it
      // refuses to accept past, so the picker can say "too big" instead of the API.
      photo: { maxBytes: config.maxPhotoBytes },
      passwordMinLength: PASSWORD_MIN,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
