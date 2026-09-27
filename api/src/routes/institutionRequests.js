'use strict';
/**
 * POST /api/institution-requests — "Don't see yours? Request it."
 *
 * The only write in this API a stranger may make, before they have an account, a
 * verified address or a session. Two things make that safe, and both are here rather
 * than in a service because they are about the door, not the data: a limit per
 * address, and the same contact screen a profile answer goes through.
 *
 * The screen matters more here than anywhere else in the API. This record holds no
 * way to reach the person who sent it — models/InstitutionRequest.js explains why
 * there is nothing to fingerprint a sender with, and the rate limit is the only
 * defence, because there is no account to suspend. So a request that says "email me
 * at naledi@…" is a promise nobody can keep, and the sentence that comes back has to
 * say so while they are still looking at the box.
 */

const express = require('express');

const institutions = require('../services/institutions');
const { findContactClue } = require('../services/profile');
const { UserError } = require('../errors');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Five an hour from one address. A person who wants three colleges added can do that
// in one sitting; a script that wants the collection full of junk cannot, and this is
// the whole of what stops it, since there is no account behind the request to throttle.
const guard = rateLimit({ limit: 5, windowMs: 60 * 60 * 1000, bucket: 'institution-request' });

/**
 * What may be written down about a college, and what may not.
 *
 * A domain is allowed through even though the contact screen would call it a link,
 * because "our addresses are @mytvet.ac.za" is the single most useful thing a
 * requester can offer — it is the field staff need in order to add the institution.
 * The line between that and `naledi@mytvet.ac.za` is the character in front: a token
 * with an address's local part or an @ glued to it is not a domain, and stays in the
 * text for the screen to find.
 */
/**
 * A link, as opposed to a domain: something with a path, a port or a scheme on it.
 *
 * The difference is the whole of the exemption below. `@mytvet.ac.za` is a field
 * staff need; `mytvet.ac.za/apply` is a place to go, and the second one is a way to
 * leave Unmask even though it starts with the same eight characters.
 */
const A_LINK = /(?:https?:\/\/|www\.)|(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\S*|:\d{2,5})/i;

function screenText(value, label, { allowDomains = false } = {}) {
  const text = String(value ?? '');
  if (!text) return null;
  const exempt = allowDomains && !A_LINK.test(text);
  const probe = exempt ? text.replace(/(^|[^@\w.])@?[\w-]+(?:\.[\w-]+)+/g, '$1 ') : text;
  const clue = findContactClue(probe);
  if (clue) {
    throw new UserError(
      `We cannot reply to a request, so please take ${clue} out of the ${label}. Staff read the list of names — the college you asked for is already enough.`,
      { status: 400, code: 'contact_in_request' }
    );
  }
  return text;
}

router.post('/', guard, async (req, res, next) => {
  try {
    const body = req.body || {};
    screenText(body.institutionName, 'institution name');
    screenText(body.city, 'town or city');
    screenText(body.detail, 'message', { allowDomains: true });

    const request = await institutions.recordRequest({
      institutionName: body.institutionName,
      city: body.city,
      detail: body.detail,
    });

    // `no-store`, for the reason every other response that describes a decision has
    // it: this one tells a person their college is not here, and a cached copy of
    // that on a shared library computer is a stale answer about who is welcome.
    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      received: true,
      institutionName: request.institutionName,
      message: `Recorded: ${request.institutionName}. Staff read this list when they decide which college to add next — and when yours appears, you will see it in the list on the sign-up page, not in an email, because we deliberately kept no way to reach you.`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
