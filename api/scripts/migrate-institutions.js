'use strict';
/**
 * The one change this project cannot make with a query and a hope: turning every
 * existing profile's free-text `campus` into an `institutionId`, and then removing
 * the field it replaced.
 *
 *   node api/scripts/migrate-institutions.js --dry-run   show what would happen
 *   node api/scripts/migrate-institutions.js             do it
 *   node api/scripts/migrate-institutions.js --to CPUT   only for a profile whose
 *                                                        address matches nothing
 *
 * **It refuses to guess.** A profile's new institution comes from the domain of the
 * address that account verified — the same rule registration applies to a new
 * account, so the migration cannot create a student whose account says one
 * institution and whose profile says another. If an address matches no active
 * institution, the run stops and names the domains, because the alternative is
 * quietly relabelling a person's identity to whichever school was first in a list,
 * and a wrong institution on a profile decides who they are matched with, what
 * their card says, and what a staff member later reads about them.
 *
 * It is re-runnable: a profile that already carries an `institutionId` and has no
 * `campus` left is skipped, so an interrupted run can be started again without
 * working out where it stopped.
 *
 * What it deliberately leaves alone: the evidence text on old reports. A report
 * copies the profile as it was at the moment someone reported it, and rewriting
 * that snapshot after the fact would change what a staff decision was based on.
 * Those rows keep saying "Bellville", which is what they were shown.
 */

const { configProblems } = require('../src/config');
const db = require('../src/db');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const institutions = require('../src/services/institutions');

/**
 * The profiles collection, read and written without a schema in the way.
 *
 * Both halves of this migration are about a field the schema no longer has, and
 * Mongoose will not let a model speak for one: it drops the `$unset` of an
 * off-schema path, and it casts `{ campus: { $exists: true } }` into something that
 * matches every row (measured here — a model-level count returned 6 for the two
 * documents that still carried the field). A run built on either would report a
 * clean migration and leave students' campuses in the database. The raw collection
 * is the only honest way to ask "is this string still in there".
 *
 * A raw write also does not bump `updatedAt`, which is right: nothing about these
 * profiles was edited, and a migration that made every one look freshly saved would
 * be a lie on the profile screen.
 */
function profiles() {
  return mongoose.connection.collection('profiles');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const toIndex = process.argv.indexOf('--to');
  const fallbackName = toIndex !== -1 ? String(process.argv[toIndex + 1] || '').trim().toUpperCase() : '';

  const problems = configProblems().filter(p => !p.startsWith('No .env'));
  if (problems.length) {
    console.error('Refusing to migrate. Fix this first:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  await db.connect();

  const all = await Institution.find({}, { shortName: 1, emailDomains: 1, isActive: 1 });
  if (!all.length) {
    console.error('No institutions in this database. Run `npm run seed` first — there is nothing to migrate a profile onto.');
    process.exit(1);
  }

  let fallback = null;
  if (fallbackName) {
    fallback = all.find(row => row.shortName === fallbackName);
    if (!fallback) {
      console.error(`--to ${fallbackName}: no such institution. Known: ${all.map(r => r.shortName).join(', ')}`);
      process.exit(1);
    }
  }

  // A profile with neither field has never been through here; one with `campus`
  // and no `institutionId` is the row this script exists for.
  const pending = await profiles().find({ $or: [{ campus: { $exists: true } }, { institutionId: { $exists: false } }] }).toArray();
  if (!pending.length) {
    console.log('Nothing to migrate: every profile already names an institution and none carries a campus.');
    await db.disconnect();
    return;
  }

  const byDomain = new Map();
  for (const row of all) {
    if (!row.isActive) continue;
    for (const domain of row.emailDomains || []) byDomain.set(Institution.normalizeDomain(domain), row);
  }

  const moved = new Map();
  const unresolved = [];
  const userIds = [...new Set(pending.map(profile => String(profile.userId)))];
  const users = await User.find({ _id: { $in: userIds } }, { email: 1 });
  const emailOf = new Map(users.map(user => [String(user._id), user.email]));

  for (const profile of pending) {
    const email = emailOf.get(String(profile.userId));
    const domain = institutions.domainOf(email);
    // The domain of the address decides, so a staff account that has been given a
    // profile is migrated by the same rule as a student's.
    let institution = byDomain.get(domain) || null;
    if (!institution && fallback) institution = fallback;
    if (!institution) {
      unresolved.push({ profileId: String(profile._id), domain: domain || '(no address on this account)' });
      continue;
    }
    moved.set(String(profile._id), institution);
  }

  const domains = [...new Set(unresolved.map(row => row.domain))];
  if (unresolved.length) {
    console.error(
      `\n${unresolved.length} profile(s) belong to an address this platform cannot place — no active institution has these domains:\n` +
        domains.map(d => `    ${d}`).join('\n') +
        `\n\nAdd the institution at /staff (or run \`npm run seed\` after editing api/src/domain/pilotInstitutions.js), then re-run this.` +
        `\nIf you are sure these students belong somewhere specific, re-run with --to <SHORTNAME> to move only the ones that did not match.`
    );
    process.exitCode = 1;
    await db.disconnect();
    return;
  }

  if (dryRun) {
    const tally = new Map();
    for (const institution of moved.values()) {
      tally.set(institution.shortName, (tally.get(institution.shortName) || 0) + 1);
    }
    console.log(`Dry run — nothing written. ${moved.size} profile(s) would move:`);
    for (const [shortName, count] of [...tally].sort()) {
      console.log(`  ${shortName}: ${count}`);
    }
    console.log(`And ${moved.size} would have their \`campus\` field removed.`);
    await db.disconnect();
    return;
  }

  let written = 0;
  for (const [profileId, institution] of moved) {
    // The map's key is a string; the raw driver matches on the real type.
    await profiles().updateOne(
      { _id: new mongoose.Types.ObjectId(profileId) },
      { $set: { institutionId: institution._id }, $unset: { campus: '' } }
    );
    written += 1;
  }

  const left = await profiles().countDocuments({
    $or: [{ campus: { $exists: true } }, { institutionId: { $exists: false } }],
  });
  console.log(
    `Migrated ${written} profile(s) onto an institution and removed their campus. ${left} still need attention${
      left ? ' — re-run this script to see which.' : '.'
    }`
  );
  if (fallback) {
    console.log(`Note: ${[...moved.values()].filter(i => String(i._id) === String(fallback._id)).length} were placed on ${fallback.shortName} because you passed --to. Check those addresses.`);
  }
  await db.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
