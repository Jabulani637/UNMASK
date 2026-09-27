'use strict';
/**
 * /api/profile — what a student writes about themselves, and the one photo.
 * FR-2.1 to FR-2.7.
 *
 * Every route here is behind `loadUser`, and the photo is behind it twice over:
 * the filename never appears in a response, and the bytes are served only for
 * the signed-in owner's own profile. A match sees a placeholder until stage 6
 * says otherwise, so there is nothing here to enumerate — asking for someone
 * else's photo is not a special case, it is just not a route.
 *
 * One more thing is absent from these bodies by design: any way to *name* an
 * institution. Which college a profile belongs to is read off the account's
 * verified address inside services/profile.js and sent back the same way, so no
 * request here can choose one — a student can no more claim a college in a save
 * than they can claim somebody else's address.
 */

const express = require('express');
const multer = require('multer');

const { config } = require('../config');
const { UserError } = require('../errors');
const institutions = require('../services/institutions');
const profile = require('../services/profile');
const photos = require('../services/photos');
const { loadUser } = require('../middleware/requireUser');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Memory, not disk: the file has to be sniffed before it is allowed a name, and
// a upload that turns out not to be a picture should never have touched the
// photos folder at all. The limit is the documented maximum plus the multipart
// framing, so an honest oversized photo gets our sentence rather than the
// library's generic 400.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxPhotoBytes, files: 1 },
});

/**
 * The institution this account belongs to.
 *
 * Read off the profile's own link when there is one, and off the verified address
 * when there is not — which is the state of every account the first time it opens
 * this screen. Both answers come from the account, never from a request body, so a
 * student cannot name the college they study at; the fallback only makes the form
 * show the same college the address already decided on, so its faculty list and its
 * free-text branch are right before anything has been saved.
 */
async function institutionOf(doc, user) {
  if (doc && doc.institutionId) {
    return (await institutions.byIds([doc.institutionId])).get(String(doc.institutionId)) || null;
  }
  return (await institutions.forEmail(user.email)) || null;
}

/** FR-2.1. The whole profile as its author left it, or null before first save. */
router.get('/', loadUser, async (req, res, next) => {
  try {
    const doc = await profile.forUser(req.user.id);
    const institution = await institutionOf(doc, req.user);
    const shown = profile.view(doc, institution);
    // `view` has nothing to say before the first save, and "nothing yet" is the
    // honest answer to *what have you written* — but the college is not something
    // the student writes, so it is sent beside the empty profile. Without this the
    // form opens with no faculty list to offer and no name to show, on the one
    // screen every student visits first.
    res.json({ profile: shown, institution: shown ? undefined : profile.institutionView(institution) });
  } catch (err) {
    next(err);
  }
});

/** FR-2.4 / FR-2.7. Create or edit. An unfinished save is allowed; matching is not. */
router.put('/', loadUser, rateLimit({ limit: 40, windowMs: 10 * 60 * 1000, bucket: 'profile-save' }), async (req, res, next) => {
  try {
    const doc = await profile.save({ userId: req.user.id, email: req.user.email, body: req.body });
    res.json({
      profile: profile.view(doc, await institutionOf(doc, req.user)),
      message: 'Saved.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * FR-2.2. One photo per student, replaced by uploading again.
 *
 * The browser is asked to shrink the image before it gets here, so a 5 MB limit
 * is a ceiling and not the normal size. Anything that is not a JPEG, PNG or
 * WebP by its first bytes is refused in services/photos.js.
 */
router.post('/photo', loadUser, rateLimit({ limit: 20, windowMs: 60 * 60 * 1000, bucket: 'photo-upload' }), (req, res, next) => {
  upload.single('photo')(req, res, err => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return next(
        tooBig
          ? new UserError(`That image is over ${Math.round(config.maxPhotoBytes / 1024 / 1024)} MB. Choose a smaller one.`)
          : new UserError('That upload could not be read. Pick a photo file and try again.')
      );
    }
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      throw new UserError('No photo came through. Choose an image file and send it again.');
    }

    const stored = await profile.setPhoto({ userId: req.user.id, buffer: req.file.buffer });
    const doc = await profile.forUser(req.user.id);

    res.json({
      message: 'Photo saved. It stays hidden until you both agree to reveal.',
      size: stored.bytes,
      profile: profile.view(doc, await institutionOf(doc, req.user)),
    });
  } catch (err) {
    next(err);
  }
});

/** FR-2.5. Deleting the photo leaves the profile in place. */
router.delete('/photo', loadUser, async (req, res, next) => {
  try {
    const removed = await profile.removePhoto(req.user.id);
    const doc = await profile.forUser(req.user.id);
    res.json({
      message: removed ? 'Photo removed.' : 'There was no photo to remove.',
      profile: profile.view(doc, await institutionOf(doc, req.user)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The owner's own copy of the bytes, for their profile screen.
 *
 * `no-store` because this is a person's face behind a session cookie: a shared
 * library computer must not keep it. A student asking for their own photo is the
 * only way to reach these bytes, because the route looks the filename up from
 * the session and never accepts one as input.
 */
router.get('/photo', loadUser, async (req, res, next) => {
  try {
    const fileName = await profile.photoFileName(req.user.id);
    if (!fileName) {
      throw new UserError('You have not uploaded a photo yet.', { status: 404, code: 'no_photo' });
    }

    const buffer = await photos.read(fileName);
    if (!buffer) {
      // The row outlived the file (a disk restore, most likely). Say so rather
      // than serve a 200 with nothing in it.
      throw new UserError('That photo could not be read. Upload it again.', { status: 404, code: 'photo_missing' });
    }

    const format = photos.sniff(buffer);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', format ? format.mime : 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
