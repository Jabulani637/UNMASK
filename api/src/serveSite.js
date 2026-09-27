'use strict';
/**
 * Serving the built site from the API process (stage 9d).
 *
 * Two reasons, and the second is the load-bearing one. One process to deploy is
 * simpler than two, but what actually decides it is the cookie: a session cookie
 * that has to cross from `localhost:5273` to `localhost:4100` is a cross-site
 * cookie, which needs `SameSite=None`, which needs HTTPS, which a campus laptop on
 * plain HTTP cannot have — and a site whose whole promise is that it knows who you
 * are cannot ship a page that sends the cookie anywhere else. Page, JSON and chat
 * socket from one origin means the cookie is first-party and no CORS pre-flight
 * ever happens.
 *
 * The cache split is the part worth reading twice:
 *
 *   /assets/*   one year, immutable. Vite writes the content hash into the file
 *               name, so a file at a given path never changes; a rebuild produces
 *               a different path. Caching it cannot serve a stale copy.
 *   everything else in the build   seven days. The fonts and the icon are not
 *               hashed, so they can go stale — 7 days is the compromise between
 *               a phone on a campus network and a font that almost never changes.
 *   the HTML     never. This is the only file that names the others, so it is the
 *               one that has to be re-read for a fresh deploy to reach a student.
 *               It is also a student's own screen: a cached copy is a page back
 *               into somebody's chat on a library machine.
 *
 * A path with a file extension that the build does not contain answers 404 rather
 * than with the HTML shell. Without that, a broken image tag or a stale
 * `/assets/index-abc123.js` from a superseded deploy would receive 200 and a
 * document, and the browser would be told the bytes were a stylesheet.
 */

const path = require('path');

const express = require('express');

const { config } = require('./config');
const { pageHeaders } = require('./middleware/pageHeaders');

// `ext` is what the request looked like it wanted; the 404 has to say the same
// thing back or a browser reading it as JSON gets HTML.
function looksLikeFile(req) {
  return /\.[a-z0-9]{1,8}$/i.test(req.path);
}

function mountSite(app) {
  const indexFile = path.join(config.webDist, 'index.html');

  app.use(pageHeaders);

  app.use(
    '/assets',
    express.static(path.join(config.webDist, 'assets'), {
      maxAge: '1y',
      immutable: true,
      index: false,
      fallthrough: true,
    })
  );

  app.use(
    express.static(config.webDist, {
      maxAge: '7d',
      // `/` is the SPA fallback's job, so the document there can be no-store.
      index: false,
      // An explicit /index.html should not be cacheable either — it is the same
      // document the fallback serves.
      setHeaders(res, filePath) {
        if (path.resolve(filePath) === path.resolve(indexFile)) res.setHeader('Cache-Control', 'no-store');
      },
    })
  );

  app.use((req, res, next) => {
    const notFound = () => res.status(404).type('application/json').json({ error: 'Not found' });

    // Anything that is not a read of a path is not a site request: every API route
    // was answered above, so a POST here is a mistake, and Express's own
    // "Cannot POST /profile" page is the one thing this file should not hand out.
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
    if (looksLikeFile(req)) return notFound();

    res.set('Cache-Control', 'no-store');
    return res.sendFile(indexFile, err => {
      if (err && !res.headersSent) next(err);
    });
  });
}

module.exports = { mountSite };
