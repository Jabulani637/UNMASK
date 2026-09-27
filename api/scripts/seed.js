'use strict';
/**
 * Demo accounts, so the site can be clicked through without a phone in your
 * hand waiting for a verification email.
 *
 *   node api/scripts/seed.js          add them
 *   node api/scripts/seed.js --reset  drop them first
 *
 * Three things make these safe to run against a real database by mistake:
 *   - it refuses to do anything when NODE_ENV is production;
 *   - every address it writes is built from the fixed lists further down this
 *     file — four `demoN@` students and one `staff1@` reviewer — and the `--reset`
 *     sweep is those same fixed local parts against the domains of the institutions
 *     on record, so a student's real address is not a string this script can form;
 *   - the password is one you are told, not one you have to remember, and it is
 *     not shared with any other account on earth.
 */

const bcrypt = require('bcryptjs');

const { config, configProblems } = require('../src/config');
const db = require('../src/db');
const User = require('../src/models/User');
const Profile = require('../src/models/Profile');
const auth = require('../src/services/auth');
const institutions = require('../src/services/institutions');
const vocab = require('../src/domain/vocabulary');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'unmask-demo-2026';
const DEMO_PREFIX = 'demo';

/**
 * The accounts a reviewer needs to see a screen work — and the profile each one
 * carries, because stage 4 has nothing to suggest without one.
 *
 * Every value is taken from src/domain/vocabulary.js, so a fixture that the
 * profile form would refuse cannot be seeded.
 *
 * Two details are deliberate. `photo` is left alone: a filename with no file
 * behind it would make the owner's own photo screen show "could not be read".
 * And demo3 is non-binary while demo2 is looking only for Women — so demo2 is
 * never shown demo3, which is what services/matching.js's conservative reading
 * of the three-value `lookingFor` list is meant to look like when you meet it.
 *
 * `institution` is a shortName from src/domain/pilotInstitutions.js, and the
 * students are spread over three of them on purpose: one of the things a reviewer
 * needs to see with their own eyes is two people at different institutions being
 * matched at all, and what their cards say about it. The address each demo gets is
 * built from that institution's own first email domain, so a seeded profile can
 * never claim a school its login would not verify it for.
 */
const DEMO_STUDENTS = [
  {
    n: 1,
    institution: 'CPUT',
    faculty: 'Informatics & Design',
    year: '2nd year',
    gender: 'Woman',
    lookingFor: 'Everyone',
    age: 21,
    revealName: 'Thando',
    preferredInstitutions: ['UCT', 'STELLENBOSCH'],
    interests: ['Amapiano', 'Gym', 'Photography', 'Studying together', 'Loadshedding jokes'],
    prompts: [
      {
        prompt: vocab.PROMPTS[0],
        answer: 'that a generator plan and a gas stove are the difference between a term you survive and one you remember.',
      },
      {
        prompt: vocab.PROMPTS[2],
        answer: 'a braai at the res that turns into a stats study group by four, and nobody ever admits it was on purpose.',
      },
    ],
  },
  {
    n: 2,
    institution: 'CPUT',
    faculty: 'Business & Management Sciences',
    year: '3rd year',
    gender: 'Man',
    lookingFor: 'Women',
    age: 22,
    revealName: 'Sipho',
    interests: ['Gym', 'Side hustles', 'Football', 'Braai culture', 'Studying together'],
    prompts: [
      {
        prompt: vocab.PROMPTS[1],
        answer: 'that a student loan budget is a full-time job nobody pays you for, and the spreadsheet is the personality.',
      },
    ],
  },
  {
    n: 3,
    institution: 'UCT',
    faculty: 'Health Sciences',
    year: '1st year',
    gender: 'Non-binary',
    lookingFor: 'Everyone',
    age: 20,
    revealName: 'Nama',
    preferredInstitutions: ['CPUT'],
    interests: ['Anime', 'Poetry & spoken word', 'Coffee runs', "Hiking Lion's Head", 'Gaming'],
    prompts: [
      {
        prompt: vocab.PROMPTS[0],
        answer: 'that first year is learning to be a whole adult overnight, and that asking for help is part of the syllabus.',
      },
      {
        prompt: vocab.PROMPTS[2],
        answer: 'sunrise on Signal Hill with a flask of rooibos, then pretending I am not tired in nine.',
      },
    ],
  },
  {
    n: 4,
    institution: 'STELLENBOSCH',
    faculty: 'Engineering',
    year: '4th year / Hons',
    gender: 'Woman',
    lookingFor: 'Men',
    age: 23,
    revealName: 'Zanele',
    preferredInstitutions: ['CPUT'],
    interests: ['Coding side projects', 'Coffee runs', 'Clubbing', 'Thrifting'],
    prompts: [
      {
        prompt: vocab.PROMPTS[1],
        answer: 'that a bus factor of one is a personality trait, and that my code review comments are love letters.',
      },
    ],
  },
];

/** The address half of each demo account, once the institutions are known. */
function domainFor(byShort, shortName) {
  const institution = byShort.get(shortName);
  if (!institution) {
    throw new Error(
      `The demo data names ${shortName}, which is not an active institution in this database. Known: ${[...byShort].map(([name]) => name).join(', ')}`
    );
  }
  const domain = (institution.emailDomains || [])[0];
  if (!domain) {
    throw new Error(
      `${shortName} has no email domain on its document, so this platform cannot verify one of its students. Add a domain at /staff, then seed again.`
    );
  }
  return domain;
}

function demoEmails(byShort) {
  return DEMO_STUDENTS.map(student => `${DEMO_PREFIX}${student.n}@${domainFor(byShort, student.institution)}`);
}

/**
 * FR-6.3's other end: somebody has to read the queue, and a reviewer cannot
 * promote an account without a keyboard unless a seeded one exists.
 *
 * `staff1` gets a role and no profile, which is the whole difference between a
 * staff account and a student who happens to be an admin: with no profile the
 * matching engine has nothing to suggest, so a seeded reviewer never turns up on a
 * real student's card. Give it one on /profile and it does, exactly like anybody
 * else — which is the point of a role that is one field on an ordinary account.
 *
 * The reviewer sits on CPUT rather than on the first institution in the list,
 * because which one it is shows up in their address, and `/staff` has to be
 * reachable by an address a reader can type from the README.
 */
const STAFF_INSTITUTION = 'CPUT';
const DEMO_STAFF = ['staff'];

function staffEmails(byShort) {
  return DEMO_STAFF.map(local => `${local}1@${domainFor(byShort, STAFF_INSTITUTION)}`);
}

/** The addresses this run writes, in the order DEMO_STUDENTS lists them. */
function demoAddresses(byShort) {
  return [...demoEmails(byShort), ...staffEmails(byShort)];
}

/**
 * What `--reset` is allowed to clear, which is wider than what this run writes.
 *
 * A demo student's institution is part of their address, so a fixture that moves
 * from CPUT to UCT — which is exactly what the institutions change did to two of
 * them — leaves its old account standing with its profile, its thread and its bell
 * behind, and a sweep built only from today's table can never find it again. So the
 * reset looks at every fixed local part against every domain on an active
 * institution: still only strings no real student is issued.
 */
function demoSweepAddresses(byShort) {
  const locals = [
    ...DEMO_STUDENTS.map(student => `${DEMO_PREFIX}${student.n}`),
    ...DEMO_STAFF.map(local => `${local}1`),
  ];
  const domains = [...byShort.values()].flatMap(row => row.emailDomains || []);
  return locals.flatMap(local => domains.map(domain => `${local}@${domain}`));
}

async function main() {
  const reset = process.argv.includes('--reset');

  if (config.nodeEnv === 'production') {
    console.error('Refusing to seed: NODE_ENV is production. Demo accounts do not belong on a live site.');
    process.exit(1);
  }

  const problems = configProblems().filter(p => !p.startsWith('No .env'));
  if (problems.length) {
    console.error('Refusing to seed. Fix this first:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const now = new Date();
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);

  await db.connect();

  // The institutions come first, and this script writes them if the database has
  // never seen them: a demo student's address is only meaningful as the domain of
  // the school their profile claims, and one brand-new database has neither.
  const pilot = await institutions.ensurePilot();
  const byShort = new Map((await institutions.activeList()).map(row => [row.shortName, row]));
  const emails = demoAddresses(byShort);
  const sweep = demoSweepAddresses(byShort);
  const staff = new Set(staffEmails(byShort));
  console.log(
    `• Institutions: ${pilot.created} added, ${pilot.present} already there (${[...byShort.keys()].join(', ')}).`
  );

  if (reset) {
    const existing = await User.find({ email: { $in: sweep } }, { _id: 1 });
    const ids = existing.map(user => user._id);
    // The same sweep a student's own deletion runs, so the demo accounts cannot
    // leave a bell, a message or a block behind that no --reset ever removes. A
    // pair only has to contain one demo id to belong to this clean-up: the other
    // half is a stranger's thread, and a thread with a deleted student in it
    // cannot go on.
    const removed = await auth.eraseDataFor(ids);
    const gone = await User.deleteMany({ _id: { $in: ids } });
    const rows = Object.entries(removed)
      .filter(([, count]) => count)
      .map(([name, count]) => `${name}: ${count}`)
      .join(', ');
    console.log(
      `• Removed ${gone.deletedCount} demo account(s)` +
        (rows ? ` and every row about them — ${rows}.` : '.')
    );
  }

  for (const email of emails) {
    await User.updateOne(
      { email },
      {
        $set: {
          email,
          passwordHash: hash,
          // Set, so a demo account gets straight past the email gate.
          emailVerifiedAt: now,
          over18AttestedAt: now,
          status: 'active',
          // A re-seed sets the role every time, so a --revoke that was followed by a
          // seed does not leave `staff1` an ordinary student without saying so.
          role: staff.has(email) ? 'admin' : 'student',
          // A profile is never written here: only DEMO_STUDENTS get one, so the staff
          // account has nothing for the matching engine to suggest.
          // A re-seed should not leave the previous run's cookies working.
          sessions: [],
        },
        $unset: {
          verifyTokenHash: '',
          verifyTokenExpiresAt: '',
          resetTokenHash: '',
          resetTokenExpiresAt: '',
          lockedUntil: '',
        },
      },
      { upsert: true }
    );
  }

  // A model save rather than an updateOne, so a mistyped interest, a prompt that
  // is not on the list or an institution this database has never heard of fails
  // here instead of going into the database quietly. An existing profile is left
  // alone: to get the fixtures back, run the seed again with --reset — which is
  // also how a demo student seeded before the institutions existed gets moved onto
  // the one their fixture names.
  let profilesWritten = 0;
  let profilesKept = 0;
  for (let i = 0; i < DEMO_STUDENTS.length; i += 1) {
    const student = DEMO_STUDENTS[i];
    // `emails` is these students in this same order, with the staff rows after them.
    const user = await User.findOne({ email: emails[i] }, { _id: 1 });
    const existing = await Profile.findOne({ userId: user._id }, { _id: 1 });
    if (existing) {
      profilesKept += 1;
      continue;
    }
    await Profile.create({
      userId: user._id,
      institutionId: byShort.get(student.institution)._id,
      preferredInstitutions: (student.preferredInstitutions || []).map((shortName, index) => ({
        institutionId: byShort.get(shortName)._id,
        rank: index + 1,
      })),
      faculty: student.faculty,
      year: student.year,
      gender: student.gender,
      lookingFor: student.lookingFor,
      age: student.age,
      revealName: student.revealName,
      interests: student.interests,
      prompts: student.prompts,
    });
    profilesWritten += 1;
  }

  console.log('');
  console.log('Demo accounts ready. Sign in with any of these:');
  for (const email of demoEmails(byShort)) console.log(`  ${email}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log('');
  console.log('Staff (the moderation queue at /staff, and the same password):');
  for (const email of staffEmails(byShort)) console.log(`  ${email}`);
  console.log('');
  console.log(`Profiles: ${profilesWritten} written, ${profilesKept} left as you had them.`);
  console.log('Sign in as demo1 and open /match to see a suggestion.');
  console.log('demo2 is only looking for women, so demo2 is never shown demo3 — that is the rule, not a bug.');
  console.log('demo1 is at CPUT and demo3 is at UCT, so their cards say so to each other.');
  console.log('');
  console.log('Change it: set DEMO_PASSWORD in .env and run the seed again.');
  console.log('These are throwaway accounts. Do not put real work into them.');

  await db.disconnect();
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
