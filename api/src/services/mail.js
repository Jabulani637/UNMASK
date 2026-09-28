'use strict';
/**
 * Sending email — three doors, and one deliberate fallback.
 *
 *   BREVO_API_KEY   a POST to Brevo's HTTPS relay. The door a restricted host must
 *                   use: Render's free tier blocks outbound traffic to ports 25, 465
 *                   and 587, so on that host an SMTP-only build boots green, reports
 *                   `emailTransport: "smtp"`, and then hangs for two minutes on every
 *                   single registration.
 *   SMTP_HOST       nodemailer, for a server that is allowed to open a socket.
 *   neither         the message is written to `api/outbox/`. That is not a bypass:
 *                   the account still has no `emailVerifiedAt`, and no route marks it
 *                   verified on its own. The only way to activate it is to open that
 *                   file on the developer's own machine and type the six digits
 *                   inside into the sign-up screen, which is what the student would
 *                   have done from their inbox.
 *
 * In production the fallback is refused, because a confirmation code sitting in a
 * folder on a server is worse than the link it replaced: read together with the
 * address, the digits are accepted by /api/auth/verify-code and return a session.
 * Anyone who can list that folder could then confirm any pending address.
 * NFR-3.1 (POPIA) does not survive that.
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const { config, API_ROOT } = require('../config');

const OUTBOX_DIR = config.outboxDir;

// A student is waiting for a page to stop spinning. nodemailer's own connection
// timeout is two minutes, and that is the hang this replaced: an hour of waiting
// would not make a dead relay answer, it would only make the browser give up first.
const REQUEST_TIMEOUT_MS = 10_000;

let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    // The same ten seconds on this door, or a relay that will not answer leaves the
    // student's browser spinning for two minutes before anything is logged.
    connectionTimeout: REQUEST_TIMEOUT_MS,
    greetingTimeout: REQUEST_TIMEOUT_MS,
    socketTimeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * Decided per call, not once at require time, for the same reason `config.r2` is
 * replaced by hand in the photo tests: the suite has to be able to point the API
 * door at a server on localhost and prove what actually leaves the process.
 */
function door() {
  if (config.mail.apiKey) return 'http';
  if (transporter) return 'smtp';
  return 'outbox';
}

function transportName() {
  const chosen = door();
  return chosen === 'http' ? 'brevo-http' : chosen === 'smtp' ? 'smtp' : 'local-outbox';
}

/**
 * `MAIL_FROM` is written the way every mail client writes it — `Unmask <a@b.c>` —
 * because that is the shape nodemailer takes directly. Brevo's API wants the two
 * halves apart, so they come apart here rather than at the caller, which should not
 * have to know which door its message goes out of.
 */
function splitFrom(value) {
  const match = /^(.*?)<([^>]+)>\s*$/.exec(String(value || '').trim());
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, '').trim() || 'Unmask',
      email: match[2].trim(),
    };
  }
  return { name: 'Unmask', email: String(value || '').trim() };
}

async function sendViaApi({ to, subject, text, html }) {
  const sender = splitFrom(config.smtp.from);
  const body = { sender, to: [{ email: to }], subject };
  if (text) body.textContent = text;
  if (html) body.htmlContent = html;

  let res;
  try {
    res = await fetch(config.mail.apiUrl, {
      method: 'POST',
      headers: {
        'api-key': config.mail.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // The name of what went wrong has to survive to the log, because "Connection
    // timeout" on its own is how this bug arrived: true, and useless.
    throw new Error(
      `Could not reach ${config.mail.apiUrl} over HTTPS (${err && err.name ? err.name : 'error'}: ${err && err.message ? err.message : 'unknown'}). ` +
        'A refused connection here means the host blocks outbound traffic, not that the key is wrong.'
    );
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    // Brevo's own sentence is the useful part: it is the difference between a key
    // that is wrong, a sender that was never verified, and a mailbox that is out of
    // credit — three fixes in three different places. The key is never echoed.
    const reason = (payload && (payload.message || payload.detail)) || `${res.status} ${res.statusText}`;
    throw new Error(`Brevo refused the message to ${to}: ${reason}`);
  }

  return { delivered: 'http', messageId: payload && payload.messageId };
}

/**
 * @returns {Promise<{delivered: 'http'|'smtp'|'outbox', messageId?: string, file?: string}>}
 *   Rejects only when nothing was written anywhere. A caller that treats "email
 *   sent" as "the user was told" must know which one happened.
 */
async function send({ to, subject, text, html }) {
  const chosen = door();
  if (chosen === 'http') return sendViaApi({ to, subject, text, html });

  if (chosen === 'smtp') {
    await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
    return { delivered: 'smtp' };
  }

  if (config.nodeEnv === 'production') {
    throw new Error('SMTP is not configured, and refusing to write a confirmation code to disk in production.');
  }

  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The address is hashed into the filename because that is the part that lands in
  // shell history and directory listings. The body below still carries it in full:
  // this folder is for reading on your own machine while SMTP is unconfigured, and
  // it is gitignored for that reason.
  const [local, domain] = String(to).split('@');
  const hint = require('crypto').createHash('sha256').update(local).digest('hex').slice(0, 8);
  const file = path.join(OUTBOX_DIR, `${stamp}_${hint}@${domain}.txt`);

  fs.writeFileSync(
    file,
    `To:      ${to}
From:    ${config.smtp.from}
Subject: ${subject}
Date:    ${new Date().toISOString()}

${text}
`,
    'utf8'
  );

  console.log(`[mail] no SMTP host and no BREVO_API_KEY — wrote "${subject}" to ${path.relative(API_ROOT, file)}`);
  return { delivered: 'outbox', file };
}

module.exports = { send, transportName, OUTBOX_DIR };
