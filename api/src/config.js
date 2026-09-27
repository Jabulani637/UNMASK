'use strict';
/**
 * Configuration. Reads exactly one .env, at the project root, and validates it.
 *
 * Node 24 does not load .env on its own, so loadEnvFile() is called explicitly
 * rather than relying on a --env-file flag that is easy to forget in a script.
 */

const fs = require('fs');
const path = require('path');

const API_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const envFile = path.join(PROJECT_ROOT, '.env');
const envFileFound = fs.existsSync(envFile);
if (envFileFound) process.loadEnvFile(envFile);

function csv(name, fallback) {
  return String(process.env[name] || fallback)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

const config = {
  envFileFound,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4100),

  mongoUrl: process.env.MONGO_URL || '',

  session: {
    secret: process.env.SESSION_SECRET || '',
    cookieName: 'unmask_session',
    // 30 days: a student should not have to re-verify their phone every session.
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  },

  // A developer's machine has no mail server, so the confirmation link is written
  // to api/outbox and reading it is the friction. This switch removes that step:
  // registering marks the address confirmed straight away, and signing in with a
  // correct password confirms an address that is still pending. It is off unless
  // you ask for it, and `productionProblems` below refuses to start a real server
  // with it on, because "the student owns this address" is the one fact the whole
  // product is built on — a live Unmask that never asked it would be a different
  // site with the same name.
  //
  // And never while testing, for the same reason `serveWeb` below is not read from
  // the environment: a developer's .env must not be able to change what a suite
  // proves. `test/devAutoVerify.test.js` is the one file that asks for it back,
  // after the require, because it is the file that tests it.
  devAutoVerify:
    (process.env.NODE_ENV || 'development') !== 'test' &&
    ['1', 'true', 'yes'].includes(String(process.env.DEV_AUTO_VERIFY || '').toLowerCase()),

  webOrigins: csv('WEB_ORIGIN', 'http://localhost:5273'),

  // How many proxies sit between the internet and this process. Zero means a
  // request's own `X-Forwarded-For` header is never believed, so `req.ip` is the
  // address that actually opened the socket. Setting this to 1 is correct behind
  // a host that terminates TLS for you — and wrong everywhere else, because it
  // hands any client the power to choose which rate-limit bucket it spends.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Unmask <no-reply@unmask.local>',
  },

  appUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:5273').replace(/\/$/, ''),

  // Deliberately outside anything the web server publishes: a photo is only
  // ever readable through the API, which checks the reveal before opening it.
  photoDir: path.resolve(API_ROOT, process.env.PHOTO_DIR || './storage/photos'),
  maxPhotoBytes: 5 * 1024 * 1024,

  // Where the local email fallback writes while SMTP_HOST is empty. The test suite
  // points this at a scratch folder so it cannot mix its files into the one a
  // developer reads by hand.
  outboxDir: path.resolve(API_ROOT, process.env.OUTBOX_DIR || './outbox'),

  // The built site. In production this process serves it, so a student's browser
  // talks to one origin for the page, the JSON and the chat socket — which is what
  // keeps the session cookie first-party and makes a CORS pre-flight unnecessary.
  webDist: path.resolve(PROJECT_ROOT, process.env.WEB_DIST || './web/dist'),
};

// Never while testing: the header suite asserts that an unknown path answers with
// JSON, and a developer's .env must not be able to turn that off. Otherwise an
// explicit SERVE_WEB wins, and with nothing set the API serves the build if there
// is one to serve.
config.serveWeb = false;
if (config.nodeEnv !== 'test') {
  config.serveWeb = process.env.SERVE_WEB
    ? ['1', 'true', 'yes'].includes(process.env.SERVE_WEB.toLowerCase())
    : fs.existsSync(path.join(config.webDist, 'index.html'));
}

/**
 * The gates that only close in production.
 *
 * Every one of these is a thing that would otherwise go *quietly* wrong: the
 * process starts, the health check is green, and the first student to arrive finds
 * a site that cannot log in, cannot verify an email, or hands out somebody's photo
 * to anyone who guesses a URL. A warning in a log is a thing an operator does not
 * read at 6 a.m. on the day the site is announced, so these stop the boot.
 *
 * None of them is a preference. Each names the key, and what breaks without it.
 */
function productionProblems() {
  const problems = [];

  const isHttp = url => typeof url === 'string' && url.startsWith('http://');

  if (isHttp(config.appUrl)) {
    problems.push(`PUBLIC_APP_URL is "${config.appUrl}" — in production the session cookie is marked Secure, so a browser will store it and then refuse to send it over plain HTTP. Every login would look like a wrong password. Put the site behind HTTPS and set PUBLIC_APP_URL to the https:// address.`);
  }

  for (const origin of config.webOrigins) {
    if (isHttp(origin)) {
      problems.push(`WEB_ORIGIN contains "${origin}" — an http origin cannot carry a Secure cookie either. Remove it, or list the https:// address of the site.`);
    }
  }

  // The socket handshake is checked against WEB_ORIGIN, and a page served by this
  // process opens its socket at this page's own host. When those two disagree, the
  // page loads, the JSON works, and chat is silently dead.
  if (config.serveWeb && config.appUrl && !config.webOrigins.includes(config.appUrl)) {
    problems.push(`This process serves the site at "${config.appUrl}", but that origin is not in WEB_ORIGIN (${config.webOrigins.join(', ') || 'empty'}) — the chat socket would be refused on every connection. Add the site's own address to WEB_ORIGIN.`);
  }

  if (!config.smtp.host) {
    problems.push('SMTP_HOST is empty — in production a verification link is written to api/outbox on this server, where no student will ever read it, so nobody can finish registering. Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD, or start the API with NODE_ENV=development while you test.');
  }

  if (/change-me/i.test(config.mongoUrl)) {
    problems.push('MONGO_URL still uses the template password ("change-me…") — that string is printed in .env.example, so it protects nothing. Give the database a real password in both .env and docker-compose.yml.');
  }

  // The whole point of storing a photo behind the API is that there is no URL for
  // it. Inside the served build, there is.
  const servedRoot = path.resolve(config.webDist);
  const photoRoot = path.resolve(config.photoDir);
  if (photoRoot === servedRoot || photoRoot.startsWith(servedRoot + path.sep)) {
    problems.push(`PHOTO_DIR (${config.photoDir}) is inside WEB_DIST (${config.webDist}) — the site would serve every profile photo straight from disk, with no session, no reveal and no check of anybody's permission. Move the photos out of the build folder.`);
  }

  if (config.devAutoVerify) {
    problems.push('DEV_AUTO_VERIFY is on — every address that registers is marked confirmed without ever proving it, so anyone who types a stranger\'s student email has an account in their name. It is a developer\'s convenience and it cannot ship: set DEV_AUTO_VERIFY=0 (or remove it) and configure SMTP_HOST so a real student gets a real link.');
  }

  if (process.env.TRUST_PROXY_HOPS === undefined || process.env.TRUST_PROXY_HOPS === '') {
    problems.push(`TRUST_PROXY_HOPS is unset. Here the API trusts no proxy, which is right when it is reachable directly — and wrong behind a host that terminates TLS for you, where every student arrives as one address and a single busy person can lock the whole campus out of logging in. Set TRUST_PROXY_HOPS=0 for a direct deployment, 1 behind one proxy.`);
  }

  if (config.serveWeb && !fs.existsSync(path.join(config.webDist, 'index.html'))) {
    problems.push(`SERVE_WEB is on but there is no build at ${path.join(config.webDist, 'index.html')} — run \`npm run build\` from UNMASK\\ before starting, or set SERVE_WEB=0 and serve the site from its own host.`);
  }

  return problems;
}

/**
 * Every problem as a sentence that names the file and the key to edit.
 * Returns [] when the API can start.
 */
function configProblems() {
  const problems = [];

  // A container is configured by its environment and has no .env file at all, so the
  // sentence is only true when the two keys with no safe default are missing too.
  const configuredFromEnvironment = process.env.MONGO_URL && process.env.SESSION_SECRET;
  if (!config.envFileFound && !configuredFromEnvironment) {
    problems.push(`No .env at ${envFile} — copy .env.example to .env in the project root.`);
  }
  if (!config.mongoUrl) {
    problems.push('MONGO_URL is empty — the API cannot read or save anything. See "The database" in .env.example.');
  }
  if (!config.session.secret) {
    problems.push('SESSION_SECRET is empty — logins cannot be signed. Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (config.session.secret.length < 32) {
    problems.push('SESSION_SECRET is shorter than 32 characters — too easy to forge a login cookie.');
  }
  if (
    !Number.isInteger(config.trustProxyHops) ||
    config.trustProxyHops < 0 ||
    config.trustProxyHops > 3
  ) {
    problems.push(`TRUST_PROXY_HOPS is "${process.env.TRUST_PROXY_HOPS}" — it must be a whole number of proxies: 0 when this API is reachable directly, 1 behind a host that terminates TLS for you.`);
  }
  if (config.smtp.host && (!config.smtp.user || !config.smtp.password)) {
    problems.push('SMTP_HOST is set but SMTP_USER/SMTP_PASSWORD are not — verification emails would fail silently.');
  }

  if (config.nodeEnv === 'production') problems.push(...productionProblems());

  return problems;
}

module.exports = { config, configProblems, productionProblems, PROJECT_ROOT, API_ROOT };
