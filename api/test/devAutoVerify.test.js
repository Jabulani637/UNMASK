'use strict';
/**
 * DEV_AUTO_VERIFY — the developer's convenience, and the five things it must not do.
 *
 * The switch exists because a machine with no mail server makes a student confirm an
 * address by opening a file in `api/outbox/`, which is friction with no lesson in it.
 * That is only safe while the *other* doors stay shut, so this suite is less about the
 * shortcut working than about what it leaves alone:
 *
 *   1. the password check (a wrong password still answers 401, and confirms nothing),
 *   2. registration's silence (it still hands out no session, verified or not),
 *   3. the answer's uniformity — a new address, a pending one and an existing member
 *      have to come back identically, or the wording is an account-exists oracle,
 *   4. the normal path (the switch is turned off partway through this file to prove the
 *      old 403 and the old emailed link are exactly where they were), and
 *   5. nobody's real outbox folder.
 *
 * The switch is flipped here by writing `config.devAutoVerify` directly, because every
 * route reads it at call time. `test/boot.test.js` proves separately that a production
 * process refuses to start with it on; this file cannot, because a test that set
 * NODE_ENV=production would be refused before it got here.
 *
 * Runs against its own `unmask_test_devauto` database and its own outbox subfolder.
 */

const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
testUrl.pathname = '/unmask_test_devauto';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-devauto';

const { config } = require('../src/config');

// config.js reads the switch off under NODE_ENV=test — otherwise a line in whatever
// .env happens to be on this machine would change what every other suite proves. This
// file is the exception it exists for, so it asks for the switch back, before any
// route is built and before the first request.
config.devAutoVerify = true;

const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions } = require('./support/institutions');
const User = require('../src/models/User');
const auth = require('../src/services/auth');
const mail = require('../src/services/mail');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'quiet-lantern-drawing-58';

let server;
let base;
let cookie = '';

function outboxListing() {
  try {
    return fs.readdirSync(mail.OUTBOX_DIR);
  } catch {
    return [];
  }
}

async function call(method, route, { body, asClient = false } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (asClient && cookie) headers.cookie = cookie;

  const res = await fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const pair = setCookie.split(';')[0];
    cookie = pair.endsWith('=') ? '' : pair;
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* printed by the assertion that failed */
  }
  return { status: res.status, json, text };
}

function emailAt(local) {
  return `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@mycput.ac.za`;
}

async function register(email, { password = PASSWORD, over18Attested = true } = {}) {
  resetRateLimits();
  const before = new Set(outboxListing());
  const res = await call('POST', '/api/auth/register', { body: { email, password, over18Attested } });
  const wrote = outboxListing().filter(file => !before.has(file));
  return { ...res, wrote };
}

/** Run a case with the switch off, then put it back exactly as it was. */
async function withSwitchOff(fn) {
  assert.equal(config.devAutoVerify, true, 'the switch has to be on before a case can turn it off');
  config.devAutoVerify = false;
  try {
    return await fn();
  } finally {
    config.devAutoVerify = true;
  }
}

test('DEV_AUTO_VERIFY — a no-link sign-up that still checks the password', async t => {
  // Guard first: this suite wipes its database, so it must never be the dev one.
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but unmask_test');
  assert.equal(config.devAutoVerify, true, 'the assignment at the top of this file has to have taken effect');

  await db.connect();
  await db.ensureIndexes();
  await seedTestInstitutions();
  await User.deleteMany({});

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await User.deleteMany({});
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('registering confirms the address, says so, and writes no mail', async () => {
    const email = emailAt('dev');
    const res = await register(email);

    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.message, auth.DEV_AUTO_VERIFIED);
    assert.equal(res.json.devAutoVerified, true);
    assert.deepEqual(res.wrote, [], 'the outbox folder stays empty — that was the friction being removed');

    const user = await User.findOne({ email }).select(
      '+verifyCodeHash +verifyCodeExpiresAt +verifyCodeSentAt +verifyCodeAttempts'
    );
    assert.ok(user, 'the account exists');
    assert.ok(user.emailVerifiedAt, 'and it is confirmed at the moment it is created');
    assert.equal(user.verifyCodeHash, null, 'there is no code waiting to be typed');
    assert.equal(user.verifyCodeExpiresAt, null);
    assert.equal(user.verifyCodeSentAt, null);
  });

  await t.test('registration still hands out no session, confirmed address or not', async () => {
    cookie = '';
    const email = emailAt('nosession');
    await register(email);

    assert.equal(cookie, '', 'FR-1.2 stays true: a confirmed address is not a signed-in browser');
    const me = await call('GET', '/api/auth/me', { asClient: true });
    assert.equal(me.status, 401, me.text);
  });

  await t.test('the same password then signs in, with no link in between', async () => {
    cookie = '';
    const email = emailAt('straight');
    await register(email);

    resetRateLimits();
    const signIn = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD }, asClient: true });
    assert.equal(signIn.status, 200, signIn.text);
    assert.ok(cookie, 'the session cookie arrives at login, as it always has');

    const me = await call('GET', '/api/auth/me', { asClient: true });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.email, email);
  });

  await t.test('a wrong password is still refused, and does not confirm anything', async () => {
    const email = emailAt('wrongpass');
    await register(email);
    await User.updateOne({ email }, { $set: { emailVerifiedAt: null } });

    resetRateLimits();
    const failed = await call('POST', '/api/auth/login', { body: { email, password: 'not-the-password-at-all' } });
    assert.equal(failed.status, 401, failed.text);
    assert.equal(failed.json.code, 'bad_credentials');
    assert.equal(failed.json.error, 'That email and password do not match an active account.');

    const user = await User.findOne({ email });
    assert.equal(user.emailVerifiedAt, null, 'the switch confirms on proof of the password, never on its absence');
  });

  await t.test('an address left pending from before the switch is confirmed by the password', async () => {
    const email = emailAt('pending');
    await withSwitchOff(async () => {
      const res = await register(email);
      assert.equal(res.json.devAutoVerified, undefined, 'off means off: the ordinary answer');
      assert.equal(res.wrote.length, 1, 'and the ordinary code, written to the ordinary folder');
    });
    assert.equal((await User.findOne({ email })).emailVerifiedAt, null);

    resetRateLimits();
    const signIn = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD }, asClient: true });
    assert.equal(signIn.status, 200, signIn.text);
    assert.ok((await User.findOne({ email })).emailVerifiedAt, 'proved the password, so the address is treated as theirs');
  });

  await t.test('with the switch off, the old 403 is exactly where it was', async () => {
    await withSwitchOff(async () => {
      const email = emailAt('off');
      const res = await register(email);
      assert.equal(res.json.message, auth.CHECK_YOUR_EMAIL);

      resetRateLimits();
      cookie = '';
      const signIn = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
      assert.equal(signIn.status, 403, signIn.text);
      assert.equal(signIn.json.code, 'email_unverified');
      assert.equal(cookie, '', 'and no session came out of it either');
    });
  });

  await t.test('registering an address that already finished is answered the same way as any other', async () => {
    const email = emailAt('twice');
    const first = await register(email);
    const second = await register(email);

    assert.equal(first.json.message, second.json.message);
    assert.equal(second.json.devAutoVerified, true, 'the same code the first answer carried');
    assert.equal(await User.countDocuments({ email }), 1, 'not two accounts');
  });
});
