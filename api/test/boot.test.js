'use strict';
/**
 * Stage 9d — the boot gates that only close in production.
 *
 * A gate that never fires is a decoration, so this file does two things: it
 * assembles a configuration that is *correct* for a real deployment and asserts
 * `configProblems()` is empty on it, then breaks one key at a time and asserts
 * that the named sentence appears — and, for the ones that should stand alone,
 * that it is the only thing wrong.
 *
 * Each gate is here because the alternative was a silent failure, and the
 * assertion quotes the consequence rather than the condition: a reader of the
 * message is supposed to be able to fix it without opening this file.
 *
 * Nothing boots and no database is touched: `config.js` is a pure reader of the
 * environment, so it is re-required against a rewritten `process.env` for each
 * case. `.env` at the project root cannot interfere — a value already in the
 * environment wins over one in the file — and every key read here is set by the
 * baseline, so the developer's real secrets never decide a result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG = require.resolve('../src/config');

// A folder that exists and has an index.html in it, so "there is a build" is true
// for the cases that need it and false for the one that does not.
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-boot-build-'));
fs.writeFileSync(path.join(buildDir, 'index.html'), '<!doctype html><title>Unmask</title>');
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-boot-empty-'));

const SECRET = 'a'.repeat(64);

// What a correct production deployment looks like. Every key `config.js` reads is
// named, so nothing inherits a value from the machine this runs on.
const PROD = {
  NODE_ENV: 'production',
  PORT: '4100',
  MONGO_URL: 'mongodb://unmask:a-real-database-password@127.0.0.1:27017/unmask?authSource=admin',
  SESSION_SECRET: SECRET,
  WEB_ORIGIN: 'https://unmask.cput.ac.za',
  TRUST_PROXY_HOPS: '1',
  SMTP_HOST: 'smtp.cput.ac.za',
  SMTP_PORT: '587',
  SMTP_USER: 'unmask@mail.cput.ac.za',
  SMTP_PASSWORD: 'an-smtp-password',
  MAIL_FROM: 'Unmask <no-reply@unmask.ac.za>',
  PUBLIC_APP_URL: 'https://unmask.cput.ac.za',
  OUTBOX_DIR: './outbox',
  PHOTO_DIR: './storage/photos',
  SERVE_WEB: '0',
  WEB_DIST: './web/dist',
  DEV_AUTO_VERIFY: '0',
};

// The keys this file writes, so each case can start from a clean slate.
const KEYS = Object.keys(PROD);

function loadProduction(overrides = {}) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, PROD, overrides);
  delete require.cache[CONFIG];
  const mod = require(CONFIG);
  return { config: mod.config, problems: mod.configProblems() };
}

function only(problems, fragment, label) {
  const hits = problems.filter(p => p.includes(fragment));
  assert.equal(hits.length, 1, `${label}: expected one problem mentioning "${fragment}", got ${problems.length}: ${problems.join(' | ')}`);
  assert.equal(problems.length, 1, `${label}: other problems fired too: ${problems.join(' | ')}`);
  return hits[0];
}

test('stage 9d — the production boot gates, each one proven to fire', async t => {
  t.after(() => {
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
    for (const key of KEYS) delete process.env[key];
    delete require.cache[CONFIG];
  });

  await t.test('a correctly configured production deployment starts, and says nothing', () => {
    const { problems } = loadProduction();
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('the same keys with NODE_ENV=development do not borrow the production gates', () => {
    const { config, problems } = loadProduction({
      NODE_ENV: 'development',
      PUBLIC_APP_URL: 'http://localhost:5273',
      WEB_ORIGIN: 'http://localhost:5273',
      SMTP_HOST: '',
      TRUST_PROXY_HOPS: '',
    });
    assert.equal(config.nodeEnv, 'development');
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('gate: PUBLIC_APP_URL over http — the cookie is Secure, so logins would vanish', () => {
    const line = only(loadProduction({ PUBLIC_APP_URL: 'http://unmask.cput.ac.za' }).problems, 'PUBLIC_APP_URL', 'http app url');
    assert.match(line, /Secure/);
    assert.match(line, /https:\/\//);
  });

  await t.test('gate: an http entry in WEB_ORIGIN, even beside a good one', () => {
    const { problems } = loadProduction({ WEB_ORIGIN: 'https://unmask.cput.ac.za,http://unmask.internal:4100' });
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /WEB_ORIGIN contains "http:\/\/unmask\.internal:4100"/);
  });

  await t.test('gate: the served site lives at an origin the socket handshake will not accept', () => {
    const { problems } = loadProduction({
      SERVE_WEB: '1',
      WEB_DIST: buildDir,
      PUBLIC_APP_URL: 'https://unmask.example',
      WEB_ORIGIN: 'https://unmask.cput.ac.za',
    });
    const line = only(problems, 'chat socket would be refused', 'origin mismatch');
    assert.match(line, /https:\/\/unmask\.example/);
    assert.match(line, /WEB_ORIGIN/);
  });

  await t.test('gate: no SMTP, so every verification link is written to a folder on the server', () => {
    const line = only(loadProduction({ SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '' }).problems, 'SMTP_HOST is empty', 'no smtp');
    assert.match(line, /nobody can finish registering/);
  });

  await t.test('gate: the database still has the password printed in the template', () => {
    const line = only(
      loadProduction({ MONGO_URL: 'mongodb://unmask:change-me-local-only@127.0.0.1:27017/unmask?authSource=admin' }).problems,
      'template password',
      'template mongo password'
    );
    assert.match(line, /docker-compose\.yml/);
  });

  await t.test('gate: PHOTO_DIR inside the served build, which would publish every photo', () => {
    const { problems } = loadProduction({
      SERVE_WEB: '1',
      WEB_DIST: buildDir,
      PHOTO_DIR: path.join(buildDir, 'photos'),
    });
    const line = only(problems, 'PHOTO_DIR', 'photos inside the build');
    assert.match(line, /no session, no reveal/);
  });

  await t.test('gate: DEV_AUTO_VERIFY on, which would let a stranger finish registering with nobody proving their address', () => {
    const line = only(loadProduction({ DEV_AUTO_VERIFY: '1' }).problems, 'DEV_AUTO_VERIFY is on', 'dev auto verify');
    assert.match(line, /without ever proving it/);
    assert.match(line, /cannot ship/);
  });

  await t.test('gate: TRUST_PROXY_HOPS left unset, which makes one campus into one rate-limit bucket', () => {
    const line = only(loadProduction({ TRUST_PROXY_HOPS: '' }).problems, 'TRUST_PROXY_HOPS is unset', 'unset hops');
    assert.match(line, /lock the whole campus out/);
    assert.match(line, /TRUST_PROXY_HOPS=0/);
  });

  await t.test('gate: SERVE_WEB on with nothing built, which would 500 every page', () => {
    const line = only(loadProduction({ SERVE_WEB: '1', WEB_DIST: emptyDir }).problems, 'no build', 'no build');
    assert.match(line, /npm run build/);
  });

  await t.test('a wrong TRUST_PROXY_HOPS is still refused in production, not just in development', () => {
    const { problems } = loadProduction({ TRUST_PROXY_HOPS: '2.5' });
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /whole number of proxies/);
  });

  await t.test('gate: MONGO_URL empty, which is the API unable to read or save anything', () => {
    const line = only(loadProduction({ MONGO_URL: '' }).problems, 'MONGO_URL is empty', 'empty mongo url');
    assert.match(line, /\.env\.example/);
  });

  await t.test('gate: an SMTP host with no credentials, which fails a verification link silently', () => {
    const line = only(loadProduction({ SMTP_USER: '', SMTP_PASSWORD: '' }).problems, 'SMTP_USER/SMTP_PASSWORD are not', 'smtp without credentials');
    assert.match(line, /fail silently/);
  });

  // Fifteen sentences in all, fourteen of them proven to fire above. The one left
  // is "there is no .env at all", which this file cannot prove: it would have to
  // delete the developer's own project file to watch the message appear, and a test
  // that destroys the machine it runs on is not a test.

  await t.test('the short and the empty secret are still refused in production', () => {
    const short = only(loadProduction({ SESSION_SECRET: 'abc123' }).problems, 'shorter than 32', 'short secret');
    assert.match(short, /32 characters/);

    // An empty secret is two problems, not one: "missing" and "too short" are both
    // true of the empty string, and both sentences name a different fix.
    const empty = loadProduction({ SESSION_SECRET: '' }).problems;
    assert.equal(empty.length, 2, empty.join('\n'));
    assert.ok(empty.some(p => p.includes('SESSION_SECRET is empty') && p.includes('crypto')), empty.join('\n'));
  });
});
