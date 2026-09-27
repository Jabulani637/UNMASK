'use strict';
/**
 * Stage 7b — the staff side: the queue, the four decisions, and the lever on an
 * account. FR-6.3, FR-6.4, FR-6.5.
 *
 * The safety suite proves what a student can set in motion. This one proves what
 * happens at the other end of it, and three claims carry the file:
 *
 *   - **The door answers 404, not 403.** A student who guesses `/api/staff/reports`
 *     learns only that there is nothing there. The assertion is on the exact body a
 *     request to a genuinely unknown endpoint produces, because "we have a staff
 *     area and you are not in it" is information FR-6.3 does not hand out.
 *   - **A decision lands in three places, so the log cannot disagree with the
 *     state.** Every subtest that decides something reads the report row, the thing
 *     it touched, and the audit row, in that order, and checks the three tell one
 *     story.
 *   - **Staff see what a student never may, and nothing beside it.** The queue
 *     carries the reported words and both accounts' cards — no student-facing route
 *     returns either — and the assertions here are that it carries no email address
 *     and no photo filename, which are the two things a shared staff-room screen
 *     must not be showing.
 *
 * Its own database and its own photos folder, because `node --test` runs the suites
 * side by side.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
testUrl.pathname = '/unmask_test_staff';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-staff';
process.env.PHOTO_DIR = './storage/test-photos-staff';

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
const photos = require('../src/services/photos');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');
const { png } = require('./fixtures/images');

const PASSWORD = 'blue-koala-printing-42';
// One real PNG for the whole file: the upload writes these bytes, and the staff read
// compares against them, which is what makes "the bytes, exactly as stored" a claim
// rather than a status code.
const PNG = png();
const REASON = vocab.REPORT_REASONS[0];
const OTHER_REASON = vocab.REPORT_REASONS[4];
const CLOSED_NOTICE = 'This conversation has been closed. You can still read it.';

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
  // One read of the body, so a photo response can be compared byte for byte and a
  // JSON response still parsed: a text() call first would consume the stream.
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

async function signIn(address) {
  resetRateLimits();
  const res = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  return res;
}

/**
 * A student, built the way a browser builds one — except for the role, which has
 * no route and cannot have one. `scripts/staff.js` sets it in the database, and so
 * does this file, because a test that could promote over HTTP would be proving a
 * hole rather than a guard.
 */
async function student(local, over = {}) {
  const address = email(local);
  resetRateLimits();
  await raw('POST', '/api/auth/register', { body: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });
  if (over.admin) await User.updateOne({ email: address }, { $set: { role: 'admin' } });

  const signedIn = await signIn(address);
  assert.equal(signedIn.status, 200, signedIn.text);
  const account = { email: address, cookie: signedIn.cookie };

  if (!over.noProfile) {
    const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
    assert.equal(saved.status, 200, saved.text);
  }
  account.userId = (await User.findOne({ email: address }))._id;
  return account;
}

/** The seeded reviewer: a role, an account, and no profile to be suggested by. */
async function staff() {
  // A reviewer with nothing to read is not a reviewer, and a reviewer with a profile
  // would turn up on a student's card — so this account takes the role and nothing
  // else, which is the whole difference between `admin` and a student here.
  return student('staff-reviewer', { admin: true, noProfile: true });
}

function send(account, id, body) {
  resetRateLimits();
  return raw('POST', `/api/chats/${id}/messages`, { cookie: account.cookie, body: { body } });
}
function threadOf(account, id) {
  resetRateLimits();
  return raw('GET', `/api/chats/${id}`, { cookie: account.cookie });
}
function suggestionOf(account) {
  resetRateLimits();
  return raw('GET', '/api/matches/suggestion', { cookie: account.cookie });
}
function connectWith(account, token) {
  resetRateLimits();
  return raw('POST', '/api/matches/suggestion/connect', { cookie: account.cookie, body: { token } });
}
function report(account, body) {
  resetRateLimits();
  reports._internal.resetBudget();
  return raw('POST', '/api/safety/reports', { cookie: account.cookie, body });
}
function queue(as, query = '') {
  resetRateLimits();
  return raw('GET', `/api/staff/reports${query}`, { cookie: as.cookie });
}
function statsFor(as) {
  resetRateLimits();
  return raw('GET', '/api/staff/stats', { cookie: as.cookie });
}
function decide(as, id, body) {
  resetRateLimits();
  return raw('POST', `/api/staff/reports/${id}/decide`, { cookie: as.cookie, body });
}
function setStatus(as, userId, body) {
  resetRateLimits();
  return raw('POST', `/api/staff/accounts/${userId}/status`, { cookie: as.cookie, body });
}
function setStudent(as, userId, body) {
  resetRateLimits();
  return raw('POST', `/api/staff/accounts/${userId}/student`, { cookie: as.cookie, body });
}
function accountRecord(as, userId) {
  resetRateLimits();
  return raw('GET', `/api/staff/accounts/${userId}`, { cookie: as.cookie });
}
function staffPhoto(as, userId) {
  resetRateLimits();
  return raw('GET', `/api/staff/accounts/${userId}/photo`, { cookie: as.cookie });
}
function uploadPhoto(account) {
  resetRateLimits();
  const form = new FormData();
  form.append('photo', new Blob([PNG]), 'face.png');
  return raw('POST', '/api/profile/photo', { cookie: account.cookie, form });
}

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

/** Two students who have never met, plus the token a browser holds about one of them. */
async function twoCards() {
  await clearWorld();
  const a = await student('staff-a', { gender: 'Woman', lookingFor: 'Men', age: 20 });
  const b = await student('staff-b', { gender: 'Man', lookingFor: 'Women', age: 21 });
  const first = await suggestionOf(a);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.suggestion, 'a has to be shown b for anything below to mean anything');
  return { a, b, token: first.json.suggestion.token };
}

/** A pair that has talked: what a message report, a block and a suspension aim at. */
async function connectedPair() {
  const world = await twoCards();
  const made = await connectWith(world.a, world.token);
  assert.equal(made.status, 201, made.text);
  const id = made.json.match.id;
  const sent = await send(world.a, id, 'I would rather not be spoken to like that.');
  assert.equal(sent.status, 201, sent.text);
  return { ...world, id, messageId: sent.json.message.id };
}

/** The one open report in the world, as a route would have to find it. */
async function onlyReport() {
  const row = await Report.findOne({});
  assert.ok(row, 'the world built no report');
  return row;
}

/** Nothing here hands out an address, a filename, or a student's id to a stranger. */
function assertCarriesNoPrivateHandles(text, accounts, files = []) {
  for (const account of accounts) {
    assert.ok(!text.includes(account.email), `a staff response carried an email address: ${account.email}`);
  }
  for (const fileName of files) {
    assert.ok(!text.includes(fileName), 'a staff response carried a stored photo filename');
  }
}

// ------------------------------------------------------------------- the suite

test('stage 7b — the staff queue, and what a decision has to touch', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');
  assert.ok(config.photoDir.endsWith('test-photos-staff'), 'refusing to write into a real photos folder');

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

  await t.test('FR-6.3: the staff door answers 401 to nobody and 404 to a student', async () => {
    const world = await connectedPair();
    const reviewer = await staff();

    const routes = [
      ['GET', '/api/staff/reports'],
      ['GET', '/api/staff/stats'],
      ['GET', `/api/staff/accounts/${world.a.userId}`],
      ['GET', `/api/staff/accounts/${world.a.userId}/photo`],
      ['POST', '/api/staff/reports/000000000000000000000000/decide', { action: 'dismissed' }],
      ['POST', `/api/staff/accounts/${world.a.userId}/status`, { status: 'suspended' }],
      ['POST', `/api/staff/accounts/${world.a.userId}/student`, { status: 'revoked', note: 'No record of you in the register.' }],
    ];

    const unknown = await raw('GET', '/api/staff/definitely-not-a-route');
    assert.equal(unknown.status, 401, 'even an unknown path behind the door wants a session');

    for (const [method, route, body] of routes) {
      resetRateLimits();
      const signedOut = await raw(method, route, { body });
      assert.equal(signedOut.status, 401, `${route} answered without a session`);
      assert.equal(signedOut.json.code, 'unauthenticated');

      resetRateLimits();
      const studentRes = await raw(method, route, { body, cookie: world.a.cookie });
      assert.equal(studentRes.status, 404, `${method} ${route} was not a 404 to a student`);
      // Not 403: a refusal that explains itself confirms the route exists. The body
      // has to be the same bytes the catch-all gives a path nobody ever wrote.
      const elsewhere = await raw('GET', '/api/not-a-real-door');
      assert.equal(elsewhere.status, 404);
      assert.deepEqual(studentRes.json, elsewhere.json, 'a student learned that there is a staff area');

      resetRateLimits();
      const asStaff = await queue(reviewer);
      assert.equal(asStaff.status, 200, 'an admin session does open the door');
    }

    // An admin is an ordinary account with one field changed, so the field is the
    // whole gate: turn it off, or suspend the account, and the same session is a
    // stranger again — without the cookie having to be touched.
    await User.updateOne({ _id: reviewer.userId }, { $set: { role: 'student' } });
    resetRateLimits();
    const demoted = await raw('GET', '/api/staff/reports', { cookie: reviewer.cookie });
    assert.equal(demoted.status, 404, 'a revoked session kept its privilege');

    await User.updateOne({ _id: reviewer.userId }, { $set: { role: 'admin', status: 'suspended' } });
    resetRateLimits();
    const paused = await raw('GET', '/api/staff/reports', { cookie: reviewer.cookie });
    // 401 rather than 404: a suspended account's session is revoked at the session
    // layer, before anyone asks what role it holds. The role gate's own status check
    // is behind that one, and stays because a guard should not depend on the order of
    // the files in front of it.
    assert.equal(paused.status, 401, 'a suspended admin read the queue');
    assert.equal(await User.countDocuments({ _id: reviewer.userId, 'sessions.0': { $exists: true } }), 0, 'the session survived the suspension');
    await User.updateOne({ _id: reviewer.userId }, { $set: { status: 'active' } });
  });

  await t.test('FR-6.3: the queue holds the reported words and two cards, and no addresses', async () => {
    const world = await connectedPair();
    const reviewer = await staff();

    /*
     * A staff card now shows the words a student chose about their own body and
     * their own type, so this is the payload the describe-only rule has to hold on:
     * the same save writes a race line into the profile beside answers that *are*
     * meant to be read, and the assertions below count the two kinds separately.
     */
    const looks = await raw('PUT', '/api/profile', {
      cookie: world.a.cookie,
      body: finished({
        gender: 'Woman',
        lookingFor: 'Men',
        age: 20,
        identity: 'Black',
        bodyType: 'Curvy',
        drinks: 'Socially',
        seekGym: ['Once in a while'],
        typeNote: 'someone who is unembarrassed about enjoying things.',
      }),
    });
    assert.equal(looks.status, 200, looks.text);

    const message = await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON, detail: 'twice now' });
    assert.equal(message.status, 201, message.text);
    const profile = await report(world.b, { kind: 'profile', matchId: world.id, reason: OTHER_REASON });
    assert.equal(profile.status, 201, profile.text);

    const res = await queue(reviewer);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a queue of reports must not sit in a browser cache');
    assert.equal(res.json.count, 2);
    assert.equal(res.json.status, 'open');
    assertCarriesNoPrivateHandles(res.text, [world.a, world.b, reviewer]);

    const byKind = {};
    for (const row of res.json.reports) byKind[row.kind] = row;
    assert.ok(byKind.message && byKind.profile, 'both reports are on the queue');

    const filed = byKind.message;
    // The words a moderator judges, copied when the button was pressed.
    assert.equal(filed.excerpt, 'I would rather not be spoken to like that.');
    assert.equal(filed.detail, 'twice now');
    assert.equal(filed.status, 'open');
    assert.equal(filed.decision, null);
    assert.equal(filed.matchId, String(world.id));
    assert.equal(String(filed.reporter.userId), String(world.b.userId), 'the queue put the two people under the wrong heading');
    assert.equal(String(filed.reported.userId), String(world.a.userId));
    // FR-6.3's one signal that separates a disputed profile from a problematic one.
    assert.equal(filed.openAgainst, 2);
    assert.equal(byKind.profile.openAgainst, 2);

    // A card is what the student's own screen holds — and nothing that identifies
    // the account to the world.
    assert.equal(filed.reported.year, '2nd year');
    assert.equal(filed.reported.faculty, 'Informatics & Design');
    assert.equal(filed.reported.prompts.length, 1);
    assert.equal(filed.reported.hasPhoto, false);
    assert.equal(filed.reported.held, false);
    assert.equal(filed.reported.account.status, 'active');
    assert.ok(!('revealName' in filed.reported), 'the queue handed staff a name nobody has revealed');

    // What the new answers do here: the type sentence is on the card and the body
    // answers are in the copied evidence, because a decision about a profile is a
    // decision about the words on it.
    assert.equal(byKind.profile.reported.typeNote, 'someone who is unembarrassed about enjoying things.');
    assert.ok(byKind.profile.excerpt.includes('About them: Curvy, Socially'), byKind.profile.excerpt);
    assert.ok(!('identity' in byKind.profile.reported), 'the staff card carried a race line');

    // What it does not do: neither staff door repeats what that student said about
    // their own race, in either of the two directions a leak could take — the key
    // arriving, or the word turning up inside copied text.
    const record = await accountRecord(reviewer, world.a.userId);
    assert.equal(record.status, 200, record.text);
    for (const text of [res.text, record.text]) {
      for (const word of ['identity', 'Black']) {
        assert.ok(!text.includes(word), `a staff response carries the race line (${word})`);
      }
    }

    // Reading it back by a name the queue does not have is a refusal, not a fallback.
    const nonsense = await queue(reviewer, '?status=pending');
    assert.equal(nonsense.status, 400);
    assert.equal(nonsense.json.code, 'bad_status');
    assertCarriesNoPrivateHandles((await queue(reviewer, '?status=all')).text, [world.a, world.b]);
  });

  await t.test('FR-6.3: a dismissal is a decision, and it is the only thing that moves', async () => {
    const world = await connectedPair();
    const reviewer = await staff();
    await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON });
    const row = await onlyReport();

    const res = await decide(reviewer, row._id, { action: 'dismissed' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.decided, true);
    assert.equal(res.json.action, 'dismissed');
    assert.equal(res.json.status, 'dismissed');
    assert.match(res.json.message, /not told/i);

    // Place one: the report.
    const after = await Report.findById(row._id).lean();
    assert.equal(after.status, 'dismissed');
    assert.equal(after.decision, 'dismissed');
    assert.equal(String(after.decidedBy), String(reviewer.userId), 'nobody signed the decision');
    assert.ok(after.decidedAt instanceof Date);
    assert.equal(after.decisionNote, null);

    // Place three: the log, which names the two accounts and carries no content.
    const audit = await AuditEvent.findOne({ action: 'report.decided' }).lean();
    assert.ok(audit);
    assert.equal(String(audit.actorId), String(reviewer.userId));
    assert.equal(String(audit.subjectId), String(world.a.userId));
    assertCarriesNoPrivateHandles(JSON.stringify(audit), [world.a, world.b]);

    // And place two never happens: nothing was touched on either account.
    assert.equal((await User.findById(world.a.userId)).status, 'active');
    assert.equal((await Profile.findOne({ userId: world.b.userId })).review.status, 'clean');
    assert.equal((await Match.findById(world.id)).status, 'open', 'a dismissal closed somebody’s conversation');
    assert.equal(await AuditEvent.countDocuments({ action: 'content.removed' }), 0);
    assert.equal(await AuditEvent.countDocuments({ action: /^account\./ }), 0);

    // The student who pressed the button is not given a way to read the outcome.
    resetRateLimits();
    const backDoor = await raw('GET', '/api/safety/reports', { cookie: world.b.cookie });
    assert.equal(backDoor.status, 404, 'a student can read their own reports back');
  });

  await t.test('FR-6.4: removed-content needs a sentence, and lands in three places', async () => {
    const world = await twoCards();
    const reviewer = await staff();
    const note = 'This reads like a promotion, not a student.';

    const filed = await report(world.a, { kind: 'profile', token: world.token, reason: OTHER_REASON });
    assert.equal(filed.status, 201, filed.text);
    const row = await onlyReport();

    const mute = await decide(reviewer, row._id, { action: 'removed-content' });
    assert.equal(mute.status, 400, 'a hold was taken with no reason behind it');
    assert.equal(mute.json.code, 'note_required');
    assert.match(mute.json.error, /will be shown/i);
    assert.equal((await Report.findById(row._id)).status, 'open', 'a refused decision still decided something');

    const res = await decide(reviewer, row._id, { action: 'removed-content', note });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.effect.held, true);
    assertCarriesNoPrivateHandles(res.text, [world.a, world.b]);

    // Place one: the report row.
    const after = await Report.findById(row._id).lean();
    assert.equal(after.status, 'actioned');
    assert.equal(after.decision, 'removed-content');
    assert.equal(after.decisionNote, note);

    // Place two: the profile — and the sentence goes out to its owner, which is the
    // only way a student learns why they stopped appearing.
    const held = await Profile.findOne({ userId: world.b.userId });
    assert.equal(held.review.status, 'held');
    assert.equal(held.review.reason, note);
    assert.ok(held.review.at instanceof Date);

    resetRateLimits();
    const own = await raw('GET', '/api/profile', { cookie: world.b.cookie });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.profile.matchable, false);
    assert.equal(own.json.profile.held, note, 'the owner was not given the hold as its own field');
    assert.ok(own.json.profile.missing.join(' ').includes(note), 'the owner was not told why');
    assert.match(own.json.profile.missing.join(' '), /Edit it and save to be shown again/);

    // A hold is not a suspension: the account is intact and signed in.
    assert.equal((await User.findById(world.b.userId)).status, 'active');
    resetRateLimits();
    assert.equal((await raw('GET', '/api/auth/me', { cookie: world.b.cookie })).status, 200);

    // Place three: both log rows, since FR-6.4’s act and FR-6.3’s decision are two
    // different things a later reader may want to ask about separately.
    assert.equal(await AuditEvent.countDocuments({ action: 'content.removed', subjectId: world.b.userId }), 1);
    assert.equal(await AuditEvent.countDocuments({ action: 'report.decided', subjectId: world.b.userId }), 1);

    // And the promise the profile screen just made out loud: a save lifts the hold,
    // because otherwise the sentence tells a student to do something that changes
    // nothing.
    resetRateLimits();
    const saved = await raw('PUT', '/api/profile', { cookie: world.b.cookie, body: finished({ gender: 'Man', lookingFor: 'Women', age: 21 }) });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.profile.held, null, 'the screen was still told it was on hold');
    assert.equal((await Profile.findOne({ userId: world.b.userId })).review.status, 'clean');
    resetRateLimits();
    assert.ok((await suggestionOf(world.a)).json.suggestion, 'the profile did not come back after the save it asked for');
  });

  await t.test('FR-6.3: a report is decided once, and only by its own four names', async () => {
    const world = await connectedPair();
    const reviewer = await staff();
    await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON });
    const row = await onlyReport();

    const first = await decide(reviewer, row._id, { action: 'dismissed' });
    assert.equal(first.status, 200, first.text);

    const again = await decide(reviewer, row._id, { action: 'banned' });
    assert.equal(again.status, 409, 'a decided report was reopened');
    assert.equal(again.json.code, 'already_decided');
    assert.equal((await User.findById(world.a.userId)).status, 'active', 'the second decision still took effect');

    const nonsense = await decide(reviewer, row._id, { action: 'delete-everything' });
    assert.equal(nonsense.status, 400);
    assert.equal(nonsense.json.code, 'bad_action');
    assert.ok(nonsense.json.error.includes('dismissed'), 'the refusal did not name the choices it has');

    resetRateLimits();
    const missing = await decide(reviewer, '000000000000000000000000', { action: 'dismissed' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'no_report');
  });

  await t.test('FR-6.3: a suspension signs the account out of everything it is in', async () => {
    const world = await connectedPair();
    const reviewer = await staff();
    const reason = 'Reported twice for harassment.';

    const res = await setStatus(reviewer, world.a.userId, { status: 'suspended', reason });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.status, 'suspended');
    assert.equal(res.json.threadsClosed, 1);
    assert.match(res.json.message, /signed out everywhere/i);
    assertCarriesNoPrivateHandles(res.text, [world.a, world.b]);

    // The session is gone, not merely distrusted: the cookie that worked a moment
    // ago is now nobody’s, and a fresh sign-in is refused for the right reason.
    resetRateLimits();
    assert.equal((await raw('GET', '/api/auth/me', { cookie: world.a.cookie })).status, 401);
    const again = await signIn(world.a.email);
    assert.equal(again.status, 403, again.text);
    assert.equal(again.json.code, 'account_inactive');
    assert.match(again.json.error, /paused/i);

    assert.equal((await User.findById(world.a.userId)).status, 'suspended');
    assert.equal((await User.findById(world.a.userId)).statusReason, reason);

    // The other half learns the thread stopped, and nothing about why or who.
    const match = await Match.findById(world.id).lean();
    assert.equal(match.status, 'closed');
    assert.equal(match.closedBy, null, 'a ban was recorded as a student walking away');
    resetRateLimits();
    const peer = await threadOf(world.b, world.id);
    assert.equal(peer.status, 200, peer.text);
    assert.equal(peer.json.thread.closedNotice, CLOSED_NOTICE);
    const shut = await send(world.b, world.id, 'are you there?');
    assert.equal(shut.status, 409);
    assert.equal(shut.json.code, 'thread_closed');

    // Two log rows, because two things happened: a person used the lever, and the
    // system closed the conversations that were left open.
    const lever = await AuditEvent.findOne({ action: 'account.suspended' }).lean();
    assert.equal(String(lever.actorId), String(reviewer.userId));
    assert.equal(String(lever.subjectId), String(world.a.userId));
    const auto = await AuditEvent.findOne({ action: 'threads.closed' }).lean();
    assert.equal(auto.automated, true);
    assert.equal(auto.actorId, null, 'an automated row blamed a person');
    assert.equal(auto.data.threads, 1);

    // Pressing it twice says so rather than closing the same threads again.
    const twice = await setStatus(reviewer, world.a.userId, { status: 'suspended', reason });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.changed, false);
    assert.equal(twice.json.threadsClosed, 0);
    assert.match(twice.json.message, /already suspended/);
    assert.equal(await AuditEvent.countDocuments({ action: 'account.suspended' }), 1);
  });

  await t.test('FR-6.3: a suspended account is out of the pool, and a reinstate puts it back', async () => {
    const world = await twoCards();
    const reviewer = await staff();

    assert.ok((await suggestionOf(world.a)).json.suggestion, 'the pool started out empty');

    const gone = await setStatus(reviewer, world.b.userId, { status: 'suspended', reason: 'Checking something.' });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.threadsClosed, 0, 'there was no thread to close, and it said so');
    assert.equal((await suggestionOf(world.a)).json.suggestion, null, 'a suspended student was still being suggested');

    // Staff read the account itself as a card while it is paused, and the card says
    // paused — which is the whole point of FR-6.5 over a silent status change.
    const card = await accountRecord(reviewer, world.b.userId);
    assert.equal(card.status, 200, card.text);
    assert.equal(card.json.account.status, 'suspended');
    assert.equal(card.json.account.reason, 'Checking something.');
    assertCarriesNoPrivateHandles(card.text, [world.a, world.b]);

    const back = await setStatus(reviewer, world.b.userId, { status: 'active' });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.status, 'active');
    assert.match(back.json.message, /the conversations that were closed stay closed/i);

    // The session that was dropped at the suspension does not come back with the
    // account; a reinstate is not an undo of signing out.
    resetRateLimits();
    assert.equal((await raw('GET', '/api/auth/me', { cookie: world.b.cookie })).status, 401);
    const signedIn = await signIn(world.b.email);
    assert.equal(signedIn.status, 200, signedIn.text);

    assert.ok((await suggestionOf(world.a)).json.suggestion, 'the pool never got them back');
    assert.equal(await AuditEvent.countDocuments({ action: 'account.reinstated', subjectId: world.b.userId }), 1);
  });

  await t.test('FR-6.3: a ban ends the account, and is not written as a departure', async () => {
    const world = await connectedPair();
    const reviewer = await staff();
    await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON });
    const row = await onlyReport();

    const res = await decide(reviewer, row._id, { action: 'banned', note: 'Not a student.' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.action, 'banned');
    assert.equal(res.json.effect.accountStatus, 'banned');
    assert.equal(res.json.effect.threads, 1);

    const user = await User.findById(world.a.userId).lean();
    assert.equal(user.status, 'banned');
    assert.equal(user.statusReason, 'Not a student.');

    // A ban keeps the data — it is not a deletion — but it keeps it unreadable to
    // the account, and closed to everyone else.
    assert.ok(await Profile.findOne({ userId: world.a.userId }), 'a ban deleted a profile');
    const match = await Match.findById(world.id).lean();
    assert.equal(match.status, 'closed');
    assert.equal(match.closedBy, null);
    resetRateLimits();
    assert.equal((await threadOf(world.b, world.id)).json.thread.closedNotice, CLOSED_NOTICE);

    const banned = await signIn(world.a.email);
    assert.equal(banned.status, 403);
    assert.match(banned.json.error, /closed for breaking the guidelines/i);

    assert.equal(await AuditEvent.countDocuments({ action: 'account.banned', subjectId: world.a.userId }), 1);
    // The word a report carries is 'banned'; the word on the account row is the
    // staff action, so the two cannot quietly drift apart.
    assert.equal((await Report.findById(row._id)).decision, 'banned');
  });

  await t.test('FR-6.4: the staff photo door is the fourth face door, and it is logged', async () => {
    const world = await twoCards();
    const reviewer = await staff();

    // Nothing on file yet, and the refusal says that rather than anything else. The
    // reviewer is the account with no photo, because a staff account is a student
    // account that never filled one in.
    const empty = await staffPhoto(reviewer, reviewer.userId);
    assert.equal(empty.status, 404);
    assert.equal(empty.json.code, 'no_photo');
    assert.equal(await AuditEvent.countDocuments({ action: 'photo.viewed' }), 0, 'a failed look was logged as a look');

    const uploaded = await uploadPhoto(world.b);
    assert.equal(uploaded.status, 200, uploaded.text);
    const stored = await Profile.findOne({ userId: world.b.userId });
    assert.ok(stored.photo.fileName);

    // FR-6.1's fourth kind, which is the reason this door has to exist at all: a
    // photo report nobody can look at is not reviewable.
    const filed = await report(world.a, { kind: 'photo', token: world.token, reason: vocab.REPORT_REASONS[1] });
    assert.equal(filed.status, 201, filed.text);

    const res = await staffPhoto(reviewer, world.b.userId);
    assert.equal(res.status, 200, res.text);
    // The bytes, exactly as stored — and not a filename, which no client may hold.
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual([...res.bytes], [...PNG], 'a staff photo response was not the stored file');
    assert.ok(!res.headers.get('content-disposition'), 'the photo door offered a filename to download');

    const card = await accountRecord(reviewer, world.b.userId);
    assert.equal(card.json.hasPhoto, true);
    assertCarriesNoPrivateHandles(card.text, [world.a, world.b], [stored.photo.fileName]);

    // FR-6.5 asks who looked at a face. This is the only door in the API that
    // answers it, and it answers it every single time.
    await staffPhoto(reviewer, world.b.userId);
    const looks = await AuditEvent.find({ action: 'photo.viewed' }).lean();
    assert.equal(looks.length, 2, 'a second look at the same face went unrecorded');
    for (const look of looks) {
      assert.equal(String(look.actorId), String(reviewer.userId));
      assert.equal(String(look.subjectId), String(world.b.userId));
      assertCarriesNoPrivateHandles(JSON.stringify(look), [world.a, world.b], [stored.photo.fileName]);
    }

    // A student cannot borrow the door, not even for their own picture — their own
    // photo has its own route, and this one does not open for them.
    resetRateLimits();
    const stolen = await staffPhoto(world.b, world.b.userId);
    assert.equal(stolen.status, 404, 'a student reached the staff photo door');
    resetRateLimits();
    assert.equal((await raw('GET', '/api/profile/photo', { cookie: world.b.cookie })).status, 200, 'the owner lost their own photo');

    // The file on disk is the one thing none of this has changed.
    assert.ok(await photos.read(stored.photo.fileName));
  });

  await t.test('FR-6.5: one account’s record is its reports and its log, in that order', async () => {
    const world = await connectedPair();
    const reviewer = await staff();
    await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON });
    const row = await onlyReport();
    await decide(reviewer, row._id, { action: 'suspended', note: 'Paused while we look at the rest.' });

    const res = await accountRecord(reviewer, world.a.userId);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assertCarriesNoPrivateHandles(res.text, [world.a, world.b]);

    assert.equal(res.json.userId, String(world.a.userId));
    assert.equal(res.json.account.status, 'suspended');
    assert.equal(res.json.reports.length, 1);
    assert.equal(res.json.reports[0].excerpt, 'I would rather not be spoken to like that.');
    assert.equal(res.json.reports[0].decision, 'suspended');

    const actions = res.json.log.map(entry => entry.action);
    // Newest first, so the top of the list is what a moderator is reading for —
    // compared on the stamps rather than by position, because two of these rows are
    // written in the same millisecond.
    const stamps = res.json.log.map(entry => new Date(entry.at).getTime());
    assert.deepEqual([...stamps].sort((x, y) => y - x), stamps);
    assert.ok(actions.includes('account.suspended'), actions.join(','));
    assert.ok(actions.includes('report.decided'), actions.join(','));
    assert.ok(actions.includes('report.filed'), actions.join(','));
    assert.equal(actions.filter(a => a === 'report.decided').length, 1);
    assert.ok(res.json.log.every(entry => entry.by === null || typeof entry.by === 'string'));

    // An id that belongs to nobody reads as an account that is gone, not as a broken
    // screen: the alternative is a 404 that a moderator files as a bug. Only staff
    // can ask, and the card carries no content either way.
    resetRateLimits();
    const nobody = await accountRecord(reviewer, '000000000000000000000000');
    assert.equal(nobody.status, 200, nobody.text);
    assert.equal(nobody.json.account.status, 'deleted');
    assert.deepEqual(nobody.json.reports, []);
    assert.deepEqual(nobody.json.log, []);
    resetRateLimits();
    assert.equal((await setStatus(reviewer, '000000000000000000000000', { status: 'banned' })).json.code, 'no_account');
  });

  await t.test('NFR-3.5: a moderator leaving does not undo what they decided', async () => {
    const world = await connectedPair();
    const leaving = await staff();
    const staying = await staff();

    await report(world.b, { kind: 'message', messageId: world.messageId, reason: REASON });
    const row = await onlyReport();
    const decided = await decide(leaving, row._id, { action: 'suspended', note: 'Paused while we look at the rest.' });
    assert.equal(decided.status, 200, decided.text);

    resetRateLimits();
    const gone = await raw('DELETE', '/api/auth/account', {
      cookie: leaving.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(await User.countDocuments({ email: leaving.email }), 0);

    // A decision about *another* student is a record about that student, not personal
    // data of whoever pressed the button, so it survives: the account stays paused,
    // and the report row still says which decision was taken and when.
    const after = await Report.findById(row._id).lean();
    assert.equal(after.status, 'actioned');
    assert.equal(after.decision, 'suspended');
    assert.equal(String(after.decidedBy), String(leaving.userId), 'the record of who decided went with their account');
    assert.equal((await User.findById(world.a.userId)).status, 'suspended', 'a moderation decision was undone by a resignation');

    // What does go is that person's own activity log — the rows that name them as the
    // actor. FR-6.5's durable answer to "what did staff do about this" is the report
    // row above, which is why the decision lives on the report and not only in a log.
    resetRateLimits();
    const listed = await raw('GET', '/api/staff/reports?status=all', { cookie: staying.cookie });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.count, 1);
    const shown = listed.json.reports[0];
    assert.equal(shown.decision, 'suspended');
    assert.equal(shown.decisionNote, 'Paused while we look at the rest.');
    assert.equal(shown.reported.account.status, 'suspended');
    assert.equal(shown.reporter.account.status, 'active');
    assertCarriesNoPrivateHandles(listed.text, [world.a, world.b, leaving, staying]);

    resetRateLimits();
    const record = await accountRecord(staying, world.a.userId);
    assert.equal(record.json.account.status, 'suspended');
    assert.ok(record.json.reports.some(entry => entry.decision === 'suspended'));

    // And the account that left takes the queue with it: no session, no door.
    resetRateLimits();
    assert.equal((await raw('GET', '/api/staff/reports', { cookie: leaving.cookie })).status, 401);
  });

  /**
   * FR-8.1, and the last subtest in the file because it empties the collections to
   * prove the empty case.
   *
   * The claim worth testing is not "the counts add up" — a test that recomputes the
   * same SUM is a copy of the code. It is that the page can only ever show numbers:
   * every string in the response is a date or one of the API's own three explanatory
   * notes, so there is no shape by which a student's sentence, name or address could
   * appear on a screen a moderator shares.
   */
  await t.test('FR-8.1: the platform numbers are counts, and no student’s words are among them', async () => {
    const world = await connectedPair();
    const reviewer = await staff();

    const before = await statsFor(reviewer);
    assert.equal(before.status, 200, before.text);

    // Three more facts for the counters to find: a second message in the chat, a
    // decline still on file, and one pair that has revealed. The reveal is written
    // straight onto the pair because *how* a reveal happens is stage 6's proof; this
    // subtest is only about what the counting does with it.
    const SECRET = 'zebra-quantum-9137';
    const second = await send(world.a, world.id, `My roommate calls me ${SECRET} so use that name here.`);
    assert.equal(second.status, 201, second.text);

    const other = await student('staff-c', { gender: 'Man', lookingFor: 'Women', age: 21 });
    const shown = await suggestionOf(other);
    assert.ok(shown.json.suggestion, shown.text);
    resetRateLimits();
    const declined = await raw('POST', '/api/matches/suggestion/pass', {
      cookie: other.cookie,
      body: { token: shown.json.suggestion.token },
    });
    assert.equal(declined.status, 200, declined.text);

    const at = new Date();
    await Match.updateOne(
      { _id: world.id },
      {
        $set: {
          'reveal.status': 'revealed',
          'reveal.askedAt': at,
          'reveal.revealedAt': at,
          'reveal.consent': [
            { userId: world.a.userId, at },
            { userId: world.b.userId, at },
          ],
        },
      }
    );

    const result = await statsFor(reviewer);
    assert.equal(result.status, 200, result.text);
    const s = result.json;
    const b = before.json;

    assert.equal(s.conversation.messages - b.conversation.messages, 1, 'a message was written and the count did not move');
    assert.equal(s.matching.chatsOpened, b.matching.chatsOpened);
    assert.equal(s.matching.declinesOnFile - b.matching.declinesOnFile, 1, 'a decline was filed and the count did not move');
    assert.equal(s.reveal.revealed - b.reveal.revealed, 1);
    assert.equal(s.reveal.asked - b.reveal.asked, 1);
    assert.equal(s.accounts.total - b.accounts.total, 1, 'the third student is not in the head count');

    // A rate the screen can be argued with: it has to come back down to the two
    // counts printed beside it, computed here by hand rather than by the service.
    assert.equal(
      s.matching.matchRate,
      Math.round((s.matching.chatsOpened / (s.matching.chatsOpened + s.matching.declinesOnFile)) * 1000) / 10,
      'the match rate is not the rate over the counts it shows'
    );
    assert.equal(s.reveal.revealRate, Math.round((s.reveal.revealed / s.matching.chatsOpened) * 1000) / 10);
    assert.ok(s.basis.matchRate && s.basis.revealRate, 'a rate arrived without its denominator spelled out');

    // The fortnight table has to hold every day, including the ones nothing happened.
    assert.equal(s.trend.length, 14);
    assert.equal(s.trend[13].date, new Date().toISOString().slice(0, 10));
    assert.ok(s.trend.every(row => ['date', 'accounts', 'chats', 'messages', 'reveals'].every(k => k in row)));
    // Everything this run created was created today, so the two most recent buckets
    // hold every chat between them — the aggregation and the plain count agree.
    assert.equal(s.trend[13].chats + s.trend[12].chats, s.matching.chatsOpened);

    // The privacy claim, checked structurally rather than by looking for one word.
    assertCarriesNoPrivateHandles(result.text, [world.a, world.b, other, reviewer]);
    assert.ok(!result.text.includes(SECRET), 'a message body reached the statistics');
    assert.ok(!/[0-9a-f]{24}/.test(result.text), 'an account id reached the statistics');

    const notes = new Set(Object.values(s.basis));
    const strings = [];
    const walk = node => {
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(s);
    for (const value of strings) {
      assert.ok(
        notes.has(value) || /^\d{4}-\d{2}-\d{2}/.test(value),
        `the statistics carried somebody's words: ${value}`
      );
    }

    // A rate over nothing is blank, not zero: on a database with no chats yet, "0%"
    // would read as students not revealing rather than as nobody having asked.
    await Match.deleteMany({});
    await Pass.deleteMany({});
    const empty = await statsFor(reviewer);
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.json.matching.matchRate, null, 'an empty database was reported as a 0% match rate');
    assert.equal(empty.json.reveal.revealRate, null);
    assert.equal(empty.json.conversation.messagesPerChat, null);
    assert.equal(empty.json.matching.chatsOpened, 0);
  });

  await t.test('FR-8.2: staff can decide somebody is not a student, and that person is told why', async () => {
    const world = await twoCards(); // a is being shown b, and nobody else has a profile
    const reviewer = await staff();
    const before = await statsFor(reviewer);
    assert.equal(before.status, 200, before.text);

    const NOTE = 'No registration record for this year.';

    // A revocation that cannot explain itself is not submitted at all: the sentence is
    // the student's half of the decision, not a comment left for the next moderator.
    const mute = await setStudent(reviewer, world.b.userId, { status: 'revoked' });
    assert.equal(mute.status, 400, mute.text);
    assert.equal(mute.json.code, 'note_required');
    assert.equal((await User.findById(world.b.userId)).student.status, 'attested', 'a refused write still wrote');

    // `attested` is where every account starts and is not a thing a staff member sets.
    const wrong = await setStudent(reviewer, world.b.userId, { status: 'attested', note: NOTE });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(wrong.json.code, 'bad_status');

    const revoked = await setStudent(reviewer, world.b.userId, { status: 'revoked', note: NOTE });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.json.accountStatus, 'suspended');
    assertCarriesNoPrivateHandles(revoked.text, [world.a, world.b, reviewer]);

    const row = await User.findById(world.b.userId);
    assert.equal(row.student.status, 'revoked');
    assert.equal(row.student.note, NOTE);
    assert.equal(String(row.student.by), String(reviewer.userId));
    assert.ok(row.student.at instanceof Date);

    // The decision is not a flag sitting beside a rule nobody reads. Revoking borrows the
    // account's own status, so the one field every route already asks is the one that moved.
    resetRateLimits();
    assert.equal((await suggestionOf(world.b)).status, 401, 'a revoked account kept its session');
    resetRateLimits();
    const after = await suggestionOf(world.a);
    assert.equal(after.status, 200, after.text);
    assert.ok(!after.json.suggestion, 'somebody staff decided is not a student is still being suggested');

    // The only moment a paused account can be reached is their own sign-in attempt, so
    // that is where the reason lives. Password first, note second: an attacker probing
    // addresses never gets here.
    resetRateLimits();
    const told = await signIn(world.b.email);
    assert.equal(told.status, 403, told.text);
    assert.equal(told.json.code, 'not_a_student');
    assert.ok(told.text.includes(NOTE), 'the student was not handed the staff member\'s own sentence');

    // Three places, one story: the account, the record a moderator reads, the numbers.
    const record = await accountRecord(reviewer, world.b.userId);
    assert.equal(record.status, 200, record.text);
    assert.equal(record.json.account.status, 'suspended');
    assert.equal(record.json.account.student.status, 'revoked');
    assert.equal(record.json.account.student.note, NOTE);
    const actions = record.json.log.map(entry => entry.action);
    assert.ok(actions.includes('student.revoked'), 'the eligibility decision was not logged');
    assert.ok(actions.includes('account.suspended'), 'the pause it caused was logged as its own act');

    const counted = await statsFor(reviewer);
    assert.equal(counted.json.accounts.studentRevoked, before.json.accounts.studentRevoked + 1);
    assert.equal(counted.json.accounts.suspended, before.json.accounts.suspended + 1);

    // Verifying is the way back — and it opens only what this tool shut.
    const verified = await setStudent(reviewer, world.b.userId, { status: 'verified' });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.accountStatus, 'active');
    resetRateLimits();
    assert.equal((await signIn(world.b.email)).status, 200, 'a restored student could not sign back in');
    resetRateLimits();
    assert.ok((await suggestionOf(world.a)).json.suggestion, 'a restored student never came back into the pool');

    const restored = await accountRecord(reviewer, world.b.userId);
    assert.equal(restored.json.account.student.status, 'verified');
    assert.equal(restored.json.account.student.note, null, 'verifying carried over the revocation\'s sentence');
    const reopened = await statsFor(reviewer);
    assert.equal(reopened.json.accounts.studentRevoked, before.json.accounts.studentRevoked);

    // The other question. A report paused this account; confirming it belongs to the
    // university is a different decision and must not undo the first one.
    const reported = await student('staff-reported', { gender: 'Man', lookingFor: 'Women', age: 23 });
    const paused = await setStatus(reviewer, reported.userId, { status: 'suspended', reason: 'Twice reported for the same line.' });
    assert.equal(paused.status, 200, paused.text);
    const checked = await setStudent(reviewer, reported.userId, { status: 'verified' });
    assert.equal(checked.status, 200, checked.text);
    assert.equal(checked.json.accountStatus, 'suspended', 'verifying a student undid a moderation pause');
    resetRateLimits();
    const stillOut = await signIn(reported.email);
    assert.equal(stillOut.status, 403, stillOut.text);
    assert.equal(stillOut.json.code, 'account_inactive', 'a moderation pause was re-labelled a student one');
    assert.equal((await User.findById(reported.userId)).student.status, 'verified');
  });
});
