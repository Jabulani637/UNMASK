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
  PHOTO_STORE: 'disk',
  R2_ENDPOINT: '',
  R2_ACCOUNT_ID: '',
  R2_BUCKET: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_TIMEOUT_MS: '',
  SERVE_WEB: '0',
  WEB_DIST: './web/dist',
  DEV_AUTO_VERIFY: '0',
};

// The keys this file writes, so each case can start from a clean slate.
const KEYS = Object.keys(PROD);

// What PHOTO_STORE=r2 looks like when it is right, so the cases below only have to
// name the one key they break.
const R2 = {
  PHOTO_STORE: 'r2',
  R2_ENDPOINT: 'https://fb3715addf006be71b9e5894f26fad1c.r2.cloudflarestorage.com',
  R2_BUCKET: 'unmask-photos',
  R2_ACCESS_KEY_ID: 'an-access-key-id',
  R2_SECRET_ACCESS_KEY: 'a-secret-access-key',
};

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

// The "there is no .env" refusal cannot be proved by deleting the developer's own
// project file, so the lie is told one layer down instead: `config.js` asks
// `fs.existsSync` exactly once about that path, at require time, and this answers
// "no" for that one question and the truth for every other.
const ENV_FILE = path.resolve(__dirname, '..', '..', '.env');
function asIfNoEnvFile(load) {
  const real = fs.existsSync;
  fs.existsSync = p => (p === ENV_FILE ? false : real(p));
  try {
    return load();
  } finally {
    fs.existsSync = real;
  }
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

  await t.test('that same gate is silent when the photos are not on disk at all', () => {
    const { problems } = loadProduction({
      SERVE_WEB: '1',
      WEB_DIST: buildDir,
      PHOTO_DIR: path.join(buildDir, 'photos'),
      ...R2,
    });
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('gate: PHOTO_STORE=r2 with no key, which is every photo upload failing at 2 p.m.', () => {
    const line = only(
      loadProduction({ PHOTO_STORE: 'r2', R2_ENDPOINT: R2.R2_ENDPOINT, R2_BUCKET: R2.R2_BUCKET }).problems,
      'PHOTO_STORE=r2',
      'r2 without a key'
    );
    assert.match(line, /R2_ACCESS_KEY_ID/);
    assert.match(line, /R2_SECRET_ACCESS_KEY/);
    assert.match(line, /PHOTO_STORE=disk/);
  });

  await t.test('gate: an endpoint that is not an address, which every signed request then fails to reach', () => {
    const line = only(
      loadProduction({ PHOTO_STORE: 'r2', R2_ENDPOINT: 'not-an-address', R2_BUCKET: R2.R2_BUCKET, R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }).problems,
      'is not an address',
      'r2 endpoint not a url'
    );
    assert.match(line, /R2_ENDPOINT/);
  });

  await t.test('R2_ACCOUNT_ID is a real alternative to R2_ENDPOINT, not a decoration', () => {
    const { config, problems } = loadProduction({
      PHOTO_STORE: 'r2',
      R2_ENDPOINT: '',
      R2_ACCOUNT_ID: 'fb3715addf006be71b9e5894f26fad1c',
      R2_BUCKET: R2.R2_BUCKET,
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
    });
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.equal(config.r2.endpoint, 'https://fb3715addf006be71b9e5894f26fad1c.r2.cloudflarestorage.com');
  });

  await t.test('a bucket pasted onto the end of the endpoint is read as the bucket', () => {
    const { config, problems } = loadProduction({
      PHOTO_STORE: 'r2',
      R2_ENDPOINT: 'https://fb3715addf006be71b9e5894f26fad1c.r2.cloudflarestorage.com/unmask-storage',
      R2_BUCKET: '',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
    });
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.equal(config.r2.bucket, 'unmask-storage');
    assert.equal(config.r2.endpoint, 'https://fb3715addf006be71b9e5894f26fad1c.r2.cloudflarestorage.com');
  });

  await t.test('gate: a PHOTO_STORE that is neither store, which would save photos nowhere', () => {
    const line = only(loadProduction({ PHOTO_STORE: 's3' }).problems, 'PHOTO_STORE is "s3"', 'unknown store');
    assert.match(line, /disk/);
    assert.match(line, /"r2"/);
  });

  await t.test('gate: an http R2 endpoint, which would send the signing secret in clear text', () => {
    const line = only(
      loadProduction({
        ...R2,
        R2_ENDPOINT: 'http://fb3715addf006be71b9e5894f26fad1c.r2.cloudflarestorage.com',
      }).problems,
      'R2_ENDPOINT is "http://',
      'http r2 endpoint'
    );
    assert.match(line, /unencrypted/);
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

  // Eighteen sentences in all, and all eighteen now fire in front of a test. The
  // last one needed the file-presence question answered falsely rather than the
  // developer's own project file deleted — see `asIfNoEnvFile`.

  await t.test('the short and the empty secret are still refused in production', () => {
    const short = only(loadProduction({ SESSION_SECRET: 'abc123' }).problems, 'shorter than 32', 'short secret');
    assert.match(short, /32 characters/);

    // An empty secret is two problems, not one: "missing" and "too short" are both
    // true of the empty string, and both sentences name a different fix.
    const empty = loadProduction({ SESSION_SECRET: '' }).problems;
    assert.equal(empty.length, 2, empty.join('\n'));
    assert.ok(empty.some(p => p.includes('SESSION_SECRET is empty') && p.includes('crypto')), empty.join('\n'));
  });

  // The startup loop says one of two sentences when nothing answers, and which one
  // it picks comes from this reader: "is the container running?" about a hosted
  // database sends someone to check the one thing that is not the problem. Requiring
  // `db.js` opens no connection — it is mongoose, not a socket.
  await t.test('the retry advice knows whether the database is on this machine', () => {
    const { config } = require('../src/config');
    const db = require('../src/db');
    const cases = [
      ['mongodb://unmask:not-the-password@127.0.0.1:27017/unmask?authSource=admin', { host: '127.0.0.1', local: true }],
      ['mongodb://unmask:not-the-password@localhost:27017/unmask', { host: 'localhost', local: true }],
      // A name with no dot in it only exists on the compose network this file runs on.
      ['mongodb://unmask:not-the-password@mongo:27017/unmask?authSource=admin', { host: 'mongo', local: true }],
      ['mongodb+srv://unmask:not-the-password@cluster0.ab1cd2.mongodb.net/unmask?retryWrites=true', { host: 'cluster0.ab1cd2.mongodb.net', local: false }],
    ];
    const keep = config.mongoUrl;
    try {
      for (const [url, expected] of cases) {
        config.mongoUrl = url;
        assert.deepEqual(db.databaseHost(), expected, url);
        assert.equal(JSON.stringify(db.databaseHost()).includes('not-the-password'), false, `a credential was published for ${url}`);
      }
    } finally {
      config.mongoUrl = keep;
    }
  });

  // The sentence this file exists to prove was wrong in exactly the way a boot
  // message can be and still be believed: it told someone on Render to "copy
  // .env.example to .env", on a host where there is no file to edit and nothing
  // they copied would be read. Measured from their own log, 27 September 2026.
  await t.test('refusal: no .env file, and the two keys with no default are not in the environment either', () => {
    const { problems } = asIfNoEnvFile(() => loadProduction({ MONGO_URL: '', SESSION_SECRET: '' }));
    const line = problems.find(p => p.includes('No .env at'));
    assert.ok(line, `no sentence about the missing file. All: ${problems.join(' | ')}`);
    assert.match(line, /MONGO_URL/);
    assert.match(line, /SESSION_SECRET/);
    assert.match(line, /copy \.env\.example to \.env/, 'a laptop needs the file route spelled out');
    assert.match(line, /environment variables/, 'a host with no filesystem needs the dashboard route spelled out');
    // The other sentences still say their own piece; this one does not swallow them.
    assert.ok(problems.some(p => p.includes('MONGO_URL is empty')), problems.join(' | '));
    assert.ok(problems.some(p => p.includes('SESSION_SECRET is empty')), problems.join(' | '));
  });

  await t.test('that same refusal names only what is missing', () => {
    const { problems } = asIfNoEnvFile(() => loadProduction({ SESSION_SECRET: '' }));
    const line = problems.find(p => p.includes('No .env at'));
    assert.ok(line, problems.join(' | '));
    assert.match(line, /no SESSION_SECRET either/);
    assert.equal(line.includes('MONGO_URL'), false, `MONGO_URL is present, so it should not be named: ${line}`);
  });

  await t.test('a host that supplies those keys from its environment is not told about a file it cannot have', () => {
    const { problems } = asIfNoEnvFile(() => loadProduction());
    assert.equal(problems.find(p => p.includes('No .env at')), undefined, problems.join(' | '));
    assert.deepEqual(problems, [], 'a container with a complete environment must boot: ' + problems.join(' | '));
  });
});
