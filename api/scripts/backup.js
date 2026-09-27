'use strict';
/**
 * A backup that a restore has to agree with.
 *
 *   node scripts/backup.js                     into api\backups\<stamp>-<db>
 *   node scripts/backup.js --to D:\backups     somewhere on another disk
 *   node scripts/backup.js --keep 30           how many folders to leave behind
 *
 * Three things happen in this order, and the order is the point: the counts are
 * taken *before* the dump, the archive is written, then the archive is hashed. A
 * manifest written afterwards would describe the backup, not the data — if the
 * dump missed a collection, the count taken after would agree with it.
 *
 * The photos folder goes with the database because they are one fact. A restored
 * profile row pointing at a file that no longer exists is a broken image on a
 * student's page, and the reveal that put it there was the whole agreement.
 *
 * `--keep` deletes folders, and only folders this script wrote: a directory is a
 * candidate when it matches `<ISO-stamp>-<dbname>` and contains a manifest.json.
 * Anything else in the destination is left alone and said out loud.
 */

const fs = require('fs');
const path = require('path');

const { config, configProblems } = require('../src/config');
const db = require('../src/db');
const photos = require('../src/services/photos');
const lib = require('./backupLib');

function usage(detail) {
  if (detail) console.error(`\n${detail}`);
  console.error('\nUsage:');
  console.error('  node scripts/backup.js [--to <folder>] [--keep <n>] [--no-photos]');
  process.exit(1);
}

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

/**
 * Folders this tool wrote, oldest first. The name is decided here so a prune can
 * never look at a folder it did not create.
 */
function candidateFolders(root, dbName) {
  if (!fs.existsSync(root)) return [];
  const stampPattern = lib.folderPattern(dbName);
  return fs
    .readdirSync(root)
    .filter(name => stampPattern.test(name))
    .filter(name => fs.existsSync(path.join(root, name, 'manifest.json')))
    .map(name => path.join(root, name))
    .sort();
}

async function main() {
  const argv = process.argv.slice(2);
  const keepRaw = arg('--keep', argv);
  const keep = keepRaw === null ? 14 : Number(keepRaw);
  const withPhotos = !argv.includes('--no-photos');
  const root = path.resolve(arg('--to', argv) || lib.BACKUP_ROOT_DEFAULT);

  if (!Number.isInteger(keep) || keep < 1) usage(`--keep is "${keepRaw}" — it has to be a whole number of folders to keep.`);

  const problems = configProblems();
  if (problems.length) {
    console.error('Refusing to back up. Fix this first:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const source = lib.sourceDbName();
  let folder = path.join(root, `${lib.stamp()}-${source}`);
  // The stamp is only accurate to a second, and a test suite (or an impatient
  // operator) can easily take two in one. Never write into a finished backup.
  for (let n = 2; fs.existsSync(folder); n += 1) folder = path.join(root, `${lib.stamp()}-${source}-${n}`);
  fs.mkdirSync(folder, { recursive: true });

  await db.connect();

  // Before the dump. See the note at the top of this file.
  const countsBefore = await lib.collectionCounts(source);
  const totalDocs = Object.values(countsBefore).reduce((a, b) => a + b, 0);

  const archive = path.join(folder, 'dump.archive.gz');
  const dump = lib.runTool('dump', ['--uri', config.mongoUrl, '--db', source, '--archive', '--gzip'], archive, null);
  if (!dump.ok) {
    console.error(`\nBackup failed: ${dump.message}`);
    fs.rmSync(folder, { recursive: true, force: true });
    await db.disconnect();
    process.exit(1);
  }

  const photoStore = photos.backend();
  const copied = withPhotos ? await photos.backupPhotos(path.join(folder, 'photos')) : { files: 0, bytes: 0, skipped: true };
  const photosRecord = Object.assign(
    { store: photoStore, dir: photoStore === 'disk' ? config.photoDir : null },
    copied
  );

  const manifest = {
    createdAt: new Date().toISOString(),
    tool: 'unmask-backup/1',
    sourceDb: source,
    uri: lib.redactedUrl(),
    via: lib.BIN ? `binary ${lib.BIN}` : `docker exec ${lib.CONTAINER}`,
    archive: {
      file: path.basename(archive),
      bytes: fs.statSync(archive).size,
      sha256: lib.sha256(archive),
      gzip: true,
    },
    documents: totalDocs,
    collections: countsBefore,
    photos: photosRecord,
    nodeEnv: config.nodeEnv,
  };
  fs.writeFileSync(path.join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('');
  console.log(`Backed up "${source}" to\n  ${folder}`);
  console.log(`  ${totalDocs} document(s) across ${Object.keys(countsBefore).length} collection(s) → ${manifest.archive.bytes.toLocaleString('en-US')} bytes, gzip`);
  for (const [name, count] of Object.entries(countsBefore)) {
    console.log(`    ${name.padEnd(16)} ${count}`);
  }
  console.log(
    copied.skipped
      ? '  photos     skipped (--no-photos)'
      : `  photos     ${copied.files} file(s), ${copied.bytes.toLocaleString('en-US')} bytes from the ${photoStore} store`
  );
  console.log(`  sha256     ${manifest.archive.sha256}`);
  console.log('\nKeep this folder somewhere the server is not. A backup next to the database it backs up is one disk failure away from being nothing.');

  // Retention, last: a prune that ran before the new folder had a manifest in it
  // could delete down to nothing and then fail.
  const folders = candidateFolders(root, source);
  const excess = folders.slice(0, Math.max(0, folders.length - keep));
  for (const old of excess) {
    fs.rmSync(old, { recursive: true, force: true });
    console.log(`  pruned     ${path.basename(old)} (older than the last ${keep})`);
  }
  const ignored = fs.existsSync(root)
    ? fs.readdirSync(root).filter(name => !folders.includes(path.join(root, name)) && fs.statSync(path.join(root, name)).isDirectory())
    : [];
  if (ignored.length) {
    console.log(`  left alone ${ignored.length} folder(s) this script did not write: ${ignored.join(', ')}`);
  }
  console.log('');

  await db.disconnect();
}

main().catch(err => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
