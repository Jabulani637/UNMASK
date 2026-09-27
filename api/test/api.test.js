'use strict';
/**
 * The two rules that must hold no matter what else changes:
 *
 *   1. /api/health is unauthenticated, so it must never carry a secret, a
 *      password, a connection string or a filesystem path.
 *   2. A page from an origin that is not the web app must get no CORS
 *      permission, or a random website could read a logged-in student's data.
 *
 * These run against the real HTTP stack, and pass with or without the database
 * reachable — health answers 503 when Mongo is down, which is also asserted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const { buildApp } = require('../src/app');

let server;
let base;

test('the API', async t => {
  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await t.test('health publishes no secrets and no paths', async () => {
    const res = await fetch(`${base}/api/health`);
    const text = await res.text();

    assert.ok(res.status === 200 || res.status === 503, `unexpected status ${res.status}`);

    for (const forbidden of [
      config.session.secret,
      config.mongoUrl,
      config.photoDir,
      config.smtp.password,
      'mongodb://',
    ]) {
      if (!forbidden) continue;
      assert.ok(!text.includes(forbidden), `health leaked ${JSON.stringify(forbidden.slice(0, 6))}…`);
    }
    assert.ok(!/\/data\/|[A-Za-z]:\\\\/.test(text), 'health contains an absolute path');
  });

  await t.test('health is honest about a database it cannot reach', async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    assert.equal(body.readiness.database, false, 'this test never connects to Mongo, so health must say so');
    assert.equal(body.status, 'degraded');
    assert.equal(body.service, 'unmask-api');
  });

  await t.test('meta with the database down is a plain JSON 500, not a guessed vocabulary', async () => {
    // Since the institutions came off `.env` and onto documents, /api/meta needs a
    // read. This suite never connects to Mongo on purpose, so what is being proven
    // here is the failure: a student gets one honest sentence, in JSON, with no
    // half-list of colleges and nothing about the server in it. The vocabulary
    // itself is asserted in test/institutions.test.js, which does connect.
    const res = await fetch(`${base}/api/meta`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'Something went wrong on our end.' });
    for (const forbidden of [config.mongoUrl, config.session.secret, config.photoDir, 'mongodb://']) {
      if (!forbidden) continue;
      assert.ok(!text.includes(forbidden), 'meta leaked ' + JSON.stringify(forbidden.slice(0, 6)));
    }
  });

  await t.test('an unfamiliar origin gets no CORS permission', async () => {
    const allowed = await fetch(`${base}/api/meta`, { headers: { Origin: config.webOrigins[0] } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), config.webOrigins[0]);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

    const blocked = await fetch(`${base}/api/meta`, { headers: { Origin: 'https://not-unmask.example' } });
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
    assert.equal(blocked.headers.get('access-control-allow-credentials'), null);
  });

  await t.test('an unknown API path is a JSON 404, not the web app', async () => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'Unknown API endpoint' });
  });
});
