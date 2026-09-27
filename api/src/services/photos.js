'use strict';
/**
 * Profile photos. FR-2.2, FR-2.3, FR-2.5, NFR-2.3.
 *
 * Three rules shape this file:
 *
 *   1. A photo has no address a person can use. On disk it is a folder the web
 *      server does not publish; in an object store it is a private bucket. Either
 *      way the only way to a picture is through this API, which checks the reveal
 *      before it opens the bytes.
 *   2. A filename is 18 random bytes. It is not derived from the user, the
 *      profile, the time, or anything else a person could work out — knowing an
 *      account id gets you nothing.
 *   3. What is accepted is decided by the bytes, not by the filename, the
 *      `Content-Type` the browser sent, or what the picker claimed. An SVG is
 *      script waiting to run in someone's profile card; a `.jpg` that is really
 *      HTML is the same trick wearing a better costume.
 *
 * Where the bytes are kept is `./photo-store`'s choice (`PHOTO_STORE=disk|r2`).
 * Everything decided here is the same either way, which is the point of the split:
 * a driver cannot weaken a rule it never sees.
 */

const crypto = require('crypto');

const { config } = require('../config');
const { UserError } = require('../errors');
const store = require('./photo-store');
const { isOurName } = require('./photo-store/photo-name');

/**
 * The handful of image formats worth accepting, by their opening bytes.
 *
 * JPEG and PNG because every phone writes them; WebP because a browser canvas
 * will happily produce it. Not GIF (256 colours, no reason), not BMP, never SVG:
 * an SVG is XML that can carry a script, and it is the one "image" an attacker
 * actually wants posted on a page full of students.
 */
const FORMATS = [
  { ext: 'jpg', mime: 'image/jpeg', match: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', match: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    ext: 'webp',
    mime: 'image/webp',
    match: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
  },
];

function sniff(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  return FORMATS.find(f => f.match(buffer)) || null;
}

/**
 * Write an image after deciding from its bytes what it is. Returns the stored
 * name, which is the only handle that ever goes into the database.
 */
async function save(buffer) {
  const format = sniff(buffer);
  if (!format) {
    throw new UserError(
      'That file is not a photo we can use. A JPEG, PNG or WebP picture from your phone or camera will work.'
    );
  }
  if (buffer.length < 1024) {
    throw new UserError('That image is too small to be a photo. Take or choose a real picture.');
  }
  if (buffer.length > config.maxPhotoBytes) {
    throw new UserError(
      `That image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(config.maxPhotoBytes / 1024 / 1024)} MB.`
    );
  }

  const name = `${crypto.randomBytes(18).toString('base64url')}.${format.ext}`;
  // No shared temp name and no overwrite: this either writes somewhere nobody else
  // could have been holding, or it fails.
  await store.current().put(name, buffer, format.mime);

  return { fileName: name, mime: format.mime, bytes: buffer.length };
}

/** The bytes, or null if the photo is not there. Never throws on a missing photo. */
async function read(fileName) {
  if (!isOurName(fileName)) return null;
  return store.current().get(fileName);
}

/**
 * Delete a photo. A missing file is success — the caller asked for it to not be
 * there. Account deletion and photo replacement both go through here, so a
 * student's picture cannot outlive the row that described it.
 */
async function unlink(fileName) {
  if (!isOurName(fileName)) return false;
  return store.current().del(fileName);
}

/** Which store the bytes are in, and whether it answered. For /api/health. */
async function status() {
  const driver = store.current();
  // A store that cannot be reached is reported, not thrown: this backs a health
  // endpoint, and 500ing the thing you consult during an outage is a bad idea.
  // Nothing from the error is published — no URL, no path, no key — because the
  // endpoint is unauthenticated.
  try {
    const probed = await driver.probe();
    return { backend: driver.name, writable: Boolean(probed.ok), reason: probed.reason || null };
  } catch {
    return { backend: driver.name, writable: false, reason: 'unreachable' };
  }
}

/** Every photo this store holds, as `{ name, bytes }`. Used by the backup script. */
async function list() {
  return store.current().list();
}

/** Which store is in use, for a log line or a manifest. */
function backend() {
  return store.current().name;
}

/**
 * Copy every photo out of the store into a folder, and back in. The backup and
 * restore scripts use these, which is why no caller outside this file ever sees a
 * driver: what a backup contains should not depend on which store is configured.
 */
async function backupPhotos(destFolder) {
  return store.current().copyTo(destFolder);
}

async function restorePhotos(srcFolder) {
  return store.current().copyFrom(srcFolder);
}

module.exports = { save, read, unlink, sniff, status, list, backend, backupPhotos, restorePhotos };
