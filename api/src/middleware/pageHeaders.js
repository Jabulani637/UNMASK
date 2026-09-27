/**
 * The headers on a page, which are not the headers on an answer.
 *
 * The API's own policy is `default-src 'none'`: it serves JSON and loads nothing,
 * so it can afford to forbid everything. That policy applied to HTML would be a
 * site that renders nothing at all, and a relaxed version of it applied to JSON
 * would be the weaker claim. So the two live in two files, and each is as strict
 * as the thing it describes.
 *
 * What is being protected here is the same thing as ever: a student's page should
 * be readable only by that student's browser, from this origin, and should not be
 * kept by the library machine it opened on. `script-src 'self'` with no
 * 'unsafe-inline' is the one worth naming — it means a stored `<script>` in a
 * prompt answer would not run even if something else on this site failed, because
 * the browser would refuse to fetch the idea of it from anywhere but here.
 *
 * `connect-src` carries `ws:` and `wss:` without a host on purpose. The chat
 * socket is opened at this page's own host, and `'self'` matching a same-origin
 * WebSocket is one of the areas where browser implementations have disagreed; a
 * policy that quietly kills the chat is worse than one that names two schemes.
 */

const { config } = require('../config');

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].concat(config.nodeEnv === 'production' ? ["upgrade-insecure-requests"] : []).join('; ');

const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), payment=(), autoplay=()';

function pageHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS,
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  if (config.nodeEnv === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

module.exports = { pageHeaders, PAGE_CSP };
