'use strict';
/**
 * Stage 5 proven over two real transports: REST for the words that are stored,
 * and a real WebSocket for the ones that arrive while you are watching.
 *
 * Three things make this suite worth having separately from the others.
 *
 * It connects. A `ws` client with the session cookie is opened against the same
 * HTTP server the Express app is listening on, which is the only way to find out
 * whether the handshake's authentication actually works — a unit test of the
 * upgrade handler would pass while the real socket sat unauthenticated.
 *
 * It reads the bytes. The claims this stage makes are all negative — no name, no
 * photo, no account id, no e-mail on this wire (FR-4.3, NFR-3.3) — and a negative
 * claim about a payload can only be proved by looking at the payload. So the
 * frames a student receives are collected and searched, not reasoned about.
 *
 * It waits. A connection is only proved live if it outlives several heartbeat
 * ticks, and a tick is thirty seconds — so the interval is injectable and two
 * subtests sit on it: a socket that answers its pings has to still be open and
 * still be receiving, and one that goes silent has to be collected.
 *
 * As in stage 4, most subtests rebuild the world from two students, because
 * "the other half cannot see this" needs a real other half.
 */

const net = require('node:net');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
// One database per suite file: the other suites clear their collections.
testUrl.pathname = '/unmask_test_chat';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-chat';
process.env.PHOTO_DIR = './storage/test-photos-chat';

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
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'blue-koala-printing-42';
const SECRET_PHRASE = 'the-phrase-only-one-of-us-knows';
// Stage 6: both students have a reveal name on file, so "no name on this wire"
// means a name that exists and is not sent, not a field that was never filled.
const ASKER_NAME = 'Chat-Askername';
const PEER_NAME = 'Chat-Peername';

let server;
let base;
let wsUrl;

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
    retryAfter: res.headers.get('retry-after'),
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
  account.profileId = (await Profile.findOne({ userId: account.userId }))._id;
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

/** The one pair this suite is about, created the way a student creates it. */
async function connectedPair(localA = 'chat-a', localB = 'chat-b') {
  await clearWorld();
  const a = await student(localA, { gender: 'Woman', lookingFor: 'Men', revealName: ASKER_NAME });
  const b = await student(localB, { gender: 'Man', lookingFor: 'Women', age: 22, revealName: PEER_NAME });

  const first = await suggestion(a);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.suggestion, 'A has to be shown somebody to connect with');

  const made = await connect(a, first.json.suggestion.token);
  assert.equal(made.status, 201, made.text);

  return { a, b, id: made.json.match.id };
}

async function sendViaRest(account, id, body) {
  resetRateLimits();
  return raw('POST', `/api/chats/${id}/messages`, { cookie: account.cookie, body: { body } });
}

/** Empty what a thread is made of, keeping the accounts and their cookies. */
async function clearWorld() {
  await Profile.deleteMany({});
  await Match.deleteMany({});
  await Message.deleteMany({});
  await Pass.deleteMany({});
  chat._internal.resetBudget();
}

// ----------------------------------------------------------------- WS plumbing

/**
 * Open a socket as one student, and keep every frame it is sent.
 *
 * The cookie is copied out of the login response by hand because a non-browser
 * client has no jar: that header is exactly what a browser would put on the
 * handshake, which is the point of the test.
 */
function openSocket(account) {
  const frames = [];
  const waiters = [];

  const ws = new WebSocket(wsUrl, {
    headers: { cookie: account.cookie, origin: config.webOrigins[0] },
  });

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
    close: () => new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.on('close', resolve);
      ws.close();
    }),
  };
}

/** Rejects a handshake; returns its HTTP status. */
function handshake({ cookie, origin }) {
  return new Promise(resolve => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;

    const ws = new WebSocket(wsUrl, { headers });
    const settle = status => {
      ws.removeAllListeners();
      resolve(status);
    };
    ws.on('open', () => {
      ws.close();
      settle('open');
    });
    ws.on('unexpected-response', (_req, res) => settle(res.statusCode));
    ws.on('error', () => settle('error'));
  });
}

// ------------------------------------------------------------------- the suite

test('stage 5 — anonymous chat over REST and WebSocket', async t => {
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

  await t.test('every chat route wants a signed-in browser', async () => {
    const world = await connectedPair();

    for (const [method, route] of [
      ['GET', '/api/chats'],
      ['GET', `/api/chats/${world.id}`],
      ['POST', `/api/chats/${world.id}/leave`],
      ['DELETE', `/api/chats/${world.id}`],
    ]) {
      const res = await raw(method, route);
      assert.equal(res.status, 401, `${method} ${route} answered without a session`);
    }

    const sent = await raw('POST', `/api/chats/${world.id}/messages`, { body: { body: 'hello?' } });
    assert.equal(sent.status, 401, 'a message can be written without a session');
  });

  await t.test('a socket that cannot show a live session never opens', async () => {
    assert.equal(await handshake({ origin: config.webOrigins[0] }), 401, 'no cookie at all');

    const world = await connectedPair();
    const forged = `${world.a.cookie.split('=')[0]}=not-a-session-anywhere`;
    assert.equal(await handshake({ cookie: forged, origin: config.webOrigins[0] }), 401, 'a cookie nothing issues');

    // A real cookie, but from a page that is not ours.
    assert.equal(
      await handshake({ cookie: world.a.cookie, origin: 'https://evil.example' }),
      403,
      'a cross-origin page holding a student session must not get a socket'
    );

    const socket = openSocket(world.a);
    await socket.opened();
    assert.equal(socket.ws.readyState, WebSocket.OPEN, 'and the same cookie from our own origin does');
    await socket.close();
  });

  await t.test('the pair shares one thread, and a stranger with the id does not', async () => {
    const world = await connectedPair();
    const outsider = await student('chat-outsider', { gender: 'Man', lookingFor: 'Women' });

    const aSends = await sendViaRest(world.a, world.id, 'first words');
    assert.equal(aSends.status, 201, aSends.text);
    assert.equal(aSends.json.message.from, 'me', 'my own message reads as mine');
    assert.equal(aSends.json.message.body, 'first words');

    const bReads = await raw('GET', `/api/chats/${world.id}`, { cookie: world.b.cookie });
    assert.equal(bReads.status, 200, bReads.text);
    assert.equal(bReads.json.messages.length, 1);
    assert.equal(bReads.json.messages[0].from, 'them', 'and reads as theirs');
    assert.equal(bReads.json.thread.peer.faculty, 'Informatics & Design', 'what the other half was shown before connecting');

    const outsiderReads = await raw('GET', `/api/chats/${world.id}`, { cookie: outsider.cookie });
    assert.equal(outsiderReads.status, 404, 'a student holding a thread id is not in it');
    assert.equal(outsiderReads.json.code, 'no_thread');

    const outsiderSends = await raw('POST', `/api/chats/${world.id}/messages`, {
      cookie: outsider.cookie,
      body: { body: 'let me in' },
    });
    assert.equal(outsiderSends.status, 404, 'and cannot write into it either');
    assert.equal(outsiderSends.text, outsiderReads.text, 'the refusal is the same sentence either way');

    // Same id, same words, and a garbage id must not confirm or deny anything.
    const nonsense = await raw('GET', '/api/chats/000000000000000000000000', { cookie: outsider.cookie });
    assert.equal(nonsense.status, 404);
    assert.equal(nonsense.json.code, 'no_thread');
  });

  await t.test('nothing on a thread response names a person (FR-4.3, NFR-3.3)', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, `mine is ${SECRET_PHRASE}`);
    await sendViaRest(world.b, world.id, 'and mine');

    const lists = await Promise.all([
      raw('GET', '/api/chats', { cookie: world.a.cookie }),
      raw('GET', `/api/chats/${world.id}`, { cookie: world.a.cookie }),
      raw('GET', '/api/chats', { cookie: world.b.cookie }),
      raw('GET', `/api/chats/${world.id}`, { cookie: world.b.cookie }),
    ]);

    for (const res of lists) {
      assert.equal(res.status, 200, res.text);
      for (const [label, value] of [
        ['the other account id', String(world.b.userId)],
        ['their profile id', String(world.b.profileId)],
        ['their own account id', String(world.a.userId)],
        ['their own profile id', String(world.a.profileId)],
        ['an email', world.b.email],
        ['the local part of it', world.b.email.split('@')[0]],
        ['the word email', 'email'],
        ['the word photo', 'photo'],
        // Stage 6 gives both of these students a reveal name. Neither may reach a
        // thread that has not unlocked it, which is the case a null field cannot
        // show on its own.
        ['the asker\'s reveal name', ASKER_NAME],
        ['the peer\'s reveal name', PEER_NAME],
      ]) {
        assert.ok(!res.text.includes(value), `${label} appears in ${res.text}`);
      }

      // A thread response now *has* a name field and a reveal block, and the whole
      // point is that both are empty until the two students say yes. So this checks
      // the shape rather than the word.
      for (const row of res.json.threads || [res.json.thread]) {
        assert.equal(row.peer.name, null, 'a thread carried a name nobody consented to');
        assert.equal(row.peer.revealed, false);
        assert.equal(row.reveal.status, 'none');
        assert.equal(row.reveal.askedBy, null);
        assert.equal(row.reveal.answeredBy, null);
        assert.equal(row.reveal.revealedAt, null);
      }
    }

    // A student's own id is not a secret, but it has no business being in a
    // payload that is addressed to them, and its absence is what lets the same
    // shape be handed to either half of the pair.
    const stored = await Message.findOne({});
    assert.ok(String(stored.senderId), 'the database does know who wrote it');
  });

  await t.test('a message written over HTTP lands on the open socket within two seconds (FR-4.2, NFR-1.2)', async () => {
    const world = await connectedPair();
    const listener = openSocket(world.b);
    await listener.opened();

    const started = Date.now();
    const sent = await sendViaRest(world.a, world.id, 'can you see this?');
    assert.equal(sent.status, 201, sent.text);

    const frame = await listener.waitFor(f => f.type === 'message');
    const elapsed = Date.now() - started;

    assert.equal(frame.message.body, 'can you see this?');
    assert.equal(frame.message.from, 'them', 'pushed as it would be read');
    assert.equal(frame.threadId, world.id);
    assert.ok(elapsed < 2000, `NFR-1.2: delivered in ${elapsed}ms`);
    assert.ok(!JSON.stringify(frame).includes(String(world.a.userId)), 'and the push names nobody');

    await listener.close();
  });

  await t.test('a message sent over the socket reaches the other student, and back to the writer', async () => {
    const world = await connectedPair();
    const a = openSocket(world.a);
    const b = openSocket(world.b);
    await a.opened();
    await b.opened();

    a.ws.send(JSON.stringify({ type: 'send', matchId: world.id, body: 'over the socket', tempId: 't-1' }));

    const received = await b.waitFor(f => f.type === 'message');
    assert.equal(received.message.body, 'over the socket');
    assert.equal(received.message.from, 'them');

    const echoed = await a.waitFor(f => f.type === 'message');
    assert.equal(echoed.message.from, 'me', 'the writer sees the stored copy, not a guess');
    assert.equal(echoed.message.id, received.message.id, 'the same row, twice, addressed per reader');
    assert.equal(echoed.tempId, 't-1', 'and the writer is told which waiting bubble it replaces');

    // One write, whichever door it came through.
    assert.equal(await Message.countDocuments({}), 1);

    await a.close();
    await b.close();
  });

  await t.test('a socket cannot write into a closed thread, and says so without blaming anyone', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, 'this is not working');

    // Open before the close: a push has nowhere to go for a student who is not
    // connected yet, and that is what the next subtest proves from the list.
    const socket = openSocket(world.b);
    await socket.opened();

    const closed = await raw('POST', `/api/chats/${world.id}/leave`, { cookie: world.a.cookie });
    assert.equal(closed.status, 200, closed.text);
    assert.ok(!closed.text.includes(world.b.email), 'the answer does not say who closed it');

    const frame = await socket.waitFor(f => f.type === 'closed');
    assert.equal(frame.threadId, world.id);
    assert.ok(!('closedBy' in frame) && !('by' in frame), 'and neither does the push');

    socket.ws.send(JSON.stringify({ type: 'send', matchId: world.id, body: 'wait, why?' }));
    const refused = await socket.waitFor(f => f.type === 'error');
    assert.equal(refused.code, 'thread_closed');
    assert.match(refused.error, /closed/);

    const viaRest = await sendViaRest(world.b, world.id, 'or over here');
    assert.equal(viaRest.status, 409);
    assert.equal(viaRest.json.code, 'thread_closed');

    assert.equal(await Message.countDocuments({}), 1, 'nothing after the leave was stored');
    await socket.close();
  });

  await t.test('a closed pair is never suggested again and cannot be reopened', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, 'ending this');
    resetRateLimits();
    const left = await raw('POST', `/api/chats/${world.id}/leave`, { cookie: world.a.cookie });
    assert.equal(left.status, 200, left.text);

    // Both of them, from both ends: FR-3.4, and no revolving door after a leave.
    for (const account of [world.a, world.b]) {
      const seen = await suggestion(account);
      assert.equal(seen.status, 200, seen.text);
      assert.equal(seen.json.suggestion, null, 'a pair that has talked stays out of the pool');
      assert.equal(seen.json.exhausted, true);
    }

    // The only way back into a thread is a token, and a token only comes from a
    // suggestion — so a refusal here is the door being shut, not a loose end.
    const rows = await Match.find({});
    assert.equal(rows[0].status, 'closed');
    assert.ok(rows[0].closedBy, 'the row records that it was left, for stage 7');
    assert.ok(!rows.some(row => row.status === 'open'), 'and nothing reopened it');
  });

  await t.test('deleting my copy leaves the other student’s words alone (FR-4.5)', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, 'one');
    await sendViaRest(world.b, world.id, 'two');
    await sendViaRest(world.a, world.id, 'three');

    const deleted = await raw('DELETE', `/api/chats/${world.id}`, { cookie: world.a.cookie });
    assert.equal(deleted.status, 200, deleted.text);
    assert.match(deleted.json.message, /other student still has/);

    const mine = await raw('GET', `/api/chats/${world.id}`, { cookie: world.a.cookie });
    assert.equal(mine.json.messages.length, 0, 'my view is empty');
    // An empty log has to say which kind of empty it is, or a reload of this
    // page reads as a conversation that never started.
    assert.match(mine.json.thread.clearedNotice, /other student still has/);

    const theirs = await raw('GET', `/api/chats/${world.id}`, { cookie: world.b.cookie });
    assert.equal(theirs.json.messages.length, 3, 'theirs is untouched');
    assert.deepEqual(theirs.json.messages.map(m => m.body), ['one', 'two', 'three']);
    assert.equal(theirs.json.thread.clearedNotice, null, 'the marker is per person, not on the pair');

    assert.equal(await Message.countDocuments({}), 3, 'nothing was destroyed');
    assert.equal((await Match.find({})).length, 1, 'and the pair is still a pair');

    // A message sent after the delete is visible again: the marker hides the
    // past, not the future.
    await sendViaRest(world.b, world.id, 'still here?');
    const after = await raw('GET', `/api/chats/${world.id}`, { cookie: world.a.cookie });
    assert.deepEqual(after.json.messages.map(m => m.body), ['still here?']);
  });

  await t.test('a history longer than one page walks backwards without losing a word', async () => {
    const world = await connectedPair();
    const total = 12;
    for (let i = 1; i <= total; i += 1) {
      const sent = await sendViaRest(world.a, world.id, `m${i}`);
      assert.equal(sent.status, 201, sent.text);
    }

    // Two students answering at the same instant is the ordinary case, so make
    // one pair of rows share a timestamp exactly: a boundary drawn on the
    // timestamp alone would drop the second of them between two pages.
    const rows = await Message.find({ matchId: world.id }).sort({ createdAt: 1 });
    // Through the driver, not the model: mongoose owns createdAt and drops a
    // $set of it, which would leave this fixture quietly untied.
    await Message.collection.updateOne({ _id: rows[1]._id }, { $set: { createdAt: rows[0].createdAt } });
    await Message.collection.updateOne({ _id: rows[7]._id }, { $set: { createdAt: rows[6].createdAt } });

    const tied = await Message.find({ matchId: world.id }, { createdAt: 1 }).sort({ createdAt: 1 });
    assert.equal(
      new Set(tied.map(row => row.createdAt.getTime())).size,
      total - 2,
      'the fixture really did put two pairs in the same millisecond, or the walk below proves nothing'
    );

    // The screen's "Older messages" button: the first read is the newest page,
    // and every press asks for what came before the oldest row it is holding.
    const seen = [];
    let oldest = null;
    for (let guard = 0; guard < total; guard += 1) {
      const url = `/api/chats/${world.id}?limit=5${oldest ? `&before=${encodeURIComponent(oldest.at)}&beforeId=${oldest.id}` : ''}`;
      const page = await raw('GET', url, { cookie: world.a.cookie });
      assert.equal(page.status, 200, page.text);

      const page1 = page.json.messages;
      assert.ok(page1.length <= 5, 'a page never overflows what was asked for');
      seen.unshift(...page1.map(row => row.body));
      if (!page.json.hasMore) break;
      oldest = { at: page1[0].at, id: page1[0].id };
    }

    assert.deepEqual(
      seen,
      Array.from({ length: total }, (_, i) => `m${i + 1}`),
      'every message exactly once, oldest first, across the pages'
    );

    const half = await raw('GET', `/api/chats/${world.id}?before=${encodeURIComponent(rows[0].createdAt.toISOString())}`, {
      cookie: world.a.cookie,
    });
    assert.equal(half.status, 400, 'a cursor missing its second half is refused, not guessed at');
    assert.equal(half.json.code, 'bad_cursor');
  });

  await t.test('the budget is the same whoever knocks (NFR-2.4)', async () => {
    const world = await connectedPair();
    const socket = openSocket(world.a);
    await socket.opened();

    const limit = chat._internal.PER_WINDOW;
    let over = null;
    for (let i = 0; i < limit + 2 && !over; i += 1) {
      const res = await sendViaRest(world.a, world.id, `message number ${i}`);
      if (res.status === 429) over = res;
    }

    assert.ok(over, 'the REST door stopped before the 200th message');
    assert.equal(over.json.code, 'rate_limited');
    assert.ok(Number(over.retryAfter) >= 1, `and said how long: ${over.retryAfter}`);
    assert.match(over.json.error, new RegExp(over.retryAfter), 'in the sentence as well as the header');

    // The socket shares the exhausted counter, because the counter is not in a
    // middleware one of the two doors can skip.
    socket.ws.send(JSON.stringify({ type: 'send', matchId: world.id, body: 'sneak one past the socket', tempId: 's-1' }));
    const refused = await socket.waitFor(f => f.type === 'error' && f.tempId === 's-1');
    assert.equal(refused.code, 'rate_limited');
    assert.equal(refused.tempId, 's-1', 'so the screen can un-stick the bubble it was waiting on');

    chat._internal.resetBudget();
    socket.ws.send(JSON.stringify({ type: 'send', matchId: world.id, body: 'and now it goes', tempId: 's-2' }));
    const allowed = await socket.waitFor(f => f.type === 'message' && f.message.body === 'and now it goes');
    assert.equal(allowed.message.from, 'me');

    await socket.close();
  });

  await t.test('a message is a message: trimmed, non-empty, and capped', async () => {
    const world = await connectedPair();

    const blank = await sendViaRest(world.a, world.id, '     ');
    assert.equal(blank.status, 400);
    assert.match(blank.json.error, /Write something first/);

    const long = await sendViaRest(world.a, world.id, 'x'.repeat(Message.MAX_BODY + 1));
    assert.equal(long.status, 400, long.text);
    assert.match(long.json.error, new RegExp(String(Message.MAX_BODY)));

    const padded = await sendViaRest(world.a, world.id, `  hello there  \n second line \n`);
    assert.equal(padded.status, 201, padded.text);
    // Outer edges go. Inside the message nothing is rewritten — a student's
    // double space, line break or ASCII face is part of what they typed.
    assert.equal(padded.json.message.body, 'hello there  \n second line');

    const max = 'y'.repeat(Message.MAX_BODY);
    const atLimit = await sendViaRest(world.a, world.id, max);
    assert.equal(atLimit.status, 201, atLimit.text);
    assert.equal(atLimit.json.message.body.length, Message.MAX_BODY);
  });

  await t.test('a thread list says which conversations are closed, not who closed them', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, 'hello');
    await sendViaRest(world.b, world.id, 'hi');
    resetRateLimits();
    await raw('POST', `/api/chats/${world.id}/leave`, { cookie: world.b.cookie });

    for (const account of [world.a, world.b]) {
      const list = await raw('GET', '/api/chats', { cookie: account.cookie });
      assert.equal(list.status, 200, list.text);
      const thread = list.json.threads.find(row => row.id === world.id);
      assert.equal(thread.status, 'closed');
      assert.equal(thread.last.body, 'hi', 'the last words are still there to read');
      assert.ok(!('closedBy' in thread), 'the list does not say who left');
    }

    const opened = await raw('GET', `/api/chats/${world.id}`, { cookie: world.a.cookie });
    assert.match(opened.json.thread.closedNotice, /closed/i);
    assert.ok(!/who|because|them|reason/i.test(opened.json.thread.closedNotice.replace(/This conversation has been closed\. You can still read it\./, '')));
  });

  await t.test('a socket that speaks nonsense is answered, not crashed', async () => {
    const world = await connectedPair();
    const socket = openSocket(world.a);
    await socket.opened();

    socket.ws.send('this is not json');
    const bad = await socket.waitFor(f => f.type === 'error');
    assert.equal(bad.code, 'bad_frame');
    assert.ok(!/JSON|parse|Unexpected/i.test(bad.error), `the answer is not a parser dump: ${bad.error}`);

    socket.ws.send(JSON.stringify({ type: 'reveal_my_identity' }));
    const unknown = await socket.waitFor(f => f.type === 'error' && f.code === 'unknown_frame');
    assert.ok(unknown);

    assert.equal(socket.ws.readyState, WebSocket.OPEN, 'and the socket is still a socket');
    assert.equal(await Message.countDocuments({}), 0, 'nothing was written by any of it');

    await socket.close();
  });

  /** Poll a frame log until one matches, so a push needs no listener plumbing. */
  async function untilSeen(frames, match, ms = 3000) {
    const until = Date.now() + ms;
    for (;;) {
      const found = frames.find(match);
      if (found) return found;
      if (Date.now() > until) return null;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * A chat server whose heartbeat is fast enough to test.
   *
   * A socket is only proved live if it outlives several ticks, and a 30-second
   * tick is not something a suite that finishes each subtest in four seconds can
   * wait for — every test above would pass while the heartbeat dropped every tab
   * in a real browser.
   */
  async function withFastHeartbeat(run) {
    const heartbeatMs = 150;
    const heartbeatServer = buildApp().listen(0);
    await new Promise(resolve => heartbeatServer.once('listening', resolve));
    const chatServer = attachChatServer(heartbeatServer, { heartbeatMs });
    try {
      return await run(`ws://127.0.0.1:${heartbeatServer.address().port}/ws`, heartbeatMs);
    } finally {
      chatServer.close();
      heartbeatServer.close();
    }
  }

  await t.test('a socket that answers the heartbeat is still live several ticks later', async () => {
    const world = await connectedPair();

    return withFastHeartbeat(async (url, heartbeatMs) => {
      const frames = [];
      const ws = new WebSocket(url, {
        headers: { cookie: world.a.cookie, origin: config.webOrigins[0] },
      });
      ws.on('message', data => frames.push(JSON.parse(data.toString('utf8'))));
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      // Six ticks: the server has pinged five times and been answered five times.
      await new Promise(resolve => setTimeout(resolve, heartbeatMs * 6));
      assert.equal(ws.readyState, WebSocket.OPEN, 'a live tab was not treated as a dead one');

      // Still a working connection, not merely an un-closed socket.
      await sendViaRest(world.b, world.id, 'still here after the pings');
      const arrived = await untilSeen(frames, f => f.type === 'message');
      assert.ok(arrived, 'a message still arrives on it');
      assert.equal(arrived.message.body, 'still here after the pings');

      ws.close();
    });
  });

  await t.test('a socket that never answers a ping is dropped', async () => {
    const world = await connectedPair();

    return withFastHeartbeat((url, heartbeatMs) =>
      new Promise((resolve, reject) => {
        // A raw handshake, then silence: this is a laptop whose lid closed, and
        // the phantom socket is what the heartbeat exists to collect.
        const key = Buffer.from('0123456789abcdef').toString('base64');
        const socket = net.connect(new URL(url).port, '127.0.0.1', () => {
          socket.write(
            [
              `GET /ws HTTP/1.1`,
              `Host: 127.0.0.1`,
              `Upgrade: websocket`,
              `Connection: Upgrade`,
              `Sec-WebSocket-Key: ${key}`,
              `Sec-WebSocket-Version: 13`,
              `Origin: ${config.webOrigins[0]}`,
              `Cookie: ${world.a.cookie}`,
              ``,
              ``,
            ].join('\r\n')
          );
        });

        let handed = false;
        socket.on('data', () => {
          if (!handed) {
            handed = true;
            assert.ok(true, 'the upgrade went through; from here it says nothing');
          }
        });
        socket.on('close', () => {
          assert.ok(handed, 'it was connected first');
          resolve();
        });
        socket.on('error', reject);
        setTimeout(() => reject(new Error('a silent socket was never collected')), heartbeatMs * 20);
      })
    );
  });

  await t.test('deleting an account takes its threads and its words with it (FR-1.6)', async () => {
    const world = await connectedPair();
    await sendViaRest(world.a, world.id, 'remember me');

    resetRateLimits();
    const gone = await raw('DELETE', '/api/auth/account', {
      cookie: world.a.cookie,
      body: { password: PASSWORD, confirmText: 'DELETE' },
    });
    assert.equal(gone.status, 200, gone.text);

    assert.equal(await Match.countDocuments({}), 0, 'the pair row went with the account');
    assert.equal(await Message.countDocuments({}), 0, 'and so did every word of it');

    const survivor = await raw('GET', '/api/chats', { cookie: world.b.cookie });
    assert.equal(survivor.json.count, 0, 'the other half is left holding nothing');
  });
});
