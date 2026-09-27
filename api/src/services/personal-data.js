'use strict';
/**
 * NFR-3.1 — "data subject access and deletion", and this file is the access half.
 *
 * POPIA asks a platform two questions about a person's record: *give me what you
 * hold*, and *take it away*. They have to be answered out of one list, or they
 * drift — an export that covers seven collections while a deletion covers eight
 * tells somebody they have everything while a row is still sitting in the
 * database. So `ownData` below is the only place that decides what "yours" means,
 * and `services/auth.js`'s `eraseDataFor` calls it instead of keeping its own copy.
 *
 * What leaves in an export is your own data, which is not the same as everything
 * that mentions you. A match row holds two people, a message holds one of them, an
 * audit row holds whoever pressed the button, and a report holds the person who
 * filed it — so the shaping below is done one collection at a time rather than by
 * dumping documents. Every account that is not the requester becomes a word:
 * `you`, `(another student)`, `(a staff member)`. A 24-character id is anonymous
 * only until somebody pastes the file into a support email, and unlike a name an id
 * is the one thing this database can join back to a person.
 */

const mongoose = require('mongoose');

const User = require('../models/User');
const institutions = require('./institutions');

const YOU = 'you';
const PEER = '(another student)';
const STAFF = '(a staff member)';
const SYSTEM = '(the system)';
// A reporter's own access request is the one place their id must not appear as
// anything else: the reported student reads a report as "(another student)".
const REPORTER = '(the student who filed it — never named to the reported person)';

const NOT_INCLUDED = [
  'Your password. Only a bcrypt hash is stored, and a hash is not a password — it is what lets the site check yours without keeping it.',
  'The strings that keep a device signed in, and the emailed link tokens for verifying an address or resetting a password. Each is stored only as a SHA-256 hash, and a copy of any of them in a file is a working door.',
  'The other student in each conversation, by name, address or id. Anonymity before a mutual reveal (FR-2.6, NFR-3.3) is not lifted by a request for your own data: you already know who you chose to chat with, and this file is not a way to let anybody else find out.',
  'Who reported you. A report never tells the reported person who filed it (FR-6.3), and an export is not an exception to that.',
  'The rows where another student blocked you. A block is designed to look exactly like an ended chat (FR-6.2); naming it here would undo the one thing it exists for.',
  'The photo file itself. Its size and the day it went up are in here, and the picture is on your own profile screen — a face should not be buried inside a text file that gets forwarded.',
  'Anything that belongs to another student and only mentions you: a staff decision recorded about somebody else, a third party’s messages, a report they filed against someone else.',
];

/**
 * The one definition of "the rows that are about these accounts".
 *
 * Each collection names a person with a different field, so each needs its own
 * sentence. An unlisted collection would be matched on `userId`, find nothing, and
 * quietly leave behind personal data that a promise said was gone.
 */
async function ownData(userIds) {
  const db = mongoose.connection;
  const inList = { $in: userIds };

  // A pass points at the *profile* that was declined as well as the account that
  // declined it, so both halves have to be listed while both still exist.
  const profileIds = await db.collection('profiles').distinct('_id', { userId: inList });

  // A message is addressed by its thread, not by its writer: both halves of a
  // pair's words belong to that pair.
  const threadIds = await db.collection('matches').distinct('_id', { users: inList });

  const photoDocs = await db
    .collection('profiles')
    .find({ userId: inList }, { projection: { 'photo.fileName': 1 } })
    .toArray();

  const filters = {
    profiles: { userId: inList },
    passes: { $or: [{ userId: inList }, { profileId: { $in: profileIds } }] },
    // A whole match row belongs to both halves — a thread with one deleted
    // participant is not a thread.
    matches: { users: inList },
    messages: { $or: [{ senderId: inList }, { matchId: { $in: threadIds } }] },
    blocks: { $or: [{ userId: inList }, { blockedUserId: inList }] },
    reports: { $or: [{ reporterId: inList }, { reportedUserId: inList }] },
    auditEvents: { $or: [{ actorId: inList }, { subjectId: inList }] },
    notifications: { userId: inList },
  };

  return {
    filters,
    profileIds,
    threadIds,
    photoFileNames: photoDocs.map(doc => doc.photo && doc.photo.fileName).filter(Boolean),
  };
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * A student's whole record, shaped to be read by that student.
 *
 * `deleteAccount` answers "take it away" and this answers "give it to me"; both
 * read `User.dataCollections`, so a collection added in stage 10 is missing from
 * both or present in both, never from one.
 */
async function collectFor(userId) {
  const db = mongoose.connection;
  const me = String(userId);

  const user = await User.findById(userId).lean();
  if (!user) throw new Error('That account is already gone.');

  const { filters, photoFileNames } = await ownData([userId]);

  const rows = {};
  for (const name of User.dataCollections) {
    rows[name] = await db.collection(name).find(filters[name]).sort({ _id: 1 }).toArray();
  }

  // Who is a staff member, so a moderation entry can say so instead of inventing a
  // student who was not one. Every other account in these rows is a peer.
  const mentioned = new Set();
  const collect = value => {
    if (value) mentioned.add(String(value));
  };
  for (const row of rows.matches) {
    (row.users || []).forEach(collect);
    collect(row.openedBy);
    collect(row.closedBy);
    (row.reveal && row.reveal.consent ? row.reveal.consent : []).forEach(c => collect(c.userId));
  }
  for (const row of rows.reports) {
    collect(row.reporterId);
    collect(row.reportedUserId);
    collect(row.decidedBy);
  }
  for (const row of rows.auditEvents) {
    collect(row.actorId);
    collect(row.subjectId);
  }
  mentioned.delete(me);

  const staffIds = new Set(
    (await User.find({ _id: { $in: [...mentioned] }, role: 'admin' }).select('_id').lean()).map(doc => String(doc._id))
  );

  function label(id) {
    if (!id) return null;
    const key = String(id);
    if (key === me) return YOU;
    if (staffIds.has(key)) return STAFF;
    return PEER;
  }

  const profile = rows.profiles[0] || null;

  // An export is read by a person, not a driver: a foreign key is the one shape of
  // "which institution" that means nothing to them. These names are public reference
  // data — the same list /api/meta hands to any browser — not a second person's data.
  const ownInstitutions = await institutions.byIds([
    ...(profile ? [profile.institutionId] : []),
    ...((profile && profile.preferredInstitutions) || []).map(entry => entry.institutionId),
  ]);
  const namedInstitutions = ids =>
    ids
      .map(id => ownInstitutions.get(String(id)))
      .filter(Boolean)
      .map(row => ({ name: row.name, shortName: row.shortName }));

  const messagesByThread = new Map();
  for (const message of rows.messages) {
    const key = String(message.matchId);
    if (!messagesByThread.has(key)) messagesByThread.set(key, []);
    messagesByThread.get(key).push({
      at: iso(message.createdAt),
      from: message.senderId ? label(message.senderId) : PEER,
      body: message.body,
    });
  }

  const conversations = rows.matches.map(match => {
    const other = (match.users || []).map(String).find(id => id !== me);
    const consent = (match.reveal && match.reveal.consent) || [];
    const mine = consent.find(c => String(c.userId) === me);
    const theirs = consent.find(c => String(c.userId) !== me);
    const cleared = (match.cleared || []).find(c => String(c.userId) === me);

    return {
      openedAt: iso(match.createdAt),
      with: other ? PEER : null,
      openedBy: label(match.openedBy),
      status: match.status,
      closedBy: match.closedBy ? label(match.closedBy) : null,
      // FR-4.5: clearing a screen is per person, so this is your marker, not the
      // pair's. The rows older than it are still listed above, because you asked.
      youClearedYourViewAt: cleared ? iso(cleared.at) : null,
      reveal: {
        status: match.reveal ? match.reveal.status : 'none',
        askedBy: match.reveal ? label(match.reveal.askedBy) : null,
        askedAt: match.reveal ? iso(match.reveal.askedAt) : null,
        youConsentedAt: mine ? iso(mine.at) : null,
        // The other half's timestamp is their data. Whether they said yes is the
        // fact you are entitled to; the minute they said it is not.
        otherConsented: theirs ? 'yes' : match.reveal && match.reveal.declinedBy ? 'declined' : 'not yet',
        revealedAt: match.reveal ? iso(match.reveal.revealedAt) : null,
      },
      messages: messagesByThread.get(String(match._id)) || [],
    };
  });

  const reportRow = row => ({
    at: iso(row.createdAt),
    kind: row.kind,
    reason: row.reason,
    detail: row.detail,
    excerpt: row.excerpt,
    status: row.status,
    decision: row.decision,
    decisionNote: row.decisionNote,
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy ? label(row.decidedBy) : null,
  });

  return {
    format: 'unmask-data-export/1',
    requestedAt: new Date().toISOString(),
    about: user.email,

    account: {
      email: user.email,
      createdAt: iso(user.createdAt),
      emailVerifiedAt: iso(user.emailVerifiedAt),
      over18AttestedAt: iso(user.over18AttestedAt),
      lastSignInAt: iso(user.lastLoginAt),
      role: user.role,
      status: user.status,
      statusReason: user.statusReason || null,
      studentStatus: {
        status: user.student ? user.student.status : 'attested',
        at: user.student ? iso(user.student.at) : null,
        decidedBy: user.student ? label(user.student.by) : null,
        note: user.student ? user.student.note : null,
      },
      failedSignInCount: user.failedLoginCount || 0,
      lockedUntil: iso(user.lockedUntil),
      switches: user.notifications || null,
      // The devices, never the keys. A session id in a file is a working login.
      signedInDevices: (user.sessions || []).map(s => ({
        since: iso(s.createdAt),
        expiresAt: iso(s.expiresAt),
        browser: s.userAgent || '',
      })),
    },

    profile: profile
      ? {
          institution: namedInstitutions([profile.institutionId])[0] || null,
          preferredInstitutions: (profile.preferredInstitutions || [])
            .slice()
            .sort((a, b) => a.rank - b.rank)
            .map(entry => ({
              rank: entry.rank,
              institution: namedInstitutions([entry.institutionId])[0] || null,
            })),
          faculty: profile.faculty,
          year: profile.year,
          gender: profile.gender,
          lookingFor: profile.lookingFor,
          age: profile.age,
          interests: profile.interests || [],
          prompts: (profile.prompts || []).map(p => ({ prompt: p.prompt, answer: p.answer })),
          revealName: profile.revealName || null,
          // A subject access export has to hold everything this row does, and not
          // merely everything it held when this file was written. The appearance
          // block is here in full, including `identity`, which a student typed
          // about themselves and which we keep exactly one copy of.
          appearance: {
            identity: profile.identity || null,
            bodyType: profile.bodyType || null,
            height: profile.height || null,
            drinks: profile.drinks || null,
            smokes: profile.smokes || null,
            gym: profile.gym || null,
            afterBodyTypes: profile.seekBodyTypes || [],
            afterHeights: profile.seekHeights || [],
            afterDrinks: profile.seekDrinks || [],
            afterSmokes: profile.seekSmokes || [],
            afterGym: profile.seekGym || [],
            typeNote: profile.typeNote || null,
          },
          photo: profile.photo && profile.photo.fileName
            ? { onFile: true, uploadedAt: iso(profile.photo.uploadedAt), bytes: profile.photo.bytes || null }
            : { onFile: false },
          review: profile.review ? { status: profile.review.status, reason: profile.review.reason || null, at: iso(profile.review.at) } : null,
        }
      : null,

    conversations,
    declines: rows.passes.map(pass => ({
      at: iso(pass.createdAt),
      // "You passed on them" and "someone passed on you" are both about you, and
      // naming either side would say who did not want whom.
      direction: String(pass.userId) === me ? 'you passed on a suggestion' : 'a suggestion passed you by',
      hiddenUntil: iso(pass.until),
    })),
    blocks: rows.blocks
      .filter(block => String(block.userId) === me)
      .map(block => ({ at: iso(block.createdAt), who: PEER })),

    reportsFiled: rows.reports.filter(row => String(row.reporterId) === me).map(reportRow),
    reportsAgainstYou: rows.reports
      .filter(row => String(row.reportedUserId) === me)
      .map(row => ({ ...reportRow(row), filedBy: String(row.reporterId) === me ? YOU : REPORTER })),

    notices: rows.notifications.map(row => ({
      at: iso(row.createdAt),
      kind: row.kind,
      body: row.body,
      readAt: iso(row.readAt),
    })),

    auditEntries: rows.auditEvents.map(row => ({
      at: iso(row.createdAt),
      action: row.action,
      by: row.automated ? SYSTEM : label(row.actorId),
      about: row.subjectId ? label(row.subjectId) : null,
      targetType: row.targetType || null,
      note: row.note || null,
      data: row.data === undefined ? null : row.data,
    })),

    summary: {
      collectionsCovered: ['users', ...User.dataCollections],
      conversations: conversations.length,
      messages: rows.messages.length,
      suggestionsYouDeclined: rows.passes.filter(p => String(p.userId) === me).length,
      reportsFiled: rows.reports.filter(r => String(r.reporterId) === me).length,
      reportsAgainstYou: rows.reports.filter(r => String(r.reportedUserId) === me).length,
      notices: rows.notifications.length,
      logEntries: rows.auditEvents.length,
      photoOnFile: photoFileNames.length > 0,
      signedInDevices: (user.sessions || []).length,
    },

    whatIsNotInThisFileAndWhy: NOT_INCLUDED,
  };
}

module.exports = { ownData, collectFor };
