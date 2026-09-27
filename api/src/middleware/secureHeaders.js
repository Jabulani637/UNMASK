'use strict';
/**
 * NFR-2 — what the API says about itself in every response.
 *
 * None of this is a secret and none of it is a lock on a door; it is the set of
 * claims a response makes to whoever received it, and until this file the API
 * made none of them, which every browser fills in with its own guesswork.
 *
 * The one that carries the most weight here is `Cache-Control: no-store`. This
 * site is the kind of thing a student opens on a library machine, a shared dorm
 * laptop, or a phone handed to a friend to show them a screenshot — and every
 * response is one person's profile, one person's messages, or the fact that
 * somebody exists in the database at all. A cached copy of any of those is a
 * copy nobody consented to keeping. The same promise runs the length of the site:
 * the HTML document is served no-store as well, and the only thing anywhere on
 * this origin that may be kept is a file under `/assets` whose name changes when
 * its contents change.
 *
 * `Content-Security-Policy` is `default-src 'none'` because this file describes
 * exactly one kind of body — JSON — and promises that it loads nothing. It is a
 * policy for `/api`, not for the origin: since stage 9d this same process can also
 * serve the built site, and a page under this policy would render nothing at all.
 * Everything that is not an API answer is headed by `middleware/pageHeaders.js`
 * instead. What stays true in both files is the claim being tested here: if
 * something ever makes an API route answer with markup, the browser should not
 * believe it is allowed to run anything, load anything, or base its URLs on it.
 */

const { config } = require('../config');

const CSP = ["default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"].join('; ');

// Nothing on this site asks a camera, a microphone or a location from inside an
// API response, and a file upload is not camera access — the browser's own picker
// handles that without any of these permissions.
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), payment=()';

/**
 * Which half of this origin is answering. `/ws` is listed because a WebSocket
 * upgrade arrives as an HTTP GET on that path before it becomes a socket, and the
 * claims on the way past that handshake belong with the API's, not with a page's.
 */
function isApiRequest(req) {
  const path = req.path || req.url || '';
  return path === '/api' || path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws?');
}

function secureHeaders(req, res, next) {
  // When this process also serves the site, everything that is not an answer from
  // `/api` is headed by pageHeaders — a page under this policy would show a blank
  // window and forbid its own stylesheet.
  if (config.serveWeb && !isApiRequest(req)) return next();

  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });

  // Only true when the connection really is HTTPS. Promising it over plain HTTP
  // does nothing, and promising it on a development port would make a laptop's
  // browser refuse its own localhost for weeks afterwards.
  if (config.nodeEnv === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

module.exports = { secureHeaders, isApiRequest, CSP };
