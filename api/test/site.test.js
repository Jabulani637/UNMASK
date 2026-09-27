'use strict';
/**
 * Stage 9d — the one origin, and the two sets of headers that live on it.
 *
 * A build directory is faked here rather than reading `web/dist`, because this
 * suite has to pass on a machine where nobody has run `npm run build`, and because
 * the assertions are about what the server *says*, not about what Vite emitted.
 *
 * Four claims:
 *
 *   - **The page and the JSON are headed separately, and neither borrows the
 *     other's policy.** `default-src 'none'` on the document would be a blank
 *     window; `default-src 'self'` on an API answer would be the weaker claim
 *     about the responses that hold a student's words. Both are asserted on both
 *     halves, in the same request round.
 *   - **Serving the site does not swallow the API.** An unknown path under `/api`
 *     still answers the JSON 404 the staff screen depends on, rather than the HTML
 *     shell — which is why the static mount sits after that catch-all.
 *   - **Nothing a student saw is kept, and the one thing that is kept can never go
 *     stale.** The document is `no-store`; only a file under `/assets`, whose name
 *     is a hash of its bytes, is allowed a year.
 *   - **The page policy has no `unsafe-inline` in it.** That is the promise the
 *     profile meter was refactored to buy, and it is checked as a string.
 *
 * No database: every route exercised here answers before a query, and the point of
 * the file is the headers, not the data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));

const { config } = require('../src/config');
const { buildApp } = require('../src/app');
const { PAGE_CSP } = require('../src/middleware/pageHeaders');
const { CSP: API_CSP } = require('../src/middleware/secureHeaders');

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-dist-'));
const HASHED = 'index-0123456789ab.js';

fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.mkdirSync(path.join(dist, 'fonts'), { recursive: true });
fs.writeFileSync(
  path.join(dist, 'index.html'),
  '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/index-0123456789ab.css">' +
    `<script type="module" src="/assets/${HASHED}"></script><title>Unmask</title></head>` +
    '<body><div id="root"></div></body></html>\n'
);
fs.writeFileSync(path.join(dist, 'assets', HASHED), 'export const built = true;\n');
fs.writeFileSync(path.join(dist, 'assets', 'index-0123456789ab.css'), 'body{margin:0}\n');
fs.writeFileSync(path.join(dist, 'fonts', 'anton-400-latin.woff2'), 'not really a font\n');

let server;
let base;

/**
 * A plain object rather than the Response: `body` on a Response is a stream and a
 * getter, and every assertion below wants the text and the headers, twice over.
 */
async function get(route, method = 'GET') {
  const res = await fetch(base + route, { method, redirect: 'manual' });
  return {
    status: res.status,
    headers: res.headers,
    text: await res.text(),
    get summary() {
      return `${method} ${route} -> ${this.status} ${this.headers.get('content-type')}: ${this.text.slice(0, 120)}`;
    },
  };
}

function cspOf(res) {
  return res.headers.get('content-security-policy') || '';
}

test('stage 9d — the API serves the site, and the two halves keep their own headers', async t => {
  assert.equal(config.serveWeb, false, 'this suite only means anything if testing does not serve a site on its own');

  config.webDist = dist;
  config.serveWeb = true;

  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  await t.test('the document is a page, not an API answer', async () => {
    const res = await get('/');
    assert.equal(res.status, 200, res.summary);
    assert.match(res.headers.get('content-type'), /text\/html/, res.summary);
    const csp = cspOf(res);
    assert.ok(csp.includes("default-src 'self'"), `page CSP was "${csp}"`);
    assert.ok(!csp.includes("default-src 'none'"), `the page is under the API's policy: "${csp}"`);
    assert.ok(!csp.includes('unsafe-inline'), `the page policy allows inline: "${csp}"`);
    assert.equal(res.headers.get('cache-control'), 'no-store', res.summary);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.ok(res.text.includes('<div id="root">'), 'the document served was not the build');
  });

  await t.test('a hashed file may be kept for a year; the fonts that are not hashed, for a week', async () => {
    const js = await get(`/assets/${HASHED}`);
    assert.equal(js.status, 200, js.summary);
    assert.match(js.headers.get('cache-control'), /max-age=31536000/, js.summary);
    assert.match(js.headers.get('cache-control'), /immutable/, js.summary);
    assert.ok(cspOf(js).includes("default-src 'self'"), 'an asset is part of the page, not of the API');

    const font = await get('/fonts/anton-400-latin.woff2');
    assert.equal(font.status, 200, font.summary);
    assert.match(font.headers.get('cache-control'), /max-age=604800/, font.summary);
  });

  await t.test('a client route the server has never heard of still gets the app, and never a cache', async () => {
    for (const route of ['/chats/6ab7f63dd4d98e5210c21cde', '/staff/reports', '/privacy']) {
      const res = await get(route);
      assert.equal(res.status, 200, res.summary);
      assert.match(res.headers.get('content-type'), /text\/html/, res.summary);
      assert.equal(res.headers.get('cache-control'), 'no-store', res.summary);
    }
  });

  await t.test('the API is untouched by any of this, including the path that reaches no route', async () => {
    const missing = await get('/api/nothing-at-all');
    assert.equal(missing.status, 404, missing.summary);
    assert.equal(cspOf(missing), API_CSP, `an API 404 must carry the API policy word for word: "${cspOf(missing)}"`);
    assert.equal(missing.headers.get('cache-control'), 'no-store', missing.summary);
    assert.match(missing.headers.get('content-type'), /application\/json/, missing.summary);
    assert.ok(!missing.text.includes('<html'), `an API 404 served the HTML shell: ${missing.summary}`);

    const health = await get('/api/health');
    assert.ok([200, 503].includes(health.status), health.summary);
    assert.equal(cspOf(health), API_CSP, health.summary);
  });

  await t.test('a missing file 404s instead of handing out the document with a 200', async () => {
    const stale = await get('/assets/index-deadbeef.js');
    assert.equal(stale.status, 404, stale.summary);
    assert.match(stale.headers.get('content-type'), /application\/json/, stale.summary);
    assert.ok(!stale.text.includes('<html'), stale.summary);

    const noSuchImage = await get('/assets/nothing.png');
    assert.equal(noSuchImage.status, 404, noSuchImage.summary);
  });

  await t.test('the site answers GET and HEAD; a POST to a page route is not a route', async () => {
    const head = await get('/', 'HEAD');
    assert.equal(head.status, 200, head.summary);
    assert.equal(head.headers.get('cache-control'), 'no-store', head.summary);

    const posted = await get('/profile', 'POST');
    assert.equal(posted.status, 404, posted.summary);
    assert.match(posted.headers.get('content-type'), /application\/json/, posted.summary);
    assert.ok(!posted.text.includes('<html'), `a framework error page: ${posted.summary}`);
  });

  await t.test('the two policies are different strings, so neither file can quietly take over', () => {
    assert.notEqual(PAGE_CSP, API_CSP);
    assert.ok(PAGE_CSP.includes("connect-src 'self' ws: wss:"), `the chat socket would be blocked: ${PAGE_CSP}`);
  });
});
