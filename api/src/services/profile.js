'use strict';
/**
 * The profile a student writes, and what stops them writing.
 * FR-2.1, FR-2.4, FR-2.6, FR-2.7.
 *
 * The form is allowed to save an unfinished profile — a student who picks three
 * interests and gives up on the prompts for tonight should not lose the three.
 * What they cannot do is get *matched* while it is unfinished, so
 * `missingForMatching()` travels with every answer and the screens say what is
 * still needed instead of silently excluding them.
 *
 * The awkward rule is the contact guard. FR-2.6 says a profile must never show a
 * name, student number or contact details, and free text is exactly where those
 * end up: "find me at 082 123 4567" is a perfectly natural thing to type into a
 * prompt answer, and it would take one screenshot for a stranger to have a phone
 * number. So anything that reads like a way to reach someone off Unmask is
 * refused here, on the way in, with the reason said out loud.
 */

const Profile = require('../models/Profile');
const vocab = require('../domain/vocabulary');
const { UserError } = require('../errors');
const institutions = require('./institutions');
const photos = require('./photos');

const MAX_INTERESTS = 10;
const MAX_PROMPT_ANSWER = 220;
/** Matches the ceiling on models/Profile.js, so the form counts against the same number. */
const MAX_FACULTY = 80;
/** Long enough for "Naledi M.", short enough that a sentence cannot hide in it. */
const MAX_REVEAL_NAME = 30;
/** One or two sentences about the sort of person you hope for; the guard below is the same one. */
const MAX_TYPE_NOTE = 200;

/**
 * Ways to hand a stranger your phone number, your email or a link to somewhere
 * that has both.
 *
 * The digit rule counts digits rather than characters, so "2020", "11pm" and
 * "first year 2019 intake" pass while "082-123-4567", "+27 82 123 4567" and
 * "0821234567" do not. Nine is the shortest South African number that is not a
 * local area code, and no honest prompt answer needs a run of digits that long.
 */
const CLUES = [
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/, name: 'an email address' },
  { pattern: /(?:\+?\d[\s-]?){9,}/, name: 'a phone number' },
  { pattern: /(?:https?:\/\/|www\.)/i, name: 'a link' },
  // "look me up at myphotos.com/thandi" is a link with the http:// left off, and
  // it is the same leak. The endings are the ones a person would type; a bare
  // "e.g." or a year has no label-plus-dot in front of one of them.
  { pattern: /(?:[a-z0-9-]+\.)+(?:com|net|org|app|io|co|za|xyz|site|online|social|link|live|life|club|shop|store|info|biz|dev|me|tv|gg)\b/i, name: 'a link' },
  { pattern: /@(?:[A-Za-z0-9_]{2,})/, name: 'a social media handle' },
  { pattern: /\b(?:whats\s?app|instagram|tiktok|telegram|snapchat|facebook|x\s?dcc)\b/i, name: 'another app to message on' },
];

function findContactClue(text) {
  for (const clue of CLUES) {
    if (clue.pattern.test(text)) return clue.name;
  }
  return null;
}

function assertCleanText(text, where) {
  const clue = findContactClue(text);
  if (clue) {
    throw new UserError(
      `Your ${where} looks like it contains ${clue}. A profile must never carry a way to reach you outside Unmask — remove it and save again.`
    );
  }
}

function oneOf(list, value, label) {
  if (!vocab.isOneOf(list, value)) {
    throw new UserError(`Choose a ${label} from the list. "${value ?? 'nothing'}" is not one of them.`);
  }
  return value;
}

/**
 * An optional single-choice field.
 *
 * `undefined` and `null` are different answers and the difference matters: a body
 * that does not mention the field at all is an older client saving the six basics
 * it knows about, and treating that as "clear it" would let a save from one screen
 * erase an answer typed on another. `null` or an empty string is the student's own
 * "I would rather not say", which really does clear it.
 */
function validateChoice(list, raw, label) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  return oneOf(list, raw, label);
}

/**
 * An optional "what I am after" list: deduplicated, in the order it was picked,
 * and capped at three. A pick that is not on the vocabulary is refused rather than
 * dropped — a form that sent `seekBodyTypes: ['Curvy', 'size 8']` is describing a
 * field the student cannot see, and silently losing half their answer is how a
 * saved profile starts to disagree with the screen that wrote it.
 */
function validatePicks(list, raw, label) {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : raw === null || raw === '' ? [] : [raw];

  const seen = new Set();
  for (const value of values) {
    if (value === '' || value === null) continue;
    seen.add(oneOf(list, value, label));
  }
  if (seen.size > vocab.MAX_PREF_PICKS) {
    throw new UserError(
      `Pick at most ${vocab.MAX_PREF_PICKS} on the ${label} list. ${seen.size} is not a preference, it is the whole list.`
    );
  }
  return [...seen];
}

/**
 * The free-text "my type" box. Everything that makes a prompt answer safe makes
 * this safe, and it has to be said rather than assumed, because this is the field
 * a student is most likely to fill in with "add me on Instagram" — the exact leak
 * the whole contact guard exists to stop.
 */
function validateTypeNote(raw) {
  if (raw === undefined) return undefined;
  const note = String(raw === null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (!note) return null;
  if (note.length > MAX_TYPE_NOTE) {
    throw new UserError(`Keep what you are after to ${MAX_TYPE_NOTE} characters — a match reads it, not reads it.`);
  }
  assertCleanText(note, 'note about who you are after');
  return note;
}

/**
 * A faculty, checked against the student's *own* institution's list.
 *
 * There was once one global list of six faculties, and it was CPUT's. Asking a
 * student at a college in Maitland to pick "Informatics & Design" was not
 * validation, it was an assumption with an error message attached. So the list is
 * per institution: when the institution document carries one, its students pick
 * from it; when it does not, they type what their own registrar calls it, and the
 * only guard is the contact screen, because a wrong faculty name is a small
 * inaccuracy while a refused save is a student who cannot finish a profile.
 */
function validateFaculty(raw, institution) {
  const value = String(raw || '').replace(/\s+/g, ' ').trim();
  const list = (institution && institution.faculties) || [];

  if (list.length) {
    if (!value) throw new UserError('Choose a faculty or school from the list.');
    return oneOf(list, value, 'faculty');
  }
  if (!value) throw new UserError('Type the faculty or school you are in.');
  if (value.length < 2) throw new UserError('That is too short to be a faculty name.');
  if (value.length > MAX_FACULTY) {
    throw new UserError(`Keep the faculty name to ${MAX_FACULTY} characters.`);
  }
  assertCleanText(value, 'faculty');
  return value;
}

function validateFields(body, institution) {
  const age = Number(body.age);
  if (!Number.isInteger(age) || age < vocab.AGE_MIN || age > vocab.AGE_MAX) {
    throw new UserError(
      `Age has to be a whole number between ${vocab.AGE_MIN} and ${vocab.AGE_MAX}. Unmask is only for adult students.`
    );
  }

  return {
    // Never `body.institutionId`. Whose student you are is the answer to a question
    // your verified email address already answered, and a form that could restate
    // it is a form that lets one student present as another institution's.
    institutionId: institution._id,
    faculty: validateFaculty(body.faculty, institution),
    year: oneOf(vocab.YEARS, body.year, 'year of study'),
    gender: oneOf(vocab.GENDERS, body.gender, 'answer for who you are'),
    lookingFor: oneOf(vocab.LOOKING_FOR, body.lookingFor, 'answer for who you are looking for'),
    age,
  };
}

/**
 * FR-5.2's name, chosen by the student who owns it.
 *
 * Optional in the strongest sense: leaving it out of a save clears it, so
 * "I would rather not have had a name out there" is one press, not a support
 * ticket. It is not in `missingForMatching()` and not in the matching
 * projection, so it can never decide who anyone is shown.
 *
 * It goes through the same contact guard as a prompt answer, because a reveal
 * name is the single field this product *guarantees* to put in front of another
 * student, and "instagram: thandi_k" typed there would be the one leak the
 * promise cannot survive.
 */
function validateRevealName(raw) {
  if (raw === undefined || raw === null) return null;
  const name = String(raw).replace(/\s+/g, ' ').trim();
  if (!name) return null;

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new UserError('A reveal name is one line of text — it cannot carry a return or a control character.');
  }
  if (name.length > MAX_REVEAL_NAME) {
    throw new UserError(`Keep your reveal name to ${MAX_REVEAL_NAME} characters. A match reads it in a second, not a paragraph.`);
  }
  assertCleanText(name, 'reveal name');
  return name;
}

function validateInterests(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();

  for (const interest of list) {
    oneOf(vocab.INTERESTS, interest, 'interest');
    seen.add(interest);
  }
  if (seen.size > MAX_INTERESTS) {
    throw new UserError(`Pick at most ${MAX_INTERESTS} interests. ${seen.size} tells a match nothing.`);
  }
  return [...seen];
}

/**
 * The look-like block, in one function, because there are twelve fields and the
 * list of them is the thing that has to stay in step with models/Profile.js.
 *
 * `identity` is here because a student has to be able to say it about themselves.
 * It is *not* in `services/matching.js`'s projection, it has no `seekIdentity`
 * partner, and test/match.test.js proves that two students who differ in nothing
 * else carry the same score — the field describes the person who wrote it and
 * decides nothing about anybody else.
 */
function validateLook(body) {
  return {
    identity: validateChoice(vocab.IDENTITY, body.identity, 'identity'),
    bodyType: validateChoice(vocab.BODY_TYPES, body.bodyType, 'body type'),
    height: validateChoice(vocab.HEIGHTS, body.height, 'height'),
    // The self-describe side takes only real answers: `vocab.EITHER` is offered on
    // the seek lists below and nowhere else, because "never mind either way" is a
    // thing to say about somebody you have not met, not a thing you are.
    drinks: validateChoice(vocab.DRINKS, body.drinks, 'answer for drinking'),
    smokes: validateChoice(vocab.SMOKES, body.smokes, 'answer for smoking'),
    gym: validateChoice(vocab.GYM, body.gym, 'answer for the gym'),
    seekBodyTypes: validatePicks(vocab.BODY_TYPES, body.seekBodyTypes, 'who you are after (body type)'),
    seekHeights: validatePicks(vocab.HEIGHTS, body.seekHeights, 'who you are after (height)'),
    seekDrinks: validatePicks([...vocab.DRINKS, vocab.EITHER], body.seekDrinks, 'who you are after (drinking)'),
    seekSmokes: validatePicks([...vocab.SMOKES, vocab.EITHER], body.seekSmokes, 'who you are after (smoking)'),
    seekGym: validatePicks([...vocab.GYM, vocab.EITHER], body.seekGym, 'who you are after (gym)'),
    typeNote: validateTypeNote(body.typeNote),
  };
}

/**
 * Prompt answers arrive as [{ prompt, answer }]. An empty answer means "I am not
 * doing this one", which is a deletion rather than a failure; a prompt may only
 * be answered once.
 */
function validatePrompts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const byPrompt = new Map();

  for (const entry of list) {
    const prompt = oneOf(vocab.PROMPTS, entry && entry.prompt, 'prompt');
    const answer = String((entry && entry.answer) || '').trim();

    if (!answer) continue;
    if (answer.length < 10) {
      throw new UserError('That answer is too short for anyone to read as an answer. Two real sentences is plenty.');
    }
    if (answer.length > MAX_PROMPT_ANSWER) {
      throw new UserError(`Keep each answer under ${MAX_PROMPT_ANSWER} characters — a match reads it, not reads it.`);
    }
    assertCleanText(answer, 'prompt answer');

    // First answer for a prompt wins, so a client that sends the same prompt
    // twice cannot store two versions of one question.
    if (!byPrompt.has(prompt)) byPrompt.set(prompt, answer);
  }

  return [...byPrompt].map(([prompt, answer]) => ({ prompt, answer }));
}

/**
 * FR-7.1 — "a new match suggestion", from the other end: the moment a profile
 * actually enters somebody's pool.
 *
 * Only three things make that true, and everything a student can save is measured
 * against them: the row is new, it has just become matchable, or a field the engine
 * *filters* on has changed. Interests and prompt answers are not among them — they
 * decide what a card says and where it ranks, not who is shown it, and a notice for
 * every re-typed sentence would be noise that trains a student to ignore the one
 * notice that is about them.
 */
const FILTER_FIELDS = ['institutionId', 'faculty', 'year', 'gender', 'lookingFor', 'age'];
// `preferredInstitutions` is deliberately not among them. It decides who *this*
// student is shown, and in what order; it cannot change who is shown this student,
// because the engine scores a candidate against the viewer's list, not the
// candidate's own. Announcing a preference edit to other students would be a bell
// for a thing that did not change about anybody.
//
// The same goes for the twelve appearance fields. `bodyType` and the rest decide
// where a card lands in somebody's order and what it says once they read it — the
// nudge can lift a candidate, never exclude one — so editing them cannot move
// anybody into or out of a pool, and a bell for each one would be the noise
// FR-7.1's rule exists to avoid.

function changesWhoItFits(before, after) {
  if (!before) return true;
  if (!before.isMatchable() && after.isMatchable()) return true;
  return FILTER_FIELDS.some(field => String(before[field]) !== String(after[field]));
}

async function announceAudience(before, after) {
  if (!after.isMatchable() || !changesWhoItFits(before, after)) return;

  try {
    const matching = require('./matching');
    const notifications = require('./notifications');

    const { userIds, truncated } = await matching.audienceFor(after);
    if (truncated) console.warn('[profile] the new-suggestion sweep hit its cap; some students were not told');

    let told = 0;
    for (const userId of userIds) {
      // One unread nudge per student is enough — the sentence does not count what it
      // points at, so a second row says the same thing twice.
      if (await notifications.hasUnreadSuggestion(userId)) continue;
      const sent = await notifications.notify({ userId, kind: 'suggestion' });
      if (sent.inApp || sent.email) told += 1;
    }
    if (told) console.log(`[profile] told ${told} student(s) there is somebody new to match`);
  } catch (err) {
    // The profile is saved and correct. A bell that failed is not a reason to tell
    // the student their edit did not land.
    console.error(`[profile] could not announce a new suggestion: ${err.message}`);
  }
}

/** FR-2.1 + FR-2.4. Creates the profile on first save and edits it after. */
async function save({ userId, email, body }) {
  // The institution is read off the account, not off the request: an address that
  // passed verification at registration is the only evidence this product has of
  // where somebody studies, and a save that let a client restate it would be a way
  // to become somebody else's institution without anybody's saying so.
  const institution = await institutions.forEmail(email);
  if (!institution) {
    throw new UserError(
      'This account no longer points at an institution on Unmask, so its profile cannot be saved. Open a support request if that is wrong.',
      { status: 403, code: 'institution_gone' }
    );
  }

  const fields = validateFields(body, institution);
  const look = validateLook(body);
  const preferredInstitutions = await institutions.normalizePreferences(body.preferredInstitutions, {
    ownInstitutionId: institution._id,
  });
  const revealName = validateRevealName(body.revealName);
  const interests = validateInterests(body.interests);
  const prompts = validatePrompts(body.prompts);

  // Read before the write: FR-7.1's notice is about a *change*, and a save that
  // changes nothing worth telling anybody about should stay quiet.
  const before = await Profile.findOne({ userId });

  const $set = {
    ...fields,
    revealName,
    interests,
    prompts,
    // FR-6.4 — a content hold lasts until the owner edits and saves, which is
    // the promise `missingForMatching()` makes out loud. Staff can hold it
    // again after reading the new version; a save cannot undo a *suspension*,
    // which is a different field on a different document.
    'review.status': 'clean',
    'review.reason': null,
    'review.at': null,
  };
  // `undefined` means the form did not show the field at all — an older client, or
  // a screen that saves the six basics without the preference picker. Writing `[]`
  // there would silently turn a student's first choice back into "anyone".
  if (preferredInstitutions !== undefined) $set.preferredInstitutions = preferredInstitutions;
  // The same rule for the twelve appearance fields: `validateLook` returns
  // `undefined` for a key the request never mentioned and `null` for one the
  // student cleared, and only the second of those two is an instruction.
  for (const [field, value] of Object.entries(look)) {
    if (value !== undefined) $set[field] = value;
  }

  const profile = await Profile.findOneAndUpdate(
    { userId },
    { $set },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // findOneAndUpdate with upsert can race a second save from the same student;
  // the unique index is the tie-break, and the loser reads the winner's row.
  const duplicates = await Profile.deleteMany({ userId, _id: { $ne: profile._id } });
  if (duplicates.deletedCount) console.warn(`[profile] merged ${duplicates.deletedCount} duplicate row(s) for one account`);

  await announceAudience(before, profile);

  return profile;
}

async function forUser(userId) {
  return Profile.findOne({ userId });
}

/**
 * The four fields a student's own screen needs about their institution, in one
 * shape. It is a function because there are two moments that need it: a saved
 * profile, and an account that has never written one — where the college is still
 * decided, by the address that was verified, and the form cannot be built without
 * knowing whether to offer a faculty list or a box to type in.
 */
function institutionView(institution) {
  if (!institution) return null;
  return {
    id: String(institution._id),
    name: institution.name,
    shortName: institution.shortName,
    // The list this form's faculty field has to offer. Empty means the
    // institution has not been given one, and the field is a text box.
    faculties: institution.faculties || [],
  };
}

/**
 * The twelve appearance fields, in the shape a screen reads them.
 *
 * Two of the three surfaces that show a profile call this: the owner's own copy
 * (`view` below) and the copy a student sees after both of them said yes
 * (`viewRevealed`). The third — the anonymous suggestion card in
 * `services/matching.js` — does not, and writes its own shorter list, because a
 * card is exactly the surface where an unchecked appearance field becomes a way to
 * sort strangers by their bodies before a word has been said.
 */
function lookView(profile) {
  return {
    identity: profile.identity || null,
    bodyType: profile.bodyType || null,
    height: profile.height || null,
    drinks: profile.drinks || null,
    smokes: profile.smokes || null,
    gym: profile.gym || null,
    seekBodyTypes: profile.seekBodyTypes || [],
    seekHeights: profile.seekHeights || [],
    seekDrinks: profile.seekDrinks || [],
    seekSmokes: profile.seekSmokes || [],
    seekGym: profile.seekGym || [],
    typeNote: profile.typeNote || null,
  };
}

/**
 * The whole profile, for the person who wrote it. Their own email is never in
 * here — a profile is what a match sees, and the email is what an account is.
 *
 * `institution` is the document behind `profile.institutionId`, passed in rather
 * than looked up here, so this stays one function the route can call after it has
 * already resolved it. Null is a real answer for a profile whose institution was
 * deleted, and the screens render "—" rather than a stack trace.
 */
function view(profile, institution) {
  if (!profile) return null;
  return {
    institution: institutionView(institution),
    faculty: profile.faculty,
    year: profile.year,
    gender: profile.gender,
    lookingFor: profile.lookingFor,
    age: profile.age,
    // The optional appearance block, in the same shape the revealed copy uses.
    ...lookView(profile),
    // Ids plus ranks, in the student's own order. The names come from /api/meta,
    // so an institution a student ranked and staff then switched off still reads
    // correctly here rather than as a hole in the list.
    preferredInstitutions: (profile.preferredInstitutions || []).map(entry => ({
      institutionId: String(entry.institutionId),
      rank: entry.rank,
    })),
    // The author's own copy carries it; a match's copy never does (see below).
    revealName: profile.revealName || null,
    interests: profile.interests,
    prompts: profile.prompts,
    hasPhoto: Boolean(profile.photo && profile.photo.fileName),
    photoUploadedAt: (profile.photo && profile.photo.fileName && profile.photo.uploadedAt) || null,
    updatedAt: profile.updatedAt,
    matchable: profile.isMatchable(),
    missing: profile.missingForMatching(),
    // FR-6.4 — a hold is not a missing form field, and listing it among them
    // would tell someone to finish a profile that is already finished.
    held:
      profile.review && profile.review.status === 'held'
        ? profile.review.reason || 'no note was left'
        : null,
    minimums: {
      interests: vocab.MIN_INTERESTS,
      prompts: vocab.MIN_PROMPTS,
      maxInterests: MAX_INTERESTS,
      facultyMax: MAX_FACULTY,
      maxPreferredInstitutions: institutions.MAX_PREFERENCES,
      // The three appearance pick lists and the free-text note count against these.
      maxPicks: vocab.MAX_PREF_PICKS,
      typeNoteMax: MAX_TYPE_NOTE,
    },
  };
}

/**
 * What the *other student* is shown once both of them have consented (FR-5.2,
 * FR-5.6). Deliberately a second function rather than a flag on the one above:
 * the day these two shapes drift apart is the day a student sees something they
 * were not supposed to, so they are not allowed to share a body.
 *
 * Everything a match could already be matched on is here, plus the two things the
 * mask was kept over — the chosen name and, through a route that only opens after
 * this, the photo. What is still not here is a profile id: a screen that needs
 * neither has no business carrying one, and an id a student could compare across
 * two different people's screens is a way to work out who was suggested to whom
 * (NFR-3.3). The account's email is not here either, because it never was.
 */
function viewRevealed(profile, institution) {
  return {
    // Optional by the student's own choice. A reveal that turns up nobody is a
    // real outcome, and the screens say "no name given" rather than guessing.
    name: profile.revealName || null,
    institution: institution ? institution.shortName : null,
    faculty: profile.faculty,
    year: profile.year,
    gender: profile.gender,
    lookingFor: profile.lookingFor,
    age: profile.age,
    ...lookView(profile),
    interests: profile.interests,
    prompts: profile.prompts,
    hasPhoto: Boolean(profile.photo && profile.photo.fileName),
  };
}

/** FR-2.2 / FR-2.5 — replace or remove the one photo. */
async function setPhoto({ userId, buffer }) {
  const existing = await Profile.findOne({ userId });
  if (!existing) {
    throw new UserError('Fill in your profile first — a photo belongs to a profile, not to an account.');
  }

  const stored = await photos.save(buffer);

  await Profile.updateOne(
    { _id: existing._id },
    { $set: { 'photo.fileName': stored.fileName, 'photo.uploadedAt': new Date(), 'photo.bytes': stored.bytes } }
  );

  // The replacement is on disk now, so the old one goes. If this fails the worst
  // case is an orphaned file that nobody can name, and the next save retries.
  const previous = existing.photo && existing.photo.fileName;
  if (previous && previous !== stored.fileName) await photos.unlink(previous);

  return stored;
}

async function removePhoto(userId) {
  const profile = await Profile.findOne({ userId });
  if (!profile || !profile.photo || !profile.photo.fileName) return false;

  const fileName = profile.photo.fileName;
  await Profile.updateOne({ _id: profile._id }, { $set: { 'photo.fileName': null, 'photo.uploadedAt': null, 'photo.bytes': null } });
  await photos.unlink(fileName);
  return true;
}

/** The stored name, for the route that reads the bytes back. */
async function photoFileName(userId) {
  const profile = await Profile.findOne({ userId }, { 'photo.fileName': 1 });
  return (profile && profile.photo && profile.photo.fileName) || null;
}

module.exports = {
  save,
  forUser,
  view,
  institutionView,
  viewRevealed,
  setPhoto,
  removePhoto,
  photoFileName,
  findContactClue,
  MAX_INTERESTS,
  MAX_FACULTY,
  MAX_PROMPT_ANSWER,
  MAX_REVEAL_NAME,
  MAX_TYPE_NOTE,
};
