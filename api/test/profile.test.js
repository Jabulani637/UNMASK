'use strict';
/**
 * Stage 3 proven over real HTTP: the profile builder and the private photo.
 *
 * The rules this file exists to keep honest are FR-2.3 and FR-2.6. A photo has
 * no URL, so the assertions are that the stored filename appears nowhere in any
 * response, that a second signed-in student cannot read the first one's picture,
 * and that a file is only ever a file — not a script, not a document wearing a
 * `.jpg`. The contact guard is asserted both ways, because a rule that refuses
 * "082 123 4567" must not also refuse "my 11pm argument is aboutload shedding".
 */

const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
// One database per suite file: `node --test` runs the files in parallel, and each
// one clears its users collection, which would sign the other one out mid-run.
testUrl.pathname = '/unmask_test_profile';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-profile';
// Its own folder: this suite deletes what it writes, and it must never be
// pointed at the pictures a developer uploaded by hand.
process.env.PHOTO_DIR = './storage/test-photos';

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions, pilotId, otherId } = require('./support/institutions');
const { Types } = require('mongoose');
const User = require('../src/models/User');
const Profile = require('../src/models/Profile');
const vocab = require('../src/domain/vocabulary');
const mail = require('../src/services/mail');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');
const { png, jpeg } = require('./fixtures/images');

const PASSWORD = 'blue-koala-printing-42';
let server;
let base;
let cookie = '';

// -------------------------------------------------------------- HTTP helpers

async function call(method, route, { body, form, asClient = true } = {}) {
  const headers = {};
  if (asClient && cookie) headers.cookie = cookie;
  // FormData only: setting a content type by hand would drop the boundary.
  if (body && !form) headers['content-type'] = 'application/json';

  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const pair = setCookie.split(';')[0];
    cookie = pair.endsWith('=') ? '' : pair;
  }
  return res;
}

async function json(method, route, options = {}) {
  const res = await call(method, route, options);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* the assertion prints the raw text */
  }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

async function saveProfile(body) {
  resetRateLimits();
  return json('PUT', '/api/profile', { body });
}

async function uploadPhoto(buffer, filename = 'me.png') {
  resetRateLimits();
  const form = new FormData();
  form.append('photo', new Blob([buffer]), filename);
  return json('POST', '/api/profile/photo', { form });
}

function testEmail(local) {
  return `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@mycput.ac.za`;
}

/** Register, confirm out of band and sign in, leaving the browser on that account. */
async function signInOnly(local) {
  const email = testEmail(local);
  resetRateLimits();
  await json('POST', '/api/auth/register', { body: { email, password: PASSWORD, over18Attested: true }, asClient: true });
  await User.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
  resetRateLimits();
  const signedIn = await json('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(signedIn.status, 200, 'the account can sign in');
  return { email, id: (await User.findOne({ email }))._id };
}

/** A student with a finished profile, which is what every photo route needs first. */
async function student(local, profileBody = completeProfile()) {
  const account = await signInOnly(local);
  if (profileBody) {
    const saved = await saveProfile(profileBody);
    assert.equal(saved.status, 200, saved.text);
  }
  return account;
}

function completeProfile(over = {}) {
  return {
    // No institution: the API reads it off the verified address and has no branch
    // that would accept it from a request.
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

function photoFiles() {
  try {
    return fs.readdirSync(config.photoDir);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------- the run

test('stage 3 — the profile builder and its private photo', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but unmask_test');
  assert.ok(config.photoDir.endsWith('test-photos'), 'refusing to write into a real photos folder');

  await db.connect();
  await db.ensureIndexes();
  await seedTestInstitutions();
  await Profile.deleteMany({});

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Profile.deleteMany({});
    await User.deleteMany({});
    fs.rmSync(config.photoDir, { recursive: true, force: true });
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('a signed-out browser cannot read or write a profile', async () => {
    for (const [method, route] of [
      ['GET', '/api/profile'],
      ['PUT', '/api/profile'],
      ['GET', '/api/profile/photo'],
      ['DELETE', '/api/profile/photo'],
    ]) {
      const res = await json(method, route, { body: method === 'PUT' ? {} : undefined, asClient: false });
      assert.equal(res.status, 401, `${method} ${route} answered without a session`);
    }
  });

  await t.test('the meta endpoint states the same ceilings the routes enforce', async () => {
    const meta = await json('GET', '/api/meta', { asClient: false });
    const profileService = require('../src/services/profile');

    assert.equal(meta.json.minimums.maxInterests, profileService.MAX_INTERESTS);
    assert.equal(meta.json.minimums.promptAnswerMax, profileService.MAX_PROMPT_ANSWER);
    assert.equal(meta.json.photo.maxBytes, config.maxPhotoBytes);

    // The look-like ceilings, against the numbers `validateLook` refuses past. The
    // lists themselves are proven in institutions.test.js, which owns this contract.
    assert.equal(meta.json.minimums.maxPicks, vocab.MAX_PREF_PICKS);
    assert.equal(meta.json.minimums.typeNoteMax, profileService.MAX_TYPE_NOTE);
  });

  await t.test('a save cannot point a student at somebody else’s college', async () => {
    const account = await signInOnly('institution');

    // The request names another institution. It is not a field the API reads: the
    // answer comes from the address that was verified, or a student could become a
    // different college's student by editing a form.
    const res = await saveProfile(completeProfile({ institutionId: String(otherId()) }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.profile.institution.shortName, 'CPUT');

    const stored = await Profile.findOne({ userId: account.id });
    assert.equal(String(stored.institutionId), String(pilotId()), 'the document points at the verified college');
  });

  await t.test('a preference for a college that is not on Unmask is refused', async () => {
    const account = await signInOnly('pref-unknown');

    const res = await saveProfile(completeProfile({
      preferredInstitutions: [{ institutionId: String(new Types.ObjectId()) }],
    }));
    assert.equal(res.status, 400);
    assert.match(res.json.error, /not on Unmask/);
    assert.equal(await Profile.countDocuments({ userId: account.id }), 0, 'nothing half-written was stored');
  });

  await t.test('preferences keep the order they were given in, and the student’s own college costs no slot', async () => {
    const account = await signInOnly('pref-order');

    const saved = await saveProfile(completeProfile({
      preferredInstitutions: [{ institutionId: String(otherId()) }, { institutionId: String(pilotId()) }],
    }));
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(
      saved.json.profile.preferredInstitutions.map(entry => entry.rank),
      [1],
      'the own institution is dropped rather than spending a slot'
    );
    assert.equal(String(saved.json.profile.preferredInstitutions[0].institutionId), String(otherId()));

    const tooMany = await saveProfile(completeProfile({
      preferredInstitutions: [
        { institutionId: String(otherId()) },
        { institutionId: String(new Types.ObjectId()) },
      ],
    }));
    assert.equal(tooMany.status, 400, 'a made-up id in the list is still refused');

    const stored = await Profile.findOne({ userId: account.id });
    assert.equal(stored.preferredInstitutions.length, 1, 'a refused save left the good list alone');
  });

  await t.test('a child age is refused, because the whole product is 18+', async () => {
    await signInOnly('age');
    for (const age of [17, 31, 'twenty', null]) {
      const res = await saveProfile(completeProfile({ age }));
      assert.equal(res.status, 400, `age ${JSON.stringify(age)} was accepted`);
      assert.match(res.json.error, /whole number between 18 and 30/);
    }
  });

  await t.test('an unfinished profile saves, and says what is still needed', async () => {
    await signInOnly('unfinished');

    const first = await saveProfile(completeProfile({ interests: ['Gym'], prompts: [] }));
    assert.equal(first.status, 200, 'saving partial work must not lose it');
    assert.equal(first.json.profile.matchable, false);
    assert.equal(first.json.profile.missing.length, 2);
    assert.match(first.json.profile.missing.join(' '), /pick at least 2 interests \(you have 1\)/);
    assert.match(first.json.profile.missing.join(' '), /finish at least 1 prompt/);

    const done = await saveProfile(completeProfile({ interests: ['Gym', 'Anime'], prompts: [{ prompt: vocab.PROMPTS[1], answer: 'that a taco is a sandwich with better branding.' }] }));
    assert.equal(done.status, 200);
    assert.equal(done.json.profile.matchable, true);
    assert.deepEqual(done.json.profile.missing, []);

    const read = await json('GET', '/api/profile');
    assert.deepEqual(read.json.profile.interests, ['Gym', 'Anime']);
    assert.equal(read.json.profile.prompts.length, 1, 'an emptied prompt is a deletion, not a second answer');
  });

  await t.test('duplicate interests collapse, and a wall of them does not', async () => {
    await signInOnly('interests');

    const twice = await saveProfile(completeProfile({ interests: ['Gym', 'Gym', 'Anime'] }));
    assert.equal(twice.status, 200);
    assert.deepEqual(twice.json.profile.interests, ['Gym', 'Anime']);

    const tooMany = await saveProfile(
      completeProfile({ interests: vocab.INTERESTS.slice(0, 11) })
    );
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.error, /at most 10 interests/);
  });

  await t.test('every appearance answer is optional, and nothing on that list is a minimum', async () => {
    const account = await signInOnly('look');

    // The six basics alone still make a matchable profile, and the twelve new keys
    // arrive empty rather than absent — a screen must never render "undefined".
    const plain = await saveProfile(completeProfile());
    assert.equal(plain.status, 200, plain.text);
    assert.equal(plain.json.profile.matchable, true, 'a student who answers none of it is not grounded');
    assert.deepEqual(plain.json.profile.missing, [], 'no appearance question is on the must-answer list');
    assert.equal(plain.json.profile.bodyType, null);
    assert.deepEqual(plain.json.profile.seekBodyTypes, []);
    assert.equal(plain.json.profile.typeNote, null);

    const all = {
      identity: 'Coloured',
      bodyType: 'Athletic',
      height: '5\u2032 7\u2033 to 5\u2032 10\u2033',
      drinks: 'Socially',
      smokes: 'Don\u2019t smoke',
      gym: 'Once in a while',
      seekBodyTypes: ['Curvy', 'Athletic', 'Slender'],
      seekHeights: ['Over 5\u2032 10\u2033'],
      seekDrinks: [vocab.EITHER],
      seekSmokes: ['Socially', 'Vape'],
      seekGym: ['Nearly every day'],
      typeNote: 'someone who will walk to the taxi rank talking about the argument we just had.',
    };
    const written = await saveProfile(completeProfile(all));
    assert.equal(written.status, 200, written.text);
    for (const [field, value] of Object.entries(all)) {
      assert.deepEqual(written.json.profile[field], value, `${field} did not come back as it was sent`);
    }

    // Duplicates collapse inside a pick list, exactly as interests do, so three
    // presses of one chip is one pick and not a filled quota.
    const doubled = await saveProfile(completeProfile({ seekBodyTypes: ['Curvy', 'Curvy', 'Athletic'] }));
    assert.equal(doubled.status, 200);
    assert.deepEqual(doubled.json.profile.seekBodyTypes, ['Curvy', 'Athletic']);

    for (const [bad, label] of [
      [{ bodyType: 'Tall' }, 'body type'],
      [{ height: '6 foot 1' }, 'height'],
      [{ drinks: 'Yes' }, 'answer for drinking'],
      // "Never mind either way" is an answer about a stranger, not about yourself:
      // it is on the seek lists and refused on the self-describe ones.
      [{ drinks: vocab.EITHER }, 'answer for drinking'],
      [{ identity: 'Zombie' }, 'identity'],
    ]) {
      const res = await saveProfile(completeProfile(bad));
      assert.equal(res.status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.ok(res.json.error.includes(label), `expected "${label}" in: ${res.json.error}`);
    }

    // Three is the ceiling the request asked for, and it is a ceiling on each list
    // rather than on the whole block: six picks across two questions is fine.
    const four = await saveProfile(completeProfile({ seekHeights: vocab.HEIGHTS }));
    assert.equal(four.status, 400);
    assert.match(four.json.error, /at most 3 on the who you are after \(height\) list/);
    assert.equal(await Profile.countDocuments({ userId: account.id, seekHeights: vocab.HEIGHTS }), 0,
      'a refused pick list was written anyway');

    const twoLists = await saveProfile(
      completeProfile({ seekBodyTypes: vocab.BODY_TYPES.slice(0, 3), seekHeights: vocab.HEIGHTS.slice(0, 3) })
    );
    assert.equal(twoLists.status, 200, twoLists.text);
    assert.equal(twoLists.json.profile.seekBodyTypes.length, 3);
    assert.equal(twoLists.json.profile.seekHeights.length, 3);
  });

  await t.test('leaving an answer out keeps it, and asking to clear it clears it', async () => {
    await signInOnly('look-keep');

    const written = await saveProfile(completeProfile({ bodyType: 'Muscular', identity: 'Indian', typeNote: 'tall order, literally.' }));
    assert.equal(written.status, 200, written.text);

    /*
     * A body that does not mention the field is what an older client sends — and
     * what the six-basics part of this very form sends if it is ever split. An
     * absent key must never be read as "delete it", or one screen could wipe
     * another one's answers by saving what it happens to know about.
     */
    const silent = await saveProfile(completeProfile());
    assert.equal(silent.status, 200, silent.text);
    assert.equal(silent.json.profile.bodyType, 'Muscular', 'a save that said nothing about it removed it');
    assert.equal(silent.json.profile.identity, 'Indian');
    assert.equal(silent.json.profile.typeNote, 'tall order, literally.');

    const cleared = await saveProfile(completeProfile({ bodyType: '', identity: null, typeNote: '  ', seekBodyTypes: [] }));
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.profile.bodyType, null, 'an empty value is the student taking it back');
    assert.equal(cleared.json.profile.identity, null);
    assert.equal(cleared.json.profile.typeNote, null);
    assert.deepEqual(cleared.json.profile.seekBodyTypes, []);
  });

  await t.test('a sentence about your type is free text, with the same two guards', async () => {
    const profileService = require('../src/services/profile');
    const account = await signInOnly('note');

    for (const [note, clue] of [
      ['add me on instagram, im not really shy about it', 'another app to message on'],
      ['my number is 0821234567 if you rather text', 'a phone number'],
      ['the answer is on myphotos.example.com/thandi', 'a link'],
    ]) {
      const res = await saveProfile(completeProfile({ typeNote: note }));
      assert.equal(res.status, 400, `${JSON.stringify(note)} was saved`);
      assert.ok(res.json.error.includes(clue), `expected "${clue}" in: ${res.json.error}`);
      assert.match(res.json.error, /note about who you are after/, 'it must say which field it object to');
      assert.equal(await Profile.countDocuments({ userId: account.id }), 0, 'a refused note wrote a profile');
    }

    const long = await saveProfile(completeProfile({ typeNote: 'a'.repeat(profileService.MAX_TYPE_NOTE + 1) }));
    assert.equal(long.status, 400);
    assert.match(long.json.error, new RegExp(`to ${profileService.MAX_TYPE_NOTE} characters`));

    const honest = await saveProfile(
      completeProfile({ typeNote: 'someone who says “I\u2019m five minutes away” from the other side of campus, and means it.\n' })
    );
    assert.equal(honest.status, 200, honest.text);
    assert.ok(!honest.json.profile.typeNote.includes('\n'), 'a paragraph break in a one-line note is collapsed');
    assert.equal(honest.json.profile.typeNote, 'someone who says “I\u2019m five minutes away” from the other side of campus, and means it.');
  });

  await t.test('a prompt answer carrying a way to reach off Unmask is refused', async () => {
    const account = await signInOnly('clues');

    const dirty = [
      ['0821234567', 'a phone number'],
      ['+27 82 123 4567', 'a phone number'],
      ['082-123-4567', 'a phone number'],
      ['ping me on thandi@mycput.ac.za', 'an email address'],
      ['look up myphotos.example.com/thandi', 'a link'],
      ['I am @thandi_b everywhere', 'a social media handle'],
      ['move to whatsapp, this app is slow', 'another app to message on'],
    ];

    for (const [answer, clue] of dirty) {
      const res = await saveProfile(completeProfile({ prompts: [{ prompt: vocab.PROMPTS[0], answer } ] }));
      assert.equal(res.status, 400, `${JSON.stringify(answer)} was saved`);
      assert.ok(res.json.error.includes(clue), `expected the reason "${clue}", got: ${res.json.error}`);
      assert.equal(await Profile.countDocuments({ userId: account.id }), 0, 'a refused save wrote a profile');
    }
  });

  await t.test('…and an honest answer that mentions numbers still gets through', async () => {
    await student('clean');

    for (const answer of [
      'that stage 4 load shedding in 2020 taught everybody to cook for one.',
      'the thing I would argue about happily at 11pm is whether a hot dog is a sandwich.',
      'two years of sharing a room with four people and still being friends.',
      'that the quiet study spot is on the 3rd floor, e.g. before nine, and it is mine.',
      'whether a res house is a lifestyle. come argue with me about it.',
      'that 2018, 2019 and 2021 all taught me the same thing about a generator.',
    ]) {
      const res = await saveProfile(completeProfile({ prompts: [{ prompt: vocab.PROMPTS[0], answer }] }));
      assert.equal(res.status, 200, `refused an innocent answer: ${answer}`);
    }
  });

  await t.test('a photo is stored, readable by its owner, and unnamed to everyone else', async () => {
    const before = photoFiles().length;
    await signInOnly('no-profile');
    const tooSoon = await uploadPhoto(png());
    assert.equal(tooSoon.status, 400);
    assert.match(tooSoon.json.error, /Fill in your profile first/);
    assert.equal(photoFiles().length, before, 'a photo was written for a profile that does not exist');

    const account = await student('photo');
    const bytes = png();

    const uploaded = await uploadPhoto(bytes, 'selfie.png');
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json.profile.hasPhoto, true);

    const stored = await Profile.findOne({ userId: account.id });
    assert.match(stored.photo.fileName, /^[A-Za-z0-9_-]{8,64}\.png$/);
    assert.ok(!uploaded.text.includes(stored.photo.fileName), 'the stored filename was sent to a browser');

    const read = await call('GET', '/api/profile/photo');
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'image/png');
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.compare(Buffer.from(await read.arrayBuffer()), bytes) === 0, 'the bytes came back changed');

    const listed = await json('GET', '/api/profile');
    assert.equal(Object.prototype.hasOwnProperty.call(listed.json.profile, 'fileName'), false);
    assert.ok(!listed.text.includes(stored.photo.fileName));
  });

  await t.test('a second signed-in student cannot reach the first one’s photo', async () => {
    const before = photoFiles();
    const owner = await student('owner');
    assert.equal((await uploadPhoto(png())).status, 200);
    const ownerCookie = cookie;
    const [onDisk] = photoFiles().filter(name => !before.includes(name));
    assert.ok(onDisk, 'the owner’s photo was not written');

    await student('peeker');
    const own = await json('GET', '/api/profile/photo');
    assert.equal(own.status, 404, 'they have no photo, and must not be served someone else’s');
    assert.match(own.json.error, /have not uploaded a photo yet/);

    // No route takes an id or a filename, so every guess falls through to 404.
    for (const route of [
      `/api/profile/${owner.id}`,
      `/api/profile/photo?userId=${owner.id}`,
      `/api/profile/photo/${onDisk}`,
      `/api/profile/${owner.id}/photo`,
      `/api/profiles/${owner.id}`,
    ]) {
      const res = await json('GET', route);
      assert.equal(res.status, 404, `${route} answered at all`);
    }

    // Even the owner's own session cannot trade the photo endpoint for a read of
    // another file: the name is looked up from the database, never from the URL.
    cookie = ownerCookie;
    const row = await Profile.findOne({ userId: owner.id });
    await Profile.updateOne({ _id: row._id }, { $set: { 'photo.fileName': '../../.env' } });
    const traversal = await json('GET', '/api/profile/photo');
    assert.equal(traversal.status, 404);
    assert.match(traversal.json.error, /could not be read/);
    assert.ok(!traversal.text.includes('SESSION_SECRET'), 'a path outside the photos folder was read');
    await Profile.updateOne({ _id: row._id }, { $set: { 'photo.fileName': row.photo.fileName } });
  });

  await t.test('what is not a picture is not stored, whatever it is called', async () => {
    const before = photoFiles().length;
    await student('fakes');

    const fakes = [
      ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'attack.svg'],
      ['<html><body>hello</body></html>', 'hello.jpg'],
      [Buffer.from('%PDF-1.4'.padEnd(2048, 'a')), 'report.jpg'],
      [png(1, 1), 'dot.png'],
    ];

    for (const [body, filename] of fakes) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const res = await uploadPhoto(buffer, filename);
      assert.equal(res.status, 400, `${filename} was accepted`);
      assert.match(res.json.error, /not a photo|too small/i);
      assert.equal(photoFiles().length, before, 'a rejected upload left a file on disk');
    }
  });

  await t.test('a JPEG is welcome and a replace deletes the file it replaced', async () => {
    const before = photoFiles();
    await student('replace');

    const first = await uploadPhoto(png(), 'one.png');
    assert.equal(first.status, 200);
    const [firstName] = photoFiles().filter(name => !before.includes(name));
    assert.ok(firstName, 'the first photo was not written');

    const second = await uploadPhoto(jpeg(), 'two.jpg');
    assert.equal(second.status, 200);
    assert.equal(second.json.profile.hasPhoto, true);

    const after = photoFiles();
    assert.equal(after.length, before.length + 1, 'replacing a photo left more than one file');
    assert.ok(!after.includes(firstName), 'the old file is still on disk');

    const served = await call('GET', '/api/profile/photo');
    assert.equal(served.headers.get('content-type'), 'image/jpeg');

    const removed = await json('DELETE', '/api/profile/photo');
    assert.equal(removed.status, 200);
    assert.equal(removed.json.profile.hasPhoto, false);
    assert.equal(photoFiles().length, before.length);

    const kept = await json('GET', '/api/profile');
    assert.equal(kept.json.profile.faculty, 'Informatics & Design', 'removing the photo kept the profile');
  });

  await t.test('deleting the account takes the photo file with it', async () => {
    const before = photoFiles().length;
    const account = await student('goodbye');
    assert.equal((await uploadPhoto(png())).status, 200);
    assert.equal(photoFiles().length, before + 1);

    resetRateLimits();
    const gone = await json('DELETE', '/api/auth/account', { body: { confirmText: 'DELETE', password: PASSWORD } });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.removed.photoFile, 1);
    assert.equal(photoFiles().length, before, 'a face outlived the account that owned it');
    assert.equal(await Profile.countDocuments({ userId: account.id }), 0);
  });
});
