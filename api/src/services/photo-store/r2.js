'use strict'
/**
 * Photos in a private Cloudflare R2 bucket.
 *
 * This exists because a server built from an image has no disk worth trusting: the
 * next deploy replaces the container, and with the disk driver that takes every
 * student's picture with it. Here the bytes go to an object store over HTTPS, and
 * the API still mediates every read — the bucket stays private, so there is still
 * no URL for a photo, which is the whole design of FR-2.3.
 *
 * R2 speaks Amazon's S3 API, so this driver signs its requests the way S3 asks to
 * have them signed (AWS Signature Version 4) and speaks nothing proprietary. Two
 * things about R2 are worth knowing and both are relied on below:
 *
 *   - The signing is done here with `node:crypto`, so the API still has no cloud
 *     SDK in its dependency tree, and the canonical request the bytes are hashed
 *     into is visible in this file rather than inside a library.
 *   - `PUT` carries `If-None-Match: *`, which R2 answers with 412 when the name is
 *     already taken. That is the object-store form of the disk driver's `wx` flag:
 *     a name in use is unwritable, and a race to write one is settled by the store.
 *
 * And two consequences of the S3 protocol, which the code handles rather than
 * discovers later:
 *
 *   - `DELETE` answers 204 whether or not the object was there. The disk driver
 *     reports whether it removed something and the account-deletion count depends
 *     on that, so a head request goes first. Deletion happens twice per student at
 *     most; an honest count is worth the extra round trip.
 *   - A rejected signature and a forbidden object are both 403. On a bucket this
 *     process owns, a valid key never gets 403, so 403 is reported as a credential
 *     problem here rather than as a photo that does not exist — a wrong key on
 *     every photo looks like a campus where nobody ever uploaded one, which is the
 *     failure this file must not allow.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { config } = require('../../config');
const { isOurName } = require('./photo-name');

/**
 * Every object this driver writes lives under one prefix, so the bucket can hold
 * other things and a backup can name exactly the set that belongs to Unmask.
 */
const PREFIX = 'photos';

/** R2 ignores the region in the signature, but the field is required — `auto` is the convention. */
const REGION = 'auto';
const SERVICE = 's3';

/** S3 answers up to 1000 keys a page; 500 matches the disk listing's page discipline. */
const PAGE = 500;

/**
 * How many pages `listKeys` follows before calling the listing broken: 50 000
 * photos, which is far past a campus cohort, so reaching it means the store handed
 * back a page that never advanced.
 */
const MAX_PAGES = 100;

function keyFor(fileName) {
  return `${PREFIX}/${fileName}`;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * AWS's `uriEncode` with the two S3 variations in one place. Unreserved per RFC 3986
 * is `A-Za-z0-9-_.~` and everything else is percent-encoded, uppercase hex; the only
 * difference is whether `/` survives. A key's slashes separate path segments and must
 * not be encoded; a query value's must.
 */
function uriEncode(value, { encodeSlash } = {}) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (c === '/' && !encodeSlash) out += '/';
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Path-style addresses: the bucket is the first segment, not part of the hostname. */
function canonicalUri(bucket, key) {
  const segments = [];
  if (bucket) segments.push(uriEncode(bucket, { encodeSlash: true }));
  if (key) segments.push(String(key).split('/').map(part => uriEncode(part, { encodeSlash: true })).join('/'));
  return '/' + segments.join('/');
}

/**
 * AWS defines canonical ordering as UTF-8 byte order. `localeCompare` does not:
 * it follows the locale and puts `Ab` after `ab`, which would sign a canonical
 * request the store then rebuilds in a different order — a signature mismatch with
 * nothing in the error to point at the cause.
 */
function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function canonicalQuery(query) {
  return Object.entries(query || {})
    .map(([k, v]) => [uriEncode(k, { encodeSlash: true }), uriEncode(v, { encodeSlash: true })])
    .sort((a, b) => byteOrder(a[0], b[0]) || byteOrder(a[1], b[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * The signature, computed the way the specification lays it out: canonical request →
 * string to sign → a chain of keyed hashes over the date, the region, the service and
 * the literal `aws4_request`. The pieces are separate functions so the test can
 * rebuild the same canonical request from the bytes the server received — it never
 * calls this function to check it, which would only prove it agrees with itself.
 */
function sign(opts, { amzDate, dateStamp }) {
  const payloadHash = sha256Hex(opts.payload === undefined || opts.payload === null ? '' : opts.payload);
  const headers = {
    host: new URL(config.r2.endpoint).host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(opts.headers || {}),
  };
  const names = Object.keys(headers)
    .map(k => [k.toLowerCase(), String(headers[k]).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => byteOrder(a[0], b[0]));
  const canonicalHeaders = names.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = names.map(([k]) => k).join(';');

  const canonicalRequest = [
    opts.method,
    canonicalUri(opts.bucket, opts.key),
    canonicalQuery(opts.query),
    canonicalHeaders + '\n' + signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let key = Buffer.from(`AWS4${config.r2.secretAccessKey}`, 'utf8');
  for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) key = hmac(key, part);

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.r2.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${hmac(key, stringToSign).toString('hex')}`;

  const url = new URL(canonicalUri(opts.bucket, opts.key), config.r2.endpoint);
  const qs = canonicalQuery(opts.query);
  if (qs) url.search = qs;
  return { url: url.toString(), headers };
}

/**
 * One request, signed. `when` exists so a test can pin the date and recompute the
 * signature; nothing in the application ever passes it.
 */
async function send(opts, when) {
  const now = when || new Date();
  // `toISOString()` ends in `Z` already. The old habit of appending another one
  // here produced `20260927T192601ZZ`, which signs perfectly and is then rejected
  // by the store for the shape of the date alone.
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const timeoutMs = opts.timeoutMs || config.r2.requestTimeoutMs;
  const { url, headers } = sign(opts, { amzDate: stamp, dateStamp: stamp.slice(0, 8) });
  try {
    return await fetch(url, {
      method: opts.method,
      headers,
      body: opts.payload === undefined ? undefined : opts.payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why =
      err && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `did not answer within ${timeoutMs} ms`
        : `could not be reached (${err && err.message ? err.message : 'unknown error'})`;
    throw new Error(`the photo store at R2_ENDPOINT ${why}`);
  }
}

/** A short, safe quote of a response body — never the request, never the headers. */
async function snippet(res) {
  try {
    return (await res.text()).slice(0, 240).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function isAuthFailure(status) {
  return status === 401 || status === 403;
}

/**
 * A provider's error body is not trusted input. It is quoted because "HTTP 403"
 * alone tells an operator nothing, but a body that echoes back a credential must
 * not put that credential in a log line.
 */
function redact(text) {
  let out = text || '';
  for (const secret of [config.r2.secretAccessKey, config.r2.accessKeyId]) {
    if (secret && secret.length > 5) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function storeError(doing, status, body) {
  const quoted = redact(body);
  return new Error(
    `could not ${doing} in the photo store — HTTP ${status}${quoted ? `: ${quoted}` : ''}` +
      (isAuthFailure(status) ? ' (the access key in R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY was refused)' : '')
  );
}

/** S3 error bodies are XML; `<Code>NoSuchBucket</Code>` is the one worth reading. */
function codeOf(body) {
  const m = /<Code>\s*([A-Za-z0-9_]+)\s*<\/Code>/.exec(body || '');
  return m ? m[1] : '';
}

/**
 * `<Contents>` blocks, unpacked. Keys come back XML-escaped, so an entity here left
 * alone would be a name that no longer matches the object it describes — and the
 * next request for it would go to a path nobody ever wrote.
 */
function parseList(xml) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = s =>
    String(s).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, what) => {
      if (what[0] === '#') return String.fromCodePoint(what[1] === 'x' || what[1] === 'X' ? parseInt(what.slice(2), 16) : parseInt(what.slice(1), 10));
      return entities[what] === undefined ? whole : entities[what];
    });
  const entries = [];
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const size = /<Size>\s*(\d+)\s*<\/Size>/.exec(block);
    if (!key || !key[1]) continue;
    entries.push({ name: decode(key[1]), bytes: size ? Number(size[1]) : 0 });
  }
  const truncated = /<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/.exec(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { entries, truncated: Boolean(truncated && truncated[1] === 'true'), nextToken: token ? decode(token[1]) : null };
}

/**
 * Reads the listing page by page. A truncated backup looks like a bucket with
 * nothing in it, so a store that answers with a full page is asked again rather
 * than believed.
 */
async function listKeys() {
  const keys = [];
  let token = null;
  for (let page = 0; ; page += 1) {
    const query = { 'list-type': '2', prefix: `${PREFIX}/`, 'max-keys': String(PAGE) };
    if (token) query['continuation-token'] = token;
    const res = await send({ method: 'GET', bucket: config.r2.bucket, query });
    if (!res.ok) throw storeError('list the stored photos', res.status, await snippet(res));
    const listed = parseList(await res.text());
    keys.push(...listed.entries);
    if (!listed.truncated || !listed.nextToken) return keys;
    // A store that hands back the token it was just given would otherwise keep a
    // backup looping while it billed request after request for the same page.
    if (listed.nextToken === token || page >= MAX_PAGES) {
      throw new Error(`the photo store kept paging at ${keys.length} objects without finishing the listing`);
    }
    token = listed.nextToken;
  }
}

/** Strips this driver's own prefix, and refuses a name the prefix was hiding. */
function fileNameOf(key) {
  if (!key.startsWith(`${PREFIX}/`)) return null;
  const fileName = key.slice(PREFIX.length + 1);
  return isOurName(fileName) ? fileName : null;
}

module.exports = {
  name: 'r2',

  describe() {
    return { backend: 'r2' };
  },

  /**
   * One request that answers all three questions a broken deployment can hide in:
   * is the host there, does the key work, does the bucket exist. `HEAD /<bucket>/`
   * — HeadBucket — separates them by status code alone, which a read of a made-up
   * object cannot: on a private bucket a wrong key and a missing object are
   * deliberately hard to tell apart.
   */
  async probe() {
    const res = await send({ method: 'HEAD', bucket: config.r2.bucket, key: '', timeoutMs: 4000 });
    if (res.ok) return { ok: true };
    if (isAuthFailure(res.status)) return { ok: false, reason: 'unauthorized' };
    if (res.status === 404) return { ok: false, reason: 'bucket-not-found' };
    return { ok: false, reason: `http-${res.status}` };
  },

  /** `If-None-Match: *` is what keeps a name in use unwritable, as on disk. */
  async put(fileName, buffer, mime) {
    const res = await send({
      method: 'PUT',
      bucket: config.r2.bucket,
      key: keyFor(fileName),
      headers: {
        'content-type': mime,
        'if-none-match': '*',
        'cache-control': 'max-age=31536000',
      },
      payload: buffer,
    });
    if (res.ok) return;
    const body = await snippet(res);
    if (res.status === 412 || codeOf(body) === 'PreconditionFailed') {
      throw new Error(`the photo store already holds an object named ${fileName}`);
    }
    throw storeError('write a photo', res.status, body);
  },

  async get(fileName) {
    const res = await send({ method: 'GET', bucket: config.r2.bucket, key: keyFor(fileName) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await snippet(res);
    if (res.status === 404 || codeOf(body) === 'NoSuchKey') return null;
    throw storeError('read a photo', res.status, body);
  },

  /**
   * A photo that is not there is not an error — the caller asked for it to go. The
   * head request in front of the delete is what makes the answer true: S3 reports
   * 204 for a delete that removed nothing, and the account-deletion count would
   * otherwise claim a file that was never there.
   */
  async del(fileName) {
    const head = await send({ method: 'HEAD', bucket: config.r2.bucket, key: keyFor(fileName) });
    if (head.status === 404) return false;
    if (!head.ok) throw storeError('delete a photo', head.status, await snippet(head));
    const res = await send({ method: 'DELETE', bucket: config.r2.bucket, key: keyFor(fileName) });
    if (!res.ok && res.status !== 404) throw storeError('delete a photo', res.status, await snippet(res));
    return true;
  },

  /**
   * Every photo this store holds, in the same `{ name, bytes }` shape the disk
   * driver gives: `name` is the handle the rest of the API uses, with this driver's
   * own prefix taken back off, and a key that is not one of our photos is not a
   * photo at all, so it is not listed. A caller asking what the store holds should
   * not have to know which store it is.
   */
  async list() {
    const ours = [];
    for (const entry of await listKeys()) {
      const name = fileNameOf(entry.name);
      if (name) ours.push({ name, bytes: entry.bytes });
    }
    return ours;
  },

  /**
   * Every object down, in the same flat shape a disk backup writes, so
   * `manifest.json` counts the same thing whichever store the photos came from.
   */
  async copyTo(destFolder) {
    // The backup script makes the folder that holds the dump and names this one
    // `photos` inside it; nothing else creates it, and a bucket whose first object
    // lands on a missing path backs up nothing while reporting the run as fine.
    await fsp.mkdir(destFolder, { recursive: true });
    const keys = await listKeys();
    let files = 0;
    let bytes = 0;
    let foreign = 0;
    for (const entry of keys) {
      const fileName = fileNameOf(entry.name);
      // A key this driver did not write is not a photo of ours, and its name is
      // text from inside somebody's bucket. It is skipped, not joined onto a path.
      if (!fileName) {
        foreign += 1;
        continue;
      }
      const buffer = await this.get(fileName);
      if (buffer === null) continue;
      await fsp.writeFile(path.join(destFolder, fileName), buffer, { mode: 0o600 });
      files += 1;
      bytes += buffer.length;
    }
    return { files, bytes, foreign };
  },

  /**
   * Pushing a backup's photos back into the bucket. This writes into the store the
   * current configuration points at — there is no second bucket to rehearse against
   * without changing R2_BUCKET first, which is why the caller has to have asked for
   * it by name.
   */
  async copyFrom(srcFolder) {
    const inBucket = new Set(
      (await listKeys()).map(k => fileNameOf(k.name)).filter(name => name !== null)
    );
    const names = (await fsp.readdir(srcFolder, { withFileTypes: true }))
      .filter(e => e.isFile())
      .map(e => e.name)
      .sort();

    // Named rather than skipped: a folder with `notes.txt` in it is a folder someone
    // picked wrongly, and a restore that quietly left that file out would look done.
    const unexpected = names.find(name => !isOurName(name));
    if (unexpected) throw new Error(`${unexpected} is not a filename this store would have written`);

    // Decided before anything is written: a push that stops halfway because the
    // seventh name was taken would leave a restore that looks complete.
    const clash = names.find(n => inBucket.has(n));
    if (clash) throw new Error(`the bucket already holds an object named ${clash} — the restore would overwrite a live photo`);

    let bytes = 0;
    for (const name of names) {
      const buffer = await fsp.readFile(path.join(srcFolder, name));
      const ext = path.extname(name).replace('.', '').toLowerCase();
      await this.put(name, buffer, ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
      bytes += buffer.length;
    }
    return { files: names.length, bytes };
  },
};
