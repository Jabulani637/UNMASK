'use strict';
/**
 * NFR-SCALE-1, proven end to end: **a college added by a staff member through the
 * staff screen behaves exactly like a college the code was written with.**
 *
 * The claim is easy to make and easy to fake, so every subtest goes through the HTTP
 * surface a person would actually use — POST the institution, register at its domain,
 * save a profile, ask for a suggestion — and nothing here restarts the server. A test
 * that had to restart would be proving a seed script rather than the running product.
 *
 * Four things carry the file:
 *
 *   - **`/api/meta` is the vocabulary.** No `campuses`, no top-level `emailDomains`;
 *     the domains and faculties belong to each college, which is why one university's
 *     "Informatics & Design" is not another's, and why a college with no list turns
 *     the form's faculty field into a text box.
 *   - **The Institution row is the eligibility rule.** A new domain can register the
 *     second its row is written, and `isActive: false` takes that away — while the
 *     accounts already there keep their login and their profile, which is what makes
 *     it a switch rather than the deletion it is not.
 *   - **One domain, one college.** A staff member cannot hand `mycput.ac.za` to a
 *     second institution, because "whose student is this" would then have two answers.
 *   - **The request box is write-only on purpose.** It holds no way to reach the
 *     sender, so a contact detail in it is refused, a bare domain is allowed, and the
 *     only thing keeping the list readable is a limit per address.
 *
 * Its own database, outbox and photo folder, because `node --test` runs suites side
 * by side.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
const testUrl = new URL(process.env.MONGO_URL);
testUrl.pathname = '/unmask_test_institutions';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-institutions';
process.env.PHOTO_DIR = './storage/test-photos-institutions';

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions, pilotId } = require('./support/institutions');
const User = require('../src/models/User');
const Profile = require('../src/models/Profile');
const Institution = require('../src/models/Institution');
const InstitutionRequest = require('../src/models/InstitutionRequest');
const AuditEvent = require('../src/models/AuditEvent');
const vocab = require('../src/domain/vocabulary');
const institutions = require('../src/services/institutions');
const profileService = require('../src/services/profile');
const revealService = require('../src/services/reveal');
const reportsService = require('../src/services/reports');
const { Message } = require('../src/models');
const { PASSWORD_MIN } = require('../src/services/auth');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'blue-koala-printing-42';

let server;
let base;

// ---------------------------------------------------------------- HTTP helpers

async function raw(method, route, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';

  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* the assertion prints the raw text */
  }
  return {
    status: res.status,
    json,
    text,
    headers: res.headers,
    cookie: setCookie ? setCookie.split(';')[0] : cookie,
  };
}

const meta = async () => {
  resetRateLimits();
  return raw('GET', '/api/meta');
};
const health = async () => {
  resetRateLimits();
  return raw('GET', '/api/health');
};
const suggestionOf = async account => {
  resetRateLimits();
  return raw('GET', '/api/matches/suggestion', { cookie: account.cookie });
};

/**
 * The body a finished profile is saved with.
 *
 * A save validates age, year, gender and looking-for every time — there is no
 * partial write in this product — so a subtest that only wants to change one field
 * still has to send the whole form, which is what this is for.
 */
function finished(over = {}) {
  return {
    faculty: 'Informatics & Design',
    year: '2nd year',
    gender: 'Woman',
    lookingFor: 'Men',
    age: 20,
    interests: ['Gym', 'Amapiano'],
    prompts: [{ prompt: vocab.PROMPTS[0], answer: 'that a generator plan is a love language of its own.' }],
    ...over,
  };
}

/**
 * A student, registered, verified and holding a saved profile.
 *
 * The address's domain is the parameter because in this product the domain *is* the
 * institution: this helper is how a test puts a student at a college that did not
 * exist a minute ago.
 */
async function student(local, domain = 'mycput.ac.za', over = {}) {
  const address = `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}@${domain}`;
  resetRateLimits();
  const registered = await raw('POST', '/api/auth/register', {
    body: { email: address, password: PASSWORD, over18Attested: true },
  });
  assert.equal(registered.status, 200, registered.text);
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });

  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);
  const account = { email: address, cookie: signedIn.cookie };

  const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
  assert.equal(saved.status, 200, saved.text);

  account.userId = (await User.findOne({ email: address }))._id;
  account.profile = saved.json.profile;
  return account;
}

/** A reviewer, promoted the only way it can be done: in the database, by script. */
async function staff() {
  const address = `reviewer.${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}@mycput.ac.za`;
  resetRateLimits();
  await raw('POST', '/api/auth/register', { body: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date(), role: 'admin' } });
  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);
  return { email: address, cookie: signedIn.cookie };
}

const listInstitutions = async as => {
  resetRateLimits();
  return raw('GET', '/api/staff/institutions', { cookie: as.cookie });
};
const saveInstitution = async (as, body, id) => {
  resetRateLimits();
  return raw(id ? 'PUT' : 'POST', id ? `/api/staff/institutions/${id}` : '/api/staff/institutions', {
    cookie: as.cookie,
    body,
  });
};

/**
 * The row a staff form writes. Numbered so a second call cannot collide with the
 * first, fictional so nothing here names a real college, and on a domain no seed
 * owns — which is the only reason a student can register on it.
 */
let invented = 0;
function newCollege() {
  invented += 1;
  return {
    name: `Kaaiman Valley University of Technology ${invented}`,
    shortName: `KVUT${invented}`,
    type: 'tvet',
    city: 'Kaaiman Valley',
    emailDomains: [`kvut${invented}.ac.za`],
    // No faculty list, because a college nobody has configured yet is the normal
    // case and the form has to survive it.
    faculties: [],
  };
}

// ------------------------------------------------------------------- the suite

test('NFR-SCALE-1 — a college added at /staff is one the product already knows how to handle', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    // This run's mail and photo folders are scratch, and a verification link left in
    // one is a live session-equivalent.
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    fs.rmSync(config.photoDir, { recursive: true, force: true });
    // The connection is what keeps the process alive: without this the suite passes
    // and `node --test` never finishes.
    await db.disconnect();
  });

  await db.connect();
  await db.ensureIndexes();
  await Promise.all([
    User.deleteMany({}),
    Profile.deleteMany({}),
    Institution.deleteMany({}),
    InstitutionRequest.deleteMany({}),
    AuditEvent.deleteMany({}),
  ]);
  await seedTestInstitutions();

  // ------------------------------------------------------------------- /api/meta
  await t.test('meta gives the vocabularies, and the colleges are the only list of colleges', async () => {
    const res = await meta();
    assert.equal(res.status, 200, res.text);
    const body = res.json;

    // The two things the single-institution build published. A fixed campus list is
    // the reason a student at any other college had to lie to finish a form, and one
    // flat domain list is the reason a second college could not exist.
    assert.ok(!('campuses' in body), 'meta still publishes a campus vocabulary');
    assert.ok(!('emailDomains' in body), 'meta still publishes one eligibility list for the whole product');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');

    // The fixed lists the profile form is built from, and the minimums it counts
    // against — asserted here rather than in api.test.js because /api/meta now needs
    // the database, and a form cannot be proven against a route that answers 500.
    assert.deepEqual(body.years, vocab.YEARS);
    assert.deepEqual(body.genders, vocab.GENDERS);
    assert.deepEqual(body.lookingFor, vocab.LOOKING_FOR);
    assert.deepEqual(body.interests, vocab.INTERESTS);
    assert.equal(body.interests.length, 20);
    assert.deepEqual(body.prompts, vocab.PROMPTS);
    assert.deepEqual(body.reportReasons, vocab.REPORT_REASONS);
    assert.deepEqual(body.reportKinds, reportsService.KINDS);
    assert.deepEqual(body.ageRange, { min: vocab.AGE_MIN, max: vocab.AGE_MAX });

    // The look-like block, published from the same arrays `validateLook` refuses a
    // save outside of. And the shape of the race line, which is the whole point of
    // how that field was decided: a list to describe yourself, with no list beside
    // it to choose somebody by.
    assert.deepEqual(body.identity, vocab.IDENTITY);
    assert.deepEqual(body.bodyTypes, vocab.BODY_TYPES);
    assert.deepEqual(body.heights, vocab.HEIGHTS);
    assert.deepEqual(body.lifestyle, { drinks: vocab.DRINKS, smokes: vocab.SMOKES, gym: vocab.GYM, either: vocab.EITHER });
    assert.ok(!Object.keys(body).some(key => key !== 'identity' && /identity/i.test(key)), 'meta publishes a race preference list');
    assert.ok(!('seekIdentity' in vocab), 'the vocabulary carries a race preference list');

    assert.deepEqual(body.minimums, {
      interests: vocab.MIN_INTERESTS,
      prompts: vocab.MIN_PROMPTS,
      maxInterests: profileService.MAX_INTERESTS,
      promptAnswerMax: profileService.MAX_PROMPT_ANSWER,
      facultyMax: profileService.MAX_FACULTY,
      maxPreferredInstitutions: institutions.MAX_PREFERENCES,
      maxPicks: vocab.MAX_PREF_PICKS,
      typeNoteMax: profileService.MAX_TYPE_NOTE,
      messageMax: Message.MAX_BODY,
      revealNameMax: profileService.MAX_REVEAL_NAME,
      revealMessagesBeforeAsk: revealService.MIN_MESSAGES_BEFORE_ASK,
    });
    assert.equal(body.photo.maxBytes, config.maxPhotoBytes, 'the form must not accept a file the route will refuse');
    assert.equal(body.passwordMinLength, PASSWORD_MIN);
    assert.ok(PASSWORD_MIN >= 10, `password minimum has dropped to ${PASSWORD_MIN}`);

    // FR-2.6: a profile never carries a real name, so nothing here may look like one.
    assert.ok(!('name' in body) && !('surname' in body) && !('email' in body));
  });

  await t.test('each college carries its own domains and faculties, and one domain has one owner', async () => {
    const body = (await meta()).json;
    assert.equal(body.institutions.length, 2, `the seed wrote two colleges; meta says ${body.institutions.length}`);

    const cput = body.institutions.find(row => row.shortName === 'CPUT');
    const pentech = body.institutions.find(row => row.shortName === 'PENTECH');
    assert.ok(cput && pentech, `both seeded colleges are not on the list: ${body.institutions.map(r => r.shortName).join(', ')}`);

    for (const row of body.institutions) {
      assert.match(row.id, /^[0-9a-f]{24}$/, 'a student cannot rank a college it has no id for');
      assert.equal(typeof row.name, 'string');
      assert.ok(Institution.TYPES.includes(row.type), `${row.shortName} has a type nothing can label`);
      assert.equal(typeof row.city, 'string', 'the city is what the score is built from');
      assert.ok(Array.isArray(row.faculties), 'a college with no faculty list is a real answer, not a missing field');
      for (const domain of row.emailDomains) {
        assert.equal(domain, domain.toLowerCase(), `${domain} is not lowercase`);
        assert.ok(!domain.startsWith('@'), `${domain} carries a leading @`);
      }
    }

    // CPUT's list is why its students get a dropdown; PENTECH has none, which is why
    // the same field is a text box for theirs. Neither is a special case in React.
    assert.ok(cput.faculties.includes('Informatics & Design'));
    assert.deepEqual(pentech.faculties, []);

    // One domain, one college, checked across the whole list rather than one pair.
    const seen = new Map();
    for (const row of body.institutions) {
      for (const domain of row.emailDomains) {
        assert.ok(!seen.has(domain), `“${domain}” is offered by both ${seen.get(domain)} and ${row.shortName}`);
        seen.set(domain, row.shortName);
      }
    }
    assert.equal(seen.get('mycput.ac.za'), 'CPUT');
  });

  await t.test('a student who is not staff gets the same 404 an unknown path gets', async () => {
    const pupil = await student('door-student');
    const unknown = await raw('GET', '/api/definitely-not-a-route');
    assert.equal(unknown.status, 404);

    // A student is signed in, so the door's answer is "there is nothing here" — the
    // body a genuinely unknown path produces, character for character.
    for (const route of ['/api/staff/institutions', '/api/staff/institution-requests', '/api/staff/reports']) {
      const res = await raw('GET', route, { cookie: pupil.cookie });
      assert.equal(res.status, 404, `${route} answered ${res.status}: ${res.text}`);
      assert.equal(res.text, unknown.text, `${route} answers differently from an unknown path, which tells a guesser where to look`);
    }

    // Anonymity is a different case and gets the answer every protected route gives,
    // so that "sign in" is not information about which screens exist.
    const anonymous = await raw('GET', '/api/staff/institutions');
    assert.equal(anonymous.status, 401, anonymous.text);
    assert.equal(anonymous.json.code, 'unauthenticated');

    // The write door is the same door: a student cannot add a college.
    const created = await saveInstitution(pupil, newCollege());
    assert.equal(created.status, 404, created.text);
  });

  // ------------------------------------------------------- adding a college live
  let reviewer;
  let added;
  await t.test('staff add a college over HTTP, and its students are on Unmask from that moment', async () => {
    reviewer = await staff();
    const before = (await meta()).json.institutions.length;
    const row = newCollege();

    const res = await saveInstitution(reviewer, row);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.created, true);
    added = res.json.institution;
    assert.equal(added.shortName, row.shortName);
    assert.equal(added.isActive, true);
    assert.equal(
      res.json.message,
      `${row.shortName} can register now. 1 domain(s): ${row.emailDomains[0]}.`
    );

    // No restart and no rebuild: the sign-up list is one cache-minute from showing
    // it, and the form already knows this college has no faculty list to offer.
    const after = (await meta()).json.institutions;
    assert.equal(after.length, before + 1);
    const onMeta = after.find(entry => entry.shortName === row.shortName);
    assert.ok(onMeta, 'the new college is not on /api/meta');
    assert.deepEqual(onMeta.faculties, []);
    assert.deepEqual(onMeta.emailDomains, [row.emailDomains[0]]);

    const ready = (await health()).json;
    assert.equal(ready.readiness.activeInstitutions, before + 1, `health still reports ${ready.readiness.activeInstitutions} colleges after another was added`);

    // The decision is in the log with the domain that came with it, because a switch
    // that decides who may register cannot be the one decision nobody can replay.
    const audit = await AuditEvent.findOne({ action: 'institution.created', targetId: added.id });
    assert.ok(audit, 'adding a college wrote no audit row');
    assert.match(audit.note, new RegExp(`${row.shortName}: added with ${row.emailDomains[0].replace('.', '\\.')}`));

    // And a college nobody had ever heard of now behaves like one the code shipped
    // with: its address registers, its name reaches the profile it resolves to, and
    // its students appear on each other's cards.
    const first = await student('kvut-first', row.emailDomains[0], { faculty: 'Accounting' });
    assert.equal(first.profile.institution.shortName, row.shortName);
    assert.equal(String(first.profile.institution.id), added.id);

    await student('kvut-second', row.emailDomains[0], { gender: 'Man', lookingFor: 'Women' });
    const suggested = await suggestionOf(first);
    assert.equal(suggested.status, 200, suggested.text);
    assert.equal(suggested.json.suggestion.institution, row.shortName, 'the card of a student at a college added a minute ago does not say which college it is');
  });

  await t.test('the staff form refuses a domain that already belongs to another college, by name', async () => {
    const clash = await saveInstitution(reviewer, {
      name: 'Peninsula Second Campus',
      shortName: 'PENTECH2',
      type: 'tvet',
      city: 'Cape Town',
      emailDomains: ['mycput.ac.za'],
      faculties: [],
    });
    assert.equal(clash.status, 409, clash.text);
    assert.match(clash.json.error, /“mycput\.ac\.za” already belongs to CPUT/);
    assert.equal(await Institution.countDocuments({ shortName: 'PENTECH2' }), 0, 'the refused college was written anyway');

    // People paste domains with an `@` on the front, because that is how the form
    // asks for them. The store trims it, so the row it saves is the bare domain.
    const atSign = await saveInstitution(reviewer, {
      name: 'At Sign College',
      shortName: 'ATSNACK',
      type: 'tvet',
      city: 'Cape Town',
      emailDomains: ['@kvut9.ac.za'],
      faculties: [],
    });
    assert.equal(atSign.status, 201, atSign.text);
    assert.deepEqual(atSign.json.institution.emailDomains, ['kvut9.ac.za'], 'the @ was stored, so no address can ever end in it');
    assert.ok(await Institution.deleteOne({ _id: atSign.json.institution.id }));

    // Anything that is not a domain at all is refused while the staff member is
    // still looking at the field, rather than stored, matching nobody, forever.
    for (const bad of ['kvut9 ac.za', 'kvut9', 'kvut9.', 'http://kvut9.ac.za']) {
      const res = await saveInstitution(reviewer, {
        name: 'Broken Domain College',
        shortName: 'BROKEN',
        type: 'tvet',
        city: 'Cape Town',
        emailDomains: [bad],
        faculties: [],
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} was accepted: ${res.text}`);
      assert.match(res.json.error, /domain/i);
    }
    assert.equal(await Institution.countDocuments({ shortName: 'BROKEN' }), 0);
  });

  await t.test('a patch that only touches the switch cannot empty the domains', async () => {
    const off = await saveInstitution(reviewer, { isActive: false }, added.id);
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json.institution.emailDomains, added.emailDomains, 'the toggle emptied the domains, which locks out every student there');
    assert.equal(off.json.institution.isActive, false);
    assert.match(off.json.message, /switched off\. Its existing accounts are untouched/);

    const on = await saveInstitution(reviewer, { isActive: true }, added.id);
    assert.equal(on.json.institution.isActive, true);
    assert.deepEqual(on.json.institution.emailDomains, added.emailDomains);
  });

  // ------------------------------------------------------------ switching it off
  await t.test('off: no new addresses and no suggestions, and the students already there keep their accounts', async () => {
    // Built while the college is still on, because a switched-off college cannot
    // register anybody — which is exactly the thing this subtest goes on to prove.
    const there = await student('kvut-remaining', added.emailDomains[0]);
    const elsewhere = await student('off-viewer');
    // Somebody compatible who is not at the college about to be switched off, so
    // "the pool still has someone in it" is a comparison and not a vacancy.
    await student('off-nearby', 'mycput.ac.za', { gender: 'Man', lookingFor: 'Women' });

    const off = await saveInstitution(reviewer, { isActive: false }, added.id);
    assert.equal(off.status, 200, off.text);

    // Gone from what a student is offered, still on the staff screen: the toggle has
    // to stay reachable, or switching something off would be permanent by accident.
    const metaRows = (await meta()).json.institutions;
    assert.ok(!metaRows.find(row => row.shortName === added.shortName), 'a switched-off college is still offered to students');
    const staffRows = (await listInstitutions(reviewer)).json.institutions;
    assert.equal(staffRows.find(row => row.shortName === added.shortName).isActive, false);
    assert.equal((await health()).json.readiness.activeInstitutions, metaRows.length);

    // Nobody new can join, and the sentence names their own address.
    const refused = await raw('POST', '/api/auth/register', {
      body: { email: `locked.out.${Date.now().toString(36)}@${added.emailDomains[0]}`, password: PASSWORD, over18Attested: true },
    });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.json.error, new RegExp(`${added.emailDomains[0]}” is not one yet`));

    // The student already there is not deleted, not signed out, and not blamed.
    resetRateLimits();
    const signedIn = await raw('POST', '/api/auth/login', { body: { email: there.email, password: PASSWORD } });
    assert.equal(signedIn.status, 200, 'a student at a switched-off college can no longer sign in');
    resetRateLimits();
    const read = await raw('GET', '/api/profile', { cookie: there.cookie });
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.profile.institution.shortName, added.shortName);

    const own = await suggestionOf(there);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.suggestion, null);
    assert.equal(own.json.exhausted, true);
    assert.match(own.json.message, new RegExp(`${added.shortName} is not taking students on Unmask right now`));
    assert.match(own.json.message, /nothing about your profile is wrong/);

    // And they are not suggested to anybody else.
    const seen = await suggestionOf(elsewhere);
    assert.equal(seen.status, 200, seen.text);
    assert.ok(seen.json.suggestion, 'the viewer was left with nobody, which is not what one switched-off college should do');
    assert.notEqual(seen.json.suggestion.institution, added.shortName);
    assert.ok(!seen.text.includes(added.shortName), 'the switched-off college is still named on another student’s screen');

    // Ranking it is refused rather than dropped: silently losing a student's first
    // choice would change who they are shown without saying so.
    resetRateLimits();
    const ranked = await raw('PUT', '/api/profile', {
      cookie: elsewhere.cookie,
      body: finished({ preferredInstitutions: [{ institutionId: added.id }] }),
    });
    assert.equal(ranked.status, 400, ranked.text);
    assert.match(ranked.json.error, new RegExp(`${added.shortName} is not taking students on Unmask right now`));

    // Back on, and both halves of the switch reverse with nothing rebuilt.
    const on = await saveInstitution(reviewer, { isActive: true }, added.id);
    assert.equal(on.status, 200, on.text);
    assert.ok((await meta()).json.institutions.find(row => row.shortName === added.shortName));
    const revived = await suggestionOf(there);
    assert.ok(revived.json.suggestion, 'switching the college back on did not give its students their suggestions');
    resetRateLimits();
    const joined = await raw('POST', '/api/auth/register', {
      body: { email: `late.${Date.now().toString(36)}@${added.emailDomains[0]}`, password: PASSWORD, over18Attested: true },
    });
    assert.equal(joined.status, 200, joined.text);
  });

  // --------------------------------------------------------------- the ask box
  await t.test('“my institution isn’t listed” records the name and refuses a way to reply to it', async () => {
    const asked = await raw('POST', '/api/institution-requests', {
      body: { institutionName: 'Peninsula TVET College', city: 'Cape Town' },
    });
    assert.equal(asked.status, 201, asked.text);
    assert.equal(asked.json.received, true);
    assert.match(asked.json.message, /you will see it in the list on the sign-up page, not in an email/);
    assert.equal(asked.headers.get('cache-control'), 'no-store', 'a cached "your college is not here" is a stale answer on a shared computer');

    // A domain is the field staff need next, so it survives the contact screen…
    resetRateLimits();
    const withDomain = await raw('POST', '/api/institution-requests', {
      body: { institutionName: 'Peninsula TVET College', detail: 'our addresses are @peninsula.tvet.ac.za and there are 4000 of us' },
    });
    assert.equal(withDomain.status, 201, withDomain.text);

    // …and an address somebody could be written back to does not.
    for (const detail of [
      'write me at naledi@peninsula.tvet.ac.za',
      'call 0821234567 and add us',
      'move to whatsapp and add us',
      'see our page at peninsulatvet.example.com/apply',
    ]) {
      resetRateLimits();
      const refused = await raw('POST', '/api/institution-requests', {
        body: { institutionName: 'Peninsula TVET College', detail },
      });
      assert.equal(refused.status, 400, `${JSON.stringify(detail)} was recorded: ${refused.text}`);
      assert.match(refused.json.error, /cannot reply to a request/);
    }

    // A name nobody can act on is not a request.
    resetRateLimits();
    const nameless = await raw('POST', '/api/institution-requests', { body: { institutionName: '   ' } });
    assert.equal(nameless.status, 400, nameless.text);
    assert.match(nameless.json.error, /Give the name of the institution/);

    assert.equal(await InstitutionRequest.countDocuments({}), 2, 'a refused request was stored, or a stored one is not there');

    // Staff read it grouped, because the question they bring is "which college next".
    const queue = await raw('GET', '/api/staff/institution-requests', { cookie: reviewer.cookie });
    assert.equal(queue.status, 200, queue.text);
    const grouped = queue.json.requests.find(row => row.institutionName === 'Peninsula TVET College');
    assert.equal(grouped.count, 2);
    assert.ok(grouped.lastRequested, 'the list has no date to sort by');
    assert.ok(!queue.text.includes('naledi'), 'the queue carries a contact detail');
    assert.ok(!queue.text.includes('0821234567'), 'the queue carries a phone number');

    // The five-an-hour guard, which is the whole defence a write from a stranger has.
    // Reset first: the refused nameless request above spent one of the five.
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) {
      const more = await raw('POST', '/api/institution-requests', { body: { institutionName: `Sixth College ${i}` } });
      assert.equal(more.status, 201, more.text);
    }
    const tooMany = await raw('POST', '/api/institution-requests', { body: { institutionName: 'Sixth College 5' } });
    assert.equal(tooMany.status, 429, tooMany.text);
    assert.ok(tooMany.headers.get('retry-after'), 'the refusal does not say when to come back');
    assert.equal(await InstitutionRequest.countDocuments({ institutionName: 'Sixth College 5' }), 0);
  });

  await t.test('a student at the college added during this run can still delete their own account', async () => {
    const gone = await student('kvut-deleting', added.emailDomains[0]);
    assert.equal(gone.profile.institution.shortName, added.shortName);

    resetRateLimits();
    const deleted = await raw('DELETE', '/api/auth/account', {
      cookie: gone.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(await Profile.countDocuments({ userId: gone.userId }), 0);
    assert.equal(await User.countDocuments({ _id: gone.userId }), 0);
    // The college outlives the student, because it was never the student's row.
    assert.ok(await Institution.findById(added.id), 'deleting a student deleted their institution');
  });

  await t.test('the eligibility rule is one query, and an address has one answer', async () => {
    // `forEmail` is the whole of who may register. A deactivated college is not in
    // the lookup's filter, it is the filter — which is why the switch above worked.
    assert.equal(String((await Institution.forEmail('anyone@mycput.ac.za'))._id), String(pilotId()));
    assert.equal(String((await Institution.forEmail('Anyone@CPUT.AC.ZA'))._id), String(pilotId()), 'an uppercase address resolves somewhere else');
    assert.equal(await Institution.forEmail('anyone@not-a-college.ac.za'), null);
    assert.equal(await Institution.forEmail('anyone@'), null);

    const switched = await Institution.findOne({ shortName: added.shortName });
    assert.equal(switched.isActive, true);
    await Institution.updateOne({ _id: switched._id }, { $set: { isActive: false } });
    const after = await Institution.forEmail(`whoever@${added.emailDomains[0]}`);
    assert.equal(after && after.shortName, null, `a deactivated college still answers for its domain, as ${after && after.shortName}`);
    await Institution.updateOne({ _id: switched._id }, { $set: { isActive: true } });
  });
});
