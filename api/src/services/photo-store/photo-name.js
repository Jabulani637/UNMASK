'use strict';
/**
 * What counts as one of our own photo names.
 *
 * This lives in its own file because two layers need to ask it and neither may
 * import the other: `photos.js` checks a name out of a database document before it
 * hands it to a driver, and a driver checks a name coming *back* out of a bucket
 * before it becomes a filename on disk. Importing `photos.js` from a driver would
 * close a require cycle through the store registry.
 */

const SAFE_NAME = /^[A-Za-z0-9_-]{8,64}\.(jpg|jpeg|png|webp)$/;

function isOurName(value) {
  return typeof value === 'string' && SAFE_NAME.test(value);
}

module.exports = { SAFE_NAME, isOurName };
