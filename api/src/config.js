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

/** Something is an address only if a host can be read out of it. */
function isUrl(value) {
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * The R2 bucket the photos go to, from the environment.
 *
 * R2 prints its endpoint with the bucket's name already on the end of it in some
 * places (`…r2.cloudflarestorage.com/my-bucket`), and that whole string is what
 * gets copied. Signed requests put the bucket first and the key after it, so a
 * pasted path would send a photo to a key that begins with the bucket's own name —
 * here the bucket is split off instead, which is the difference between a working
 * deployment and one that 404s on every picture.
 */
function r2Config() {
  const env = process.env;
  let endpoint = String(env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  let bucket = String(env.R2_BUCKET || '').trim();

  if (endpoint) {
    try {
      const url = new URL(endpoint);
      const [first] = url.pathname.split('/').filter(Boolean);
      if (first) {
        if (!bucket) bucket = first;
        url.pathname = '/';
        endpoint = url.toString().replace(/\/+$/, '');
      }
    } catch {
      // Left as written: a gate below reports an address that is not a URL rather
      // than guessing at what was meant by it.
    }
  } else if (String(env.R2_ACCOUNT_ID || '').trim()) {
    endpoint = `https://${String(env.R2_ACCOUNT_ID).trim()}.r2.cloudflarestorage.com`;
  }

  return {
    endpoint,
    bucket,
    accessKeyId: String(env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || '').trim(),
    requestTimeoutMs: Number(env.R2_TIMEOUT_MS || 8000),
  };
}

const config = {
  envFile,
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

  // A developer's machine has no mail server, so the confirmation code is written
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

  // The second way a message leaves this process: Brevo's HTTPS relay, on the port
  // no host blocks. It exists because Render's free tier refuses outbound traffic to
  // 25, 465 and 587 (their own changelog, 26 September 2025) — an SMTP-only build
  // boots green there, answers /api/health with `emailTransport: "smtp"`, and then
  // hangs for two minutes on every registration before answering "something went
  // wrong on our end".
  //
  // `BREVO_API_KEY` is the *API* key from Brevo's settings (it starts `xkeysib-`),
  // which is a different credential from the SMTP key and is not interchangeable with
  // it. The URL is overridable for the same reason R2's endpoint is: the one test that
  // proves this path aims it at a server on localhost instead of at Brevo.
  //
  // And the key is never read while testing, for the third time in this file: a suite
  // that honoured it would send a few hundred made-up students' verification codes
  // through a real mailbox in somebody's account. `test/mailBrevo.test.js` is the one
  // file that asks for it back, and it aims the URL at a server on localhost.
  mail: {
    apiKey:
      (process.env.NODE_ENV || 'development') === 'test'
        ? ''
        : process.env.BREVO_API_KEY || '',
    apiUrl: process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email',
  },

  appUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:5273').replace(/\/$/, ''),

  // Where a profile photo's bytes actually live. `disk` is the default because it
  // is what a laptop and the shipped Docker image do; `r2` puts them in a private
  // Cloudflare R2 bucket, which is what a server that can be rebuilt from git needs
  // — an image rebuild wipes everything inside the container, photos included.
  //
  // And never while testing, for the same reason `devAutoVerify` is not read from
  // the environment there: a suite that honoured PHOTO_STORE=r2 would upload two
  // thousand made-up students' pictures into a real bucket, in somebody's account,
  // on a machine that only meant to run a test.
  // `test/photoStoreR2.test.js` is the one file that asks for it back.
  photoStore:
    (process.env.NODE_ENV || 'development') === 'test'
      ? 'disk'
      : String(process.env.PHOTO_STORE || 'disk').trim().toLowerCase(),

  // Deliberately outside anything the web server publishes: a photo is only
  // ever readable through the API, which checks the reveal before opening it.
  // Read by the disk driver only.
  photoDir: path.resolve(API_ROOT, process.env.PHOTO_DIR || './storage/photos'),
  maxPhotoBytes: 5 * 1024 * 1024,

  // A private bucket is writable and readable only by a key that can sign an S3
  // request — R2 issues that pair on its own page, and it is not the `cfat_` token
  // that manages the account. The secret half is the whole bucket in one string, so
  // it stays in this process and in `.env`, never in the built site and never in a
  // response.
  r2: r2Config(),

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

  if (!config.smtp.host && !config.mail.apiKey) {
    problems.push('No mail transport is configured — SMTP_HOST is empty and BREVO_API_KEY is not set, so in production a confirmation code is written to api/outbox on this server, where no student will ever read it, so nobody can finish registering. Either set SMTP_HOST/SMTP_USER/SMTP_PASSWORD, or set BREVO_API_KEY to send over HTTPS instead (Render\'s free tier blocks SMTP egress, so on that host the second is the only one that works), or start the API with NODE_ENV=development while you test.');
  }

  if (/change-me/i.test(config.mongoUrl)) {
    problems.push('MONGO_URL still uses the template password ("change-me…") — that string is printed in .env.example, so it protects nothing. Give the database a real password in both .env and docker-compose.yml.');
  }

  // The whole point of storing a photo behind the API is that there is no URL for
  // it. Inside the served build, there is. Only the disk driver has a folder.
  const servedRoot = path.resolve(config.webDist);
  const photoRoot = path.resolve(config.photoDir);
  if (config.photoStore === 'disk' && (photoRoot === servedRoot || photoRoot.startsWith(servedRoot + path.sep))) {
    problems.push(`PHOTO_DIR (${config.photoDir}) is inside WEB_DIST (${config.webDist}) — the site would serve every profile photo straight from disk, with no session, no reveal and no check of anybody's permission. Move the photos out of the build folder, or set PHOTO_STORE=r2.`);
  }

  // Only an http:// address, and not every unusable one: a value that is not an
  // address at all is the other gate's business. This sentence is about a signature
  // travelling in the clear, and that is only true of one that starts http://.
  if (config.photoStore === 'r2' && config.r2.endpoint.startsWith('http://')) {
    problems.push(`R2_ENDPOINT is "${config.r2.endpoint}" — every photo read and write signs its request with R2_SECRET_ACCESS_KEY, and over plain http that signature goes out unencrypted, on a line anyone between here and Cloudflare can read. Use the https:// endpoint R2 gives you (https://<account-id>.r2.cloudflarestorage.com).`);
  }

  // The same rule as the one above, for the other secret this process puts on a
  // wire: the Brevo key is a whole mailbox in one string, and it rides in a header.
  if (config.mail.apiKey && config.mail.apiUrl.startsWith('http://')) {
    problems.push(`BREVO_API_URL is "${config.mail.apiUrl}" — every request to it carries BREVO_API_KEY in a header, so over plain http that key leaves this server unencrypted and anyone reading the line can send mail as your domain. Use the https:// address; the default, https://api.brevo.com/v3/smtp/email, needs no setting at all.`);
  }

  if (config.devAutoVerify) {
    problems.push('DEV_AUTO_VERIFY is on — every address that registers is marked confirmed without ever proving it, so anyone who types a stranger\'s student email has an account in their name. It is a developer\'s convenience and it cannot ship: set DEV_AUTO_VERIFY=0 (or remove it) and configure SMTP_HOST so a real student gets a real code.');
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

  // A container, and every "push to git and it deploys" host, is configured by its
  // environment and has no .env file to edit — Render's own dashboard calls them
  // Environment Variables. So a missing file is only news when the two keys with no
  // safe default are missing from the environment as well, and the sentence has to
  // name both places a value can come from instead of sending someone to Render's
  // dashboard for a file that will never exist there.
  if (!config.envFileFound && (!config.mongoUrl || !config.session.secret)) {
    const missing = [];
    if (!config.mongoUrl) missing.push('MONGO_URL');
    if (!config.session.secret) missing.push('SESSION_SECRET');
    const where = missing.length === 1 ? missing[0] : `${missing[0]} or ${missing[1]}`;
    problems.push(
      `No .env at ${envFile}, and the environment has no ${where} either, so this process cannot start. ` +
        `On a laptop: copy .env.example to .env in the project root and fill it in. ` +
        `On a host that deploys from git (Render, Railway, Fly) or runs the shipped Docker image there is no file to edit — add ${missing.join(' and ')} as environment variables in that host's dashboard instead.`
    );
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
    const missing = [];
    if (!config.smtp.user) missing.push('SMTP_USER');
    if (!config.smtp.password) missing.push('SMTP_PASSWORD');
    const which = missing.join(' and ');
    problems.push(
      `SMTP_HOST is set but ${which} ${missing.length === 1 ? 'is' : 'are'} not — verification emails would fail silently. ` +
        `${missing.length === 1 ? 'It must carry that exact name' : 'Both must carry these exact names'}: a sender address or a key filed under any other name is a different variable, and this process never reads it.`
    );
  }

  // Asked outside production as well as inside it, like the R2 questions: a sender
  // Brevo has never seen is refused at 6 a.m. on a laptop exactly as loudly as it is
  // refused on a server, and a developer should hear about it at boot rather than as
  // a 500 the first time a student asks for a code. Three addresses count as a
  // placeholder: the one this process invents when nothing is set, the one
  // `.env.example` prints for someone to copy without changing, and the one the
  // production compose file fills in when `MAIL_FROM` is left blank in `prod.env`.
  if (config.mail.apiKey && (/\.(local|example)\b/i.test(config.smtp.from) || /@your-domain\b/i.test(config.smtp.from))) {
    problems.push(`BREVO_API_KEY is set but MAIL_FROM is still "${config.smtp.from}" — an address this project ships with, not one anyone owns. Brevo refuses a message from any sender it has not seen before, so every code would be rejected. Set MAIL_FROM to the address you verified under "Senders, Domains and IPs" in Brevo, or unset BREVO_API_KEY to go back to writing mail into api/outbox.`);
  }

  // Two, because these are all that exist. A typo here (`s3`, `r2bucket`) would
  // otherwise boot happily and write students' photos somewhere no one is looking.
  if (!['disk', 'r2'].includes(config.photoStore)) {
    problems.push(`PHOTO_STORE is "${process.env.PHOTO_STORE}" — the choices are "disk" (a folder this process can see, set by PHOTO_DIR) or "r2" (a private Cloudflare R2 bucket, set by R2_ENDPOINT or R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY).`);
  }

  // Asked whenever the store is R2, not only in production: a missing key is a
  // broken upload at any hour, and a developer should hear about it at boot rather
  // than as a 500 the first time a student picks a picture.
  if (config.photoStore === 'r2') {
    const missing = [];
    if (!config.r2.endpoint) missing.push('R2_ENDPOINT (https://<account-id>.r2.cloudflarestorage.com), or R2_ACCOUNT_ID to build it');
    else if (!isUrl(config.r2.endpoint)) missing.push(`R2_ENDPOINT ("${config.r2.endpoint}" is not an address)`);
    if (!config.r2.bucket) missing.push('R2_BUCKET (the exact name of a *private* bucket)');
    if (!config.r2.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!config.r2.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
    if (missing.length) {
      problems.push(`PHOTO_STORE=r2 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing — every photo upload and every photo read would fail. Set ${missing.length === 1 ? 'it' : 'them'} in .env, or set PHOTO_STORE=disk to keep the photos in PHOTO_DIR.`);
    }
  }

  if (config.nodeEnv === 'production') problems.push(...productionProblems());

  return problems;
}

module.exports = { config, configProblems, productionProblems, PROJECT_ROOT, API_ROOT };
