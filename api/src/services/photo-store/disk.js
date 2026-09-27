'use strict';
/**
 * Photos on a folder this process can see.
 *
 * The rules that make this safe are the ones `photos.js` already states: nothing
 * outside `PHOTO_DIR` is addressable, and the only names that ever get written are
 * ones this process generated. A container rebuild erases everything here unless
 * the folder is a mounted volume — which is why the same interface is also
 * implemented against an object store in `r2.js`.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { config } = require('../../config');
const { isOurName } = require('./photo-name');

/**
 * Where a name belongs on disk. Returns null for anything that is not one of our
 * own filenames, so a database document written some other way cannot read
 * `../../.env` through this module. `path.join` normalises `..` away, which is why
 * the check is against the resolved root rather than a joined string.
 */
function targetFor(dir, fileName) {
  const absolute = path.join(dir, fileName);
  const root = path.resolve(dir);
  if (!path.resolve(absolute).startsWith(root + path.sep)) return null;
  return absolute;
}

function walk(folder) {
  const out = [];
  if (!fs.existsSync(folder)) return out;
  const stack = [['', folder]];
  while (stack.length) {
    const [rel, abs] = stack.pop();
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) stack.push([childRel, childAbs]);
      else out.push({ name: childRel, abs: childAbs, bytes: fs.statSync(childAbs).size });
    }
  }
  return out;
}

module.exports = {
  name: 'disk',

  /** What an operator needs to see about this store on /api/health. Never a path. */
  describe() {
    return { backend: 'disk' };
  },

  /**
   * The folder has to exist before an upload can land in it, and a health check
   * that assumes it is writable is not a health check.
   */
  probe() {
    const dir = config.photoDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `PHOTO_DIR (${dir}) could not be written to: ${err.code || err.message}` };
    }
  },

  /** Never overwrites: `wx` fails on a name that is already there. */
  async put(fileName, buffer, mime) {
    void mime;
    const target = targetFor(config.photoDir, fileName);
    if (!target) throw new Error('refusing to write a photo name that is not ours');
    await fsp.mkdir(config.photoDir, { recursive: true });
    await fsp.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  },

  /** The bytes, or null if the file is not there. Never throws on a missing photo. */
  async get(fileName) {
    const target = targetFor(config.photoDir, fileName);
    if (!target) return null;
    try {
      return await fsp.readFile(target);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  },

  async del(fileName) {
    const target = targetFor(config.photoDir, fileName);
    if (!target) return false;
    try {
      await fsp.unlink(target);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  },

  /**
   * Every stored photo, for a backup and for /api/health's count. Bare names, so a
   * restore can mirror them, and only names this process would itself have written:
   * a stray or nested file in the folder is not a student's photo, and `r2.js` does
   * not list its equivalents either.
   */
  async list() {
    return walk(config.photoDir)
      .filter(f => isOurName(f.name))
      .map(f => ({ name: f.name, bytes: f.bytes }));
  },

  async copyTo(destFolder) {
    const files = walk(config.photoDir);
    let bytes = 0;
    for (const file of files) {
      const dest = path.join(destFolder, file.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.abs, dest);
      bytes += file.bytes;
    }
    return { files: files.length, bytes };
  },

  /**
   * Pushing a backup's photos back onto a disk store. Refuses to overwrite, so a
   * half-finished restore is something you can see rather than one you have to
   * suspect.
   */
  async copyFrom(srcFolder) {
    const files = walk(srcFolder);
    let bytes = 0;
    for (const file of files) {
      const dest = targetFor(config.photoDir, file.name);
      if (!dest) throw new Error(`${file.name} is not a filename this store would have written`);
      if (fs.existsSync(dest)) throw new Error(`${dest} already exists — empty the target folder or restore the photos somewhere new.`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.abs, dest);
      bytes += file.bytes;
    }
    return { files: files.length, bytes };
  },
};
