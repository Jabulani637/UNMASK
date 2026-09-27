'use strict';
/**
 * Which store the photo bytes go to, decided once per call from `PHOTO_STORE`.
 *
 * Nothing below `photos.js` is allowed to know a backend exists: the four rules
 * that make a photo safe to store — decide the format from the bytes, generate the
 * name, refuse to overwrite, refuse a name that is not ours — are the same whoever
 * holds the file, and they are enforced in `photos.js` so a new driver cannot
 * quietly drop one. A driver is storage and nothing else.
 */

const { config } = require('../../config');

const DISK = require('./disk');
const R2 = require('./r2');

const DRIVERS = { disk: DISK, r2: R2 };

function current() {
  const driver = DRIVERS[config.photoStore];
  if (!driver) {
    // `configProblems()` refuses to boot on this, so arriving here means someone
    // changed `config.photoStore` after startup. Say so rather than pick a default
    // and write students' photos somewhere the operator is not looking.
    throw new Error(`PHOTO_STORE is "${config.photoStore}" — the only stores implemented are ${Object.keys(DRIVERS).join(' and ')}.`);
  }
  return driver;
}

module.exports = { current, implemented: Object.keys(DRIVERS) };
