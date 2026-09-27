'use strict';
/**
 * The one document the whole product turns on, put back by every suite that wipes
 * its database.
 *
 * Since the multi-institution work, "may this address register" is answered by a
 * row in `institutions`, not by an environment variable. A test database that has
 * just been cleared therefore refuses `@mycput.ac.za` — not because the address is
 * wrong but because the college is missing — and every suite that signs a student
 * up fails in the setup rather than in the behaviour it came to prove.
 *
 * Two institutions rather than one, because a preference ranking has to name a
 * college that is not the student's own, and because "there is exactly one" is a
 * state no real deployment is ever in.
 */

const Institution = require('../../src/models/Institution');

/** The college the suites sign up at: `testEmail()` ends in its first domain. */
const PILOT = {
  name: 'Cape Peninsula University of Technology',
  shortName: 'CPUT',
  type: 'university',
  city: 'Cape Town',
  emailDomains: ['mycput.ac.za', 'cput.ac.za'],
  faculties: [
    'Engineering',
    'Informatics & Design',
    'Business & Management Sciences',
    'Applied Sciences',
    'Education',
    'Health & Wellness Sciences',
  ],
};

/** Somewhere else, with no faculty list — so free-text faculty is covered too. */
const OTHER = {
  name: 'Peninsula Technikon',
  shortName: 'PENTECH',
  type: 'tvet',
  city: 'Cape Town',
  emailDomains: ['pentechn.ac.za'],
  faculties: [],
};

/** The rows the last seed wrote, by short name. A suite reads this instead of
 *  looking the document up again, and one process is one database. */
const written = new Map();

async function seedTestInstitutions() {
  const rows = [PILOT, OTHER];
  for (const row of rows) {
    const doc = await Institution.findOneAndUpdate(
      { shortName: row.shortName },
      { $set: row, $setOnInsert: { isActive: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    written.set(doc.shortName, doc);
  }
  return rows.map(row => row.shortName);
}

/**
 * The id of the college `testEmail()` signs up at, once the seed has run.
 *
 * A fixture that writes a profile row directly (bypassing the service, to plant a
 * shape the API would refuse) still has to name a real institution, because
 * `institutionId` is required on the document — and this is the only place a suite
 * is allowed to learn that id.
 */
function pilotId() {
  const doc = written.get(PILOT.shortName);
  if (!doc) throw new Error('seedTestInstitutions() has to run before pilotId()');
  return doc._id;
}

/** The other college's id — the one a preference can name without being home. */
function otherId() {
  const doc = written.get(OTHER.shortName);
  if (!doc) throw new Error('seedTestInstitutions() has to run before otherId()');
  return doc._id;
}

/** The same rows, put back only if they are gone — for a suite that must not move them. */
async function ensureTestInstitutions() {
  const count = await Institution.countDocuments();
  return count ? [] : seedTestInstitutions();
}

module.exports = { seedTestInstitutions, ensureTestInstitutions, pilotId, otherId, PILOT, OTHER };
