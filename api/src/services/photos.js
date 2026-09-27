'use strict';
/**
 * Profile photos on disk. FR-2.2, FR-2.3, FR-2.5, NFR-2.3.
 *
 * Three rules shape this file:
 *
 *   1. The folder is `api\storage\photos\`, which the web server does not
 *      publish. There is no URL for a photo, so there is no URL to guess, and a
 *      misconfigured static handler cannot expose it either.
 *   2. A filename is 18 random bytes. It is not derived from the user, the
 *      profile, the time, or anything else a person could work out — knowing an
 *      account id gets you nothing.
 *   3. What is accepted is decided by the bytes, not by the filename, the
 *      `Content-Type` the browser sent, or what the picker claimed. An SVG is
 *      script waiting to run in someone's profile card; a `.jpg` that is really
 *      HTML is the same trick wearing a better costume.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { config } = require('../config');
const { UserError } = require('../errors');

const SAFE_NAME = /^[A-Za-z0-9_-]{8,64}\.(jpg|jpeg|png|webp)$/;

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
 * Where a stored name belongs on disk, refusing anything that is not already
 * known to be one of our own filenames. The check is not decoration: the name
 * comes out of a database document, and a document that got written some other
 * way should not be able to read `../../.env`.
 */
function pathFor(fileName) {
  if (typeof fileName !== 'string' || !SAFE_NAME.test(fileName)) return null;
  const absolute = path.join(config.photoDir, fileName);
  const root = path.resolve(config.photoDir);
  if (!path.resolve(absolute).startsWith(root + path.sep)) return null;
  return absolute;
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
  const target = pathFor(name);

  await fs.mkdir(config.photoDir, { recursive: true });
  // No shared temp name and no overwrite: this either writes a file nobody else
  // could have been holding, or it fails.
  await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });

  return { fileName: name, mime: format.mime, bytes: buffer.length };
}

/** The bytes, or null if the file is not there. Never throws on a missing photo. */
async function read(fileName) {
  const target = pathFor(fileName);
  if (!target) return null;
  try {
    return await fs.readFile(target);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Delete a photo. A missing file is success — the caller asked for it to not be
 * there. Account deletion and photo replacement both go through here, so a
 * student's picture cannot outlive the row that described it.
 */
async function unlink(fileName) {
  if (!fileName) return false;
  const target = pathFor(fileName);
  if (!target) return false;
  try {
    await fs.unlink(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = { save, read, unlink, sniff, pathFor };
