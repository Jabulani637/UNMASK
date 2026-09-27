'use strict';
/**
 * Stage 9b — POPIA's right of access, and the one list it has to share with
 * deletion. NFR-3.1, NFR-3.2, and the promises in FR-2.6/FR-6.2/FR-6.3 that an
 * export must not quietly break.
 *
 * Four claims carry this file:
 *
 *   - **The file is the whole record.** Every collection `User.dataCollections`
 *     names is counted through `services/personal-data.js`, and each count is
 *     compared with what the export lists for it — then with what the deletion of
 *     that same account reports having taken, moments later. An export covering
 *     seven of eight collections is the failure this exists to catch: it would tell
 *     a student they had everything while a row was still in the database.
 *   - **The door is not free.** No session answers 401; a wrong password answers
 *     403 and releases nothing, because a document holding an address, a photo
 *     record and every message is exactly what a warm cookie on a shared laptop
 *     must not be able to download.
 *   - **Everybody else stays anonymous.** The peer in a thread, the student who
 *     filed a report against this account, and the account that blocked it are each
 *     named by *nobody*. The test asserts their email addresses and their raw
 *     24-character ids are absent from the bytes — not merely that the labels look
 *     friendly, since an id is anonymous only until somebody pastes it somewhere.
 *   - **Redaction is stated, not silent.** Where the file lists less than the
 *     database holds — the blocks made *against* this account, which FR-6.2 exists
 *     to keep invisible — the document says so in words, and the two counts are
 *     checked to differ by exactly the number of those rows and nothing else.
 *
 * Most rows are built through the same routes a browser uses. Four are written
 * with their models, and each says why at the line: the write paths for a block,
 * a report about a stranger and a staff decision belong to stage 7b, which proves
 * them there. This file needs those rows to exist in order to read one account's
 * record back.
 *
 * Its own database, photos folder and outbox, because `node --test` runs the
 * suites side by side.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
testUrl.pathname = '/unmask_test_access';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-access';
process.env.PHOTO_DIR = './storage/test-photos-access';

const mongoose = require('mongoose');

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions } = require('./support/institutions');
const User = require('../src/models/User');
const Profile = require('../src/models/Profile');
const Match = require('../src/models/Match');
const Message = require('../src/models/Message');
const Pass = require('../src/models/Pass');
const Block = require('../src/models/Block');
const Report = require('../src/models/Report');
const AuditEvent = require('../src/models/AuditEvent');
const Notification = require('../src/models/Notification');
const vocab = require('../src/domain/vocabulary');
const chat = require('../src/services/chat');
const reports = require('../src/services/reports');
const personalData = require('../src/services/personal-data');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');
const { png } = require('./fixtures/images');

const PASSWORD = 'blue-koala-printing-42';
const PNG = png();
const REASON = vocab.REPORT_REASONS[0];
const NOT_A_STUDENT = vocab.REPORT_REASONS[4];

let server;
let base;

// ---------------------------------------------------------------- HTTP helpers

async function raw(method, route, { body, form, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body && !form) headers['content-type'] = 'application/json';

  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  const setCookie = res.headers.get('set-cookie');
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
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
    bytes,
    headers: res.headers,
    cookie: setCookie ? setCookie.split(';')[0] : cookie,
  };
}

function email(local) {
  return `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}@mycput.ac.za`;
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

async function student(local, over = {}) {
  const address = email(local);
  resetRateLimits();
  await raw('POST', '/api/auth/register', { body: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });
  if (over.admin) await User.updateOne({ email: address }, { $set: { role: 'admin' } });

  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);
  const account = { email: address, cookie: signedIn.cookie };

  if (!over.noProfile) {
    const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
    assert.equal(saved.status, 200, saved.text);
  }
  const row = await User.findOne({ email: address });
  account.userId = row._id;
  account.id = String(row._id);
  return account;
}

function suggestionOf(account) {
  resetRateLimits();
  return raw('GET', '/api/matches/suggestion', { cookie: account.cookie });
}
function connectWith(account, token) {
  resetRateLimits();
  return raw('POST', '/api/matches/suggestion/connect', { cookie: account.cookie, body: { token } });
}
function send(account, id, body) {
  resetRateLimits();
  return raw('POST', `/api/chats/${id}/messages`, { cookie: account.cookie, body: { body } });
}
function uploadPhoto(account) {
  resetRateLimits();
  const form = new FormData();
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'face.png');
  return raw('POST', '/api/profile/photo', { cookie: account.cookie, form });
}
function exportData(password, account) {
  resetRateLimits();
  return raw('POST', '/api/auth/export', { cookie: account.cookie, body: { password } });
}

async function clearWorld() {
  await Profile.deleteMany({});
  await Match.deleteMany({});
  await Message.deleteMany({});
  await Pass.deleteMany({});
  await Block.deleteMany({});
  await Report.deleteMany({});
  await AuditEvent.deleteMany({});
  await Notification.deleteMany({});
  chat._internal.resetBudget();
  reports._internal.resetBudget();
}

// -------------------------------------------------------------- the one world

/**
 * An account with at least one row in every collection, and four other people in it.
 *
 * `a` asks for their data. `b` is the peer they actually talked to. `c` is somebody
 * `a` blocked and passed on. `d` is somebody who blocked `a`, reported `a`, and
 * passed on `a` — the half of the record this file has to prove stays out of it.
 */
async function buildWorld() {
  await clearWorld();
  const a = await student('access-a', { gender: 'Woman', lookingFor: 'Men', age: 20 });
  const b = await student('access-b', { gender: 'Man', lookingFor: 'Women', age: 21 });
  const c = await student('access-c', { gender: 'Man', lookingFor: 'Women', age: 22 });
  const d = await student('access-d', { gender: 'Man', lookingFor: 'Women', age: 23 });
  const staff = await student('access-staff', { admin: true, noProfile: true });

  // A photo, because it is the one piece of this record that is a file, not a row.
  const photo = await uploadPhoto(a);
  assert.equal(photo.status, 200, photo.text);
  const mine = await Profile.findOne({ userId: a.userId });
  assert.ok(mine.photo && mine.photo.fileName, 'the upload stored no filename to look for');
  const fileName = mine.photo.fileName;

  // A thread with words both ways, and a reveal that one of them asked for.
  const first = await suggestionOf(a);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.suggestion, 'a was never shown b, so nothing below can mean anything');
  const made = await connectWith(a, first.json.suggestion.token);
  assert.equal(made.status, 201, made.text);
  const threadId = made.json.match.id;

  const written = await send(a, threadId, 'The generator plan was a joke, in case that was unclear.');
  assert.equal(written.status, 201, written.text);
  const replied = await send(b, threadId, 'It was unclear. Also you have ugly handwriting.');
  assert.equal(replied.status, 201, replied.text);
  // A reveal is a decision about a conversation, so the door wants three of this
  // student's own words in it first.
  const second = await send(a, threadId, 'Fine. Yours is worse. What faculty?');
  assert.equal(second.status, 201, second.text);
  const third = await send(a, threadId, 'Informatics. You?');
  assert.equal(third.status, 201, third.text);

  resetRateLimits();
  const asked = await raw('POST', `/api/reveals/${threadId}/ask`, { cookie: a.cookie });
  assert.equal(asked.status, 200, asked.text);

  // a's own report, through the door a student uses.
  reports._internal.resetBudget();
  resetRateLimits();
  const filed = await raw('POST', '/api/safety/reports', {
    cookie: a.cookie,
    body: { kind: 'message', messageId: replied.json.message.id, reason: REASON, detail: 'quoted me to someone else' },
  });
  assert.equal(filed.status, 201, filed.text);

  // The three rows whose write paths stage 7b proves elsewhere, planted so this
  // account has something on every side of them.
  const aboutA = await Report.create({
    reporterId: d.userId,
    reportedUserId: a.userId,
    kind: 'profile',
    reason: NOT_A_STUDENT,
    detail: 'I do not think this is a student here.',
    status: 'actioned',
    decision: 'dismissed',
    decisionNote: 'Checked the faculty list. This account is on it.',
    decidedBy: staff.userId,
    decidedAt: new Date(),
  });
  await Block.create({ userId: d.userId, blockedUserId: a.userId });
  await Block.create({ userId: a.userId, blockedUserId: c.userId });
  await AuditEvent.create({
    actorId: staff.userId,
    action: 'report.decided',
    subjectId: a.userId,
    targetType: 'report',
    targetId: aboutA._id,
    note: 'dismissed',
    data: { action: 'dismissed', kind: 'profile' },
  });

  // One pass each way: a declined a suggestion, and a suggestion declined a.
  const cProfile = await Profile.findOne({ userId: c.userId });
  assert.ok(cProfile, 'c has no profile to be passed on');
  await Pass.create({ userId: a.userId, profileId: cProfile._id, until: new Date(Date.now() + 86400000) });
  await Pass.create({ userId: d.userId, profileId: mine._id, until: new Date(Date.now() + 86400000) });

  return { a, b, c, d, staff, threadId, fileName, peerMessageId: String(replied.json.message.id) };
}

/** What the database holds for one account, read through the same filters the
 *  export and the deletion both use. */
async function heldFor(userId) {
  const dbh = mongoose.connection;
  const { filters } = await personalData.ownData([userId]);
  const held = {};
  for (const name of User.dataCollections) held[name] = await dbh.collection(name).countDocuments(filters[name]);
  return held;
}

// ------------------------------------------------------------------- the suite

test('stage 9b — the right of access, and the deletion it has to agree with', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');
  assert.ok(config.photoDir.endsWith('test-photos-access'), 'refusing to write into a real photos folder');

  await db.connect();
  await db.ensureIndexes();
  await seedTestInstitutions();
  await User.deleteMany({});

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await clearWorld();
    await User.deleteMany({});
    fs.rmSync(config.photoDir, { recursive: true, force: true });
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('NFR-3.1: the door wants a session and the right password', async () => {
    const world = await buildWorld();

    resetRateLimits();
    const anon = await raw('POST', '/api/auth/export', { body: { password: PASSWORD } });
    assert.equal(anon.status, 401, anon.text);
    assert.equal(anon.headers.get('set-cookie'), null, 'the 401 handed out a session cookie');
    assert.equal(anon.text.includes(world.a.email), false, 'the 401 named the account it refused');

    const empty = await exportData('', world.a);
    assert.ok(empty.status >= 400, `an empty password was accepted: ${empty.status}`);
    assert.equal(empty.text.includes('conversations'), false, 'a refused request still carried the record');

    const wrong = await exportData('not-the-password', world.a);
    assert.equal(wrong.status, 403, wrong.text);
    assert.equal(wrong.text.includes('conversations'), false, 'a wrong password released the record anyway');
    assert.equal(wrong.headers.get('content-disposition'), null, 'a refused request was offered as a download');

    // Each cookie opens its own file and nobody else's.
    const asPeer = await exportData(PASSWORD, world.b);
    assert.equal(asPeer.status, 200, asPeer.text.slice(0, 200));
    assert.equal(asPeer.json.about, world.b.email, 'b was handed a record that is not b');
    assert.equal(asPeer.text.includes(world.a.email), false, 'b received a file carrying a@\'s address');
    assert.equal(asPeer.text.includes(world.a.id), false, 'b received a file carrying a@\'s id');
  });

  await t.test('NFR-3.1: the answer is a file, and a readable one', async () => {
    const world = await buildWorld();
    const res = await exportData(PASSWORD, world.a);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.match(
      res.headers.get('content-disposition') || '',
      /^attachment; filename="unmask-my-data-\d{4}-\d{2}-\d{2}\.json"$/,
      `Content-Disposition was "${res.headers.get('content-disposition')}"`
    );
    assert.match(res.headers.get('content-type') || '', /^application\/json/);
    // NFR-2.1's shared headers have to survive a route that writes its own.
    assert.equal(res.headers.get('cache-control'), 'no-store', "a file of one student's whole life was cacheable");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const doc = res.json;
    assert.equal(doc.format, 'unmask-data-export/1');
    assert.equal(doc.about, world.a.email);
    assert.equal(doc.account.email, world.a.email);
    assert.deepEqual(doc.summary.collectionsCovered, ['users', ...User.dataCollections]);

    assert.equal(doc.conversations.length, 1, doc.conversations.length);
    assert.equal(doc.conversations[0].messages.length, 4, 'a thread in the file is missing one half of the words');
    assert.deepEqual(
      doc.conversations[0].messages.map(row => row.from),
      ['you', '(another student)', 'you', 'you']
    );
    // The peer's words are in the file because the conversation is both halves of a
    // pair's, and deleting one student's row takes the thread with it.
    assert.equal(doc.conversations[0].messages[1].body, 'It was unclear. Also you have ugly handwriting.');
    assert.ok(doc.conversations[0].messages.every(row => typeof row.at === 'string'));
    assert.equal(doc.conversations[0].reveal.status, 'pending');
    assert.equal(doc.conversations[0].reveal.askedBy, 'you');
    // That they agreed is the requester's business; the minute they agreed is not.
    assert.equal(doc.conversations[0].reveal.otherConsented, 'not yet');

    assert.equal(doc.account.studentStatus.status, 'attested');
    assert.equal(doc.profile.photo.onFile, true, 'the file did not know a photo was stored');
    assert.ok(doc.profile.photo.bytes > 0, 'the photo record lost its size');
    assert.equal(doc.declines.length, 2, 'a pass each way should read as two lines');
    assert.deepEqual(
      doc.declines.map(row => row.direction).sort(),
      ['a suggestion passed you by', 'you passed on a suggestion']
    );
    assert.ok(doc.whatIsNotInThisFileAndWhy.length >= 5, 'no statement of what is deliberately missing');
  });

  await t.test('NFR-3.3, FR-6.2, FR-6.3: nobody else in the file', async () => {
    const world = await buildWorld();
    const res = await exportData(PASSWORD, world.a);
    const doc = res.json;
    const text = res.text;

    // Every other account in this record, by address and by the id the database
    // actually joins on.
    for (const other of [world.b, world.c, world.d, world.staff]) {
      assert.equal(text.includes(other.email), false, `the file carried ${other.email}`);
      assert.equal(text.includes(other.id), false, `the file carried an id: ${other.id}`);
    }
    // The requester's own id buys nothing here either, and its presence would make
    // every other row reachable by the same lookup.
    assert.equal(text.includes(world.a.id), false, "the file carried the requester's own id");

    // Nothing that is a credential, in any form.
    for (const forbidden of ['passwordHash', 'idHash', 'verifyCodeHash', 'verifyCodeAttempts', 'resetTokenHash', '$2a$', 'fileName']) {
      assert.equal(text.includes(forbidden), false, `the file carried "${forbidden}"`);
    }
    assert.equal(text.includes(world.fileName), false, 'the file carried the stored photo filename');
    assert.equal(text.includes(world.peerMessageId), false, 'the file carried a message id of another account');

    // The shape of the redactions, by name rather than by absence.
    assert.equal(doc.conversations[0].with, '(another student)');
    assert.equal(doc.reportsAgainstYou.length, 1, 'the file lost the report about this account');
    assert.equal(
      doc.reportsAgainstYou[0].filedBy,
      '(the student who filed it — never named to the reported person)'
    );
    assert.equal(doc.reportsAgainstYou[0].decidedBy, '(a staff member)');
    assert.equal(doc.reportsFiled.length, 1);
    assert.equal(doc.auditEntries.filter(row => row.by === '(a staff member)').length, 1);

    // FR-6.2: a block pointed *at* the requester is invisible to them here as on
    // every other screen — and the file says so rather than leaving a quiet gap.
    assert.equal(doc.blocks.length, 1, 'the file listed a block made against this account');
    assert.equal(doc.blocks[0].who, '(another student)');
    assert.ok(
      doc.whatIsNotInThisFileAndWhy.some(line => line.includes('blocked you')),
      'the file did not say a block stays invisible'
    );
    assert.ok(
      doc.whatIsNotInThisFileAndWhy.some(line => line.includes('Who reported you')),
      'the file did not say the reporter stays unnamed'
    );
  });

  await t.test('NFR-3.1/3.2: the file is the inventory the deletion then empties', async () => {
    const world = await buildWorld();
    const dbh = mongoose.connection;

    const held = await heldFor(world.a.userId);
    for (const name of User.dataCollections) {
      assert.ok(held[name] >= 1, `the world left ${name} empty, so that collection proves nothing`);
    }

    const res = await exportData(PASSWORD, world.a);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const doc = res.json;

    const listed = {
      profiles: doc.profile ? 1 : 0,
      passes: doc.declines.length,
      matches: doc.conversations.length,
      messages: doc.conversations.reduce((n, thread) => n + thread.messages.length, 0),
      blocks: doc.blocks.length,
      reports: doc.reportsFiled.length + doc.reportsAgainstYou.length,
      notifications: doc.notices.length,
      auditEvents: doc.auditEntries.length,
    };

    // Every collection agrees, except the one that is not allowed to.
    for (const name of User.dataCollections) {
      if (name === 'blocks') continue;
      assert.equal(
        listed[name],
        held[name],
        `${name}: the database holds ${held[name]} row(s) for this account and the file lists ${listed[name]}`
      );
    }

    // Blocks, measured rather than excused: two rows point at this account's pair,
    // one of them was made by them and one against them, and the file may only
    // carry the first — while the deletion has to take both.
    const madeByA = await dbh.collection('blocks').countDocuments({ userId: world.a.userId });
    const againstA = await dbh.collection('blocks').countDocuments({ blockedUserId: world.a.userId });
    assert.equal(madeByA, 1);
    assert.equal(againstA, 1);
    assert.equal(held.blocks, madeByA + againstA, 'the shared filter missed a direction of a block');
    assert.equal(listed.blocks, madeByA, 'the file listed a block made against the requester');

    assert.equal(doc.summary.conversations, held.matches);
    assert.equal(doc.summary.messages, held.messages);
    assert.equal(doc.summary.logEntries, held.auditEvents);
    assert.equal(doc.summary.notices, held.notifications);
    assert.equal(doc.summary.photoOnFile, true);
    const devices = (await User.findById(world.a.userId)).sessions.length;
    assert.ok(devices >= 1, 'a signed-in account reported no devices');
    assert.equal(doc.summary.signedInDevices, devices);
    assert.equal(doc.account.signedInDevices.length, devices);
    for (const device of doc.account.signedInDevices) {
      assert.deepEqual(Object.keys(device).sort(), ['browser', 'expiresAt', 'since']);
    }

    // Now take it all away, and read the tally against the inventory handed over.
    resetRateLimits();
    const gone = await raw('DELETE', '/api/auth/account', {
      cookie: world.a.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(gone.status, 200, gone.text.slice(0, 200));

    for (const name of User.dataCollections) {
      assert.equal(
        gone.json.removed[name],
        held[name],
        `${name}: the file listed ${held[name]} row(s) and the deletion took ${gone.json.removed[name]}`
      );
    }
    assert.equal(gone.json.removed.photoFile, 1, 'the profile row went and the photo file stayed on disk');
    assert.equal(fs.existsSync(path.join(config.photoDir, world.fileName)), false, 'the stored photo still exists');
    assert.equal(await User.countDocuments({ _id: world.a.userId }), 0);

    // The other half of the pair is untouched, and still has its own words.
    assert.equal(await Match.countDocuments({ users: world.a.userId }), 0);
    assert.equal(await User.countDocuments({ _id: world.b.userId }), 1);
    assert.ok((await User.findById(world.b.userId)).sessions.length >= 1);
    assert.equal(await heldFor(world.b.userId).then(h => h.matches), 0, 'b still holds a thread with a deleted account');
  });

  await t.test('NFR-2.4: the export door is limited', async () => {
    const world = await buildWorld();
    resetRateLimits();

    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      // A wrong password each time, so the limit is what stops the loop and not the
      // lockout: the file must never be reachable on the strength of a guess.
      const res = await raw('POST', '/api/auth/export', { cookie: world.a.cookie, body: { password: 'wrong' } });
      statuses.push(res.status);
    }
    assert.equal(statuses.slice(0, 6).every(s => s === 403), true, `the first six were ${statuses}`);
    assert.equal(statuses[6], 429, `the seventh guess was not stopped: ${statuses.join(',')}`);
    assert.equal(statuses[7], 429, statuses.join(','));

    const limited = await raw('POST', '/api/auth/export', { cookie: world.a.cookie, body: { password: PASSWORD } });
    assert.equal(limited.status, 429, limited.text);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'a 429 with no Retry-After');
    assert.equal(limited.headers.get('content-disposition'), null, 'a rate-limited request still returned a file');
  });
});
