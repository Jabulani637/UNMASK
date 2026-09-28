'use strict';
/**
 * The HTTPS door out of a host that is not allowed to open an SMTP socket.
 *
 * This exists because of a measured failure, not a hypothetical one: Render's free
 * tier blocks outbound traffic to ports 25, 465 and 587, so the deployed API booted
 * green, printed `email via smtp-relay.brevo.com`, and then hung for two minutes on
 * every single registration before answering "Something went wrong on our end."
 * Nothing in the boot gates could see that, because every gate asks whether a value
 * is *present* and none of them can ask whether a port can be reached.
 *
 * Nothing here touches Brevo, a real key, or a real inbox. `config.mail.apiKey` is
 * forced to empty while `NODE_ENV=test` (so no suite can mail a stranger by
 * accident), and this file asks for it back the way the photo suite asks for its R2
 * values: by replacing them on the config object and pointing the URL at a server on
 * 127.0.0.1 that records what actually arrived on the socket.
 */

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const CONFIG = require.resolve('../src/config');
const { config } = require('../src/config');
const mail = require('../src/services/mail');

const API_KEY = 'xkeysib-test-key-not-a-real-one';
const URL_PATH = '/v3/smtp/email';
// Pinned rather than read, so this file says the same thing on a laptop whose .env
// has a real MAIL_FROM in it and on a server that has none.
const FROM = 'Unmask <no-reply@unmask.local>';

/**
 * A stand-in Brevo. It answers whatever the case below hands it and remembers every
 * request it received, so the assertions are about the bytes that left this process.
 */
function standIn(responder) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const { status, json } = responder(raw ? JSON.parse(raw) : null);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        seen,
        url: `http://127.0.0.1:${server.address().port}${URL_PATH}`,
      });
    });
  });
}

/** Point the service at a stand-in for the length of `run`. */
async function withStandIn(responder, run) {
  const stub = await standIn(responder);
  const before = { key: config.mail.apiKey, url: config.mail.apiUrl, from: config.smtp.from };
  config.mail.apiKey = API_KEY;
  config.mail.apiUrl = stub.url;
  config.smtp.from = FROM;
  try {
    await run(stub);
  } finally {
    config.mail.apiKey = before.key;
    config.mail.apiUrl = before.url;
    config.smtp.from = before.from;
    stub.server.close();
  }
}

test('the key is never read while testing, whatever the machine has set', () => {
  const original = require.cache[CONFIG];
  process.env.BREVO_API_KEY = API_KEY;
  delete require.cache[CONFIG];
  const fresh = require(CONFIG).config;
  delete process.env.BREVO_API_KEY;
  require.cache[CONFIG] = original;

  assert.equal(fresh.mail.apiKey, '', 'a suite that honoured BREVO_API_KEY would mail real addresses out of a real account');
  assert.equal(fresh.mail.apiUrl, 'https://api.brevo.com/v3/smtp/email');
});

test('with no key and no SMTP host, mail still goes to the outbox', () => {
  assert.equal(config.mail.apiKey, '');
  assert.equal(mail.transportName(), 'local-outbox');
});

test('a key turns the transport name over, and taking it away turns it back', async () => {
  await withStandIn(() => ({ status: 201, json: { messageId: 'stub' } }), async () => {
    assert.equal(mail.transportName(), 'brevo-http');
  });
  assert.equal(mail.transportName(), 'local-outbox', 'the stand-in was cleaned up, not left switched on');
});

test('the request that leaves this process is the one Brevo documents', async () => {
  await withStandIn(
    () => ({ status: 201, json: { messageIds: { messageId: 'abc-123' } } }),
    async stub => {
      const result = await mail.send({
        to: '222113510@mycput.ac.za',
        subject: 'Your Unmask code',
        text: 'Your code is 123456.',
      });

      assert.equal(stub.seen.length, 1);
      const req = stub.seen[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, URL_PATH);
      assert.equal(req.headers['api-key'], API_KEY);
      assert.equal(req.headers['content-type'], 'application/json');

      // `MAIL_FROM` is written "Name <address>" because that is the shape nodemailer
      // takes whole. The API wants the two halves apart, and a body that sent the
      // combined string as the address would be refused for a reason no gate catches.
      assert.deepEqual(req.body.sender, { name: 'Unmask', email: 'no-reply@unmask.local' });
      assert.deepEqual(req.body.to, [{ email: '222113510@mycput.ac.za' }]);
      assert.equal(req.body.subject, 'Your Unmask code');
      assert.equal(req.body.textContent, 'Your code is 123456.');

      assert.equal(result.delivered, 'http');
    }
  );
});

test('a quoted display name in MAIL_FROM survives the split, and an empty one does not ship', async () => {
  for (const [value, expected] of [
    ['"Unmask Campus" <hello@unmask.ac.za>', { name: 'Unmask Campus', email: 'hello@unmask.ac.za' }],
    ['Unmask <hello@unmask.ac.za>', { name: 'Unmask', email: 'hello@unmask.ac.za' }],
    ['<hello@unmask.ac.za>', { name: 'Unmask', email: 'hello@unmask.ac.za' }],
    ['hello@unmask.ac.za', { name: 'Unmask', email: 'hello@unmask.ac.za' }],
  ]) {
    await withStandIn(
      () => ({ status: 201, json: {} }),
      async stub => {
        config.smtp.from = value;
        await mail.send({ to: 'student@mycput.ac.za', subject: 's', text: 't' });
        assert.deepEqual(stub.seen[0].body.sender, expected, value);
      }
    );
  }
});

test('Brevo\'s own reason reaches the log, and the key does not', async () => {
  await withStandIn(
    () => ({ status: 400, json: { code: 'invalid_parameter', message: 'This email address is not verified' } }),
    async () => {
      await assert.rejects(
        () => mail.send({ to: 'student@mycput.ac.za', subject: 's', text: 't' }),
        err => {
          assert.match(err.message, /not verified/, 'the sentence that says how to fix it is Brevo\'s, not ours');
          assert.ok(!err.message.includes(API_KEY), `the key must never be echoed: ${err.message}`);
          return true;
        }
      );
    }
  );
});

test('a host that cannot be reached fails in seconds and says which door it was', async () => {
  const key = config.mail.apiKey;
  const url = config.mail.apiUrl;
  config.mail.apiKey = API_KEY;
  // A port nothing listens on: this is the shape of Render's blocked egress as far
  // as this process can tell, and the old failure was a two-minute wait for it.
  config.mail.apiUrl = 'http://127.0.0.1:1/v3/smtp/email';
  const started = Date.now();
  try {
    await assert.rejects(
      () => mail.send({ to: 'student@mycput.ac.za', subject: 's', text: 't' }),
      err => {
        assert.match(err.message, /Could not reach http:\/\/127\.0\.0\.1:1/);
        assert.match(err.message, /blocks outbound traffic/);
        assert.ok(!err.message.includes(API_KEY), 'a connection failure is not a place to repeat a key');
        return true;
      }
    );
  } finally {
    config.mail.apiKey = key;
    config.mail.apiUrl = url;
  }
  assert.ok(Date.now() - started < 10_000, 'gives up inside its own timeout, not two minutes later');
});
