'use strict';
/**
 * Stage 9a — what the API says about itself, and what it refuses to believe.
 *
 * NFR-2.1 to NFR-2.5, and the part of NFR-3.1 that is a header rather than a page.
 *
 * Three claims carry this file:
 *
 *   - **Every response carries the headers, including the responses that reach no
 *     route.** A 404, a 413 and a 401 are the three responses most likely to be
 *     rendered by a browser as something else, and they are exactly the ones a
 *     middleware-only guard forgets. Each is asserted here on its own.
 *   - **A client cannot choose which rate-limit bucket it spends.** With
 *     `TRUST_PROXY_HOPS` unset the limiter keys off the socket address, so twelve
 *     guesses carrying twelve different `X-Forwarded-For` values are twelve guesses
 *     against one counter. This is the guard that was measured as open before it was
 *     written: the probe that found it got 14 unbroken 401s by rotating that header.
 *   - **A query operator in a body reaches no query.** Every door that takes an
 *     id, an address or a token is fired with `{"$ne": null}` in that field and the
 *     database is read afterwards: no session issued, no row written, no unread
 *     notice marked read, no profile changed. The assertion is on the state, not the
 *     status code, because "it answered 400" proves nothing about what it did first.
 *
 * Its own database, its own photos folder and its own outbox, because `node --test`
 * runs the suites side by side.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
testUrl.pathname = '/unmask_test_security';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-security';
process.env.PHOTO_DIR = './storage/test-photos-security';

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions } = require('./support/institutions');
const User = require('../src/models/User');
const Profile = require('../src/models/Profile');
const Match = require('../src/models/Match');
const Notification = require('../src/models/Notification');
const vocab = require('../src/domain/vocabulary');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');
const { png } = require('./fixtures/images');

const PASSWORD = 'blue-koala-printing-42';
const PNG = png();

// The five every response must carry, word for word. The policy header is a whole
// string of its own and is checked separately, below.
const EXPECTED = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const CSP_DIRECTIVES = ["default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"];

let server;
let base;

// ---------------------------------------------------------------- HTTP helpers

async function raw(method, route, { body, json, cookie, headers = {}, text } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined || json !== undefined) h['content-type'] = 'application/json';

  const res = await fetch(`${base}${route}`, {
    method,
    headers: h,
    body:
      json !== undefined
        ? JSON.stringify(json)
        : body !== undefined
          ? body
          : text,
  });

  const setCookie = res.headers.get('set-cookie');
  const buf = Buffer.from(await res.arrayBuffer());
  const bodyText = buf.toString('utf8');
  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    /* the assertion prints the raw text */
  }
  return {
    status: res.status,
    json: parsed,
    text: bodyText,
    bytes: buf,
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
  await raw('POST', '/api/auth/register', { json: { email: address, password: PASSWORD, over18Attested: true } });
  await User.updateOne({ email: address }, { $set: { emailVerifiedAt: new Date() } });
  resetRateLimits();
  const signedIn = await raw('POST', '/api/auth/login', { json: { email: address, password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);
  const account = { email: address, cookie: signedIn.cookie };
  if (!over.noProfile) {
    const saved = await raw('PUT', '/api/profile', { cookie: account.cookie, json: finished(over) });
    assert.equal(saved.status, 200, saved.text);
  }
  account.userId = (await User.findOne({ email: address }))._id;
  return account;
}

/** Upload the one PNG this file needs, so the photo door can be read back. */
async function uploadPhoto(account) {
  resetRateLimits();
  const form = new FormData();
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const res = await fetch(`${base}/api/profile/photo`, {
    method: 'POST',
    headers: { cookie: account.cookie },
    body: form,
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
}

// ------------------------------------------------------------------- assertions

function expectHeaders(res, label) {
  for (const [name, value] of Object.entries(EXPECTED)) {
    assert.equal(res.headers.get(name), value, `${label}: ${name} was "${res.headers.get(name)}"`);
  }
  const csp = res.headers.get('content-security-policy') || '';
  for (const directive of CSP_DIRECTIVES) {
    assert.ok(csp.includes(directive), `${label}: content-security-policy "${csp}" is missing ${directive}`);
  }
  assert.equal(res.headers.get('x-powered-by'), null, `${label}: still advertising the framework`);
}

// ------------------------------------------------------------------- the suite

test('stage 9a — response headers, the client address, and operator payloads', async t => {
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but a test database');
  assert.ok(config.photoDir.endsWith('test-photos-security'), 'refusing to write into a real photos folder');
  assert.equal(config.trustProxyHops, 0, 'this suite is only meaningful when no proxy is believed');

  await db.connect();
  await db.ensureIndexes();
  await seedTestInstitutions();
  await User.deleteMany({});

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await Notification.deleteMany({});
    await Match.deleteMany({});
    await Profile.deleteMany({});
    await User.deleteMany({});
    fs.rmSync(config.photoDir, { recursive: true, force: true });
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('NFR-2: the same six headers on the success, the 401, the 404 and the 413', async () => {
    const ok = await raw('GET', '/api/health');
    expectHeaders(ok, 'GET /api/health');
    assert.equal(ok.status, 200, ok.text);

    const anon = await raw('GET', '/api/auth/me');
    expectHeaders(anon, 'GET /api/auth/me unsigned in');
    assert.equal(anon.status, 401, anon.text);

    const missing = await raw('GET', '/api/no-such-door');
    expectHeaders(missing, 'GET /api/no-such-door');
    assert.equal(missing.status, 404, missing.text);

    // Over the 64kb body limit, so the parser answers before any route is reached.
    const huge = await raw('POST', '/api/auth/login', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email('huge'), password: 'x'.repeat(70 * 1024) }),
    });
    expectHeaders(huge, 'a request rejected for its size');
    assert.equal(huge.status, 413, huge.text.slice(0, 120));

    // HTTPS-only promises belong to an HTTPS deployment. Sending one over a plain
    // development port would make a browser refuse its own localhost for a month.
    assert.equal(ok.headers.get('strict-transport-security'), null, 'promised HSTS on a plain-HTTP test run');
    assert.ok(
      ok.headers.get('permissions-policy').startsWith('camera=()'),
      `Permissions-Policy was "${ok.headers.get('permissions-policy')}"`
    );
  });

  await t.test('NFR-2.3: a photo read still says no-store after the shared headers ran', async () => {
    const account = await student('photo-owner');
    await uploadPhoto(account);

    const photo = await raw('GET', '/api/profile/photo', { cookie: account.cookie });
    expectHeaders(photo, 'GET /api/profile/photo');
    assert.equal(photo.status, 200, photo.text);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.deepEqual(photo.bytes, PNG, 'the photo door did not hand back the bytes it stored');

    // The route's own no-store and the shared one have to agree, or whichever ran
    // last quietly wins and a face lands in a shared machine's cache.
    assert.equal(photo.headers.get('cache-control'), 'no-store');
  });

  await t.test('NFR-2.4: a forged X-Forwarded-For buys no fresh login budget', async () => {
    resetRateLimits();
    const statuses = [];
    let sawCookie = false;

    // Twelve guesses, each claiming to arrive from a different address. The limit on
    // this route is 10 per 15 minutes, so a limiter that believed the header would
    // serve all twelve.
    for (let i = 0; i < 12; i += 1) {
      const res = await raw('POST', '/api/auth/login', {
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        json: { email: 'nobody@nowhere.invalid', password: `wrong-${i}` },
      });
      statuses.push(res.status);
      if (res.headers.get('set-cookie')) sawCookie = true;
    }

    assert.equal(statuses.slice(0, 10).every(s => s === 401), true, `first ten were ${statuses}`);
    assert.equal(statuses[10], 429, `the eleventh guess was not stopped: ${statuses.join(',')}`);
    assert.equal(statuses[11], 429, statuses.join(','));
    assert.equal(sawCookie, false, 'a failed login was handed a session cookie');

    const limited = await raw('POST', '/api/auth/login', {
      json: { email: 'nobody@nowhere.invalid', password: 'wrong-again' },
    });
    assert.equal(limited.status, 429, limited.text);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'a 429 with no Retry-After');

    // The log line NFR-2.5 asks for must not carry the address itself.
    resetRateLimits();
  });

  await t.test('NFR-2: a Mongo operator in a body reaches no query, and changes no row', async () => {
    const account = await student('payload-owner');
    const operator = { $ne: null };

    // One unread notice, planted directly, so "marked: 0" is a fact about the payload
    // rather than a fact about an empty collection.
    await Notification.create({ userId: account.userId, kind: 'message', body: 'You have a new message.' });
    const unreadBefore = await Notification.countDocuments({ userId: account.userId, readAt: null });
    assert.equal(unreadBefore, 1);

    const usersBefore = await User.countDocuments({});
    const matchesBefore = await Match.countDocuments({});
    const hashBefore = (await User.findById(account.userId).select('+passwordHash')).passwordHash;

    const shots = [
      ['POST', '/api/auth/login', { email: operator, password: operator }],
      ['POST', '/api/auth/register', { email: operator, password: PASSWORD, over18Attested: true }],
      ['POST', '/api/auth/forgot', { email: { $regex: '.*' } }],
      ['POST', '/api/auth/reset', { token: operator, password: PASSWORD }],
      ['POST', '/api/matches/suggestion/pass', { token: operator }],
      ['POST', '/api/matches/suggestion/connect', { token: operator }],
      ['POST', '/api/notifications/read', { ids: operator }],
      ['POST', '/api/notifications/read', { ids: [operator] }],
      ['PUT', '/api/notifications/settings', { inApp: operator }],
      ['PUT', '/api/profile', { year: operator }],
    ];

    for (const [method, route, payload] of shots) {
      resetRateLimits();
      const res = await raw(method, route, { cookie: account.cookie, json: payload });
      // Either the door refuses it, or it answers and reports that it did nothing.
      // Anything else is a 200 that went and found rows, which the reads below would
      // only notice if the row it changed happened to be one they look at.
      const emptyEffect = res.json && (res.json.marked === 0 || res.json.count === 0);
      assert.ok(
        res.status >= 400 || emptyEffect,
        `${method} ${route} answered ${res.status} "${res.text.slice(0, 160)}" to ${JSON.stringify(payload)}`
      );
      assert.equal(res.headers.get('set-cookie'), null, `${method} ${route} handed out a session to an operator payload`);
    }

    // Query strings too: this one is a filter a route could have passed on.
    resetRateLimits();
    const list = await raw('GET', '/api/chats?limit[%24ne]=1', { cookie: account.cookie });
    assert.equal(list.status, 200, list.text);
    assert.equal(Array.isArray(list.json.threads), true, list.text);

    assert.equal(await User.countDocuments({}), usersBefore, 'an operator payload created an account');
    assert.equal(await Match.countDocuments({}), matchesBefore, 'an operator payload opened a conversation');
    assert.equal(
      (await User.findById(account.userId).select('+passwordHash')).passwordHash,
      hashBefore,
      'an operator payload changed a password'
    );
    assert.equal(
      await Notification.countDocuments({ userId: account.userId, readAt: null }),
      1,
      'an operator payload marked a notice read'
    );
    const profile = await Profile.findOne({ userId: account.userId });
    assert.equal(profile.year, '2nd year', `the profile year became "${profile.year}"`);
  });
});
