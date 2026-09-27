'use strict';
/**
 * Stage 6 — two students agreeing to stop being anonymous to each other.
 * FR-5.1 to FR-5.6, and the privacy floor under them: FR-2.3, FR-2.6, NFR-3.3.
 *
 * The claims this stage makes are mostly negative — no name before both yeses, no
 * photo before both yeses, no id on the socket, no un-reveal — and a negative
 * claim about a payload can only be proved by reading the payload. So every
 * subtest below looks at bytes, and the ones about consent look at the database
 * row re-read fresh, because a write that succeeds in memory and never reaches
 * Mongo is exactly the bug an in-memory assertion cannot see.
 *
 * Two students, and only two, are enough to break a reveal: most subtests rebuild
 * the pair, since "the other half has not answered" is a different world from
 * "the other half said no".
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
testUrl.pathname = '/unmask_test_reveal';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-reveal';
process.env.PHOTO_DIR = './storage/test-photos-reveal';

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
const Pass = require('../src/models/Pass');
const vocab = require('../src/domain/vocabulary');
const chat = require('../src/services/chat');
const reveal = require('../src/services/reveal');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');
const { png } = require('./fixtures/images');

const PASSWORD = 'blue-koala-printing-42';
const ASKER_NAME = 'Asker-Revealname';
const PEER_NAME = 'Peer-Revealname';

let server;
let base;
let wsUrl;

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
  // Bytes first, text second: the photo route returns a PNG, and a PNG decoded as
  // UTF-8 is not the picture that went in.
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
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
    buffer,
    type: res.headers.get('content-type'),
    cache: res.headers.get('cache-control'),
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

async function uploadPhoto(account, buffer) {
  const form = new FormData();
  form.append('photo', new Blob([buffer]), 'me.png');
  resetRateLimits();
  return raw('POST', '/api/profile/photo', { cookie: account.cookie, form });
}

async function send(account, id, body) {
  resetRateLimits();
  return raw('POST', `/api/chats/${id}/messages`, { cookie: account.cookie, body: { body } });
}

async function threadOf(account, id) {
  resetRateLimits();
  return raw('GET', `/api/chats/${id}`, { cookie: account.cookie });
}

/** One student's view of the pair's reveal state, read the way a screen reads it. */
async function revealStateOf(account, id) {
  const res = await threadOf(account, id);
  assert.equal(res.status, 200, res.text);
  return res.json.thread.reveal;
}

function ask(account, id) {
  resetRateLimits();
  return raw('POST', `/api/reveals/${id}/ask`, { cookie: account.cookie });
}
function answer(account, id, accept) {
  resetRateLimits();
  return raw('POST', `/api/reveals/${id}/answer`, { cookie: account.cookie, body: { accept } });
}
function revoke(account, id) {
  resetRateLimits();
  return raw('POST', `/api/reveals/${id}/revoke`, { cookie: account.cookie });
}
function revealedProfile(account, id) {
  resetRateLimits();
  return raw('GET', `/api/reveals/${id}/profile`, { cookie: account.cookie });
}
function revealedPhoto(account, id) {
  resetRateLimits();
  return raw('GET', `/api/reveals/${id}/photo`, { cookie: account.cookie });
}

/**
 * The pair this suite is about, made the way a student makes one: a suggestion,
 * a connect, and a thread that both halves can open.
 *
 * `a` is the one who will ask, `b` the one who will be asked, and `b` has a photo
 * on file so the second door has something behind it.
 */
async function connectedPair() {
  await clearWorld();
  const a = await student('reveal-a', {
    gender: 'Woman',
    lookingFor: 'Men',
    revealName: ASKER_NAME,
  });
  const b = await student('reveal-b', {
    gender: 'Man',
    lookingFor: 'Women',
    age: 22,
    revealName: PEER_NAME,
  });

  const uploaded = await uploadPhoto(b, png());
  assert.equal(uploaded.status, 200, uploaded.text);

  resetRateLimits();
  const first = await raw('GET', '/api/matches/suggestion', { cookie: a.cookie });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.suggestion, 'the asker has to be shown somebody');

  resetRateLimits();
  const made = await raw('POST', '/api/matches/suggestion/connect', { cookie: a.cookie, body: { token: first.json.suggestion.token } });
  assert.equal(made.status, 201, made.text);

  return { a, b, id: made.json.match.id };
}

/** Send the asker's own messages until the reveal gate lifts. */
async function satisfyGate(a, id, count = reveal.MIN_MESSAGES_BEFORE_ASK) {
  for (let i = 0; i < count; i += 1) {
    const sent = await send(a, id, `message ${i + 1} before the mask comes off`);
    assert.equal(sent.status, 201, sent.text);
  }
}

/** Empty what a thread is made of, keeping the accounts and their cookies. */
async function clearWorld() {
  await Profile.deleteMany({});
  await Match.deleteMany({});
  await Message.deleteMany({});
  await Pass.deleteMany({});
  chat._internal.resetBudget();
}

/**
 * The pair's row as Mongo holds it, not as this process last wrote it.
 *
 * Every consent assertion goes through here: a nested-path mutation that mongoose
 * drops on the floor would still return the right state from the routes, and this
 * file would pass while the database knew nothing about the consent.
 */
async function row(id) {
  return Match.findById(id).lean();
}

// ----------------------------------------------------------------- WS plumbing

function openSocket(account) {
  const frames = [];
  const waiters = [];

  const ws = new WebSocket(wsUrl, { headers: { cookie: account.cookie, origin: config.webOrigins[0] } });

  ws.on('message', data => {
    const frame = { raw: data.toString('utf8') };
    try {
      Object.assign(frame, JSON.parse(data.toString('utf8')));
    } catch {
      /* kept as raw text so the byte assertions can see it */
    }
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
    frames,
    waitFor,
    opened: () => waitFor(frame => frame.type === 'connected'),
    close: () =>
      new Promise(resolve => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.on('close', resolve);
        ws.close();
      }),
  };
}

/** Frames that arrived after this point — the ones a student did not already have. */
function fresh(frames, since) {
  return frames.slice(since);
}

// ------------------------------------------------------------------- the suite

test('stage 6 — a reveal takes two yeses', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');
  assert.ok(config.photoDir.endsWith('test-photos-reveal'), 'refusing to write into a real photos folder');

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
    fs.rmSync(config.photoDir, { recursive: true, force: true });
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('every reveal route wants a signed-in browser', async () => {
    const world = await connectedPair();

    for (const [method, route] of [
      ['POST', `/api/reveals/${world.id}/ask`],
      ['POST', `/api/reveals/${world.id}/answer`],
      ['POST', `/api/reveals/${world.id}/revoke`],
      ['GET', `/api/reveals/${world.id}/profile`],
      ['GET', `/api/reveals/${world.id}/photo`],
    ]) {
      const res = await raw(method, route, { body: method === 'POST' && route.endsWith('answer') ? { accept: true } : undefined });
      assert.equal(res.status, 401, `${method} ${route} answered without a session`);
    }
  });

  await t.test('a stranger holding a pair id is not half of that pair', async () => {
    const world = await connectedPair();
    const outsider = await student('reveal-outsider', { gender: 'Woman', lookingFor: 'Men' });

    const neverIssued = await ask(outsider, '507f1f77bcf86cd799439011');
    const heldBySomeoneElse = await ask(outsider, world.id);

    assert.equal(heldBySomeoneElse.status, neverIssued.status, 'the two refusals must not be tellable apart');
    assert.equal(heldBySomeoneElse.json.error, neverIssued.json.error);
    assert.ok(!heldBySomeoneElse.text.includes(PEER_NAME), 'a refusal is not a way to read a name');

    for (const route of ['/profile', '/photo']) {
      const peek = await raw('GET', `/api/reveals/${world.id}${route}`, { cookie: outsider.cookie });
      assert.equal(peek.status, heldBySomeoneElse.status, `GET ${route} tells an outsider more than POST ask does`);
    }
  });

  await t.test('FR-5.1: an ask waits until the asker has said something', async () => {
    const world = await connectedPair();

    const blocked = await revealStateOf(world.a, world.id);
    assert.equal(blocked.status, 'none');
    assert.equal(blocked.canAsk, false);
    assert.equal(blocked.asksIn, reveal.MIN_MESSAGES_BEFORE_ASK);
    assert.match(blocked.askBlocked, /more of your own message/);

    const tooSoon = await ask(world.a, world.id);
    assert.equal(tooSoon.status, 400, tooSoon.text);
    assert.equal(tooSoon.json.code, 'reveal_too_early');

    // Somebody else's messages are not your conversation.
    await satisfyGate(world.b, world.id);
    const stillBlocked = await revealStateOf(world.a, world.id);
    assert.equal(stillBlocked.canAsk, false, "the gate counts *your* messages, and b's do not lift it for a");
    assert.equal(stillBlocked.asksIn, reveal.MIN_MESSAGES_BEFORE_ASK);

    await satisfyGate(world.a, world.id);
    const lifted = await revealStateOf(world.a, world.id);
    assert.equal(lifted.canAsk, true);
    assert.equal(lifted.asksIn, 0);
    assert.equal(lifted.askBlocked, undefined);
    assert.equal((await ask(world.a, world.id)).json.reveal.status, 'pending');
  });

  await t.test('FR-5.2: one press writes one consent and unlocks nothing', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);

    const asked = await ask(world.a, world.id);
    assert.equal(asked.status, 200, asked.text);
    assert.equal(asked.json.reveal.status, 'pending');
    assert.equal(asked.json.reveal.askedBy, 'me');

    const stored = await row(world.id);
    assert.equal(stored.reveal.status, 'pending');
    assert.equal(stored.reveal.consent.length, 1, 'an ask is one consent, not two');
    assert.equal(String(stored.reveal.consent[0].userId), String(world.a.userId));

    // The half that was asked sees a request, and no identity.
    const seen = await revealStateOf(world.b, world.id);
    assert.equal(seen.status, 'pending');
    assert.equal(seen.askedBy, 'them');
    const peerThread = await threadOf(world.b, world.id);
    assert.equal(peerThread.json.thread.peer.name, null, 'a pending request is not a reveal');
    assert.ok(!peerThread.text.includes(ASKER_NAME), 'the asker\'s name reached the peer before they said yes');

    // One consent is not agreement: the doors stay shut for both of them, including
    // the one who pressed, and a refusal is not a way to read a name back.
    for (const [label, half] of [['the half that asked', world.a], ['the half that was asked', world.b]]) {
      for (const peek of [revealedProfile, revealedPhoto]) {
        const locked = await peek(half, world.id);
        assert.equal(locked.status, 403, `one consent opened a door for ${label}`);
        assert.equal(locked.json.code, 'not_revealed');
        assert.ok(!locked.text.includes(ASKER_NAME) && !locked.text.includes(PEER_NAME), `a refusal leaked a name to ${label}`);
      }
    }
  });

  await t.test('the chat list stays nameless until the pair has revealed', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);

    resetRateLimits();
    const list = await raw('GET', '/api/chats', { cookie: world.b.cookie });
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.text.includes(ASKER_NAME), 'the list carried a name nobody consented to');
    assert.equal(list.json.threads[0].peer.revealed, false);
    assert.equal(list.json.threads[0].reveal.status, 'pending');

    await answer(world.b, world.id, true);
    resetRateLimits();
    const after = await raw('GET', '/api/chats', { cookie: world.b.cookie });
    assert.equal(after.status, 200, after.text);
    assert.ok(after.text.includes(ASKER_NAME), 'a revealed peer is still nameless in the list');
    assert.equal(after.json.threads[0].peer.revealed, true);
    assert.equal(after.json.threads[0].reveal.status, 'revealed');
    for (const leak of [world.a.email, world.b.email, 'mycput', 'fileName', String(world.a.userId)]) {
      assert.ok(!after.text.includes(leak), `the chat list carried ${leak}`);
    }
  });

  await t.test('FR-5.3: the ask arrives by itself, and carries one word', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);

    const peer = openSocket(world.b);
    const asker = openSocket(world.a);
    await peer.opened();
    await asker.opened();

    const sent = asker.frames.length;
    const asked = await ask(world.a, world.id);
    assert.equal(asked.status, 200, asked.text);

    const frame = await peer.waitFor(row => row.type === 'reveal' && row.event === 'asked');
    assert.equal(frame.threadId, world.id);
    for (const leak of [ASKER_NAME, PEER_NAME, world.a.email, world.b.email, 'mycput', String(world.a.userId), 'consent']) {
      assert.ok(!frame.raw.includes(leak), `the reveal frame carried ${leak}`);
    }
    assert.deepEqual(fresh(asker.frames, sent).filter(row => row.type === 'reveal'), [], 'nobody is told they asked');

    await peer.close();
    await asker.close();
  });

  await t.test('FR-5.4: not yet says so and ends nothing', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);

    const declined = await answer(world.b, world.id, false);
    assert.equal(declined.status, 200, declined.text);
    assert.equal(declined.json.reveal.status, 'none');

    const stored = await row(world.id);
    assert.equal(stored.reveal.status, 'none');
    assert.equal(stored.reveal.consent.length, 0, 'a consent nobody answered is not agreement');
    assert.equal(String(stored.reveal.declinedBy), String(world.b.userId));
    assert.ok(stored.reveal.declinedAt, 'the timestamp is what lets a screen say when honestly');
    assert.equal(stored.status, 'open', 'FR-5.4: declining is not leaving');

    const askerSees = await revealStateOf(world.a, world.id);
    assert.equal(askerSees.answeredBy.action, 'declined');
    assert.equal(askerSees.answeredBy.by, 'them');
    assert.equal(askerSees.canAsk, true, 'the conversation goes on, and so may they ask again later');

    const stillTalking = await send(world.b, world.id, 'not yet, but I am still here');
    assert.equal(stillTalking.status, 201, stillTalking.text);
  });

  await t.test('FR-5.5: the asker can take it back, and nobody else can', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);

    const wrongHands = await revoke(world.b, world.id);
    assert.equal(wrongHands.status, 409, wrongHands.text);
    assert.equal(wrongHands.json.code, 'no_pending_reveal');

    const cancelled = await revoke(world.a, world.id);
    assert.equal(cancelled.status, 200, cancelled.text);

    const stored = await row(world.id);
    assert.equal(stored.reveal.status, 'none');
    assert.equal(stored.reveal.consent.length, 0);
    assert.equal(String(stored.reveal.revokedBy), String(world.a.userId));
    assert.equal(stored.status, 'open');

    const peerSees = await revealStateOf(world.b, world.id);
    assert.equal(peerSees.answeredBy.action, 'revoked');
    assert.equal(peerSees.answeredBy.by, 'them');
  });

  await t.test('a fresh ask buries the last answer, so no screen lies', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);
    await answer(world.b, world.id, false);

    const again = await ask(world.a, world.id);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.reveal.status, 'pending');
    assert.equal(again.json.reveal.answeredBy, null, 'a request they have not seen yet cannot be shown as answered');

    const stored = await row(world.id);
    assert.equal(stored.reveal.declinedAt, null);
    assert.equal(stored.reveal.consent.length, 1);
  });

  await t.test('FR-5.2: two yeses, and the two doors open', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);

    const yes = await answer(world.b, world.id, true);
    assert.equal(yes.status, 200, yes.text);
    assert.equal(yes.json.reveal.status, 'revealed');
    assert.ok(yes.json.reveal.revealedAt);

    const stored = await row(world.id);
    assert.equal(stored.reveal.status, 'revealed');
    assert.equal(stored.reveal.consent.length, 2);
    const ids = stored.reveal.consent.map(entry => String(entry.userId)).sort();
    assert.deepEqual(ids, [String(world.a.userId), String(world.b.userId)].sort(), 'FR-5.2 wants both, independently');
    assert.ok(stored.reveal.consent.every(entry => entry.at instanceof Date));

    // FR-5.6: the same thread, still open, with every message in it.
    const after = await threadOf(world.a, world.id);
    assert.equal(after.json.thread.status, 'open');
    assert.equal(after.json.thread.peer.revealed, true);
    assert.equal(after.json.thread.peer.name, PEER_NAME);
    assert.ok(after.json.messages.length >= reveal.MIN_MESSAGES_BEFORE_ASK);
    assert.equal(stored.reveal.consent.length, 2, 'a thread read must not rewrite consent');
  });

  await t.test('both pressing ask is one decision, not two prompts', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await satisfyGate(world.b, world.id);

    assert.equal((await ask(world.a, world.id)).json.reveal.status, 'pending');
    const second = await ask(world.b, world.id);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.reveal.status, 'revealed');
    assert.equal((await row(world.id)).reveal.consent.length, 2);
  });

  await t.test('FR-5.6: what a revealed student sees, and nothing else', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);
    await answer(world.b, world.id, true);

    const res = await revealedProfile(world.a, world.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.cache, 'no-store', 'a face must not sit in a shared browser cache');
    assert.equal(res.json.profile.name, PEER_NAME);
    assert.equal(res.json.profile.age, 22);
    assert.equal(res.json.profile.faculty, 'Informatics & Design');
    assert.ok(res.json.profile.hasPhoto);
    assert.ok(Array.isArray(res.json.profile.prompts) && res.json.profile.prompts.length === 1);

    // The shapes the privacy section promises stay out of this payload. `hasPhoto`
    // is the one photo fact a revealed card carries — a filename is not a fact a
    // student can act on, and it is a pointer into somebody else's disk.
    for (const leak of [world.b.email, 'mycput', String(world.b.userId), 'fileName', 'password', 'token']) {
      assert.ok(!res.text.includes(leak), `the revealed profile carried ${leak}`);
    }
    assert.ok(!Object.keys(res.json.profile).includes('id'), 'a comparable id across screens defeats NFR-3.3');
  });

  await t.test('the second door serves the bytes, and only after both yeses', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    const bytes = png();

    const locked = await revealedPhoto(world.a, world.id);
    assert.equal(locked.status, 403);

    await ask(world.a, world.id);
    await answer(world.b, world.id, true);

    const opened = await revealedPhoto(world.a, world.id);
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.type, 'image/png');
    assert.equal(opened.cache, 'no-store');
    assert.ok(opened.buffer.equals(Buffer.from(bytes)), 'a different picture came back');

    // The other half never uploaded one, so there is nothing to give.
    const none = await revealedPhoto(world.b, world.id);
    assert.equal(none.status, 404);
    assert.equal(none.json.code, 'no_photo');
  });

  await t.test('FR-5.6: a reveal cannot be taken back', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);
    await answer(world.b, world.id, true);

    for (const [name, res] of [
      ['ask again', await ask(world.a, world.id)],
      ['answer again', await answer(world.b, world.id, false)],
      ['revoke', await revoke(world.a, world.id)],
    ]) {
      assert.equal(res.status, 409, `${name}: ${res.text}`);
      assert.equal(res.json.code, 'already_revealed', name);
    }
    assert.equal((await row(world.id)).reveal.status, 'revealed');
  });

  await t.test('an answer only answers a request that is waiting for it', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);

    const nothingPending = await answer(world.b, world.id, true);
    assert.equal(nothingPending.status, 409);
    assert.equal(nothingPending.json.code, 'no_pending_reveal');

    await ask(world.a, world.id);
    const ownRequest = await answer(world.a, world.id, true);
    assert.equal(ownRequest.status, 409, 'a student cannot answer their own ask');

    const formless = await raw('POST', `/api/reveals/${world.id}/answer`, { cookie: world.b.cookie, body: {} });
    assert.equal(formless.status, 400, formless.text);
    const nonsense = await answer(world.b, world.id, 'maybe');
    assert.equal(nonsense.status, 400, nonsense.text);
    assert.ok(!nonsense.text.includes('true'), 'a refused answer must not have changed anything');
    assert.equal((await row(world.id)).reveal.status, 'pending');

    // The words the browser actually sends are accepted, both ways.
    assert.equal((await answer(world.b, world.id, 'false')).status, 200);
    await ask(world.a, world.id);
    assert.equal((await answer(world.b, world.id, 'true')).json.reveal.status, 'revealed');
  });

  await t.test('a closed conversation has nothing to reveal', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);

    resetRateLimits();
    const closed = await raw('POST', `/api/chats/${world.id}/leave`, { cookie: world.b.cookie });
    assert.equal(closed.status, 200, closed.text);

    const after = await answer(world.a, world.id, true);
    assert.equal(after.status, 409, after.text);
    assert.equal(after.json.code, 'thread_closed');

    const state = await revealStateOf(world.a, world.id);
    assert.equal(state.canAsk, undefined, 'a closed pair is not offered an ask');
    assert.equal(state.status, 'pending', 'the request they left standing is still what it was');

    const stillRevealed = await revealedProfile(world.b, world.id);
    assert.equal(stillRevealed.status, 403);
  });

  await t.test('FR-2.6 and FR-1.4: the reveal name is the only name, and it is chosen', async () => {
    resetRateLimits();
    const meta = await raw('GET', '/api/meta');
    assert.equal(meta.status, 200, meta.text);
    assert.equal(meta.json.minimums.revealNameMax, 30);
    assert.equal(meta.json.minimums.revealMessagesBeforeAsk, reveal.MIN_MESSAGES_BEFORE_ASK);

    const world = await connectedPair();
    const tooLong = await raw('PUT', '/api/profile', {
      cookie: world.a.cookie,
      body: finished({ revealName: 'a'.repeat(31) }),
    });
    assert.equal(tooLong.status, 400, tooLong.text);

    const control = await raw('PUT', '/api/profile', {
      cookie: world.a.cookie,
      body: finished({ revealName: 'ok\u0000then' }),
    });
    assert.equal(control.status, 400, control.text);

    const collapsed = await raw('PUT', '/api/profile', {
      cookie: world.a.cookie,
      body: finished({ revealName: '  Naledi\u00a0   Nama  ' }),
    });
    assert.equal(collapsed.status, 200, collapsed.text);
    resetRateLimits();
    const own = await raw('GET', '/api/profile', { cookie: world.a.cookie });
    assert.equal(own.json.profile.revealName, 'Naledi Nama');

    // Empty is a real answer, and the reveal screen has to say so rather than invent one.
    const cleared = await raw('PUT', '/api/profile', { cookie: world.a.cookie, body: finished({ revealName: '' }) });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal((await Profile.findOne({ userId: world.a.userId }).lean()).revealName, null);
  });

  await t.test('the matching engine never reads a reveal name', async () => {
    const world = await connectedPair();

    resetRateLimits();
    const suggested = await raw('GET', '/api/matches/suggestion', { cookie: world.b.cookie });
    assert.equal(suggested.status, 200, suggested.text);
    assert.ok(!suggested.text.includes(ASKER_NAME), 'a name reached a suggestion card');
    assert.ok(!suggested.text.includes('revealName'), 'the suggestion payload carries the field at all');

    // A student who has never typed one stays that way: nothing defaults a name.
    const nameless = await student('reveal-nameless', { gender: 'Woman', lookingFor: 'Men' });
    assert.equal((await Profile.findOne({ userId: nameless.userId }).lean()).revealName, null);
  });

  await t.test('the state shape a screen acts on never carries an id', async () => {
    const world = await connectedPair();
    await satisfyGate(world.a, world.id);
    await ask(world.a, world.id);

    const state = await revealStateOf(world.b, world.id);
    const text = JSON.stringify(state);
    assert.ok(!text.includes(String(world.a.userId)), 'an account id reached a reveal state');
    assert.ok(!text.match(/[0-9a-f]{24}/), 'somebody\'s id is in that state');
    assert.equal(state.askedBy, 'them');
    assert.equal(state.revealedAt, null);
  });
});
