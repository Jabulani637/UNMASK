'use strict';
/**
 * FR-1.2 under attack — what a six-digit code is worth, measured.
 *
 * A confirmation *link* was unguessable, so it only had to be single-use and
 * short-lived. A code has a million candidates in it, and a thousand students
 * registering a day means some guess lands on *someone*. So every protection in
 * this file is about spending the guess budget rather than about the secret being
 * hard to find:
 *
 *   1. five wrong entries burn a live code, and the sixth entry is refused even
 *      when it carries the right digits — otherwise the counter is a suggestion;
 *   2. a mistyped *shape* is not a guess. "You typed five digits" costs nothing,
 *      because a student who dropped a leading zero is not attacking anything;
 *   3. the code is bound to the address it was mailed to: Alice's digits typed at
 *      Bob's account confirm nobody, and do not spend Alice's budget either;
 *   4. an expired window is a closed door with the account still standing, and the
 *      student can ask for another code while a stranger cannot;
 *   5. one sentence for every reason to say no, so the screen cannot be used to
 *      walk a university's email list and find out who signed up;
 *   6. one letter per address per minute, which is what stops a single script
 *      spending the day's entire mail allowance;
 *   7. and the digits drawn without modulo bias, because a code whose first digit
 *      is twice as likely to be 0 as 9 is a code with fewer than a million
 *      possibilities in it.
 *
 * Its own database and its own outbox subfolder, because `node --test` runs the
 * suite files side by side and each one clears its own users collection.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const envFile = path.resolve(__dirname, '..', '..', '.env');
process.loadEnvFile(envFile);
const testUrl = new URL(process.env.MONGO_URL);
testUrl.pathname = '/unmask_test_verifycode';
process.env.MONGO_URL = testUrl.toString();
process.env.OUTBOX_DIR = './outbox/test-run-verifycode';

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const { seedTestInstitutions } = require('./support/institutions');
const User = require('../src/models/User');
const auth = require('../src/services/auth');
const mail = require('../src/services/mail');
const { randomDigits } = require('../src/utils/tokens');
const { reset: resetRateLimits } = require('../src/middleware/rateLimit');

const PASSWORD = 'amber-trekkie-drawing-33';
const BAD_CODE = 'That code does not match, or it has stopped working. Check the six digits, or ask for a new one.';

let server;
let base;
let cookie = '';

function outboxSnapshot() {
  try {
    return new Set(fs.readdirSync(mail.OUTBOX_DIR));
  } catch {
    return new Set();
  }
}

/**
 * The letters written since `before`. `mail.send()` writes the file before it
 * resolves and every route awaits it, so by the time a response is back the folder
 * is already final — a test that means to prove *nothing* went out must not wait.
 */
function lettersSince(before) {
  return [...outboxSnapshot()]
    .filter(file => !before.has(file))
    .sort()
    .map(file => fs.readFileSync(path.join(mail.OUTBOX_DIR, file), 'utf8'));
}

async function waitForLetter(before) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [letter] = lettersSince(before);
    if (letter) return letter;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('nothing appeared in api/outbox/');
}

function codeFrom(letter) {
  const match = letter.match(/^\s{4}(\d{6})\s*$/m);
  assert.ok(match, 'no six-digit code line in the mail');
  return match[1];
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

function testEmail(local) {
  return `${local}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@mycput.ac.za`;
}

async function type(email, code) {
  return call('POST', '/api/auth/verify-code', { body: { email, code } });
}

async function storedCode(email) {
  return User.findOne({ email }).select(
    '+verifyCodeHash +verifyCodeExpiresAt +verifyCodeSentAt +verifyCodeAttempts'
  );
}

/** Sign up, then pick the digits out of the letter the way a student does. */
async function signUpWithCode(local) {
  resetRateLimits();
  const email = testEmail(local);
  const before = outboxSnapshot();
  const res = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, over18Attested: true },
  });
  assert.equal(res.status, 200, res.text);
  const letter = await waitForLetter(before);
  return { email, letter, code: codeFrom(letter) };
}

test('FR-1.2 — an emailed six-digit code, and the seven things that make it safe', async t => {
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
    // A code left in that folder, with its address, is a session.
    fs.rmSync(config.outboxDir, { recursive: true, force: true });
    await db.disconnect();
  });

  await t.test('the letter is the only place the digits are ever offered', async () => {
    cookie = '';
    const { email, letter, code } = await signUpWithCode('letter');

    assert.match(letter, /^Subject:\s*Your CPUT confirmation code — Unmask$/m);
    assert.match(letter, /Type these six digits into the sign-up screen/);
    assert.match(letter, /stop working in 10 minutes/i);
    // The line that matters most on a phishing day, said by the one email Unmask
    // sends that contains a secret: nobody at Unmask ever asks for these digits.
    assert.match(letter, /will never phone, message or email you asking for this code/i);
    assert.match(letter, /If you did not ask for this, do nothing/i);

    const stored = await storedCode(email);
    assert.equal(stored.verifyCodeHash, crypto.createHash('sha256').update(code).digest('hex'));

    // Signing up hands out no session, code or no code: the digits are the whole of
    // the way in, and they are only ever in the mailbox.
    assert.equal(cookie, '', 'registration set no session cookie');

    resetRateLimits();
    const again = await call('POST', '/api/auth/register', {
      body: { email, password: PASSWORD, over18Attested: true },
    });
    assert.equal(again.text.includes(code), false, 'the sign-up answer repeated the code');
    assert.equal(again.text.includes(stored.verifyCodeHash), false, 'or its digest');
  });

  await t.test('five wrong entries burn the code, and the right digits arrive too late', async () => {
    const { email, code } = await signUpWithCode('budget');

    for (const wrong of ['000000', '111111', '222222', '333333']) {
      const refused = await type(email, wrong);
      assert.equal(refused.status, 401, refused.text);
      assert.equal(refused.json.error, BAD_CODE);
    }
    assert.equal((await storedCode(email)).verifyCodeAttempts, 4, 'each wrong entry is counted in the database');

    const fifth = await type(email, '444444');
    assert.equal(fifth.status, 401);
    const burned = await storedCode(email);
    assert.equal(burned.verifyCodeAttempts, 5);
    assert.equal(burned.verifyCodeHash, null, 'the fifth guess closes the code, not the sixth');

    // The point of the counter: the real digits, offered after the budget is spent,
    // buy nothing. The student reads one sentence and asks for a new code.
    cookie = '';
    const correctButDead = await type(email, code);
    assert.equal(correctButDead.status, 401);
    assert.equal(correctButDead.json.error, BAD_CODE, 'and it reads like any other refusal');
    assert.equal(cookie, '', 'no session from a burned code');
    assert.equal((await User.findOne({ email })).emailVerifiedAt, null);
  });

  await t.test('a mistyped shape is not a guess and costs none of the budget', async () => {
    const { email, code } = await signUpWithCode('shape');

    for (const notSixDigits of ['12345', '1234567', 'abcdef', '12 34', '', null]) {
      const refused = await type(email, notSixDigits);
      assert.equal(refused.status, 400, `${JSON.stringify(notSixDigits)} should be a shape refusal`);
      assert.equal(refused.json.code, 'bad_code');
      assert.match(refused.json.error, /Enter the six digits/);
    }

    // A dropped leading zero is the ordinary mistake. It must not spend any of the
    // five, and its sentence must not be about the account either.
    const stored = await storedCode(email);
    assert.equal(stored.verifyCodeAttempts, 0, 'shape refusals cost nothing');
    assert.ok(stored.verifyCodeHash, 'and leave the live code standing');

    assert.equal((await type(email, code)).status, 200, 'the digits still work after five typos');
  });

  await t.test('a code belongs only to the address it was mailed to', async () => {
    const alice = await signUpWithCode('alice');
    const aliceBefore = (await storedCode(alice.email)).verifyCodeHash;
    const bob = await signUpWithCode('bob');

    cookie = '';
    const crossed = await type(bob.email, alice.code);
    assert.equal(crossed.status, 401, "Alice's digits do not confirm Bob");
    assert.equal(crossed.json.error, BAD_CODE);
    assert.equal(cookie, '', 'and hand out nobody a session');

    // Alice's own code survived an attempt made on somebody else's account, so
    // working through addresses cannot spend anyone's budget but your own.
    assert.equal((await storedCode(alice.email)).verifyCodeHash, aliceBefore, "Alice's code is untouched");
    assert.equal((await storedCode(alice.email)).verifyCodeAttempts, 0);
    assert.equal((await storedCode(bob.email)).verifyCodeAttempts, 1, 'the attempt was counted against Bob');

    assert.equal((await type(alice.email, alice.code)).status, 200, 'and Alice can still finish her own sign-up');
    assert.equal((await User.findOne({ email: bob.email })).emailVerifiedAt, null, 'Bob is untouched');
  });

  await t.test('an expired code is a closed door, not a closed account', async () => {
    const { email, code } = await signUpWithCode('expired');

    // Ten minutes old in both columns, because that is what an expired code is.
    await User.updateOne(
      { email },
      {
        $set: {
          verifyCodeExpiresAt: new Date(Date.now() - 1000),
          verifyCodeSentAt: new Date(Date.now() - 11 * 60_000),
        },
      }
    );

    cookie = '';
    const refused = await type(email, code);
    assert.equal(refused.status, 401);
    assert.equal(refused.json.error, BAD_CODE, 'an expired code reads like a wrong one');
    assert.equal(cookie, '');

    resetRateLimits();
    const pending = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(pending.status, 403, 'the account is still there, and still pending');
    assert.equal(pending.json.code, 'email_unverified');
    assert.match(pending.json.error, /six digits/);

    // And the fix is in reach: the cooldown has passed by the time a code expires,
    // so a new one goes out and its digits get the student in.
    const before = outboxSnapshot();
    resetRateLimits();
    const resend = await call('POST', '/api/auth/resend-verification', { body: { email } });
    assert.equal(resend.status, 200, resend.text);
    const fresh = codeFrom(await waitForLetter(before));
    assert.notEqual(fresh, code, 'a different code, not the expired one re-mailed');
    assert.equal((await type(email, fresh)).status, 200, 'and it works');
  });

  await t.test('one letter per address per minute, and the first code keeps working', async () => {
    const { email, code } = await signUpWithCode('cooldown');
    const firstHash = (await storedCode(email)).verifyCodeHash;

    resetRateLimits();
    const before = outboxSnapshot();
    const tooSoon = await call('POST', '/api/auth/resend-verification', { body: { email } });
    assert.equal(tooSoon.status, 200);
    assert.equal(tooSoon.json.message, auth.CHECK_YOUR_EMAIL, 'the answer cannot admit it sent nothing');
    assert.deepEqual(lettersSince(before), [], 'and no second letter went out');

    const unchanged = await storedCode(email);
    assert.equal(unchanged.verifyCodeHash, firstHash, 'the code being typed was not overwritten');
    assert.ok(unchanged.verifyCodeExpiresAt > new Date(), 'and is still inside its window');

    // Signing up a second time over the same pending account is the same door, so
    // the cooldown has to live where both of them go through it.
    resetRateLimits();
    const beforeAgain = outboxSnapshot();
    await call('POST', '/api/auth/register', { body: { email, password: PASSWORD, over18Attested: true } });
    assert.deepEqual(lettersSince(beforeAgain), [], 'no letter for a re-signup inside the minute');

    // A minute older, and the next request does go out — with different digits that
    // replace the old ones outright, so a spent code cannot be revived by luck.
    await User.updateOne({ email }, { $set: { verifyCodeSentAt: new Date(Date.now() - 61_000) } });
    const afterCooldown = outboxSnapshot();
    resetRateLimits();
    await call('POST', '/api/auth/resend-verification', { body: { email } });
    const newCode = codeFrom(await waitForLetter(afterCooldown));
    assert.notEqual(newCode, code, 'a different code, not the same one re-mailed');

    assert.equal((await type(email, code)).status, 401, 'the old digits are done for');
    assert.equal((await type(email, newCode)).status, 200, 'the new ones open it');
  });

  await t.test('a code for a suspended account confirms nothing', async () => {
    const { email, code } = await signUpWithCode('paused');
    await User.updateOne(
      { email },
      { $set: { status: 'suspended', statusReason: 'Referred to the student conduct office.' } }
    );

    cookie = '';
    const refused = await type(email, code);
    assert.equal(refused.status, 403, refused.text);
    assert.match(refused.json.error, /not active/);
    assert.equal(cookie, '', 'the door that names the block is not a way through it');

    const stored = await storedCode(email);
    assert.equal(stored.emailVerifiedAt, null, 'and the address stays unverified');
    assert.ok(stored.verifyCodeHash, 'the code stands, for whoever later lifts the suspension');
  });

  await t.test('the digits are drawn without bias', () => {
    // The claim in utils/tokens.js, measured instead of assumed. `randomBytes() % 10`
    // would make some codes likelier than others, and this secret starts out with
    // only a million possibilities — so the spread is checked on both ends of the
    // code, the two places a naive reduction shows up.
    const draws = 30_000;
    const seen = new Map();
    const firstDigit = new Array(10).fill(0);
    const lastDigit = new Array(10).fill(0);
    let leadingZeros = 0;

    for (let i = 0; i < draws; i += 1) {
      const code = randomDigits(6);
      assert.match(code, /^\d{6}$/, `a draw came out as ${JSON.stringify(code)}`);
      if (code.startsWith('0')) leadingZeros += 1;
      seen.set(code, (seen.get(code) || 0) + 1);
      firstDigit[Number(code[0])] += 1;
      lastDigit[Number(code[5])] += 1;
    }

    // A leading zero is a tenth of the space, and padding has to keep it there: a
    // code that silently comes out as five characters is a student typing it wrong.
    assert.ok(leadingZeros > draws * 0.08 && leadingZeros < draws * 0.12, `${leadingZeros} of ${draws} began with 0`);

    for (const [name, counts] of [['first', firstDigit], ['last', lastDigit]]) {
      const expected = draws / 10;
      for (const count of counts) {
        assert.ok(
          count > expected * 0.8 && count < expected * 1.2,
          `${name}-digit spread is off: ${counts.join(', ')}`
        );
      }
    }

    // Thirty thousand draws over a million codes: a few pairs are chance, a code
    // appearing five times is a generator with far fewer than a million outputs.
    let max = 0;
    for (const count of seen.values()) max = Math.max(max, count);
    assert.ok(max <= 5, `one code came up ${max} times in ${draws} draws`);
  });
});
