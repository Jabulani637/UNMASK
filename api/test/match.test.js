'use strict';
/**
 * Stage 4 proven over real HTTP: who is suggested to whom, in what order, and
 * what the screen is allowed to know about it.
 *
 * The suite is deliberately built out of *worlds of two*. Compatibility, the age
 * window and the exhaustion messages are all about who tops a list, so a test
 * that leaves three students in the database cannot tell "not shown" from "shown
 * second" — and a test that cannot tell those apart proves nothing. Most
 * subtests therefore start by emptying the profile, match and pass collections
 * and then create exactly the students that claim needs.
 *
 * The tokens are opened inside these tests with the service's own unseal(), which
 * is the only way to ask "which student was this?" of a card that deliberately
 * does not say. That is why it is exported; the assertions below are about the
 * HTTP surface, not about the cipher.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
// One database per suite file: the other suites clear their collections, and a
// shared database would empty theirs while this one is reading it.
testUrl.pathname = '/unmask_test_match';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-match';
process.env.PHOTO_DIR = './storage/test-photos';

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions, otherId } = require('./support/institutions');
const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const Profile = require('../src/models/Profile');
const Match = require('../src/models/Match');
const Pass = require('../src/models/Pass');
const vocab = require('../src/domain/vocabulary');
const matching = require('../src/services/matching');
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
  return { status: res.status, json, text, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

function email(local, domain = 'mycput.ac.za') {
  return `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}@${domain}`;
}

/**
 * A signed-in student, their profile written through the real route rather than
 * inserted, so a fixture the form would refuse cannot slip into a test.
 *
 * `domain` is the only way to put a student at a college other than the pilot one:
 * which institution a profile belongs to is decided by the verified address, so a
 * test that wants two colleges on Unmask has to register two addresses.
 */
async function student(local, over = {}, domain = 'mycput.ac.za') {
  const address = email(local, domain);
  resetRateLimits();
  await raw('POST', '/api/auth/register', { body: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });
  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);

  const account = { email: address, cookie: signedIn.cookie };
  if (over === null) return account;

  const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
  assert.equal(saved.status, 200, saved.text);
  account.userId = (await User.findOne({ email: address }))._id;
  account.profile = await Profile.findOne({ userId: account.userId });
  account.profileId = account.profile._id;
  account.institutionId = String(account.profile.institutionId);
  return account;
}

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

async function suggestion(account) {
  resetRateLimits();
  return raw('GET', '/api/matches/suggestion', { cookie: account.cookie });
}

async function pass(account, token) {
  resetRateLimits();
  return raw('POST', '/api/matches/suggestion/pass', { cookie: account.cookie, body: { token } });
}

async function connect(account, token) {
  resetRateLimits();
  return raw('POST', '/api/matches/suggestion/connect', { cookie: account.cookie, body: { token } });
}

/** Whom a card was really about — the only way a test can ask. */
function who(account, token) {
  const profileId = matching._internal.unseal(String(account.userId), token);
  assert.ok(profileId, 'the token this suite is holding should open');
  return String(profileId);
}

/** Empty the three collections a suggestion is built from, keeping the accounts. */
async function clearWorld() {
  await Profile.deleteMany({});
  await Match.deleteMany({});
  await Pass.deleteMany({});
}

// ------------------------------------------------------------------- the suite

test('stage 4 — one suggested student at a time', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');

  await db.connect();
  await db.ensureIndexes();
  await seedTestInstitutions();
  await User.deleteMany({});
  await clearWorld();

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await clearWorld();
    await User.deleteMany({});
    await db.disconnect();
  });

  await t.test('every matching route wants a signed-in browser', async () => {
    for (const [method, route] of [
      ['GET', '/api/matches/suggestion'],
    ]) {
      const res = await raw(method, route);
      assert.equal(res.status, 401, `${method} ${route} answered without a session`);
    }
    for (const route of ['/api/matches/suggestion/pass', '/api/matches/suggestion/connect']) {
      const res = await raw('POST', route, { body: { token: 'anything' } });
      assert.equal(res.status, 401, `${route} answered without a session`);
    }
  });

  await t.test('a student with no profile, or an unfinished one, is shown nobody', async () => {
    await clearWorld();
    const bare = await student('noprofile', null);

    const missingAll = await suggestion(bare);
    assert.equal(missingAll.status, 428);
    assert.equal(missingAll.json.code, 'profile_incomplete');

    resetRateLimits();
    const halfWritten = await raw('PUT', '/api/profile', {
      cookie: bare.cookie,
      body: finished({ interests: ['Gym'], prompts: [] }),
    });
    assert.equal(halfWritten.status, 200, 'an unfinished profile still saves');

    const refused = await suggestion(bare);
    assert.equal(refused.status, 428);
    assert.match(refused.json.error, /not ready to match yet/);
    assert.match(refused.json.error, /pick at least 2 interests/, 'it must name what is still needed');
    assert.match(refused.json.error, /finish at least 1 prompt/);
  });

  await t.test('the card carries what the design shows and nothing that names anyone', async () => {
    await clearWorld();
    const viewer = await student('card-viewer', { gender: 'Woman', lookingFor: 'Men', age: 20, interests: ['Gym', 'Amapiano'] });
    const seen = await student('card-seen', {
      gender: 'Man',
      lookingFor: 'Women',
      age: 22,
      faculty: 'Engineering',
      year: '3rd year',
      interests: ['Gym', 'Football'],
      prompts: [{ prompt: vocab.PROMPTS[1], answer: 'that the queue for the printer is a study of human nature.' }],
    });

    // A photo that exists on the candidate's row, under a name this test can
    // look for: FR-2.3 says no form of it reaches a match.
    await Profile.updateOne(
      { _id: seen.profileId },
      { $set: { 'photo.fileName': 'do-not-leak-this-name.jpg', 'photo.bytes': 2048, 'photo.uploadedAt': new Date() } }
    );

    const res = await suggestion(viewer);
    assert.equal(res.status, 200, res.text);
    const card = res.json.suggestion;

    assert.deepEqual(Object.keys(card).sort(), ['after', 'faculty', 'institution', 'look', 'prompt', 'score', 'sharedInterests', 'token', 'year']);
    assert.equal(card.year, '3rd year');
    assert.equal(card.faculty, 'Engineering');
    // The short name, never the id: a card is allowed to say which college this
    // is and is not allowed to say which document.
    assert.equal(card.institution, 'CPUT');
    assert.deepEqual(card.sharedInterests, ['Gym']);
    assert.equal(card.prompt.answer, 'that the queue for the printer is a study of human nature.');
    // One shared interest out of two is half of the 60-point interest weight,
    // two years apart takes a third off the 20-point age weight, the viewer named
    // no preferences so the institution tier pays nothing, and both students study
    // in Cape Town, which is worth 6. A literal, so moving a weight fails this test.
    assert.equal(card.score, 49);

    // The things that would name a person, or narrow a small class to one body.
    for (const forbidden of [
      seen.email,
      String(seen.userId),
      String(seen.profileId),
      seen.institutionId,
      'do-not-leak-this-name',
      'photo',
      String(seen.profile.age),
      seen.profile.gender,
      'Man',
    ]) {
      assert.ok(!res.text.includes(forbidden), `the answer mentions ${forbidden}`);
    }
    assert.ok(Array.isArray(res.json.suggestion.sharedInterests) && res.json.suggestion.sharedInterests.length === 1);
    assert.ok(!('interests' in card), 'their full interest list would be a fingerprint');

    /*
     * Neither of these two students answered a single appearance question, which
     * is the shape most real profiles will have on day one. So the two new blocks
     * must arrive *empty* — not `undefined`, not a wall of "Prefer not to say",
     * and above all not a guess at anybody's body or colour.
     */
    assert.deepEqual(card.look, { bodyType: null, height: null, drinks: null, smokes: null, gym: null });
    assert.deepEqual(card.after, { bodyTypes: [], heights: [], drinks: [], smokes: [], gym: [], note: null });
    for (const word of ['identity', 'seekIdentity', ...vocab.IDENTITY]) {
      assert.ok(!res.text.includes(word), `the anonymous card mentions ${word}`);
    }
  });

  await t.test('compatibility has to run in both directions', async () => {
    await clearWorld();
    // A woman looking for men, and a woman looking for women: each is what the
    // other is not asking for, so neither is shown.
    const first = await student('both-ways-a', { gender: 'Woman', lookingFor: 'Men' });
    const second = await student('both-ways-b', { gender: 'Woman', lookingFor: 'Women' });

    for (const viewer of [first, second]) {
      const res = await suggestion(viewer);
      assert.equal(res.status, 200);
      assert.equal(res.json.suggestion, null, 'a one-way preference is not a match');
      assert.equal(res.json.exhausted, true);
      assert.match(res.json.message, /Nobody else fits/);
    }
  });

  await t.test('a non-binary student is suggested only to someone looking for everyone', async () => {
    await clearWorld();
    const nonBinary = await student('nb', { gender: 'Non-binary', lookingFor: 'Everyone', age: 21 });
    const onlyWomen = await student('men-only', { gender: 'Man', lookingFor: 'Women', age: 21 });
    const everySeeker = await student('all-seeker', { gender: 'Woman', lookingFor: 'Everyone', age: 21 });

    /**
     * Everyone this viewer is actually offered, walked to the end of the pool by
     * passing each card. An empty answer is meaningful here: this is the only way
     * to tell "never shown" apart from "shown later in the list".
     */
    async function poolOf(account) {
      const ids = [];
      for (let step = 0; step < 10; step += 1) {
        const res = await suggestion(account);
        assert.equal(res.status, 200, res.text);
        if (!res.json.suggestion) return ids;
        ids.push(who(account, res.json.suggestion.token));
        await pass(account, res.json.suggestion.token);
      }
      throw new Error('the pool never ran out');
    }

    // The three of them form two compatible pairs, so nobody's pool is empty for
    // an unrelated reason — the assertion below is about which face is missing.
    assert.deepEqual(await poolOf(onlyWomen), [String(everySeeker.profileId)],
      'a man looking only for women is shown a non-binary student');
    assert.deepEqual(await poolOf(nonBinary), [String(everySeeker.profileId)],
      'and the same holds back: nobody is guessed into a box to fill a preference');

    const soughtByAll = await poolOf(everySeeker);
    assert.deepEqual(soughtByAll.sort(), [String(nonBinary.profileId), String(onlyWomen.profileId)].sort());
    assert.ok(soughtByAll.includes(String(nonBinary.profileId)), 'looking for everyone does include this student');
  });

  await t.test('the age window is five years, and it stops there', async () => {
    await clearWorld();
    const a = await student('window-a', { age: 20 });
    const b = await student('window-b', { gender: 'Man', lookingFor: 'Women', age: 25 });
    const shown = await suggestion(a);
    assert.ok(shown.json.suggestion, 'five years apart is inside the window');
    assert.equal(who(a, shown.json.suggestion.token), String(b.profileId));

    await clearWorld();
    const c = await student('window-c', { age: 20 });
    await student('window-d', { gender: 'Man', lookingFor: 'Women', age: 26 });
    const none = await suggestion(c);
    assert.equal(none.json.suggestion, null, 'six years apart is outside it');

    // Read out of the service rather than counted off a card, so the number in
    // this test is the number the routes use.
    assert.equal(matching._internal.MAX_AGE_GAP, 5);
  });

  await t.test('an unfinished profile is never suggested to anyone else', async () => {
    await clearWorld();
    const viewer = await student('pool-viewer', { gender: 'Woman', lookingFor: 'Men' });
    // One interest and no prompt: saved, real, and not yet worth suggesting.
    const shallow = await student('pool-shallow', { gender: 'Man', lookingFor: 'Women', interests: ['Gym'], prompts: [] });

    const res = await suggestion(viewer);
    assert.equal(res.json.suggestion, null);
    const stored = await Profile.findById(shallow.profileId);
    assert.ok(stored, 'the shallow profile is really saved');
    assert.equal(stored.isMatchable(), false, 'and the model agrees it is not ready to be matched');
  });

  await t.test('a decline moves to the next-best and does not come back', async () => {
    await clearWorld();
    const viewer = await student('pass-viewer', { gender: 'Woman', lookingFor: 'Everyone', age: 21 });
    const one = await student('pass-one', { gender: 'Man', lookingFor: 'Everyone', age: 21 });
    const two = await student('pass-two', { gender: 'Non-binary', lookingFor: 'Everyone', age: 21 });

    const first = await suggestion(viewer);
    const firstId = who(viewer, first.json.suggestion.token);

    const second = await pass(viewer, first.json.suggestion.token);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.passed, true);
    const secondId = who(viewer, second.json.suggestion.token);
    assert.notEqual(secondId, firstId, 'passing must move you on');

    const third = await pass(viewer, second.json.suggestion.token);
    assert.equal(third.json.suggestion, null, 'there were two of them');
    assert.equal(third.json.exhausted, true);

    // The same decline, spent twice, is still one row.
    const again = await pass(viewer, first.json.suggestion.token);
    assert.equal(again.status, 200, again.text);
    assert.equal(await Pass.countDocuments({ userId: viewer.userId }), 2);

    // What a 30-day TTL does when it fires: the person returns to the pool.
    await Pass.deleteMany({});
    const revived = await suggestion(viewer);
    assert.ok(revived.json.suggestion);
    assert.ok([String(one.profileId), String(two.profileId)].includes(who(viewer, revived.json.suggestion.token)));
  });

  await t.test('more in common is scored higher, in the same order every time', async () => {
    await clearWorld();
    const viewer = await student('score-viewer', {
      gender: 'Woman',
      lookingFor: 'Men',
      age: 20,
      interests: ['Gym', 'Amapiano', 'Photography', 'Braai culture', 'Gaming'],
    });
    const little = await student('score-little', {
      gender: 'Man',
      lookingFor: 'Women',
      age: 20,
      faculty: 'Education',
      year: '1st year',
      interests: ['Gym', 'Netball', 'Football'],
      prompts: [{ prompt: vocab.PROMPTS[1], answer: 'that a 9am lecture is a decision, not a time.' }],
    });
    const much = await student('score-much', {
      gender: 'Man',
      lookingFor: 'Women',
      age: 20,
      interests: ['Gym', 'Amapiano', 'Photography', 'Braai culture', 'Taxi stories'],
      prompts: [{ prompt: vocab.PROMPTS[0], answer: 'that sharing a lift home is half of what makes a campus feel small.' }],
    });

    const top = await suggestion(viewer);
    assert.equal(who(viewer, top.json.suggestion.token), String(much.profileId), 'the bigger overlap comes first');
    assert.ok(top.json.suggestion.score > 50);
    assert.deepEqual(top.json.suggestion.sharedInterests, ['Gym', 'Amapiano', 'Photography', 'Braai culture']);
    assert.equal(top.json.waiting, 2);

    const next = await pass(viewer, top.json.suggestion.token);
    assert.equal(who(viewer, next.json.suggestion.token), String(little.profileId));
    assert.ok(next.json.suggestion.score < top.json.suggestion.score);

    // Deterministic: with the world unchanged, asking twice cannot disagree.
    await Pass.deleteMany({});
    const repeat1 = await suggestion(viewer);
    const repeat2 = await suggestion(viewer);
    assert.equal(who(viewer, repeat1.json.suggestion.token), who(viewer, repeat2.json.suggestion.token));
    assert.equal(repeat1.json.suggestion.score, repeat2.json.suggestion.score);
  });

  await t.test('a named preference is worth its rank, and nothing else about the two cards differs', async () => {
    await clearWorld();
    // Every other input is identical between the two candidates: same age, the
    // same three interests of which the viewer shares two, and the same city as
    // the viewer. The only thing that can move the score is the preference tier.
    const sharedInterests = ['Gym', 'Amapiano', 'Football'];
    const viewer = await student('rank-viewer', {
      gender: 'Woman',
      lookingFor: 'Men',
      age: 20,
      interests: ['Gym', 'Amapiano', 'Photography'],
      preferredInstitutions: [{ institutionId: String(otherId()) }],
    });
    const atHome = await student('rank-home', { gender: 'Man', lookingFor: 'Women', age: 20, interests: sharedInterests });
    const atChoice = await student('rank-choice', { gender: 'Man', lookingFor: 'Women', age: 20, interests: sharedInterests }, 'pentechn.ac.za');

    const top = await suggestion(viewer);
    assert.equal(who(viewer, top.json.suggestion.token), String(atChoice.profileId), 'the college the student named comes first');
    const next = await pass(viewer, top.json.suggestion.token);
    assert.equal(who(viewer, next.json.suggestion.token), String(atHome.profileId));

    // Two shared of three is 40 interest points, the same age is the whole 20, and
    // both colleges are in Cape Town, so both cards carry the same 6. The 14 on top
    // of the first one is a first preference, and it is the whole difference.
    assert.equal(top.json.suggestion.score, 80);
    assert.equal(next.json.suggestion.score, 66);
  });

  await t.test('a pick that fits lifts the card, and a pick that misses loses nothing', async () => {
    await clearWorld();
    /*
     * The two candidates are identical in every field the engine has always read:
     * same age, same college, same three interests. The only difference in the
     * world is that one of them is the body type this viewer asked for. So any
     * gap between the two scores *is* the nudge, and nothing else.
     */
    const sharedInterests = ['Gym', 'Amapiano', 'Football'];
    const viewer = await student('nudge-viewer', {
      gender: 'Woman',
      lookingFor: 'Men',
      age: 20,
      interests: ['Gym', 'Amapiano', 'Photography'],
      seekBodyTypes: ['Athletic'],
      seekGym: ['A few times a week'],
    });
    const fits = await student('nudge-fits', {
      gender: 'Man',
      lookingFor: 'Women',
      age: 20,
      interests: sharedInterests,
      bodyType: 'Athletic',
      gym: 'A few times a week',
      seekHeights: ['5\u2032 7\u2033 to 5\u2032 10\u2033'],
      typeNote: 'someone who laughs at their own jokes before finishing them.',
    });
    const misses = await student('nudge-misses', {
      gender: 'Man',
      lookingFor: 'Women',
      age: 20,
      interests: sharedInterests,
      bodyType: 'Chubby',
    });

    const top = await suggestion(viewer);
    assert.equal(who(viewer, top.json.suggestion.token), String(fits.profileId), 'the card that fits the ask comes first');
    const next = await pass(viewer, top.json.suggestion.token);
    assert.equal(who(viewer, next.json.suggestion.token), String(misses.profileId), 'and the one that does not is still shown');

    // 40 interest points, the full 20 for the same age, 6 for one city: both cards
    // sit on 66. The lift on the first is 3 for the body type and 1 for the gym,
    // which is the entire difference, and it is a lift — not a re-sort of the pool.
    assert.equal(top.json.suggestion.score, 70);
    assert.equal(next.json.suggestion.score, 66);
    assert.equal(
      top.json.suggestion.score - next.json.suggestion.score,
      matching._internal.LOOK_WEIGHTS.bodyType + matching._internal.LOOK_WEIGHTS.lifestyle
    );

    // What the other person is, and what they are after, in their own words.
    assert.equal(top.json.suggestion.look.bodyType, 'Athletic');
    assert.equal(top.json.suggestion.look.gym, 'A few times a week');
    assert.equal(top.json.suggestion.look.height, null, 'a question left unanswered is not answered for them');
    assert.deepEqual(top.json.suggestion.after.heights, ['5\u2032 7\u2033 to 5\u2032 10\u2033']);
    assert.equal(top.json.suggestion.after.note, 'someone who laughs at their own jokes before finishing them.');
    assert.equal(next.json.suggestion.look.bodyType, 'Chubby', 'the card does not hide the one who did not fit');

    /*
     * The two neutral cases, measured on the function itself: a viewer who named
     * nothing pays nothing on every card, and a candidate who answered nothing is
     * neither punished nor guessed at. Both are the difference between a nudge and
     * a filter, and neither can be seen from the two scores above.
     */
    const base = { bodyType: 'Athletic', gym: 'A few times a week' };
    assert.equal(matching._internal.lookPoints({ seekBodyTypes: [], seekGym: [] }, base), 0, 'saying nothing costs you nobody');
    assert.equal(matching._internal.lookPoints({ seekBodyTypes: ['Athletic'], seekGym: ['Nearly every day'] }, {}), 0,
      'a student who left the field blank is not scored down for it');
    assert.equal(matching._internal.lookPoints({ seekBodyTypes: ['Athletic'] }, { bodyType: 'Chubby' }), 0,
      'the only arithmetic available to a miss is zero, never a minus');
  });

  await t.test('a race is something you say about yourself, and the ranking cannot hear it', async () => {
    await clearWorld();
    // Three students who differ from each other in nothing but the identity line.
    // If the engine could read that field these three would separate; the whole
    // describe-only decision is that they must not.
    const sharedInterests = ['Gym', 'Amapiano', 'Football'];
    const viewer = await student('identity-viewer', {
      gender: 'Woman',
      lookingFor: 'Men',
      age: 20,
      interests: sharedInterests,
      identity: 'Coloured',
    });
    const black = await student('identity-a', { gender: 'Man', lookingFor: 'Women', age: 20, interests: sharedInterests, identity: 'Black' });
    const white = await student('identity-b', { gender: 'Man', lookingFor: 'Women', age: 20, interests: sharedInterests, identity: 'White' });
    const silent = await student('identity-c', { gender: 'Man', lookingFor: 'Women', age: 20, interests: sharedInterests });

    const cards = new Map();
    for (let step = 0; step < 3; step += 1) {
      const res = await suggestion(viewer);
      assert.ok(res.json.suggestion, res.text);
      cards.set(who(viewer, res.json.suggestion.token), res.json.suggestion);
      await pass(viewer, res.json.suggestion.token);
    }
    assert.deepEqual([...cards.keys()].sort(), [String(black.profileId), String(white.profileId), String(silent.profileId)].sort());
    const scores = [...cards.values()].map(card => card.score);
    assert.equal(new Set(scores).size, 1, `identity split three identical students: ${scores.join(', ')}`);

    // The line the last assertion rests on, read off the projection rather than
    // off a score: the scorer is never *given* the field, so no future weight can
    // accidentally start using it.
    assert.ok(!('identity' in matching._internal.READ_FIELDS), 'the matching projection must not carry identity');
    for (const card of cards) {
      for (const word of ['identity', ...vocab.IDENTITY]) {
        assert.ok(!JSON.stringify(card).includes(word), `an anonymous card mentions ${word}`);
      }
    }
  });

  await t.test('a college added while the server was already running is scored on its own city', async () => {
    await clearWorld();
    // No restart, no new code: this row is written here and is a college the
    // product has never heard of, which is what the second seeded one is not —
    // both of those are in Cape Town, so neither of them can show the city tier.
    const distant = await Institution.create({
      name: 'Quettys Valley Polytechnic',
      shortName: 'COVEXT',
      type: 'university',
      city: 'Bloemfontein',
      emailDomains: ['covext.ac.za'],
      faculties: [],
    });

    const viewer = await student('city-viewer', {
      gender: 'Woman',
      lookingFor: 'Men',
      age: 20,
      interests: ['Gym', 'Amapiano', 'Photography'],
    });
    const nearby = await student('city-nearby', { gender: 'Man', lookingFor: 'Women', age: 20, interests: ['Gym', 'Amapiano', 'Football'] });
    const far = await student('city-far', { gender: 'Man', lookingFor: 'Women', age: 20, interests: ['Gym', 'Amapiano', 'Football'] }, 'covext.ac.za');

    // The new college's students can register and be matched, and the card says
    // which college it is by the name staff typed — not by anything hard-coded.
    const first = await suggestion(viewer);
    assert.equal(first.json.waiting, 2);
    const seen = { [who(viewer, first.json.suggestion.token)]: first.json.suggestion };
    const second = await pass(viewer, first.json.suggestion.token);
    seen[who(viewer, second.json.suggestion.token)] = second.json.suggestion;

    assert.equal(seen[String(nearby.profileId)].institution, 'CPUT');
    assert.equal(seen[String(far.profileId)].institution, 'COVEXT');
    // Identical students, six points apart, and the only difference is the city
    // their colleges sit in.
    assert.equal(seen[String(nearby.profileId)].score - seen[String(far.profileId)].score, 6);

    await Institution.deleteOne({ _id: distant._id });
  });

  await t.test('connecting makes one pair and stops suggesting each other', async () => {
    await clearWorld();
    const a = await student('pair-a', { gender: 'Woman', lookingFor: 'Men' });
    const b = await student('pair-b', { gender: 'Man', lookingFor: 'Women' });

    const first = await suggestion(a);
    const made = await connect(a, first.json.suggestion.token);
    assert.equal(made.status, 201, made.text);
    assert.match(made.json.message, /chat is open/);

    const rows = await Match.find({});
    assert.equal(rows.length, 1, 'one pair, not one row per viewer');
    assert.deepEqual(rows[0].users.map(String).sort(), [String(a.userId), String(b.userId)].sort());
    assert.equal(String(rows[0].openedBy), String(a.userId));

    // FR-3.4, both ends of it.
    const aAgain = await suggestion(a);
    assert.equal(aAgain.json.suggestion, null, 'you cannot be shown someone you have connected with');
    const bAgain = await suggestion(b);
    assert.equal(bAgain.json.suggestion, null, 'nor they you');

    const listA = await raw('GET', '/api/chats', { cookie: a.cookie });
    const listB = await raw('GET', '/api/chats', { cookie: b.cookie });
    assert.equal(listA.json.count, 1, listA.text);
    assert.equal(listB.json.count, 1, listB.text);
    assert.equal(listA.json.threads[0].id, listB.json.threads[0].id, 'the same thread, seen from both sides');
    assert.ok(!listA.text.includes(String(b.userId)) && !listA.text.includes(String(b.profileId)));
  });

  await t.test('pressing start chatting twice does not make two matches', async () => {
    await clearWorld();
    const a = await student('twice-a', { gender: 'Woman', lookingFor: 'Men' });
    const b = await student('twice-b', { gender: 'Man', lookingFor: 'Women' });

    const token = (await suggestion(a)).json.suggestion.token;
    assert.equal((await connect(a, token)).status, 201);
    const second = await connect(a, token);
    assert.equal(second.status, 200, 'the pair already exists, and that is not an error');
    assert.match(second.json.message, /already connected/);
    assert.equal(await Match.countDocuments({}), 1);
  });

  await t.test('a token opens a card for the student it was sealed for, and nobody else', async () => {
    await clearWorld();
    const owner = await student('token-owner', { gender: 'Woman', lookingFor: 'Everyone' });
    const subject = await student('token-subject', { gender: 'Man', lookingFor: 'Everyone' });
    const thief = await student('token-thief', { gender: 'Non-binary', lookingFor: 'Everyone' });

    const issued = (await suggestion(owner)).json.suggestion.token;
    assert.equal(who(owner, issued), String(subject.profileId));
    assert.ok(!issued.includes(String(subject.profileId)), 'the card must not carry a profile id in the clear');

    // Stolen whole.
    const stolen = await connect(thief, issued);
    assert.equal(stolen.status, 409);
    assert.equal(stolen.json.code, 'stale_suggestion');
    assert.equal(await Match.countDocuments({}), 0, 'and it made nothing');

    // Edited: a different profile id inside the same envelope.
    const [, iv, cipher, tag] = issued.split('.');
    const forged = ['sugg1', iv, Buffer.from(Buffer.from(cipher, 'base64url').map(byte => byte ^ 0x01)).toString('base64url'), tag].join('.');
    assert.notEqual(forged, issued);
    assert.equal((await connect(owner, forged)).status, 409);
    assert.equal((await pass(owner, forged)).status, 409);

    // Made up entirely, and an empty one.
    assert.equal((await pass(owner, 'sugg1.aaa.bbb.ccc')).status, 409);
    assert.equal((await connect(owner, undefined)).status, 400);
    assert.equal((await pass(owner, '')).status, 409);

    // The owner can still spend the real one.
    const spent = await connect(owner, issued);
    assert.equal(spent.status, 201, spent.text);
  });

  await t.test('editing your profile changes who you are shown, with nothing to invalidate', async () => {
    await clearWorld();
    const viewer = await student('refresh-viewer', { gender: 'Woman', lookingFor: 'Men', age: 20 });
    const man = await student('refresh-man', { gender: 'Man', lookingFor: 'Women', age: 21 });
    const woman = await student('refresh-woman', { gender: 'Woman', lookingFor: 'Women', age: 21 });

    const before = who(viewer, (await suggestion(viewer)).json.suggestion.token);
    assert.equal(before, String(man.profileId));

    // She now says she is looking for women: the next answer must change without
    // any cache being cleared, because there is no cache.
    resetRateLimits();
    const edited = await raw('PUT', '/api/profile', { cookie: viewer.cookie, body: finished({ gender: 'Woman', lookingFor: 'Women', age: 20 }) });
    assert.equal(edited.status, 200, edited.text);

    const after = who(viewer, (await suggestion(viewer)).json.suggestion.token);
    assert.equal(after, String(woman.profileId));
  });

  await t.test('a student is never the suggestion of their own account', async () => {
    await clearWorld();
    const only = await student('alone', {});
    const res = await suggestion(only);
    assert.equal(res.status, 200);
    assert.equal(res.json.suggestion, null);
    assert.equal(res.json.exhausted, true);
  });

  await t.test('deleting an account takes its pair and its declines with it', async () => {
    await clearWorld();
    const a = await student('gone-a', { gender: 'Woman', lookingFor: 'Everyone' });
    const b = await student('gone-b', { gender: 'Man', lookingFor: 'Everyone' });
    const c = await student('gone-c', { gender: 'Non-binary', lookingFor: 'Everyone' });

    const firstToken = (await suggestion(a)).json.suggestion.token;
    const firstId = who(a, firstToken);
    await pass(a, firstToken);
    assert.equal((await connect(a, (await suggestion(a)).json.suggestion.token)).status, 201);

    assert.equal(await Match.countDocuments({}), 1);
    assert.equal(await Pass.countDocuments({ userId: a.userId }), 1);

    resetRateLimits();
    const deleted = await raw('DELETE', '/api/auth/account', {
      cookie: a.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.removed.matches, 1, 'the pair is not left with a ghost in it');
    assert.equal(deleted.json.removed.passes, 1);

    assert.equal(await Match.countDocuments({}), 0);
    // b was declined by the deleted account; that row named a profile that no
    // longer exists, so it goes too.
    assert.equal(await Pass.countDocuments({}), 0);
    assert.ok([String(b.profileId), String(c.profileId)].includes(firstId));

    // Whoever is left cannot be shown a profile that has been deleted.
    const survivors = await Promise.all([suggestion(b), suggestion(c)]);
    for (const res of survivors) {
      assert.equal(res.status, 200);
      if (res.json.suggestion) {
        assert.ok(!res.text.includes(String(a.profileId)));
      }
    }
  });
});
