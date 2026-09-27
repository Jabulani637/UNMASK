'use strict';
/**
 * The sealed token a suggestion card is addressed by.
 *
 * It lives here rather than inside services/matching.js because stage 7 gave it a
 * second user: reporting a profile and blocking a card both need to answer "which
 * student is this screen about?", and a client is only ever given this token, never
 * an account id (NFR-3.3). Two implementations of the same cipher is how a card ends
 * up readable by the wrong student.
 *
 * AES-256-GCM with the *viewer's own account id* as additional authenticated data,
 * so a token is unreadable to anyone who did not sign in as that student, useless to
 * a different student, and cannot be edited into pointing at somebody else — the
 * profile id is never in the open, so a pair of students cannot compare notes and
 * work out who the other one is.
 */

const crypto = require('crypto');

const { config } = require('../config');

const TOKEN_PREFIX = 'sugg1';

// Derived once: the session secret is 64 hex characters, and sha256 of it is a
// key AES-256 can actually take.
const KEY = crypto.createHash('sha256').update(String(config.session.secret)).digest();

function seal(viewerId, profileId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(Buffer.from(String(viewerId)));
  const cipherText = Buffer.concat([cipher.update(`${viewerId}|${profileId}`, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_PREFIX}.${[iv, cipherText, tag].map(part => part.toString('base64url')).join('.')}`;
}

/**
 * Who the token was issued to, and whom it was issued about — or nothing, which
 * is what an edited or replayed token from another account resolves to.
 */
function unseal(viewerId, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;

  try {
    const [, iv, cipherText, tag] = parts.map(part => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAAD(Buffer.from(String(viewerId)));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    const [sealedFor, profileId] = plain.split('|');
    // The AAD already fails a token aimed at someone else; this is the belt to
    // that brace, because a token must never be spendable for a stranger.
    if (sealedFor !== String(viewerId)) return null;
    return profileId;
  } catch {
    // A tampered ciphertext is a GCM auth failure, and that is the whole point.
    return null;
  }
}

module.exports = { seal, unseal, TOKEN_PREFIX };
