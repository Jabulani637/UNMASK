'use strict';
/**
 * Promote an existing account to staff — or hand it back.
 *
 *   node scripts/staff.js <address>              make it an admin
 *   node scripts/staff.js <address> --revoke     make it a student again
 *
 * `<address>` is the one the person already signed up with — any institution Unmask
 * lists, as long as that account exists.
 *
 * There is no route that does this, on purpose. FR-6.3 gives a staff member the
 * queue, the reports and the account lever; giving the same lever over HTTP would
 * mean an admin session can mint another admin, which is the shape of every
 * privilege-escalation story this project has read about. So the change needs the
 * database and a keyboard, which is the same place the seed already stands.
 *
 * The account has to exist first. This is not a registration path: it adds a role
 * to an address that already went through institution email verification, so a typo
 * here hands a queue to nobody rather than to somebody else's student.
 */

const { configProblems } = require('../src/config');
const db = require('../src/db');
const institutions = require('../src/services/institutions');
const sessions = require('../src/services/sessions');
const User = require('../src/models/User');

function usage(detail) {
  if (detail) console.error(`\n${detail}`);
  console.error('\nUsage:');
  console.error('  node scripts/staff.js <address>            promote to staff');
  console.error('  node scripts/staff.js <address> --revoke   back to student');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const email = args.find(a => !a.startsWith('--'));

  if (!email) usage('No email address given.');
  if (!email.includes('@')) usage(`"${email}" is not an email address.`);

  const problems = configProblems().filter(p => !p.startsWith('No .env'));
  if (problems.length) {
    console.error('Refusing to change a role. Fix this first:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  await db.connect();

  const institution = await institutions.forEmail(email.toLowerCase());
  if (!institution) {
    await db.disconnect();
    usage(
      `No Unmask institution uses the domain in "${email}", so no account can hold that address.\n` +
        'Add the institution at /staff (or run the seed), then promote someone from it.'
    );
  }

  const user = await User.findOne({ email: email.toLowerCase() }, { role: 1, status: 1, emailVerifiedAt: 1 });
  if (!user) {
    await db.disconnect();
    usage(
      `No Unmask account uses ${email} yet.\n` +
        'Register it on the site first — this script gives an existing account a role, it does not create one.'
    );
  }

  const role = revoke ? 'student' : 'admin';
  if (user.role === role) {
    console.log(`${email} is already ${role === 'admin' ? 'staff' : 'an ordinary student'}. Nothing changed.`);
    await db.disconnect();
    return;
  }

  await User.updateOne({ _id: user._id }, { $set: { role } });

  // An account that was signed in as a student a moment ago is now somebody else.
  // The sessions go with the role, so the change lands at once rather than when a
  // cookie happens to expire — the same reasoning behind signing out a suspension.
  await sessions.dropAll(user._id);

  console.log('');
  console.log(role === 'admin' ? `Staff access granted to ${email}.` : `Staff access removed from ${email}.`);
  console.log('Signed that account out everywhere; sign in again to take the change effect.');
  if (role === 'admin') console.log('The queue is at /staff once you are in.');
  if (!user.emailVerifiedAt) console.log(`Note: ${email} has not confirmed its email yet, so it cannot sign in until it does.`);
  if (user.status !== 'active') console.log(`Note: that account is ${user.status}, so it cannot sign in at all.`);
  console.log('');

  await db.disconnect();
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
