'use strict';
/**
 * The one error type whose message is safe to hand to a person.
 *
 * Every service throws this instead of a bare Error because src/app.js has to
 * know which failures it may quote back verbatim and which are its own bugs. A
 * plain Error becomes a 500 and one generic sentence; a UserError becomes the
 * status it asks for and the sentence written for the reader — including the
 * several answers that must read identically whether or not an account exists.
 */

class UserError extends Error {
  constructor(message, { status = 400, code = 'bad_request', retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'UserError';
    this.status = status;
    this.code = code;
    // A 429 with no Retry-After leaves the client guessing, so the two routes
    // that answer "not yet" carry how long they mean.
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

module.exports = { UserError };
