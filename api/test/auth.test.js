'use strict';
/**
 * Stage 2 proven over real HTTP against a real MongoDB, in its own `unmask_test_auth`
 * database so it can never touch development data — or the other suite's rows.
 *
 * The assertions worth keeping are the ones about what the API *does not say*:
 * that a wrong address and a wrong password answer identically, that registering
 * an existing address answers identically to registering a new one, and that no
 * route confirms an account exists to someone who cannot prove the password.
 * Those are the FR-1.x / NFR-3.3 rules that one convenient error message breaks,
 * which is why this file compares sentences, not just status codes.
 *
 * The confirmation code is read out of api/outbox/, which is what a machine with
 * no SMTP sees — the same way a student reads it out of an inbox. The reset link
 * still comes out of a letter too, so both helpers are here. What the code does
 * under attack (five wrong entries, an expired window, a second letter) is
 * `test/verifyCode.test.js`; this file walks the lifecycle.
 */

const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Before anything reads config: process.loadEnvFile() does not overwrite a
// variable that is already set, which is how the test database wins over .env.
process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
// One database per suite file: `node --test` runs the files in parallel, and each
// one clears its users collection, which would sign the other one out mid-run.
testUrl.pathname = '/unmask_test_auth';
process.env.MONGO_URL = testUrl.toString();
// Inside api/outbox/, so it is already ignored, but separate from the folder a
// developer actually reads.
process.env.OUTBOX_DIR = './outbox/test-run';

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions, pilotId } = require('./support/institutions');
const User = require('../src/models/User');
const Match = require('../src/models/Match');
const auth = require('../src/services/auth');
const mail = require('../src/services/mail');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'blue-koala-printing-42';
const NEW_PASSWORD = 'maroon-velvet-printing-71';
const Types = mongoose.Types;

let server;
let base;
/** The `name=value` pair the browser would send, and the full header it arrived in. */
let cookie = '';
let lastSetCookie = '';

function outboxSnapshot() {
  try {
    return new Set(fs.readdirSync(mail.OUTBOX_DIR));
  } catch {
    return new Set();
  }
}

/** The newest file the mailer wrote since `before`. */
async function waitForMail(before) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const fresh = [...outboxSnapshot()].filter(file => !before.has(file));
    if (fresh.length) return fs.readFileSync(path.join(mail.OUTBOX_DIR, fresh[0]), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('nothing appeared in api/outbox/');
}

/** A link's token, read out of a letter — reset still arrives as a link. */
function tokenFrom(mailText, route) {
  const match = mailText.match(new RegExp(`${route}\\?token=([A-Za-z0-9_-]+)`));
  assert.ok(match, `no ${route} link in the mail`);
  return match[1];
}

/** The confirmation code, out of the one indented line the letter puts it on. */
function codeFrom(mailText) {
  const match = mailText.match(/^\s{4}(\d{6})\s*$/m);
  assert.ok(match, 'no six-digit code line in the mail');
  return match[1];
}

async function call(method, route, { body, raw, asClient = false } = {}) {
  const headers = {};
  if (body || raw) headers['content-type'] = 'application/json';
  if (asClient && cookie) headers.cookie = cookie;

  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    lastSetCookie = setCookie;
    const pair = setCookie.split(';')[0];
    // `unmask_session=;` is a clear, not a value.
    cookie = pair.endsWith('=') ? '' : pair;
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — the assertion below prints the raw text */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function testEmail(local) {
  return `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@mycput.ac.za`;
}

async function register(email, extra = {}) {
  resetRateLimits();
  const before = outboxSnapshot();
  const res = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, over18Attested: true, ...extra },
  });
  return { ...res, before };
}

async function verifiedAccount(local) {
  const email = testEmail(local);
  await register(email);
  await User.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
  return email;
}

async function signIn(email, password = PASSWORD) {
  resetRateLimits();
  const res = await call('POST', '/api/auth/login', { body: { email, password }, asClient: true });
  return res;
}

test('stage 2 — the account lifecycle', async t => {
  // Guard first: this suite wipes its database, so it must never be the dev one.
  assert.ok(config.mongoUrl.includes('unmask_test'), 'refusing to run against anything but unmask_test');

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
    // A written code is a live session-equivalent — with its address it is accepted
    // by /api/auth/verify-code; do not leave one lying around in a folder after the
    // run that made it.
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('an address at a domain no institution claims is refused, look-alikes included', async () => {
    for (const email of [
      'someone@gmail.com',
      // Ends with the real domain, but is not on it.
      'x@mycput.ac.za.attacker.example',
      // A subdomain of the real domain: what an `endsWith()` check waves through.
      'x@evil.mycput.ac.za',
      'x@portal.cput.ac.za.evil.test',
      // The real domain as a prefix.
      'x@notmycput.ac.za',
    ]) {
      const res = await register(email);
      assert.equal(res.status, 400, `${email} should not be accepted`);
      assert.match(res.json.error, /is not one yet/i);
      assert.match(res.json.error, /ask for your institution to be added/i);
      assert.equal(await User.countDocuments({ email: email.toLowerCase() }), 0);
    }
  });

  await t.test('the 18+ attestation is required, not assumed', async () => {
    for (const attestation of [undefined, false, 'true', 1]) {
      resetRateLimits();
      const res = await call('POST', '/api/auth/register', {
        body: { email: testEmail('attest'), password: PASSWORD, over18Attested: attestation },
      });
      assert.equal(res.status, 400, `attestation ${JSON.stringify(attestation)} is not consent`);
      assert.match(res.json.error, /18 or older/);
    }
  });

  await t.test('a short password is refused with the reason', async () => {
    resetRateLimits();
    const res = await call('POST', '/api/auth/register', {
      body: { email: testEmail('short'), password: 'sun-12345', over18Attested: true },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /at least 10 characters/);
  });

  await t.test('register → emailed code → typed in → signed in → sign out', async () => {
    const email = testEmail('full');
    const res = await register(email);
    assert.equal(res.status, 200);
    assert.equal(res.json.message, auth.CHECK_YOUR_EMAIL);

    const user = await User.findOne({ email });
    assert.ok(user, 'the account exists before it is confirmed');
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(user.notifications.email, false, 'FR-7.4: email is opt-in');
    assert.ok(user.over18AttestedAt, 'FR-1.3: the attestation is dated');
    assert.ok(!JSON.stringify(user.toObject()).includes(PASSWORD), 'the password is never stored');

    const letter = await waitForMail(res.before);
    // NFR-SCALE-1: the wording comes off the institution document the address
    // resolved to, so another college's student is told about their own college.
    assert.match(letter, /^Subject:\s*Your CPUT confirmation code — Unmask$/m);
    const code = codeFrom(letter);

    const stored = await User.findOne({ email }).select('+verifyCodeHash +verifyCodeExpiresAt +verifyCodeSentAt');
    assert.match(stored.verifyCodeHash, /^[0-9a-f]{64}$/, 'what is stored is a digest, not the digits');
    assert.notEqual(letter.includes(stored.verifyCodeHash), true, 'and the digest never reaches the letter');
    assert.ok(stored.verifyCodeExpiresAt > new Date(), 'the window is open');

    const verified = await call('POST', '/api/auth/verify-code', { body: { email, code } });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.signedIn, true, 'FR-1.2: the code is the whole of signing in');
    assert.equal(verified.json.email, email);
    assert.ok(!('code' in verified.json) && !('token' in verified.json), 'the answer hands back no secret');
    assert.ok(cookie.startsWith('unmask_session='), 'the session arrives as a cookie');
    assert.match(lastSetCookie, /HttpOnly/i, 'page script must not be able to read the session');
    assert.match(lastSetCookie, /SameSite=Lax/i);
    assert.match(lastSetCookie, /Expires=/, 'a 30-day cookie, not a session-only one');
    assert.ok(cookie.split('=')[1].length >= 40, 'the cookie is a long random value, not a guessable id');

    const after = await User.findOne({ email }).select(
      '+verifyCodeHash +verifyCodeExpiresAt +verifyCodeSentAt +verifyCodeAttempts'
    );
    assert.ok(after.emailVerifiedAt);
    assert.equal(after.verifyCodeHash, null, 'a used code is cleared');
    assert.equal(after.verifyCodeExpiresAt, null);
    assert.equal(after.verifyCodeSentAt, null);
    assert.equal(after.verifyCodeAttempts, 0);

    const me = await call('GET', '/api/auth/me', { asClient: true });
    assert.equal(me.status, 200);
    assert.equal(me.json.email, email);
    assert.ok(!('passwordHash' in me.json) && !('sessions' in me.json));

    assert.equal((await call('POST', '/api/auth/logout', { asClient: true })).status, 200);
    assert.equal(cookie, '', 'logout clears it in the browser too');
    const dead = await call('GET', '/api/auth/me', { asClient: true });
    assert.equal(dead.status, 401);
    assert.equal(dead.json.code, 'unauthenticated');

    // The password chosen on the sign-up screen is a real password, not a step on
    // the way to a code: it opens the same door the next day.
    assert.equal((await signIn(email)).status, 200);
  });

  await t.test('a password alone does not sign an unverified address in', async () => {
    const email = testEmail('pending');
    await register(email);

    const res = await signIn(email);
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'email_unverified');
    assert.match(res.json.error, /Confirm your student email first/);
  });

  await t.test('a wrong password and an unknown address give the identical answer', async () => {
    const known = await verifiedAccount('known');

    const wrongPassword = await signIn(known, 'not-the-password-at-all');
    const noSuchAddress = await signIn(testEmail('nobody'), 'not-the-password-at-all');

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchAddress.status, 401);
    assert.deepEqual(noSuchAddress.json, wrongPassword.json);
    assert.equal(
      wrongPassword.json.error,
      'That email and password do not match an active account.',
      'the sentence must name neither half of the pair'
    );
  });

  await t.test('re-registering an existing address says exactly what a new one says', async () => {
    const email = testEmail('dupe');
    const first = await register(email);
    const second = await register(email);

    assert.equal(second.status, 200);
    assert.equal(second.json.message, first.json.message);
    assert.equal(await User.countDocuments({ email }), 1, 'and no second account is created');

    const capitals = await register(email.toUpperCase());
    assert.equal(capitals.json.message, first.json.message);
    assert.equal(await User.countDocuments({ email }), 1, 'capitalisation is not a second identity');
  });

  await t.test('a code works once, and every refusal reads exactly the same', async () => {
    const email = testEmail('once');
    const res = await register(email);
    const code = codeFrom(await waitForMail(res.before));

    cookie = '';
    assert.equal((await call('POST', '/api/auth/verify-code', { body: { email, code } })).status, 200);

    const spent = await call('POST', '/api/auth/verify-code', { body: { email, code } });
    assert.equal(spent.status, 401);
    assert.equal(spent.json.code, 'bad_code');

    const neverIssued = await call('POST', '/api/auth/verify-code', { body: { email, code: '000000' } });
    const noAccount = await call('POST', '/api/auth/verify-code', {
      body: { email: testEmail('ghost'), code: '123456' },
    });

    // Three different reasons to say no, one sentence for all three. Anything finer
    // is a way to walk a list of a university's addresses and find out which of them
    // registered — the same rule NFR-3.3 puts on sign-in and on sign-up.
    assert.equal(neverIssued.status, 401);
    assert.equal(noAccount.status, 401);
    assert.deepEqual(neverIssued.json, spent.json, 'a code never sent reads like a code already used');
    assert.deepEqual(noAccount.json, spent.json, 'and an address with no account reads like either');
    assert.equal(
      spent.json.error,
      'That code does not match, or it has stopped working. Check the six digits, or ask for a new one.'
    );

    cookie = '';
    assert.equal((await call('GET', '/api/auth/me', { asClient: true })).status, 401, 'a refused code mints no session');
  });

  await t.test('eight wrong passwords locks the account for 15 minutes', async () => {
    const email = await verifiedAccount('locked');

    let last;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      last = await signIn(email, `wrong-${attempt}-password-x`);
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'locked');
    assert.ok(Number(last.headers.get('retry-after')) > 0, 'the client is told how long to wait');

    // The correct password during the lockout is still refused, so the lock is real.
    const during = await signIn(email);
    assert.equal(during.status, 429);
    await User.updateOne({ email }, { $set: { lockedUntil: null, failedLoginCount: 0 } });
  });

  await t.test('forgot-password answers the same whether or not the address exists', async () => {
    const known = await verifiedAccount('forgot');

    resetRateLimits();
    const before = outboxSnapshot();
    const forKnown = await call('POST', '/api/auth/forgot', { body: { email: known } });
    const mailed = await waitForMail(before);

    resetRateLimits();
    const forUnknown = await call('POST', '/api/auth/forgot', { body: { email: testEmail('never') } });

    assert.equal(forKnown.status, 200);
    assert.equal(forUnknown.status, 200);
    assert.equal(forKnown.json.message, forUnknown.json.message);
    assert.equal(forKnown.json.message, auth.RESET_SENT);
    assert.match(mailed, /\/reset\?token=/);

    // An unverified account gets no link: the mail itself would be the disclosure.
    const pending = testEmail('forgot-pending');
    await register(pending);
    resetRateLimits();
    const quietBefore = outboxSnapshot();
    const forPending = await call('POST', '/api/auth/forgot', { body: { email: pending } });
    assert.equal(forPending.json.message, auth.RESET_SENT);
    assert.deepEqual([...outboxSnapshot()].filter(f => !quietBefore.has(f)), [], 'no reset mail for a pending account');
  });

  await t.test('a reset link sets a new password and kills every old session', async () => {
    const email = await verifiedAccount('reset');
    assert.equal((await signIn(email)).status, 200);
    const stolenCookie = cookie;

    resetRateLimits();
    const before = outboxSnapshot();
    await call('POST', '/api/auth/forgot', { body: { email } });
    const token = tokenFrom(await waitForMail(before), '/reset');

    const tooShort = await call('POST', '/api/auth/reset', { body: { token, password: 'short' } });
    assert.equal(tooShort.status, 400);
    assert.match(tooShort.json.error, /at least 10 characters/);

    const done = await call('POST', '/api/auth/reset', { body: { token, password: NEW_PASSWORD } });
    assert.equal(done.status, 200);
    assert.match(done.json.message, /Sign in with it/i);

    cookie = stolenCookie;
    const hijacked = await call('GET', '/api/auth/me', { asClient: true });
    assert.equal(hijacked.status, 401, 'a copied cookie dies the moment the password changes');

    cookie = '';
    assert.equal((await signIn(email)).status, 401, 'the old password no longer works');
    assert.equal((await signIn(email, NEW_PASSWORD)).status, 200);

    const reuse = await call('POST', '/api/auth/reset', { body: { token, password: 'another-fine-password' } });
    assert.equal(reuse.status, 410, 'a reset link is single-use');
  });

  await t.test('changing a password needs the current one and refuses a reuse', async () => {
    const email = await verifiedAccount('changepw');
    assert.equal((await signIn(email)).status, 200);

    const wrongCurrent = await call('POST', '/api/auth/password', {
      body: { currentPassword: 'not-it-at-all-nope', newPassword: 'a-fresh-long-password' },
      asClient: true,
    });
    assert.equal(wrongCurrent.status, 403);
    assert.match(wrongCurrent.json.error, /nothing was changed/);

    const sameAgain = await call('POST', '/api/auth/password', {
      body: { currentPassword: PASSWORD, newPassword: PASSWORD },
      asClient: true,
    });
    assert.equal(sameAgain.status, 400);
    assert.match(sameAgain.json.error, /already using/);

    const changed = await call('POST', '/api/auth/password', {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      asClient: true,
    });
    assert.equal(changed.status, 200);
    assert.equal((await call('GET', '/api/auth/me', { asClient: true })).status, 401);

    assert.equal((await signIn(email, NEW_PASSWORD)).status, 200);
  });

  await t.test('an anonymous request gets one generic 401, and a broken body a plain 400', async () => {
    cookie = 'unmask_session=' + 'x'.repeat(64);
    const res = await call('GET', '/api/auth/me', { asClient: true });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'unauthenticated');
    assert.ok(!res.text.includes('node_modules') && !res.text.includes('at Object.'), 'no stack in a response');
    cookie = '';

    resetRateLimits();
    const malformed = await call('POST', '/api/auth/login', { raw: '{"email":' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error, 'That request could not be read.');
    assert.ok(!malformed.text.includes('JSON'), 'the parser’s own message is not shown either');
  });

  await t.test('one account holds at most five live sessions', async () => {
    const email = await verifiedAccount('sessions');

    for (let device = 0; device < 7; device += 1) {
      cookie = '';
      assert.equal((await signIn(email)).status, 200);
    }
    const user = await User.findOne({ email });
    assert.equal(user.sessions.length, 5, 'an old device is signed out rather than accumulating forever');
  });

  await t.test('deleting the account needs the password and takes everything with it', async () => {
    const email = await verifiedAccount('delete');
    assert.equal((await signIn(email)).status, 200);
    const userId = (await User.findOne({ email }))._id;

    // Rows in the other collections, written in the shapes stages 3 to 5 use.
    const conn = mongoose.connection;
    await conn.collection('profiles').insertOne({ userId, institutionId: pilotId(), faculty: 'Engineering' });

    // A message is not addressed to one person: it belongs to a pair's thread
    // (stage 5), so the fixture plants the pair row as well, and both halves of
    // its conversation. Through the model rather than as a raw document, because
    // the row a pair has is more than the two ids in it.
    const partnerId = new Types.ObjectId();
    const shared = (await Match.create({ users: [userId, partnerId], openedBy: userId }))._id;
    await conn.collection('messages').insertOne({ matchId: shared, senderId: userId, body: 'hello' });
    await conn.collection('messages').insertOne({ matchId: shared, senderId: partnerId, body: 'hi' });

    // Somebody else's thread, which nothing here is allowed to touch.
    const otherId = new Types.ObjectId();
    const other = new Types.ObjectId();
    const theirs = (await Match.create({ users: [otherId, other], openedBy: otherId }))._id;
    await conn.collection('messages').insertOne({ matchId: theirs, senderId: otherId, body: 'someone else' });

    const noWords = await call('DELETE', '/api/auth/account', { body: { password: PASSWORD }, asClient: true });
    assert.equal(noWords.status, 400);
    assert.match(noWords.json.error, /Type DELETE/);

    const wrongPw = await call('DELETE', '/api/auth/account', {
      body: { confirmText: 'DELETE', password: 'not-the-password' },
      asClient: true,
    });
    assert.equal(wrongPw.status, 403);
    assert.ok(await User.findById(userId), 'a failed deletion attempt deletes nothing');

    const gone = await call('DELETE', '/api/auth/account', {
      body: { confirmText: 'DELETE', password: PASSWORD },
      asClient: true,
    });
    assert.equal(gone.status, 200);
    assert.equal(gone.json.removed.profiles, 1);
    assert.equal(gone.json.removed.matches, 1, 'the pair went with the account');
    assert.equal(gone.json.removed.messages, 2, 'both halves of that thread, not just the one they wrote');
    assert.equal(await User.countDocuments({ email }), 0);
    assert.equal(await conn.collection('profiles').countDocuments({ userId }), 0);
    assert.equal(
      await conn.collection('messages').countDocuments({ matchId: theirs }),
      1,
      'another student’s conversation survives'
    );
    assert.equal(await conn.collection('matches').countDocuments({ users: otherId }), 1);

    cookie = '';
    assert.equal((await signIn(email, PASSWORD)).status, 401, 'the address can no longer sign in at all');
  });
});
