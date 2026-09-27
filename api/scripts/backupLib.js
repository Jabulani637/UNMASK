'use strict';
/**
 * The parts both backup scripts need: how to reach mongodump/mongorestore, what is
 * in the database right now, and how a backup folder is laid out.
 *
 * On a development machine mongodump is not installed — it is inside the
 * `unmask-mongo` container, which is where the database itself runs. So the archive
 * is streamed through `docker exec`'s stdout rather than written to a path the
 * container cannot see, and the same pipe runs backwards for a restore.
 *
 * A hosted database has no container on the server, so there is nothing to exec
 * into: point `MONGODUMP_BIN` at an installed mongodump and the same code paths run
 * against `MONGO_URL` directly. That is what an Atlas deployment does.
 *
 * A backup folder is:
 *
 *   backups/2026-09-26T20-15-04Z-unmask/
 *     dump.archive.gz    the whole database, one file, gzip
 *     manifest.json      what it holds, counted before it was written
 *     photos/...         a copy of every photo the configured store holds
 *
 * The manifest is the part that makes a restore checkable. Without a count taken
 * *before* the dump, "the restore succeeded" only means "the restore did not
 * complain".
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { config } = require('../src/config');
const models = require('../src/models');

const CONTAINER = process.env.MONGO_CONTAINER || 'unmask-mongo';
const BIN = process.env.MONGODUMP_BIN || '';
const BACKUP_ROOT_DEFAULT = path.resolve(__dirname, '..', 'backups');

/** The name of the database the URI points at — `unmask`, from `.../unmask?...`. */
function sourceDbName() {
  const withoutScheme = config.mongoUrl.replace(/^[^:]+:\/\//, '');
  const afterAuth = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const [hosts, rest] = [afterAuth.split('/')[0], afterAuth.split('/').slice(1).join('/')];
  const db = (rest.split('?')[0] || '').trim();
  // The URI is in the message on purpose — an operator has to see which path the
  // string is missing — but never the raw one: this throws before anything is
  // connected, so its text is printed by the script's catch and lands in a log.
  if (!db) throw new Error(`MONGO_URL names no database (nothing after the host part): ${redactedUrl()}`);
  return db;
}

/**
 * The host the URI aims at — the first of a replica set, without the port, with
 * the credentials skipped. Good enough to decide which advice to give a failing
 * backup, and which database a restore would actually overwrite; `mongodump`
 * itself is the authority on parsing the rest. Pass a URL to read a different one
 * than the configured — a manifest's recorded `uri` is redacted, and redaction
 * leaves the host alone.
 */
function databaseHost(url = config.mongoUrl) {
  const text = String(url || '');
  const afterAuth = text.slice(text.lastIndexOf('@') + 1).replace(/^[^:]+:\/\//, '');
  return (afterAuth.split('/')[0].split(',')[0] || '').replace(/:\d+$/, '');
}

/**
 * Is the database somewhere other than this machine? `mongodb+srv://` always is —
 * Atlas hands out SRV strings and no server on a laptop answers them.
 */
function databaseIsRemote() {
  const host = databaseHost();
  return /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|\[::1\])$/.test(host) === false;
}

/** The same URI with the password removed — the form that is safe to write down. */
function redactedUrl() {
  return config.mongoUrl.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

/** MONGO_URL aimed at a different database on the same server. */
function urlForDb(dbName) {
  const source = sourceDbName();
  if (dbName === source) return config.mongoUrl;
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return config.mongoUrl.replace(new RegExp(`/${escaped}(?=\\?|$)`), `/${dbName}`);
}

/**
 * Run one database tool. `mode` is 'dump' (archive comes back on stdout) or
 * 'restore' (archive goes in on stdin). Never a shell string: the URI and the
 * database names are passed as separate arguments, so a name with a space or a
 * quote in it is one argument and not a command.
 */
function runTool(mode, toolArgs, archivePath, inputBuffer) {
  const binary = BIN || 'docker';
  const args = BIN ? toolArgs : ['exec', '-i', CONTAINER, mode === 'dump' ? 'mongodump' : 'mongorestore', ...toolArgs];

  const options = { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 };
  if (mode === 'restore' && inputBuffer) options.input = inputBuffer;

  const run = spawnSync(binary, args, options);

  if (run.error) {
    const hint = BIN
      ? `MONGODUMP_BIN points at "${BIN}" and it did not run.`
      : databaseIsRemote()
        ? `MONGO_URL names "${databaseHost()}", which is not a database on this machine, so there is no container here holding mongodump. Install the MongoDB Database Tools and set MONGODUMP_BIN to their mongodump/mongorestore.`
        : `Is the database container up? Try: docker compose up -d   (the container this looks for is "${CONTAINER}")`;
    return { ok: false, message: `${run.error.message}\n  ${hint}` };
  }
  if (run.status !== 0) {
    return {
      ok: false,
      message: `${mode === 'dump' ? 'mongodump' : 'mongorestore'} exited ${run.status}:\n${run.stderr.toString().trim()}`,
    };
  }
  if (mode === 'dump') {
    if (!run.stdout || run.stdout.length === 0) return { ok: false, message: 'mongodump produced an empty archive.' };
    if (archivePath) fs.writeFileSync(archivePath, run.stdout);
  }
  return { ok: true, stdout: run.stdout, stderr: run.stderr.toString(), bytes: run.stdout ? run.stdout.length : 0 };
}

/** One document count per collection the API owns, plus any strays it finds. */
async function collectionCounts(dbName) {
  const mongoose = require('mongoose');
  const db = mongoose.connection.useDb(dbName, { useCache: false });
  const named = {};
  for (const [modelName, Model] of Object.entries(models)) {
    const collection = Model.collection.name;
    named[collection] = await db.collection(collection).countDocuments();
  }
  return named;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every file under a folder, with its path relative to that folder. */
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
      else out.push({ rel: childRel, abs: childAbs, bytes: fs.statSync(childAbs).size });
    }
  }
  return out;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Matches the folder name `stamp()` produces for one database, plus the optional
 * collision suffix. It lives next to `stamp()` on purpose: the format changed once
 * already, and a hand-copied pattern that matches nothing fails silently, because a
 * prune that finds no candidates looks exactly like a backup folder with nothing to
 * remove.
 */
function folderPattern(dbName) {
  const db = dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${db}(-\\d+)?$`);
}

function readManifest(folder) {
  const file = path.join(folder, 'manifest.json');
  if (!fs.existsSync(file)) {
    throw new Error(`${folder} has no manifest.json — that is not a folder this tool wrote.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  BACKUP_ROOT_DEFAULT,
  CONTAINER,
  BIN,
  collectionCounts,
  databaseHost,
  databaseIsRemote,
  folderPattern,
  readManifest,
  redactedUrl,
  runTool,
  sha256,
  sourceDbName,
  stamp,
  urlForDb,
  walk,
};
