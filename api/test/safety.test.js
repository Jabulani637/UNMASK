'use strict';
/**
 * Stage 7a — what a student does for themself: report something, and block somebody.
 * FR-6.1, FR-6.2, and the parts of FR-6.3 and FR-6.4 that a student's own screen can
 * prove without a staff member in the room.
 *
 * Two claims here are about *sounds* rather than behaviour — a block must not sound
 * like a block to the student it is aimed at, and a report must not leak who it is
 * about — and a claim about a sound can only be proved by reading bytes and comparing
 * them to the ordinary case. So one subtest holds an End-chat side by side with a
 * block, in the same world, and asserts the two students' screens came to the same
 * words; every response in this file is searched for an account id.
 *
 * The rest is arithmetic on a pool: a block, a suspension and a staff hold each have
 * to make one fewer student appear, and the proof is the count, not a flag.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
// One database per suite file: the other suites clear their collections.
testUrl.pathname = '/unmask_test_safety';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-safety';
process.env.PHOTO_DIR = './storage/test-photos-safety';

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
const vocab = require('../src/domain/vocabulary');
const chat = require('../src/services/chat');
const reports = require('../src/services/reports');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'blue-koala-printing-42';
const REASON = vocab.REPORT_REASONS[0];
/** Somebody else's thread, addressed the way services/pair.js words its refusal. */
const NO_THREAD = 'That conversation is not one you can open.';

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
    retry: res.headers.get('retry-after'),
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

/** A signed-in student with a matchable profile, built through the real routes. */
async function student(local, over = {}) {
  const address = email(local);
  resetRateLimits();
  await raw('POST', '/api/auth/register', { body: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });
  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);

  const account = { email: address, cookie: signedIn.cookie };
  const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
  assert.equal(saved.status, 200, saved.text);
  account.userId = (await User.findOne({ email: address }))._id;
  return account;
}

function send(account, id, body) {
  resetRateLimits();
  return raw('POST', `/api/chats/${id}/messages`, { cookie: account.cookie, body: { body } });
}
function threadOf(account, id) {
  resetRateLimits();
  return raw('GET', `/api/chats/${id}`, { cookie: account.cookie });
}
function chatList(account) {
  resetRateLimits();
  return raw('GET', '/api/chats', { cookie: account.cookie });
}
function suggestionOf(account) {
  resetRateLimits();
  return raw('GET', '/api/matches/suggestion', { cookie: account.cookie });
}
function connectWith(account, token) {
  resetRateLimits();
  return raw('POST', '/api/matches/suggestion/connect', { cookie: account.cookie, body: { token } });
}
function saveProfile(account, over) {
  resetRateLimits();
  return raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
}
function report(account, body) {
  resetRateLimits();
  reports._internal.resetBudget();
  return raw('POST', '/api/safety/reports', { cookie: account.cookie, body });
}
/** The same call with the per-account budget left standing, for the flood test. */
function reportFaster(account, body) {
  resetRateLimits();
  return raw('POST', '/api/safety/reports', { cookie: account.cookie, body });
}
function block(account, body) {
  resetRateLimits();
  return raw('POST', '/api/safety/blocks', { cookie: account.cookie, body });
}
function blockList(account) {
  resetRateLimits();
  return raw('GET', '/api/safety/blocks', { cookie: account.cookie });
}
function unblock(account, id) {
  resetRateLimits();
  return raw('DELETE', `/api/safety/blocks/${id}`, { cookie: account.cookie });
}

/** Empty what a thread and a safety record are made of, keeping nothing behind. */
async function clearWorld() {
  await Profile.deleteMany({});
  await Match.deleteMany({});
  await Message.deleteMany({});
  await Pass.deleteMany({});
  await Block.deleteMany({});
  await Report.deleteMany({});
  await AuditEvent.deleteMany({});
  chat._internal.resetBudget();
  reports._internal.resetBudget();
}

// -------------------------------------------------------------- the small worlds

/**
 * Two students who have never met, plus the one thing a browser can hold about a
 * suggestion: its sealed token. A pool of exactly two, because every later assertion
 * about "one fewer person" is an assertion about a count.
 */
async function twoCards() {
  await clearWorld();
  const a = await student('safety-a', { gender: 'Woman', lookingFor: 'Men', age: 20 });
  const b = await student('safety-b', { gender: 'Man', lookingFor: 'Women', age: 21 });

  const first = await suggestionOf(a);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.suggestion, 'a has to be shown somebody to report or block');
  return { a, b, token: first.json.suggestion.token };
}

/** A pair that has talked: what a block and a message report are aimed at. */
async function connectedPair() {
  const world = await twoCards();
  const made = await connectWith(world.a, world.token);
  assert.equal(made.status, 201, made.text);
  const id = made.json.match.id;

  const sent = await send(world.a, id, 'I would rather not be spoken to like that.');
  assert.equal(sent.status, 201, sent.text);
  return { ...world, id, messageId: sent.json.message.id };
}

/**
 * Two pairs at once, which is what "a block is indistinguishable from a departure"
 * needs: one of them leaves on purpose, the other is blocked, and the two have to be
 * compared while both are still in the database.
 *
 * The ages keep the pairing honest. A suggestion is one-at-a-time and the engine
 * works ±5 years, so a 20-21 pair and a 27-28 pair cannot reach across each other,
 * and `a` is shown `b` rather than whichever row Mongo happened to read first.
 */
async function twoPairs() {
  await clearWorld();
  const a = await student('safety-a', { gender: 'Woman', lookingFor: 'Men', age: 20 });
  const b = await student('safety-b', { gender: 'Man', lookingFor: 'Women', age: 21 });
  const c = await student('safety-c', { gender: 'Woman', lookingFor: 'Men', age: 27 });
  const d = await student('safety-d', { gender: 'Man', lookingFor: 'Women', age: 28 });

  const madeA = await connectWith(a, (await suggestionOf(a)).json.suggestion.token);
  assert.equal(madeA.status, 201, madeA.text);
  const madeC = await connectWith(c, (await suggestionOf(c)).json.suggestion.token);
  assert.equal(madeC.status, 201, madeC.text);

  assert.ok(String(madeA.json.match.id) !== String(madeC.json.match.id), 'the two worlds collided');
  return {
    block: { x: a, y: b, id: madeA.json.match.id },
    leave: { x: c, y: d, id: madeC.json.match.id },
  };
}

/** Nothing in this API has ever handed a client an account id; stage 7 keeps that. */
function assertNoIds(text, accounts) {
  for (const account of accounts) {
    assert.ok(!text.includes(String(account.userId)), `a response carried an account id: ${text.slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------- the suite

test('stage 7a — a student can report and can block, and neither makes a sound', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');
  assert.ok(config.photoDir.endsWith('test-photos-safety'), 'refusing to write into a real photos folder');

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
    fs.rmSync(config.photoDir, { recursive: true, force: true });
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('the safety routes want a signed-in browser', async () => {
    const world = await connectedPair();

    for (const [method, route, body] of [
      ['POST', '/api/safety/reports', { kind: 'message', messageId: world.messageId, reason: REASON }],
      ['POST', '/api/safety/blocks', { matchId: world.id }],
      ['GET', '/api/safety/blocks'],
      ['DELETE', `/api/safety/blocks/${world.id}`],
    ]) {
      resetRateLimits();
      const res = await raw(method, route, { body });
      assert.equal(res.status, 401, `${method} ${route} answered without a session`);
      assert.equal(res.json.code, 'unauthenticated');
    }
  });

  await t.test('FR-6.1: a report copies the words it is about', async () => {
    const world = await connectedPair();

    const filed = await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON, detail: 'twice now' });
    assert.equal(filed.status, 201, filed.text);
    assert.equal(filed.json.reported, true);
    assertNoIds(filed.text, [world.a, world.b]);

    const row = await Report.findOne({}).lean();
    assert.ok(row, 'the report is a document, not just a response');
    assert.equal(row.kind, 'message');
    // The reported line, stored as it was at the moment of the press.
    assert.equal(row.excerpt, 'I would rather not be spoken to like that.');
    assert.equal(String(row.reportedUserId), String(world.a.userId), 'the reporter names nobody; the thread does');
    assert.equal(String(row.matchId), String(world.id));
    assert.equal(row.status, 'open');
    assert.equal(row.detail, 'twice now');

    const audited = await AuditEvent.findOne({ action: 'report.filed' }).lean();
    assert.ok(audited, 'a report is logged');
    assert.equal(String(audited.subjectId), String(world.a.userId));
    // FR-6.5 with NFR-3.5: the log holds ids and one sentence, never the text.
    assert.ok(!JSON.stringify(audited).includes('generator plan'));
  });

  await t.test('FR-6.1: a profile report copies the new block, and not the race line', async () => {
    const world = await connectedPair();

    // The reported student fills in everything the anonymous card now shows, plus
    // the one answer the card is not allowed to show.
    const written = await saveProfile(world.b, {
      bodyType: 'Curvy',
      height: '5\u2032 2\u2033 to 5\u2032 6\u2033',
      drinks: 'Socially',
      identity: 'Black',
      typeNote: 'someone who is unembarrassed about enjoying things.',
      seekGym: ['Once in a while'],
    });
    assert.equal(written.status, 200, written.text);

    const filed = await report(world.a, { kind: 'profile', matchId: world.id, reason: REASON });
    assert.equal(filed.status, 201, filed.text);

    const row = await Report.findOne({ reporterId: world.a.userId }).lean();
    assert.ok(row.excerpt.includes('About them: Curvy, 5\u2032 2\u2033 to 5\u2032 6\u2033, Socially'), row.excerpt);
    assert.ok(row.excerpt.includes('Who they are after: someone who is unembarrassed about enjoying things.'), row.excerpt);

    /*
     * The one field that is on a profile and in no staff reach. A queue row is the
     * only place in this product where a third party could read what somebody said
     * about their own race, so it is the place the rule has to hold hardest — and
     * the assertion covers the response as well as the document, because the report
     * is echoed back to the reporter too.
     */
    for (const text of [row.excerpt, JSON.stringify(row), filed.text]) {
      for (const word of ['identity', 'Black']) assert.ok(!text.includes(word), `the report carries ${word}`);
    }
  });

  await t.test('FR-6.1: a snapshot survives the edit it is likely to cause', async () => {
    const world = await connectedPair();
    const oldAnswer = (await Profile.findOne({ userId: world.b.userId })).prompts[0].answer;

    const filed = await report(world.a, { kind: 'prompt', matchId: world.id, promptIndex: 0, reason: REASON });
    assert.equal(filed.status, 201, filed.text);

    // The reported student rewrites the answer — which is what a person does.
    const edited = await saveProfile(world.b, {
      gender: 'Man',
      lookingFor: 'Women',
      age: 21,
      prompts: [{ prompt: vocab.PROMPTS[1], answer: 'that res meals are a public utility, not a hobby.' }],
    });
    assert.equal(edited.status, 200, edited.text);

    const row = await Report.findOne({ reporterId: world.a.userId }).lean();
    assert.ok(row.excerpt.includes(oldAnswer), 'the copy a staff member judges did not move with the profile');
    assert.ok(!row.excerpt.includes('public utility'));
    assert.notEqual((await Profile.findOne({ userId: world.b.userId })).prompts[0].answer, oldAnswer);
  });

  await t.test('FR-6.1: the reason is one of six, the kind one of four', async () => {
    const world = await connectedPair();

    const invented = await report(world.a, { kind: 'message', messageId: world.messageId, reason: 'He breathed near me at the mall' });
    assert.equal(invented.status, 400);
    assert.equal(invented.json.code, 'bad_reason');

    const kind = await report(world.a, { kind: 'vibe', matchId: world.id, reason: REASON });
    assert.equal(kind.status, 400);
    assert.equal(kind.json.code, 'bad_kind');

    // A report about a face that is not there would sit in the queue forever.
    const photo = await report(world.a, { kind: 'photo', matchId: world.id, reason: REASON });
    assert.equal(photo.status, 400);
    assert.equal(photo.json.code, 'no_photo');

    // You cannot report something you cannot read.
    const other = await student('safety-c', { gender: 'Man', lookingFor: 'Women', age: 24 });
    const peeked = await report(other, { kind: 'message', messageId: world.messageId, reason: REASON });
    assert.equal(peeked.status, 404, 'a message id is not a way into a report');
    assert.equal(peeked.json.code, 'no_thread');
    assert.equal(peeked.json.error, NO_THREAD);

    // And not your own line in it, either.
    const own = await report(world.a, { kind: 'message', messageId: world.messageId, reason: REASON });
    assert.equal(own.status, 400);
    assert.equal(own.json.code, 'self_report');

    // A token that was never issued to this student points at nothing.
    const forged = await report(world.a, { kind: 'profile', token: 'sugg1.nope.nope.nope', reason: REASON });
    assert.equal(forged.status, 409);
    assert.equal(forged.json.code, 'stale_suggestion');

    // Reporting the other half of a thread, on the other hand, is the whole point.
    const filed = await report(world.a, { kind: 'profile', matchId: world.id, reason: REASON });
    assert.equal(filed.status, 201, filed.text);
  });

  await t.test('NFR-2.5: the same report twice is one report, and a flood costs a wait', async () => {
    const world = await connectedPair();

    const first = await report(world.a, { kind: 'profile', matchId: world.id, reason: REASON });
    assert.equal(first.status, 201, first.text);

    const second = await report(world.a, { kind: 'profile', matchId: world.id, reason: REASON });
    assert.equal(second.status, 200, 'a duplicate is not a new queue item');
    assert.equal(second.json.already, true);
    assert.match(second.json.message, /already/i);
    assert.equal(await Report.countDocuments({ reporterId: world.a.userId }), 1);

    // Eight presses of the same button. The unique index has already dealt with the
    // duplicate rows; what stops the *queue* from being walked through is the count,
    // and it is spent whether or not the report was new.
    reports._internal.resetBudget();
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await reportFaster(world.a, {
        kind: 'prompt',
        matchId: world.id,
        promptIndex: 0,
        reason: REASON,
        detail: `press ${i}`,
      });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.match(res.json.error, /staff member a moment/i);
        assert.ok(Number(res.retry) > 0, 'a 429 says how long, in the header the route answers with');
      }
    }
    assert.equal(statuses.filter(code => code < 300).length, 5, 'five get through');
    assert.equal(statuses.filter(code => code === 429).length, 3, 'three are told to wait');
  });

  await t.test('FR-6.1: a card can be reported before anybody agrees to chat', async () => {
    const world = await twoCards();

    const filed = await report(world.a, { kind: 'profile', token: world.token, reason: vocab.REPORT_REASONS[4] });
    assert.equal(filed.status, 201, filed.text);

    const row = await Report.findOne({ reporterId: world.a.userId }).lean();
    assert.equal(String(row.reportedUserId), String(world.b.userId));
    assert.equal(row.matchId, null, 'there is no thread, and a report does not invent one');
    // The card a staff member reads is the card that was on the screen.
    assert.ok(row.excerpt.includes('2nd year'));
    assert.ok(row.excerpt.includes('generator plan'));
    assert.equal(await Match.countDocuments({}), 0, 'reporting is not matching');
  });

  await t.test('FR-6.2: a block closes the thread and sounds exactly like a departure', async () => {
    const pairs = await twoPairs();

    // The control, first: FR-4.4's own route, wording not written for this test.
    resetRateLimits();
    const left = await raw('POST', `/api/chats/${pairs.leave.id}/leave`, { cookie: pairs.leave.x.cookie });
    assert.equal(left.status, 200, left.text);

    const pressed = await block(pairs.block.x, { matchId: pairs.block.id });
    assert.equal(pressed.status, 200, pressed.text);
    assert.equal(pressed.json.blocked, true);
    assert.equal(pressed.json.closedThread, true);
    assertNoIds(pressed.text, [pairs.block.x, pairs.block.y]);

    // The student who was blocked, and the one who was simply left: the same three
    // facts, and not one word more.
    const mine = await threadOf(pairs.block.y, pairs.block.id);
    const theirs = await threadOf(pairs.leave.y, pairs.leave.id);
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.json.thread.status, 'closed');
    assert.equal(mine.json.thread.closedNotice, theirs.json.thread.closedNotice);
    assert.ok(!/block/i.test(mine.json.thread.closedNotice), 'the sentence a student reads must not name itself');
    // The same fields, in the same shape: a block adds nothing here to read.
    assert.deepEqual(Object.keys(mine.json.thread).sort(), Object.keys(theirs.json.thread).sort());

    // Same in the list a student opens first, row for row.
    const list = await chatList(pairs.block.y);
    const controlList = await chatList(pairs.leave.y);
    assert.equal(list.json.threads[0].status, 'closed');
    const shapeOf = row => JSON.stringify({ ...row, id: 'x', connectedAt: 'x', lastActivity: 'x', last: 'x', peer: 'x', reveal: 'x' });
    assert.equal(shapeOf(list.json.threads[0]), shapeOf(controlList.json.threads[0]));

    // The pair's row records who closed it — the same field an End-chat writes. The
    // difference lives in the blocks collection, which nobody but its owner reads.
    const row = await Match.findById(pairs.block.id).lean();
    assert.equal(row.status, 'closed');
    assert.equal(String(row.closedBy), String(pairs.block.x.userId));

    // A second press changes nothing and says so.
    const again = await block(pairs.block.x, { matchId: pairs.block.id });
    assert.equal(again.json.already, true);
    assert.equal(await Block.countDocuments({}), 1);

    // A closed thread stays shut from the blocked side, too.
    const wrote = await send(pairs.block.y, pairs.block.id, 'why is this gone');
    assert.equal(wrote.status, 409);
    assert.equal(wrote.json.code, 'thread_closed');
  });

  await t.test('FR-6.2: unblocking is allowed, and does not reopen the conversation', async () => {
    const world = await connectedPair();
    const pressed = await block(world.a, { matchId: world.id });
    assert.equal(pressed.status, 200, pressed.text);

    const list = await blockList(world.a);
    assert.equal(list.json.count, 1);
    assertNoIds(list.text, [world.b]);
    // Anonymous still: a block list is not a way to read back a name.
    assert.equal(list.json.blocked[0].peer.name, null);
    assert.equal(list.json.blocked[0].peer.revealed, false);
    assert.equal(list.json.blocked[0].peer.year, '2nd year');

    const lifted = await unblock(world.a, list.json.blocked[0].id);
    assert.equal(lifted.status, 200, lifted.text);
    assert.equal(lifted.json.blocked, false);
    assert.match(lifted.json.message, /stays closed/i);

    const still = await threadOf(world.b, world.id);
    assert.equal(still.json.thread.status, 'closed', 'lifting a block is not undoing somebody else’s goodbye');
    const wrote = await send(world.b, world.id, 'are you there');
    assert.equal(wrote.status, 409);

    // A row is addressed by its own id, and only by its owner.
    const other = await student('safety-c', { gender: 'Man', lookingFor: 'Women', age: 24 });
    const card = await suggestionOf(other);
    assert.ok(card.json.suggestion, 'c has to be shown somebody to block');
    await block(other, { token: card.json.suggestion.token });
    const stolen = await unblock(world.b, list.json.blocked[0].id);
    assert.equal(stolen.status, 409);
    assert.equal(stolen.json.code, 'not_blocked');
    assert.equal((await blockList(other)).json.count, 1);
  });

  await t.test('FR-6.2: a block stops being suggested, in both directions', async () => {
    const world = await twoCards();

    const before = await suggestionOf(world.b);
    assert.equal(before.status, 200, before.text);
    assert.ok(before.json.suggestion, 'they are visible to each other to begin with');
    assert.equal(before.json.waiting, 1);
    assert.equal(await Match.countDocuments({}), 0, 'so no later exclusion can be blamed on a thread');

    const pressed = await block(world.a, { token: world.token });
    assert.equal(pressed.status, 200, pressed.text);
    assert.equal(pressed.json.closedThread, false, 'there was no conversation to close');

    for (const [label, account] of [['the blocker', world.a], ['the blocked', world.b]]) {
      const after = await suggestionOf(account);
      assert.equal(after.status, 200, after.text);
      assert.equal(after.json.suggestion, null, `${label} was still shown somebody`);
      assert.equal(after.json.exhausted, true);
    }
    assert.equal(await Match.countDocuments({}), 0);

    // A card already open on a screen: the same sentence a stale token always gets,
    // so this refusal cannot be used to find out which of the two students pressed.
    const stale = await connectWith(world.b, before.json.suggestion.token);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'stale_suggestion');
    assert.equal(await Match.countDocuments({}), 0, 'and it did not open behind the refusal');

    // Lift it, and the pool is a pool again.
    const list = await blockList(world.a);
    await unblock(world.a, list.json.blocked[0].id);
    const back = await suggestionOf(world.b);
    assert.ok(back.json.suggestion, 'an unblock has to be allowed to put somebody back');
  });

  await t.test('FR-6.3: a suspended account stops being suggested and cannot be chatted into', async () => {
    const world = await twoCards();
    const before = await suggestionOf(world.a);
    assert.ok(before.json.suggestion);

    await User.updateOne({ _id: world.b.userId }, { $set: { status: 'suspended', statusReason: 'staff test' } });

    const after = await suggestionOf(world.a);
    assert.equal(after.json.suggestion, null, 'a paused account was still on offer');

    // A card from before the suspension, held open on a screen.
    const stale = await connectWith(world.a, before.json.suggestion.token);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'stale_suggestion');
    assert.equal(await Match.countDocuments({}), 0);

    await User.updateOne({ _id: world.b.userId }, { $set: { status: 'active' } });
    assert.ok((await suggestionOf(world.a)).json.suggestion);
  });

  await t.test('FR-6.4: a staff hold stops a profile, tells its owner why, and a save lifts it', async () => {
    const world = await twoCards();
    await Profile.updateOne({ userId: world.b.userId }, {
      $set: { 'review.status': 'held', 'review.reason': 'an answer that broke the guidelines', 'review.at': new Date() },
    });

    const hidden = await suggestionOf(world.a);
    assert.equal(hidden.json.suggestion, null, 'a held profile was still suggested');

    // The owner is not left guessing why nobody sees them any more.
    const own = await suggestionOf(world.b);
    assert.equal(own.status, 428);
    assert.equal(own.json.code, 'profile_incomplete');
    assert.match(own.json.error, /paused this profile/);
    assert.match(own.json.error, /an answer that broke the guidelines/);

    // ...and the sentence promised that editing and saving would fix it.
    const saved = await saveProfile(world.b, { gender: 'Man', lookingFor: 'Women', age: 21 });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await Profile.findOne({ userId: world.b.userId })).review.status, 'clean');

    assert.ok((await suggestionOf(world.a)).json.suggestion);
  });

  await t.test('NFR-3.5: deleting an account takes its blocks, reports and audit rows', async () => {
    const world = await connectedPair();
    await report(world.a, { kind: 'profile', matchId: world.id, reason: REASON });
    await block(world.a, { matchId: world.id });
    // Both directions, because a block is one student's act and the row is data
    // about two people.
    await block(world.b, { matchId: world.id });

    assert.equal(await Report.countDocuments({ reporterId: world.a.userId }), 1);
    assert.equal(await Block.countDocuments({ userId: world.a.userId }), 1);
    assert.ok(await AuditEvent.findOne({ actorId: world.a.userId }));

    resetRateLimits();
    const gone = await raw('DELETE', '/api/auth/account', {
      cookie: world.a.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(gone.status, 200, gone.text);

    assert.equal(await Report.countDocuments({ $or: [{ reporterId: world.a.userId }, { reportedUserId: world.a.userId }] }), 0);
    assert.equal(await Block.countDocuments({ $or: [{ userId: world.a.userId }, { blockedUserId: world.a.userId }] }), 0);
    assert.equal(await AuditEvent.countDocuments({ $or: [{ actorId: world.a.userId }, { subjectId: world.a.userId }] }), 0);
    // The thread goes with it, as every other stage's deletion already promised —
    // a pair with one deleted participant is not a pair. So does the block the *other*
    // student placed against this one: a record naming a person is a record about
    // them, and NFR-3.5 does not grade that by who pressed the button.
    assert.equal(await Match.countDocuments({}), 0);
    assert.equal(await Block.countDocuments({ userId: world.b.userId }), 0);
  });
});
