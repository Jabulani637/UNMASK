'use strict';
/**
 * Restoring a backup — into a database you name, never over the one that is live.
 *
 *   node scripts/restore.js api\\backups\\2026-09-26T20-15-04Z-unmask --into unmask_rehearsal
 *
 * A backup you have not restored is a file with a claim on it. This script exists
 * so that claim can be checked, and the check is the output: the counts in the
 * target database are read back and compared with the manifest taken before the
 * dump ever ran, and a mismatch is exit 1, not a paragraph you have to read.
 *
 * `--into` is required, and the live database refuses to be its own target. That is
 * deliberate. The moment a restore script is willing to overwrite production, it is
 * one typo away from being the incident rather than the recovery, and a disaster
 * recovery is not the thing to practise for the first time at 9 p.m. To replace the
 * live data for real: restore into a scratch name, check it, then point MONGO_URL at
 * it and start the API. Same archive, one deliberate switch instead of a flag.
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
  console.error('  node scripts/restore.js <backup-folder> --into <database-name> [--push-photos | --photos-into <folder>]');
  console.error('\n  --into is required, and cannot be the database the backup came from.');
  console.error('  --push-photos writes the backup\'s photos into the currently configured PHOTO_STORE, refusing to overwrite any name already there.');
  process.exit(1);
}

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const folder = path.resolve(argv.find(a => !a.startsWith('--')) || '');
  const into = arg('--into', argv);
  const photosInto = arg('--photos-into', argv);
  const pushPhotos = argv.includes('--push-photos');

  if (!folder || !fs.existsSync(folder)) usage(`No such backup folder: ${argv.find(a => !a.startsWith('--')) || '(none given)'}`);
  if (!into) usage('Nothing was named to restore into.');
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(into)) {
    usage(`"${into}" is not a database name this will write. Use letters, digits, "-" and "_", 2 to 40 characters.`);
  }

  const manifest = lib.readManifest(folder);

  // The guard is about the *server*, not the word in `--into`. Two databases may
  // honestly be called `unmask` on two machines, and "carry this laptop's data to
  // Atlas" is then one command. A manifest with no readable host is treated as the
  // worst case: an old or hand-edited folder refuses on the name alone rather than
  // losing the only check that stops a production database being overwritten.
  const sourceHost = lib.databaseHost(manifest.uri || '');
  const targetHost = lib.databaseHost();
  const sameServer = sourceHost === '' || sourceHost === targetHost;

  if (into === manifest.sourceDb && sameServer) {
    usage(
      `"${into}" is the database this backup was taken from, on the server it was taken ` +
        `from (${targetHost}). Overwriting it is what a real disaster recovery does, ` +
        'and it is not what this script is for.\n' +
        `  Rehearse it:  --into ${into}_rehearsal, read the counts, then change MONGO_URL to that name and restart.\n` +
        '  For real:     stop the API first, and say so in the change log.\n' +
        '  To move the data somewhere new: point MONGO_URL at the other server and run this again.'
    );
  }

  const problems = configProblems();
  if (problems.length) {
    console.error('Refusing to restore. Fix this first:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const archive = path.join(folder, manifest.archive.file);
  if (!fs.existsSync(archive)) usage(`${folder} names ${manifest.archive.file} in its manifest and the file is not there.`);

  // Before anything is written: an archive that does not hash to what the manifest
  // recorded is a damaged backup, and a partial restore is worse than no restore.
  const actual = lib.sha256(archive);
  if (actual !== manifest.archive.sha256) {
    console.error(`\nThe archive does not match its manifest — this backup is damaged.\n  expected ${manifest.archive.sha256}\n  got      ${actual}`);
    process.exit(1);
  }
  console.log(`\nArchive verified: ${manifest.archive.bytes.toLocaleString('en-US')} bytes, sha256 ${actual.slice(0, 16)}…`);
  console.log(`Restoring "${manifest.sourceDb}" (taken ${manifest.createdAt}) into "${into}".`);

  const run = lib.runTool(
    'restore',
    [
      '--uri',
      lib.urlForDb(into),
      // --nsInclude is not decoration. mongorestore reads the database in --uri as a
      // filter on what to restore, so an archive written from another name matches
      // nothing, is reported as a complete success, and restores zero documents.
      // Measured on 100.18: without this line the exit code is 0 either way.
      '--nsInclude',
      `${manifest.sourceDb}.*`,
      '--nsFrom',
      `${manifest.sourceDb}.*`,
      '--nsTo',
      `${into}.*`,
      '--drop',
      '--archive',
      '--gzip',
    ],
    null,
    fs.readFileSync(archive)
  );
  if (!run.ok) {
    console.error(`\nRestore failed: ${run.message}`);
    process.exit(1);
  }
  const wrote = (run.stderr.match(/\d+ document\(s\) restored successfully/) || [''])[0];
  if (wrote) console.log(`mongorestore: ${wrote}.`);

  await db.connect();
  const after = await lib.collectionCounts(into);
  await db.disconnect();

  let ok = true;
  console.log('\n  collection        expected   restored');
  for (const [name, expected] of Object.entries(manifest.collections)) {
    const got = after[name] === undefined ? 0 : after[name];
    const same = got === expected;
    if (!same) ok = false;
    console.log(`  ${name.padEnd(16)} ${String(expected).padStart(9)} ${String(got).padStart(11)}   ${same ? '' : '  ← DIFFERENT'}`);
  }
  const extra = Object.keys(after).filter(name => !(name in manifest.collections));
  if (extra.length) console.log(`\n  ${extra.length} collection(s) in the target that the backup did not name: ${extra.join(', ')}`);

  const photosFolder = path.join(folder, 'photos');
  const photoFiles = lib.walk(photosFolder);
  if (!photoFiles.length) {
    console.log('\n  photos      this backup holds none (--no-photos was used, or the folder was empty).');
  } else if (photosInto && pushPhotos) {
    usage('Both --photos-into and --push-photos were given. Say where the photos go once: a folder, or the live store.');
  } else if (pushPhotos) {
    // Straight into whatever PHOTO_STORE points at. For a bucket that is the live
    // one — there is no second bucket to rehearse against without editing the
    // configuration — which is why this needs to be asked for by name.
    const pushed = await photos.restorePhotos(photosFolder);
    console.log(`\n  photos      ${pushed.files} file(s), ${pushed.bytes.toLocaleString('en-US')} bytes pushed into the ${photos.backend()} store.`);
  } else if (!photosInto) {
    console.log(`\n  photos      ${photoFiles.length} file(s) are in ${photosFolder} and were NOT restored. Add --push-photos to put them back into the ${photos.backend()} store, or --photos-into <folder> to lay them out somewhere new.`);
  } else {
    let bytes = 0;
    for (const file of photoFiles) {
      const dest = path.join(path.resolve(photosInto), file.rel);
      if (fs.existsSync(dest)) {
        console.error(`\nRefusing to overwrite an existing photo: ${dest}\n  Empty the target folder, or point --photos-into somewhere new.`);
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.abs, dest);
      bytes += file.bytes;
    }
    console.log(`\n  photos      ${photoFiles.length} file(s), ${bytes.toLocaleString('en-US')} bytes → ${path.resolve(photosInto)}`);
  }

  console.log('');
  if (!ok) {
    console.error('The restore did NOT reproduce the backup. Read the DIFFERENT rows above before trusting this database.');
    process.exit(1);
  }
  console.log(`Restored and verified: every collection matches the manifest taken before the dump.`);
  console.log(`  "${into}" now holds ${manifest.documents} document(s). Nothing on the site reads it — point MONGO_URL at it to serve it.\n`);
}

main().catch(err => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
