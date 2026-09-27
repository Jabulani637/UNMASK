'use strict';
/**
 * Stage 8 proven over real HTTP, a real WebSocket and the real outbox — FR-7.1 to
 * FR-7.4, and the POPIA half of NFR-3.5.
 *
 * Four things this file is structured around:
 *
 * It checks the *silences*. Almost every claim stage 8 makes is a negative: no mail
 * unless the student asked for one, no notice for a thread that is already on
 * screen, no second nudge piled on the first, no name in a sentence that is pushed
 * at someone who is not looking. A negative about a side effect can only be proved
 * by looking for the side effect, so the outbox directory is snapshotted before each
 * send and diffed after it, and the bell is read back through the same route the nav
 * uses.
 *
 * It reads the bytes of what a student is told. The notices and the mails are
 * searched for the sender's address and reveal name, because the whole design rests
 * on the wording being the server's (`TEXT` in services/notifications.js) and no
 * caller being able to put a string into it.
 *
 * It uses a real socket for FR-7.2. "Not actively viewing" is per-connection state
 * inside the process, so the only honest test of it is a connection that declares a
 * thread and one that stops declaring it, with a message sent in between.
 *
 * And it keeps the account boundary visible: a notice belongs to its reader, so
 * marking read is tried with a stranger's id as well as the caller's own.
 */

const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
// One database per suite file: `node --test` runs the files in parallel.
testUrl.pathname = '/unmask_test_notify';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-notify';
process.env.PHOTO_DIR = './storage/test-photos-notify';

const WebSocket = require('ws');

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const { attachChatServer } = require('../src/realtime');
const db = require('../src/db');
const { seedTestInstitutions } = require('./support/institutions');
const User = require('../src/models/User');
const Profile = require('../src/models/Profile');
const Match = require('../src/models/Match');
const Message = require('../src/models/Message');
const Notification = require('../src/models/Notification');
const Pass = require('../src/models/Pass');
const vocab = require('../src/domain/vocabulary');
const chat = require('../src/services/chat');
const notifications = require('../src/services/notifications');
const mail = require('../src/services/mail');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'blue-koala-printing-42';
const ASKER_NAME = 'Notify-Askername';
const PEER_NAME = 'Notify-Peername';

let server;
let base;
let wsUrl;

// ---------------------------------------------------------------- HTTP helpers

async function raw(method, route, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body || method === 'DELETE') headers['content-type'] = 'application/json';

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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A signed-in student with a matchable profile, built through the real routes. */
async function student(local, over = {}) {
  const account = await bareStudent(local);
  const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, body: finished(over) });
  assert.equal(saved.status, 200, saved.text);
  account.profileId = (await Profile.findOne({ userId: account.userId }))._id;
  return account;
}

/** A signed-in student with no profile at all — the state before FR-7.1 can fire. */
async function bareStudent(local) {
  const address = email(local);
  resetRateLimits();
  await raw('POST', '/api/auth/register', { body: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });
  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { body: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);

  const account = { email: address, cookie: signedIn.cookie };
  account.userId = (await User.findOne({ email: address }))._id;
  return account;
}

async function suggestion(account) {
  resetRateLimits();
  return raw('GET', '/api/matches/suggestion', { cookie: account.cookie });
}

async function connect(account, token) {
  resetRateLimits();
  return raw('POST', '/api/matches/suggestion/connect', { cookie: account.cookie, body: { token } });
}

async function sendViaRest(account, id, body) {
  resetRateLimits();
  return raw('POST', `/api/chats/${id}/messages`, { cookie: account.cookie, body: { body } });
}

/** What a student's bell holds, read the way the nav reads it. */
async function bell(account, limit = 30) {
  resetRateLimits();
  const res = await raw('GET', `/api/notifications?limit=${limit}`, { cookie: account.cookie });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

async function setSettings(account, body) {
  resetRateLimits();
  const res = await raw('PUT', '/api/notifications/settings', { cookie: account.cookie, body });
  assert.equal(res.status, 200, res.text);
  return res.json.notifications;
}

/** Empty what a thread is made of, keeping the accounts and their cookies. */
async function clearWorld() {
  await Profile.deleteMany({});
  await Match.deleteMany({});
  await Message.deleteMany({});
  await Pass.deleteMany({});
  await Notification.deleteMany({});
  chat._internal.resetBudget();
}

async function connectedPair(localA = 'notify-a', localB = 'notify-b') {
  await clearWorld();
  const a = await student(localA, { gender: 'Woman', lookingFor: 'Men', revealName: ASKER_NAME });
  const b = await student(localB, { gender: 'Man', lookingFor: 'Women', age: 22, revealName: PEER_NAME });

  // Building the pair is itself a FR-7.1 event: B's save puts B into A's pool, so A
  // has been told "someone new" by the fixtures. Every subtest below reads a bell
  // that started empty, which is what makes `unread === 1` mean "this send".
  await Notification.deleteMany({});

  const first = await suggestion(a);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.suggestion, 'A has to be shown somebody to connect with');

  const made = await connect(a, first.json.suggestion.token);
  assert.equal(made.status, 201, made.text);

  return { a, b, id: made.json.match.id };
}

// ------------------------------------------------------------- the mail outbox

function outboxSnapshot() {
  try {
    return new Set(fs.readdirSync(mail.OUTBOX_DIR));
  } catch {
    return new Set();
  }
}

/** Files the mailer wrote since `before`, or null when it wrote none. */
async function freshMails(before) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const fresh = [...outboxSnapshot()].filter(file => !before.has(file));
    if (fresh.length) {
      return fresh.map(file => ({
        file,
        text: fs.readFileSync(path.join(mail.OUTBOX_DIR, file), 'utf8'),
      }));
    }
    await wait(50);
  }
  return null;
}

// ----------------------------------------------------------------- WS plumbing

/**
 * A socket that says which thread its owner is looking at.
 *
 * FR-7.2's whole rule lives in this per-connection state, so it is driven here
 * through the wire rather than by reaching into the server's maps.
 */
function openSocket(account) {
  const frames = [];
  const waiters = [];

  const ws = new WebSocket(wsUrl, { headers: { cookie: account.cookie, origin: config.webOrigins[0] } });

  ws.on('message', data => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });

  function waitFor(match, limit = 4000) {
    const existing = frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame matched; saw ${JSON.stringify(frames)}`)), limit);
      waiters.push({ match, resolve: frame => { clearTimeout(timer); resolve(frame); } });
    });
  }

  return {
    ws,
    frames,
    waitFor,
    opened: () => waitFor(frame => frame.type === 'connected'),
    /** Declare a thread — or stop declaring one when passed null. */
    view: async threadId => {
      ws.send(JSON.stringify({ type: 'view', threadId }));
      // The server handles frames one at a time; a beat makes sure the declaration
      // has been read before a message is sent against it.
      await wait(150);
    },
    close: () =>
      new Promise(resolve => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.on('close', resolve);
        ws.close();
      }),
  };
}

// ------------------------------------------------------------------- the suite

test('stage 8 — notifications: who is told, how, and when not', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');

  await db.connect();
  await db.ensureIndexes();
  await seedTestInstitutions();
  await User.deleteMany({});
  await clearWorld();

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  const chatServer = attachChatServer(server);

  t.after(async () => {
    chatServer.close();
    server.close();
    await clearWorld();
    await User.deleteMany({});
    await db.disconnect();
  });

  await t.test('every notification route wants a signed-in browser', async () => {
    for (const [method, route, body] of [
      ['GET', '/api/notifications'],
      ['GET', '/api/notifications/settings'],
      ['POST', '/api/notifications/read', { all: true }],
      ['PUT', '/api/notifications/settings', { email: true }],
    ]) {
      const res = await raw(method, route, { body });
      assert.equal(res.status, 401, `${method} ${route} answered without a session`);
    }
  });

  await t.test('a message tells the other half once, and never its own author', async () => {
    const world = await connectedPair();
    const sent = await sendViaRest(world.a, world.id, 'words for the bell');
    assert.equal(sent.status, 201, sent.text);

    const [mine, theirs] = await Promise.all([bell(world.a), bell(world.b)]);
    assert.equal(mine.unread, 0, 'a student is not notified about their own message');
    assert.equal(theirs.unread, 1, 'the other half is');
    assert.equal(theirs.notifications[0].kind, 'message');
    assert.equal(theirs.notifications[0].body, notifications.TEXT.message);
    assert.equal(theirs.notifications[0].threadId, world.id, 'and it points at the pair, which only they can open');

    // The wording is the server's, so nothing identifying the sender is in it.
    const wire = JSON.stringify(theirs);
    assert.ok(!wire.includes(world.a.email), 'the bell does not carry the sender’s address');
    assert.ok(!wire.includes(ASKER_NAME), 'nor the name behind it');
    assert.ok(!wire.includes(String(world.a.userId)), 'nor the sender’s account id');
  });

  await t.test('a thread that is on screen is not news (FR-7.2)', async () => {
    const world = await connectedPair();
    const socket = openSocket(world.b);
    // Open in `try`, closed in `finally`: a red assertion here must report red, not
    // hold the process open with a socket nobody shut.
    try {
      await socket.opened();

      await socket.view(world.id);
      const sent = await sendViaRest(world.a, world.id, 'while you are reading');
      assert.equal(sent.status, 201, sent.text);
      await socket.waitFor(frame => frame.type === 'message' && frame.message?.body === 'while you are reading');

      const whileViewing = await bell(world.b);
      assert.equal(whileViewing.unread, 0, 'the words arrived live, so no notice was written');

      await socket.view(null);
      const after = await sendViaRest(world.a, world.id, 'after you left');
      assert.equal(after.status, 201, after.text);
      await wait(300);

      const leftThread = await bell(world.b);
      assert.equal(leftThread.unread, 1, 'and once they have left, the same send does tell them');
      assert.equal(leftThread.notifications[0].body, notifications.TEXT.message);
    } finally {
      await socket.close();
    }
  });

  await t.test('email is opt-in, and the mail it sends names nobody (FR-7.4)', async () => {
    const world = await connectedPair();

    const silent = await freshMails(outboxSnapshot());
    assert.equal(silent, null, 'nothing is mailed before anything happens');

    const beforeQuiet = outboxSnapshot();
    await sendViaRest(world.a, world.id, 'a bell only');
    assert.deepEqual(
      [...outboxSnapshot()].filter(file => !beforeQuiet.has(file)),
      [],
      'a message send mails nobody while the switch is off (the default)'
    );
    assert.equal((await bell(world.b)).unread, 1, 'the in-app notice still arrives');

    const settings = await setSettings(world.b, { email: true });
    assert.equal(settings.email, true);
    assert.equal(settings.inApp, true, 'and the other switches keep whatever they were');

    const beforeMail = outboxSnapshot();
    await sendViaRest(world.a, world.id, 'and an email too');
    const mails = await freshMails(beforeMail);
    assert.ok(mails, 'the next send after opting in does mail');
    assert.equal(mails.length, 1, 'one event is one mail, not one per channel switch');
    assert.ok(mails[0].text.includes(notifications.TEXT.message), 'the same sentence the bell shows');
    assert.ok(!mails[0].text.includes(world.a.email), 'and it names nobody');
    assert.ok(!mails[0].text.includes(ASKER_NAME), 'not even a reveal name that already exists');
    assert.ok(mails[0].text.includes('names nobody'), 'it says so to the reader as well');
  });

  await t.test('the new-match nudge can be refused on its own (FR-7.4)', async () => {
    const world = await connectedPair();
    const before = await bell(world.b);
    assert.equal(before.unread, 0);

    await setSettings(world.b, { suggestions: false });
    const refused = await notifications.notify({ userId: world.b.userId, kind: 'suggestion' });
    assert.deepEqual(refused, { inApp: false, email: false, skipped: 'suggestions-off' });
    assert.equal((await bell(world.b)).unread, 0, 'nothing was stored in either channel');

    await setSettings(world.b, { suggestions: true });
    const accepted = await notifications.notify({ userId: world.b.userId, kind: 'suggestion' });
    assert.equal(accepted.inApp, true);

    const res = await notifications.notify({ userId: world.b.userId, kind: 'message' });
    assert.equal(res.inApp, true, 'a message notice is not affected by that switch at all');
  });

  await t.test('only the two reveal moments ring, and neither names anybody (FR-7.3)', async () => {
    const world = await connectedPair();
    for (const body of ['one', 'two', 'three']) {
      assert.equal((await sendViaRest(world.a, world.id, body)).status, 201, body);
    }

    resetRateLimits();
    const asked = await raw('POST', `/api/reveals/${world.id}/ask`, { cookie: world.a.cookie });
    assert.equal(asked.status, 200, asked.text);
    await wait(300);

    assert.ok(
      (await bell(world.b)).notifications.some(row => row.kind === 'reveal-request'),
      'the student who was asked is told, in words that describe no one'
    );
    assert.equal(
      await Notification.countDocuments({ userId: world.a.userId, kind: 'reveal-request' }),
      0,
      'and the asker is not told about their own press'
    );

    const answered = await raw('POST', `/api/reveals/${world.id}/answer`, {
      cookie: world.b.cookie,
      body: { accept: true },
    });
    assert.equal(answered.status, 200, answered.text);
    await wait(300);

    const done = await Notification.find({ kind: 'reveal-done' }).select('userId');
    assert.equal(new Set(done.map(row => String(row.userId))).size, 2, 'the yes that lands second tells both halves');

    // The one moment a name exists on the wire between two accounts, in a sentence
    // pushed at someone who is not looking: it must still carry neither.
    const wire = JSON.stringify(
      await Notification.find({ kind: { $in: ['reveal-request', 'reveal-done'] } }).lean()
    );
    assert.ok(wire.length > 2, 'the rows above exist');
    assert.ok(!wire.includes(ASKER_NAME), `a reveal notice does not carry "${ASKER_NAME}"`);
    assert.ok(!wire.includes(PEER_NAME), `nor "${PEER_NAME}"`);
  });

  await t.test('a profile entering somebody’s pool tells them once (FR-7.1)', async () => {
    await clearWorld();
    // The viewer is built after the clear, because a cleared profile is a profile
    // that can be nobody's audience.
    const viewer = await student('notify-viewer', { gender: 'Woman', lookingFor: 'Men', age: 20 });
    assert.equal((await bell(viewer)).unread, 0, 'a fresh bell');

    const newcomer = await bareStudent('notify-newcomer');
    const firstSave = await raw('PUT', '/api/profile', {
      cookie: newcomer.cookie,
      body: finished({ gender: 'Man', lookingFor: 'Women', age: 22 }),
    });
    assert.equal(firstSave.status, 200, firstSave.text);
    await wait(400);

    const told = await bell(viewer);
    assert.equal(told.unread, 1, 'the viewer is told there is somebody new');
    assert.equal(told.notifications[0].kind, 'suggestion');

    // A second change the engine filters on, while the first nudge is unread.
    const secondSave = await raw('PUT', '/api/profile', {
      cookie: newcomer.cookie,
      body: finished({ gender: 'Man', lookingFor: 'Women', age: 23, year: '3rd year' }),
    });
    assert.equal(secondSave.status, 200, secondSave.text);
    await wait(400);

    const piled = await bell(viewer);
    assert.equal(piled.unread, 1, 'one unread nudge is enough; the sentence does not count what it points at');

    // An edit that changes nothing the engine filters on tells nobody, unread or not.
    await raw('POST', '/api/notifications/read', { cookie: viewer.cookie, body: { all: true } });
    const samePool = await raw('PUT', '/api/profile', {
      cookie: newcomer.cookie,
      body: finished({ gender: 'Man', lookingFor: 'Women', age: 23, year: '3rd year', interests: ['Amapiano'] }),
    });
    assert.equal(samePool.status, 200, samePool.text);
    await wait(400);
    assert.equal((await bell(viewer)).unread, 0, 're-typing interests is not a new match');
  });

  await t.test('a notice is its reader’s: read markers cannot reach a stranger', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, 'one for b');
    await sendViaRest(world.b, world.id, 'one for a');
    resetRateLimits();

    const theirs = await Notification.findOne({ userId: world.a.userId }).select('_id');
    assert.ok(theirs, 'A has a notice of their own');

    resetRateLimits();
    const stolen = await raw('POST', '/api/notifications/read', {
      cookie: world.b.cookie,
      body: { ids: [String(theirs._id)] },
    });
    assert.equal(stolen.status, 200, stolen.text);
    assert.equal(stolen.json.marked, 0, 'A’s notice is not in B’s filter to begin with');
    assert.ok((await Notification.findById(theirs._id)).readAt === null, 'and it is still unread');

    const mine = await bell(world.b);
    const own = mine.notifications.map(row => row.id);
    resetRateLimits();
    const marked = await raw('POST', '/api/notifications/read', { cookie: world.b.cookie, body: { ids: own } });
    assert.equal(marked.json.marked, own.length);
    assert.equal((await bell(world.b)).unread, 0);
  });

  await t.test('a paused account is not told, and a deleted one leaves nothing', async () => {
    const world = await connectedPair();

    await User.updateOne({ _id: world.b.userId }, { $set: { status: 'suspended' } });
    const paused = await notifications.notify({ userId: world.b.userId, kind: 'message' });
    assert.deepEqual(paused, { inApp: false, email: false, skipped: 'not-notifiable' });
    await User.updateOne({ _id: world.b.userId }, { $set: { status: 'active' } });

    await sendViaRest(world.a, world.id, 'a row to delete later');
    assert.ok((await bell(world.b)).unread >= 1, 'B holds at least one notice');

    resetRateLimits();
    const gone = await raw('DELETE', '/api/auth/account', {
      cookie: world.b.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(gone.status, 200, gone.text);
    assert.ok(gone.json.removed.notifications >= 1, 'the tally counts the bell it cleared');
    assert.equal(
      await Notification.countDocuments({ userId: world.b.userId }),
      0,
      'NFR-3.5: the bell is erased with the person'
    );
  });
});
