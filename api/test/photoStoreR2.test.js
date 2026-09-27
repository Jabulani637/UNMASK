'use strict';
/**
 * The Cloudflare R2 photo driver, proven against a stand-in for the storage API.
 *
 * R2 answers with an XML error document and a status code, and nothing about that
 * is worth finding out at 2 p.m. on a live site: a signature that is wrong in one
 * character, a bucket name that ended up inside a key, a `DELETE` that reported
 * success for an object that was never there. So this file runs a real HTTP server
 * on 127.0.0.1 and holds the driver to the wire.
 *
 * The important choice is how the signature is checked. The test does **not** call
 * the driver's own signing function — that would only prove the function agrees
 * with itself. It rebuilds the canonical request from the bytes the server actually
 * received: the method, the path as it arrived, the query re-sorted by this file's
 * own reference implementation, the headers named in `SignedHeaders` read off the
 * request, and the body hashed from what was written to the socket. If those two
 * independent computations land on the same signature, the driver signed what it
 * sent rather than what it meant to send.
 *
 * Nothing here touches Cloudflare, a real bucket, or a real key. `config.photoStore`
 * is forced to `disk` while `NODE_ENV=test` (so no suite can ever upload to a live
 * bucket by accident), and this file asks for the R2 configuration back by replacing
 * `config.r2` with these local values for the length of each case.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('node:http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { config } = require('../src/config');
const R2 = require('../src/services/photo-store/r2');

const BUCKET = 'unmask-photos';
const KEY_ID = 'AKIDTESTEXAMPLEKEYID';
const SECRET = 'test-secret-access-key-value';
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

// A name this driver would have written: `photo-name.js` allows 8–64 of
// [A-Za-z0-9_-] plus one of four extensions.
const NAME = 'Ab1_-9cd.jpg';
const KEY = `photos/${NAME}`;

/**
 * RFC 3986 unreserved encoding, written again here on purpose. The driver has its
 * own; a test that reused it could not catch it encoding something it should not.
 */
function refEncode(value) {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The query as it arrived on the socket, canonicalised independently. */
function refCanonicalQuery(rawQuery) {
  return String(rawQuery || '')
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const at = pair.indexOf('=');
      const raw = at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
      return [refEncode(decodeURIComponent(raw[0])), refEncode(decodeURIComponent(raw[1]))];
    })
    .sort((a, b) => byteOrder(a[0], b[0]) || byteOrder(a[1], b[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Does the Authorization header match the request this server was handed?
 * Returns the pieces either way, so a failure says which part disagreed.
 */
function verifySignature({ method, rawPath, rawQuery, headers, body }) {
  const auth = String(headers.authorization || '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return { ok: false, why: `Authorization is not an AWS4-HMAC-SHA256 header: ${auth}` };
  const [, sentKeyId, scope, signedList, signature] = m;

  const names = signedList.split(';');
  const canonicalHeaders = names
    .map(n => `${n}:${String(headers[n] === undefined ? '' : headers[n]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');

  const canonicalRequest = [
    method,
    rawPath,
    refCanonicalQuery(rawQuery),
    `${canonicalHeaders}\n${names.join(';')}`,
    String(headers['x-amz-content-sha256'] || ''),
  ].join('\n');

  const amzDate = String(headers['x-amz-date'] || '');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  let key = Buffer.from(`AWS4${SECRET}`, 'utf8');
  for (const part of scope.split('/')) key = crypto.createHmac('sha256', key).update(part).digest();
  const expected = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  const [dateStamp, region, service, terminator] = scope.split('/');
  const problems = [];
  if (sentKeyId !== KEY_ID) problems.push(`credential names ${sentKeyId}`);
  if (region !== 'auto' || service !== 's3' || terminator !== 'aws4_request') problems.push(`scope is "${scope}"`);
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) problems.push(`x-amz-date "${amzDate}" is not yyyymmddThhmmssZ`);
  if (dateStamp !== amzDate.slice(0, 8)) problems.push(`scope date ${dateStamp} is not the request date ${amzDate.slice(0, 8)}`);
  if (EMPTY_HASH !== String(headers['x-amz-content-sha256'])) {
    const actual = crypto.createHash('sha256').update(body || Buffer.alloc(0)).digest('hex');
    if (actual !== String(headers['x-amz-content-sha256'])) problems.push('the payload hash is not a hash of the body that arrived');
  }
  if (expected !== signature) problems.push('signature mismatch');

  return { ok: problems.length === 0, why: problems.join('; '), names, canonicalRequest, stringToSign };
}

function xmlError(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><BucketName>${BUCKET}</BucketName></Error>`;
}

function listedPage(keys, { truncated = false, token = null } = {}) {
  const contents = keys
    .map(k => `<Contents><Key>${k.name}</Key><Size>${k.bytes}</Size><LastModified>2026-09-27T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>photos/</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>500</MaxKeys><IsTruncated>${truncated}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`;
}

const REAL_R2 = config.r2;

// A real JPEG header, because the driver is handed bytes and a mime type, not a file.
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x55, 0x6e, 0x6d, 0x61, 0x73, 0x6b]);

/**
 * Start one stand-in store, point the driver at it, run `fn`, put the real
 * configuration back. `handler` sees every request and answers it; the signature
 * check happens here first, so a case that signs wrong gets a 403 whether or not it
 * was the thing under test.
 */
async function withStore(handler, fn, { timeoutMs = 8000, secret = SECRET } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const raw = req.url;
      const at = raw.indexOf('?');
      const rawPath = at === -1 ? raw : raw.slice(0, at);
      const rawQuery = at === -1 ? '' : raw.slice(at + 1);
      const signed = verifySignature({ method: req.method, rawPath, rawQuery, headers: req.headers, body });
      seen.push({ method: req.method, rawPath, rawQuery, headers: req.headers, body, signed });
      if (!signed.ok) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(xmlError('SignatureDoesNotMatch', signed.why));
        return;
      }
      handler({ method: req.method, rawPath, rawQuery, headers: req.headers, body, seen, res });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  config.r2 = {
    endpoint: `http://127.0.0.1:${port}`,
    bucket: BUCKET,
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    requestTimeoutMs: timeoutMs,
  };
  try {
    await fn({ origin: `http://127.0.0.1:${port}`, seen });
  } finally {
    config.r2 = REAL_R2;
    // A stalled handler (the timeout case) would otherwise hold a socket open and
    // keep the run alive after its assertions are long finished.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('the R2 photo driver, proven against a stand-in for the storage API', async t => {
  await t.test('a photo read arrives path-style, signed, and with an empty-payload hash', async () => {
    await withStore(({ method, rawPath, headers, res }) => {
      assert.equal(method, 'GET');
      assert.equal(rawPath, `/${BUCKET}/${KEY}`);
      assert.equal(headers['x-amz-content-sha256'], EMPTY_HASH);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) });
      res.end(bytes);
    }, async () => {
      const out = await R2.get(NAME);
      assert.ok(out.equals(bytes));
    });
  });

  await t.test('the signed date has exactly one trailing Z', async () => {
    let stamp = '';
    await withStore(({ headers, res }) => {
      stamp = String(headers['x-amz-date']);
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end(xmlError('NoSuchKey', 'no such key'));
    }, async () => {
      assert.equal(await R2.get(NAME), null);
    });
    assert.match(stamp, /^\d{8}T\d{6}Z$/);
  });

  await t.test('an upload carries the no-overwrite precondition, and signs it', async () => {
    await withStore(({ method, rawPath, headers, body, res }) => {
      assert.equal(method, 'PUT');
      assert.equal(rawPath, `/${BUCKET}/${KEY}`);
      assert.equal(headers['if-none-match'], '*');
      assert.equal(headers['content-type'], 'image/png');
      assert.equal(headers['cache-control'], 'max-age=31536000');
      assert.ok(body.equals(bytes));
      for (const name of ['if-none-match', 'content-type', 'cache-control']) {
        assert.ok(headers.authorization.includes(name), `${name} must be inside SignedHeaders`);
      }
      res.writeHead(200);
      res.end('');
    }, async () => {
      await R2.put(NAME, bytes, 'image/png');
    });
  });

  await t.test('a name already in the bucket is refused, not overwritten', async () => {
    await withStore(({ res }) => {
      res.writeHead(412, { 'content-type': 'application/xml' });
      res.end(xmlError('PreconditionFailed', 'the object exists'));
    }, async () => {
      await assert.rejects(() => R2.put(NAME, bytes, 'image/jpeg'), /already holds an object named/);
    });
  });

  await t.test('a refused credential says so, and never quotes the secret back', async () => {
    const leak = `<Error><Code>InvalidAccessKeyId</Code><Message>The secret ${SECRET} is not valid</Message></Error>`;
    await withStore(({ res }) => {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(leak);
    }, async () => {
      await assert.rejects(
        () => R2.get(NAME),
        err => {
          assert.ok(!err.message.includes(SECRET), `the secret appeared in an error message: ${err.message}`);
          assert.match(err.message, /\[redacted\]/);
          assert.match(err.message, /R2_ACCESS_KEY_ID/);
          assert.match(err.message, /HTTP 403/);
          return true;
        }
      );
    });
  });

  await t.test('a 404 with no code is a missing photo, not an error', async () => {
    await withStore(({ res }) => {
      res.writeHead(404);
      res.end('');
    }, async () => {
      assert.equal(await R2.get(NAME), null);
    });
  });

  await t.test('a request the store cannot verify is refused, so every other case here has teeth', async () => {
    // If the stand-in answered whatever it was handed, the cases around this one
    // would pass against a driver that signed nothing at all. This one fails on
    // purpose: the secret it signs with is not the secret the server hashes with.
    await withStore(
      ({ res }) => {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(xmlError('SignatureDoesNotMatch', 'the request signature we calculated does not match the signature you provided'));
      },
      async () => {
        await assert.rejects(() => R2.get(NAME), /was refused/);
      },
      { secret: 'a-different-secret-access-key' }
    );
  });

  await t.test('delete asks first, and reports false for an object that was never there', async () => {
    await withStore(({ method, res }) => {
      if (method === 'HEAD') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
    }, async ({ seen }) => {
      assert.equal(await R2.del(NAME), false);
      assert.deepEqual(seen.map(r => r.method), ['HEAD']);
    });
  });

  await t.test('delete returns true only after a head that found the object', async () => {
    await withStore(({ method, res }) => {
      if (method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(bytes.length) });
        res.end();
        return;
      }
      assert.equal(method, 'DELETE');
      res.writeHead(204);
      res.end();
    }, async ({ seen }) => {
      assert.equal(await R2.del(NAME), true);
      assert.deepEqual(seen.map(r => r.method), ['HEAD', 'DELETE']);
    });
  });

  await t.test('a listing is followed over more than one page, and is the same shape a disk listing is', async () => {
    const other = 'photos/zzzzzzzzzzzz.png';
    await withStore(({ rawQuery, res }) => {
      assert.match(rawQuery, /list-type=2/);
      assert.match(rawQuery, /prefix=photos%2F/);
      if (rawQuery.includes('continuation-token')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(listedPage([{ name: other, bytes: 7 }]));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(listedPage([{ name: 'photos/a&amp;b.jpg', bytes: 3 }, { name: KEY, bytes: bytes.length }], { truncated: true, token: 'next+token' }));
    }, async ({ seen }) => {
      const listed = await R2.list();
      // Bare names, no `photos/` in front: the same thing `disk.js` answers with, so
      // no caller has to know which store it is holding.
      assert.deepEqual(listed, [{ name: NAME, bytes: bytes.length }, { name: 'zzzzzzzzzzzz.png', bytes: 7 }]);
      // `a&amp;b.jpg` decoded to `a&b.jpg`, which is not a name this store would ever
      // have written, and so is not a photo of ours.
      assert.equal(seen.length, 2, 'one page is not a listing');
      // The token went back out the way a canonical query encodes it, and the
      // signature verified against that exact form — which is the only proof either
      // side has of what a "+" inside a query value means.
      assert.match(seen[1].rawQuery, /continuation-token=next%2Btoken/);
    });
  });

  await t.test('the wire query arrives in canonical sorted order', async () => {
    await withStore(({ res }) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(listedPage([]));
    }, async ({ seen }) => {
      await R2.list();
      const raw = seen[0].rawQuery;
      const keys = raw.split('&').map(p => p.split('=')[0]);
      const sorted = [...keys].sort(byteOrder);
      assert.deepEqual(keys, sorted, `query params are not in byte order: ${raw}`);
    });
  });

  await t.test('a store that hands back the same page token twice is stopped, not billed', async () => {
    await withStore(({ res }) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(listedPage([{ name: KEY, bytes: 1 }], { truncated: true, token: 'stuck' }));
    }, async () => {
      await assert.rejects(() => R2.list(), /kept paging at \d+ objects without finishing/);
    });
  });

  await t.test('a backup writes flat files into a folder that does not exist yet', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-r2-backup-'));
    const dest = path.join(work, 'bundle', 'photos');
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const foreign = 'photos/someone-elses/notes.txt';
    await withStore(({ method, rawPath, rawQuery, res }) => {
      if (method === 'GET' && rawQuery.includes('list-type=2')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(listedPage([{ name: KEY, bytes: bytes.length }, { name: foreign, bytes: 40 }]));
        return;
      }
      assert.equal(rawPath, `/${BUCKET}/${KEY}`);
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(bytes);
    }, async () => {
      const out = await R2.copyTo(dest);
      assert.deepEqual(out, { files: 1, bytes: bytes.length, foreign: 1 });
      assert.deepEqual(fs.readdirSync(dest), [NAME]);
      assert.ok(fs.readFileSync(path.join(dest, NAME)).equals(bytes));
    });
  });

  await t.test('a restore refuses a folder it did not write, before writing anything', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-r2-restore-'));
    fs.writeFileSync(path.join(work, NAME), bytes);
    fs.writeFileSync(path.join(work, 'notes.txt'), 'mine');
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    await withStore(({ res }) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(listedPage([]));
    }, async ({ seen }) => {
      await assert.rejects(() => R2.copyFrom(work), /notes\.txt is not a filename this store would have written/);
      assert.deepEqual(seen.map(r => r.method), ['GET'], 'nothing should be uploaded yet');
    });
  });

  await t.test('a restore refuses to overwrite a live photo, before writing anything', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-r2-clash-'));
    fs.writeFileSync(path.join(work, NAME), bytes);
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    await withStore(({ method, res }) => {
      if (method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(listedPage([{ name: KEY, bytes: 9 }]));
        return;
      }
      res.writeHead(200);
      res.end('');
    }, async ({ seen }) => {
      await assert.rejects(() => R2.copyFrom(work), /already holds an object named/);
      assert.deepEqual(seen.map(r => r.method), ['GET']);
    });
  });

  await t.test('a restore pushes every file and reports the real count', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-r2-push-'));
    const second = `${'q'.repeat(10)}.webp`;
    fs.writeFileSync(path.join(work, NAME), bytes);
    fs.writeFileSync(path.join(work, second), Buffer.from('webp bytes'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const putTypes = [];
    await withStore(({ method, headers, res }) => {
      if (method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(listedPage([{ name: 'photos/not-a-photo-name.txt', bytes: 4 }]));
        return;
      }
      putTypes.push(headers['content-type']);
      res.writeHead(200);
      res.end('');
    }, async () => {
      const out = await R2.copyFrom(work);
      assert.equal(out.files, 2);
      assert.equal(out.bytes, bytes.length + 10);
      assert.deepEqual(putTypes.sort(), ['image/jpeg', 'image/webp']);
    });
  });

  await t.test('the health probe tells a bad key from a missing bucket', async () => {
    for (const [status, reason] of [[200, null], [403, 'unauthorized'], [404, 'bucket-not-found'], [500, 'http-500']]) {
      await withStore(({ method, rawPath, res }) => {
        assert.equal(method, 'HEAD');
        assert.equal(rawPath, `/${BUCKET}`);
        res.writeHead(status);
        res.end();
      }, async () => {
        const out = await R2.probe();
        if (reason === null) assert.deepEqual(out, { ok: true });
        else assert.deepEqual(out, { ok: false, reason });
      });
    }
  });

  await t.test('a store that stops answering gives up on its own, and says after how long', async () => {
    await withStore(
      t,
      () => {
        // Deliberately never answers.
      },
      async () => {
        await assert.rejects(() => R2.get(NAME), /did not answer within 250 ms/);
      },
      { timeoutMs: 250 }
    );
  });

  await t.test('an endpoint with nothing behind it is named as unreachable', async () => {
    config.r2 = { endpoint: 'http://127.0.0.1:1', bucket: BUCKET, accessKeyId: KEY_ID, secretAccessKey: SECRET, requestTimeoutMs: 2000 };
    try {
      await assert.rejects(() => R2.get(NAME), /the photo store at R2_ENDPOINT could not be reached/);
    } finally {
      config.r2 = REAL_R2;
    }
  });

  await t.test('both drivers answer "what does the store hold" with the same thing', async () => {
    // One question, two stores. A name carrying a folder or a `photos/` prefix would
    // mean the answer depends on which driver is configured, and a backup script
    // written against one of them would be wrong for the other.
    const { isOurName } = require('../src/services/photo-store/photo-name');
    const DISK = require('../src/services/photo-store/disk');

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-list-shape-'));
    fs.writeFileSync(path.join(work, NAME), bytes);
    fs.writeFileSync(path.join(work, 'notes.txt'), 'not a photo');
    fs.mkdirSync(path.join(work, 'nested'));
    fs.writeFileSync(path.join(work, 'nested', 'deep.jpg'), 'also not a photo');
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));

    const dir = config.photoDir;
    config.photoDir = work;
    let fromDisk;
    try {
      fromDisk = await DISK.list();
    } finally {
      config.photoDir = dir;
    }
    assert.deepEqual(fromDisk, [{ name: NAME, bytes: bytes.length }]);

    let fromR2;
    await withStore(({ res }) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        listedPage([
          { name: KEY, bytes: bytes.length },
          { name: 'photos/notes.txt', bytes: 11 },
          { name: 'nested/deep.jpg', bytes: 15 },
        ])
      );
    }, async () => {
      fromR2 = await R2.list();
    });
    assert.deepEqual(fromR2, [{ name: NAME, bytes: bytes.length }]);
    for (const listed of [fromDisk, fromR2]) {
      for (const entry of listed) assert.ok(isOurName(entry.name), `${entry.name} is not a photo name`);
    }
  });

  await t.test('the registry offers exactly disk and r2, and r2 is this driver', async () => {
    const registry = require('../src/services/photo-store');
    assert.deepEqual(registry.implemented, ['disk', 'r2']);
    const store = config.photoStore;
    config.photoStore = 'r2';
    try {
      assert.equal(registry.current().name, 'r2');
    } finally {
      config.photoStore = store;
    }
  });
});
