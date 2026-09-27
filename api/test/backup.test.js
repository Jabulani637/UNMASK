'use strict';
/**
 * Stage 9d — the backup is proven by restoring it, not by writing it.
 *
 * `backup.js` is easy to believe and hard to trust. This file does the round trip
 * on a scratch database that exists only for the length of the run:
 *
 *   build the six collections + 1 photo  →  backup.js  →  delete one student and
 *   their message from the source  →  restore.js --into a third database  →  read
 *   the third one back and ask it for the words that were lost.
 *
 * The last assertion is on content, not counts: a count that comes back at three
 * says nothing about whether *those* three are the three that went in. So the check
 * is that the exact sentence the deleted student typed is in the restored database
 * — and that the source is still missing it, because a restore that wrote into the
 * wrong place would otherwise look like a success here.
 *
 * Then the refusals, because a restore script's value is mostly in what it declines:
 * the live database as its own target, no target at all, a folder it did not write,
 * and an archive whose bytes no longer match its own manifest. The corruption is
 * done to a *second* backup, so nothing is checked after the file it damages was
 * already needed.
 *
 * mongodump runs inside the `unmask-mongo` container, so this suite needs the
 * database up like every other one, and says so when it is not.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));

const SOURCE_DB = 'unmask_test_backup';
const TARGET_DB = 'unmask_test_backup_rt';

const url = new URL(process.env.MONGO_URL);
url.pathname = `/${SOURCE_DB}`;
const SOURCE_URL = url.toString();
url.pathname = `/${TARGET_DB}`;
const TARGET_URL = url.toString();

// The scratch folders, and the environment the child scripts inherit — so they read
// this database and this photos folder, never the ones a deployment uses.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unmask-backup-'));
const backups = path.join(work, 'backups');
const photoDir = path.join(work, 'photos');
const restoredPhotos = path.join(work, 'restored-photos');
fs.mkdirSync(backups, { recursive: true });
fs.mkdirSync(photoDir, { recursive: true });

process.env.MONGO_URL = SOURCE_URL;
process.env.PHOTO_DIR = photoDir;
process.env.OUTBOX_DIR = path.join(work, 'outbox');
process.env.SERVE_WEB = '0';

const CHILD_ENV = Object.assign({}, process.env);

const mongoose = require('mongoose');
const { config } = require('../src/config');
const lib = require('../scripts/backupLib');
const db = require('../src/db');
const { seedTestInstitutions, pilotId, otherId } = require('./support/institutions');
const { User, Profile, Match, Message, Notification, AuditEvent, Institution } = require('../src/models');
const vocab = require('../src/domain/vocabulary');

const ALL_MODELS = [User, Institution, Profile, Match, Message, Notification, AuditEvent];
const COLL = ALL_MODELS.map(m => m.collection.name);
const EXPECT = {
  [User.collection.name]: 2,
  [Institution.collection.name]: 2,
  [Profile.collection.name]: 2,
  [Match.collection.name]: 1,
  [Message.collection.name]: 3,
  [Notification.collection.name]: 1,
  [AuditEvent.collection.name]: 1,
};

function script(name, args) {
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', name), ...args], {
    env: CHILD_ENV,
    encoding: 'utf8',
  });
  return { status: run.status, out: `${run.stdout || ''}${run.stderr || ''}` };
}

async function rows(connectTo, collection) {
  const c = await mongoose.createConnection(connectTo).asPromise();
  const out = await c.collection(collection).find({}).sort({ createdAt: 1 }).toArray();
  await c.close();
  return out;
}

async function drop(connectTo) {
  const c = await mongoose.createConnection(connectTo).asPromise();
  await c.dropDatabase();
  await c.close();
}

test('stage 9d — a backup that a restore has to agree with', async t => {
  assert.equal(config.mongoUrl, SOURCE_URL, '.env won over the scratch database, so this would read the real one');
  assert.ok(!config.serveWeb, 'this suite must not boot the site');

  t.after(async () => {
    await db.disconnect().catch(() => {});
    await drop(SOURCE_URL).catch(() => {});
    await drop(TARGET_URL).catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  });

  await db.connect();
  await db.ensureIndexes();
  await Promise.all(ALL_MODELS.map(m => m.deleteMany({})));
  await seedTestInstitutions();

  // --------------------------------------------------------------- the fixture
  const [ada, boris] = await Promise.all([
    User.create({ email: 'ada@mycput.ac.za', passwordHash: 'a-fixture-hash-not-a-real-one', emailVerifiedAt: new Date() }),
    User.create({ email: 'boris@pentechn.ac.za', passwordHash: 'a-fixture-hash-not-a-real-one', emailVerifiedAt: new Date() }),
  ]);

  const prompt = vocab.PROMPTS[0];
  const lostWords = 'and these ones too, from the second student';
  const keptWords = 'the words that must come back after a restore';

  await Profile.create([
    {
      userId: ada._id,
      institutionId: pilotId(),
      faculty: 'Informatics & Design',
      year: vocab.YEARS[1],
      gender: vocab.GENDERS[0],
      lookingFor: vocab.LOOKING_FOR[0],
      age: 20,
      prompts: [{ prompt, answer: keptWords }],
    },
    {
      userId: boris._id,
      institutionId: otherId(),
      faculty: 'Accounting',
      year: vocab.YEARS[2],
      gender: vocab.GENDERS[1],
      lookingFor: vocab.LOOKING_FOR[1],
      age: 22,
      prompts: [{ prompt, answer: lostWords }],
    },
  ]);

  const thread = await Match.create({ users: [ada._id, boris._id], openedBy: ada._id });
  await Message.create([
    { matchId: thread._id, senderId: ada._id, body: keptWords },
    { matchId: thread._id, senderId: boris._id, body: lostWords },
    { matchId: thread._id, senderId: ada._id, body: 'a third message, from the first student' },
  ]);
  await Notification.create({ userId: ada._id, kind: 'message', body: 'A message arrived' });
  await AuditEvent.create({ actorId: ada._id, action: 'match.opened', subjectId: boris._id });

  const photoName = 'fixture-photo.bin';
  const photoWords = 'a photo that is not a photo — 9d fixture';
  fs.mkdirSync(path.join(photoDir, 'aa'), { recursive: true });
  fs.writeFileSync(path.join(photoDir, 'aa', photoName), photoWords);

  // ------------------------------------------------------------------ the dump
  const backup = script('backup.js', ['--to', backups]);
  assert.equal(backup.status, 0, backup.out);
  assert.match(backup.out, /Backed up "/);

  const folders = () => fs.readdirSync(backups).sort();
  assert.equal(folders().length, 1, `expected one backup folder, saw ${folders().join(', ')}`);
  const folder = path.join(backups, folders()[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));

  await t.test('the manifest counts what was in the database when the backup was taken', () => {
    assert.equal(manifest.sourceDb, SOURCE_DB);
    for (const name of COLL) {
      assert.equal(manifest.collections[name], EXPECT[name], `${name}: ${JSON.stringify(manifest.collections)}`);
    }
    assert.equal(manifest.documents, Object.values(EXPECT).reduce((a, b) => a + b, 0));
    assert.equal(manifest.photos.files, 1);
    assert.match(manifest.archive.sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.archive.bytes > 0, 'the archive is empty');
    const password = decodeURIComponent(new URL(SOURCE_URL).password);
    assert.ok(password.length > 0, 'this suite is running against a passwordless URI, so the redaction below proves nothing');
    assert.ok(!JSON.stringify(manifest).includes(password), 'the manifest recorded a database password');
    assert.match(manifest.uri, /^mongodb:\/\/[^:@/]+:\*{3}@/, `the manifest URI is not in the redacted form: ${manifest.uri}`);
  });

  // ----------------------------------------------- the loss, and then its reversal
  await Message.deleteMany({ body: lostWords });
  await Profile.deleteMany({ userId: boris._id });
  await User.deleteOne({ _id: boris._id });
  assert.equal(await Message.countDocuments(), EXPECT[Message.collection.name] - 1, 'the deletion did not happen, so this proves nothing');
  assert.equal(await User.countDocuments(), 1);
  await db.disconnect();

  const restored = script('restore.js', [folder, '--into', TARGET_DB, '--photos-into', restoredPhotos]);
  assert.equal(restored.status, 0, restored.out);
  assert.match(restored.out, /Archive verified/);
  assert.match(restored.out, /Restored and verified/);

  await t.test('the restored database holds the words that were deleted from the source', async () => {
    const messages = await rows(TARGET_URL, Message.collection.name);
    const users = await rows(TARGET_URL, User.collection.name);
    const profiles = await rows(TARGET_URL, Profile.collection.name);
    const institutions = await rows(TARGET_URL, Institution.collection.name);

    const text = messages.map(m => m.body);
    assert.ok(text.includes(lostWords), `the deleted student's message did not come back: ${text.join(' | ')}`);
    assert.equal(messages.length, EXPECT[Message.collection.name]);
    assert.deepEqual(users.map(u => u.email).sort(), ['ada@mycput.ac.za', 'boris@pentechn.ac.za']);
    assert.equal(profiles.length, EXPECT[Profile.collection.name]);

    // A restore that brought the students back without their colleges would leave
    // every profile pointing at an id that resolves to nothing — the matching
    // engine and the name on the card both read that reference.
    assert.deepEqual(institutions.map(i => i.shortName).sort(), ['CPUT', 'PENTECH']);
    const ids = institutions.map(i => String(i._id));
    for (const profile of profiles) {
      assert.ok(ids.includes(String(profile.institutionId)), `a profile points at ${profile.institutionId}, which is not in the restored colleges`);
    }
  });

  await t.test('the photo came back too, at the same relative path', () => {
    const file = path.join(restoredPhotos, 'aa', photoName);
    assert.ok(fs.existsSync(file), `${file} was not written`);
    assert.equal(fs.readFileSync(file, 'utf8'), photoWords);
  });

  await t.test('the source is still missing what was deleted — the restore wrote nowhere else', async () => {
    assert.equal((await rows(SOURCE_URL, User.collection.name)).length, 1);
    assert.equal((await rows(SOURCE_URL, Message.collection.name)).length, EXPECT[Message.collection.name] - 1);
  });

  // ------------------------------------------------------------------ refusals
  await t.test('refusal: the database the backup came from cannot be its own target', () => {
    const run = script('restore.js', [folder, '--into', SOURCE_DB]);
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /is the database this backup was taken from/);
  });

  await t.test('refusal: no --into', () => {
    const run = script('restore.js', [folder]);
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /--into is required/);
  });

  await t.test('refusal: a folder this tool did not write', () => {
    const stranger = path.join(work, 'stranger');
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(path.join(stranger, 'notes.txt'), 'nothing to do with a backup');
    const run = script('restore.js', [stranger, '--into', TARGET_DB]);
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /not a folder this tool wrote/);
  });

  await t.test('refusal: an archive whose bytes do not match its manifest', () => {
    const again = script('backup.js', ['--to', backups]);
    assert.equal(again.status, 0, again.out);
    assert.equal(folders().length, 2, folders().join(', '));

    const damaged = path.join(backups, folders()[1]);
    const dm = JSON.parse(fs.readFileSync(path.join(damaged, 'manifest.json'), 'utf8'));
    const archive = path.join(damaged, dm.archive.file);
    const bytes = fs.readFileSync(archive);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(archive, bytes);

    const run = script('restore.js', [damaged, '--into', `${TARGET_DB}_never`]);
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /this backup is damaged/);
  });

  await t.test('retention: --keep 1 leaves the newest folder and prunes the rest', () => {
    assert.ok(
      lib.folderPattern(SOURCE_DB).test(`${lib.stamp()}-${SOURCE_DB}`),
      'stamp() and folderPattern() disagree — retention would prune nothing, forever, and print nothing to show it'
    );
    const before = folders();
    assert.equal(before.length, 2, before.join(', '));

    const run = script('backup.js', ['--to', backups, '--keep', '1']);
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /pruned/);

    const after = folders();
    assert.equal(after.length, 1, after.join(', '));
    assert.ok(after[0] > before[before.length - 1], `the folder that survived was not the newest: ${after[0]} vs ${before.join(', ')}`);
  });
});
