'use strict';
/**
 * Sending email — with a deliberate fallback, and a hard stop in production.
 *
 * Without SMTP_HOST the message is written to `api/outbox/` instead. That is not
 * a bypass: the account still has no `emailVerifiedAt`, and no route marks it
 * verified on its own. The only way to activate it is to open that file from the
 * developer's own machine and visit the link inside, which is exactly what the
 * student would have done in their inbox.
 *
 * In production the fallback is refused, because a verification link sitting in
 * a folder on a server is a way for anyone who can read that folder to confirm an
 * address. NFR-3.1 (POPIA) does not survive that.
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const { config, API_ROOT } = require('../config');

const OUTBOX_DIR = config.outboxDir;

let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  });
}

function transportName() {
  return transporter ? 'smtp' : 'local-outbox';
}

/**
 * @returns {Promise<{delivered: 'smtp'|'outbox', file?: string}>}
 *   Rejects only when nothing was written anywhere. A caller that treats "email
 *   sent" as "the user was told" must know which one happened.
 */
async function send({ to, subject, text, html }) {
  if (transporter) {
    await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
    return { delivered: 'smtp' };
  }

  if (config.nodeEnv === 'production') {
    throw new Error('SMTP is not configured, and refusing to write a verification link to disk in production.');
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

  console.log(`[mail] no SMTP_HOST — wrote "${subject}" to ${path.relative(API_ROOT, file)}`);
  return { delivered: 'outbox', file };
}

module.exports = { send, transportName, OUTBOX_DIR };
