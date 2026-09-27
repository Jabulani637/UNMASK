'use strict';
/**
 * Every question the product asks about institutions, answered in one place.
 *
 * The rule behind this file is that **nobody downstream is allowed to know how
 * many institutions there are, or what any of them is called.** Registration asks
 * "does this address belong to an active institution"; matching asks "do these two
 * profiles share a city"; the front end asks for a list and renders it. Each of
 * those is one query, and none of them is a branch on a name — which is what makes
 * NFR-SCALE-1 true in code rather than in intention: adding a sixth college
 * changes a document, and every one of these functions already returns six answers.
 *
 * There is no cache. The collection is a handful of small documents read a couple
 * of times per request, and a cache would be a second copy of the eligibility rule
 * that keeps answering for up to its own lifetime after a staff member turns an
 * institution off — which is precisely the moment somebody is trying to be kept
 * out.
 */

const mongoose = require('mongoose');

const Institution = require('../models/Institution');
const InstitutionRequest = require('../models/InstitutionRequest');
const { PILOT_INSTITUTIONS } = require('../domain/pilotInstitutions');
const { UserError } = require('../errors');

/** v2 §4 — a student may rank three, and no more. */
const MAX_PREFERENCES = 3;

const asId = value => {
  const text = String(value || '');
  return mongoose.isValidObjectId(text) ? text : null;
};

/** The address's own half, lowercased. Not a validator — shape is auth's job. */
function domainOf(email) {
  const value = String(email || '');
  return Institution.normalizeDomain(value.slice(value.lastIndexOf('@') + 1));
}

/**
 * Which institution, if any, this address belongs to.
 *
 * `isActive: true` is part of the lookup rather than a check afterwards, so a
 * deactivated institution cannot register a new account by having its domain left
 * in the list — the one way to be sure the flag means what it says.
 */
async function forEmail(email) {
  const domain = domainOf(email);
  if (!domain) return null;
  return Institution.findOne({ emailDomains: domain, isActive: true });
}

async function activeList() {
  return Institution.find({ isActive: true }).sort({ shortName: 1 });
}

/**
 * Every row, switched off included.
 *
 * `/api/meta` must not use this one: a deactivated institution is still on the list
 * here precisely so the staff screen can show the toggle and the person looking at it
 * can turn it back on. A student's dropdown has no business offering a college that
 * Unmask has stopped taking students from.
 */
async function staffList() {
  return Institution.find({}).sort({ isActive: -1, shortName: 1 });
}

/** One row by id, or the 404 a route should not have to write itself. */
async function get(id) {
  const institution = await Institution.findById(asId(id));
  if (!institution) throw new UserError('No such institution.', { status: 404 });
  return institution;
}

/** id -> document, for a page of profiles at once. */
async function byIds(ids) {
  const clean = [...new Set((ids || []).map(asId).filter(Boolean))];
  if (!clean.length) return new Map();
  const rows = await Institution.find({ _id: { $in: clean } });
  return new Map(rows.map(row => [String(row._id), row]));
}

/** What `/api/meta` may say. A staff-only field is never in this shape. */
function publicList(institutions) {
  return (institutions || []).map(institution => ({
    id: String(institution._id),
    name: institution.name,
    shortName: institution.shortName,
    type: institution.type,
    city: institution.city,
    // An empty list is the honest answer, and the form reads it as free text.
    faculties: institution.faculties || [],
    emailDomains: institution.emailDomains || [],
  }));
}

/**
 * The one line an institution's name is allowed to occupy on a student's screen.
 *
 * A card, a chat header, a blocked row and a reveal all used to write
 * `${year}, ${faculty}, ${campus}`. Four copies of a sentence about a person is four
 * chances to disagree, so the shape lives here: institution first, because after a
 * reveal it is the field that tells two people they are at the same place.
 */
function labelFor(institution, profile) {
  const parts = [];
  if (profile.year) parts.push(profile.year);
  if (profile.faculty) parts.push(profile.faculty);
  if (institution) parts.push(institution.shortName);
  return parts;
}

/**
 * Clean what a client sent into `preferredInstitutions`.
 *
 * Ranks are assigned from the order, never taken from the body: a request that
 * claims `[1, 1, 3]` or `[2]` alone is a client describing its own list, and the
 * whole point of a ranked preference is that the server's copy is the one the
 * engine scores. Duplicates collapse to their first appearance. An unknown or
 * deactivated id is refused rather than dropped — silently losing a student's
 * first choice would change who they are shown without saying so.
 */
async function normalizePreferences(raw, { ownInstitutionId } = {}) {
  if (raw === undefined || raw === null) return undefined; // "leave it as it is"
  if (!Array.isArray(raw)) throw new UserError('Your institution preferences have to be a list.');
  if (raw.length === 0) return [];

  const ids = [];
  for (const entry of raw) {
    const id = asId(entry && (entry.institutionId || entry.id));
    if (!id) throw new UserError('Each preference has to name an institution from the list.');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_PREFERENCES) {
    throw new UserError(`Choose at most ${MAX_PREFERENCES} institutions. ${ids.length} is not a preference order, it is a shrug.`);
  }

  const found = await byIds(ids);
  const ordered = [];
  for (const id of ids) {
    const institution = found.get(id);
    if (!institution) throw new UserError('One of those institutions is not on Unmask.');
    if (!institution.isActive) {
      throw new UserError(`${institution.shortName} is not taking students on Unmask right now, so it cannot be one of your choices.`);
    }
    // Listing your own institution is not a preference, it is a fact about where
    // you study — and leaving it in would quietly spend one of the three slots on
    // an answer the engine can reach a different way.
    if (ownInstitutionId && id === String(ownInstitutionId)) continue;
    ordered.push({ institutionId: institution._id, rank: ordered.length + 1 });
  }
  return ordered;
}

/**
 * The domains of an institution, as they will be compared.
 *
 * The shape check is the point. A domain that is not a domain — a space, a missing
 * dot, somebody typing `@mycput.ac.za` with the at-sign and all — is accepted by the
 * document, stored, and then matches no address ever, so the institution looks
 * configured and its students are refused at registration with a sentence that says
 * their own address is not one of ours. A staff member cannot debug that from a
 * browser, so it is refused here, by name, while they are still looking at the field.
 */
const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function cleanDomains(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const clean = [];
  for (const entry of list) {
    const domain = Institution.normalizeDomain(entry);
    if (!domain) continue;
    if (!DOMAIN_SHAPE.test(domain)) {
      throw new UserError(
        `“${domain}” is not an email domain. It is the part after the @ — for example surnames.ac.za — with no spaces, no @ and no http:// in front of it.`,
        { status: 400, code: 'bad_domain' }
      );
    }
    if (!clean.includes(domain)) clean.push(domain);
  }
  if (!clean.length) {
    throw new UserError(
      'Add at least one email domain. It is the part after the @ in a student address — without it nobody can prove they study here, and the institution is a name with no way to verify anyone.',
      { status: 400, code: 'no_domains' }
    );
  }
  return clean;
}

/** Faculty names, trimmed and de-duplicated. Empty means "its students type theirs". */
function cleanFaculties(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const clean = [];
  for (const entry of list) {
    const value = String(entry || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (value.length > 80) throw new UserError(`Keep a faculty name to 80 characters: “${value.slice(0, 30)}…” is longer.`);
    if (!clean.includes(value)) clean.push(value);
  }
  return clean;
}

/**
 * Staff writes. `update` takes a patch, so a form that sends three fields cannot
 * silently empty the other four.
 *
 * The domain collision check is here for the *sentence*: Mongo's unique index on
 * the array is the hard guarantee that one domain belongs to one institution, but
 * an 11000 from the index would reach a staff member as "duplicate key error on
 * emailDomains" — which does not name the institution they are about to steal a
 * domain from, and that is the one detail they need in order to fix it.
 */
async function create(body) {
  const doc = new Institution({
    name: String(body.name || '').trim(),
    shortName: String(body.shortName || '').trim(),
    type: body.type,
    city: String(body.city || '').trim(),
    emailDomains: cleanDomains(body.emailDomains),
    faculties: cleanFaculties(body.faculties),
    isActive: body.isActive !== false,
  });
  await assertDomainsFree(doc.emailDomains, null);
  try {
    await doc.save();
  } catch (err) {
    throw mongoError(err);
  }
  return doc;
}

async function update(id, changes) {
  const institution = await get(id);

  for (const field of ['name', 'shortName', 'type', 'city']) {
    if (changes[field] !== undefined) institution[field] = String(changes[field]).trim();
  }
  if (changes.emailDomains !== undefined) {
    const domains = cleanDomains(changes.emailDomains);
    await assertDomainsFree(domains, institution._id);
    institution.emailDomains = domains;
  }
  if (changes.faculties !== undefined) institution.faculties = cleanFaculties(changes.faculties);
  if (changes.isActive !== undefined) institution.isActive = Boolean(changes.isActive);

  try {
    await institution.save();
  } catch (err) {
    throw mongoError(err);
  }
  return institution;
}

/** Which active institution already answers to this domain, if any. */
async function assertDomainsFree(domains, exceptId) {
  const clean = [...new Set((domains || []).map(Institution.normalizeDomain).filter(Boolean))];
  if (!clean.length) return;
  const clash = await Institution.find({ _id: { $ne: exceptId }, emailDomains: { $in: clean } });
  if (clash.length) {
    const owner = new Map(clash.map(row => [String(row._id), row.shortName]));
    for (const row of clash) {
      for (const domain of (row.emailDomains || []).map(Institution.normalizeDomain)) {
        if (clean.includes(domain)) {
          throw new UserError(
            `“${domain}” already belongs to ${owner.get(String(row._id))}. One domain can only verify one institution — otherwise “whose student is this” has two answers.`,
            { status: 409 }
          );
        }
      }
    }
  }
}

function mongoError(err) {
  if (err && err.name === 'ValidationError') {
    const first = Object.values(err.errors)[0];
    throw new UserError(`That institution is incomplete: ${first ? first.message : err.message}`);
  }
  if (err && err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'a field';
    throw new UserError(
      field === 'emailDomains'
        ? 'One of those email domains already belongs to another institution.'
        : `Another institution already uses that ${field}.`,
      { status: 409 }
    );
  }
  throw err;
}

/**
 * The pilot list, put into the database. Idempotent, and it never edits a
 * document that already exists — a staff member who has since changed CPUT's
 * faculties or deactivated a college must not be undone by a reseed.
 */
async function ensurePilot() {
  let created = 0;
  let present = 0;
  for (const entry of PILOT_INSTITUTIONS) {
    const result = await Institution.updateOne(
      { shortName: entry.shortName },
      {
        $setOnInsert: {
          name: entry.name,
          shortName: entry.shortName,
          type: entry.type,
          city: entry.city,
          emailDomains: entry.emailDomains.map(Institution.normalizeDomain),
          faculties: entry.faculties,
          isActive: true,
        },
      },
      { upsert: true }
    );
    if (result.upsertedCount) created += 1;
    else present += 1;
  }
  return { created, present };
}

/**
 * "My institution isn't listed." Held without any link to who sent it — see
 * models/InstitutionRequest.js. Grouped by the name the requester typed, newest
 * first, because the question a staff member brings to this list is "which
 * college next", and the answer is a count with a spelling problem attached to it.
 */
async function recordRequest({ institutionName, city, detail }) {
  const name = String(institutionName || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2) throw new UserError('Give the name of the institution you are asking for.');
  if (name.length > 100) throw new UserError('That institution name is too long to be one.');
  const where = String(city || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  const note = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 240) || null;
  await InstitutionRequest.create({ institutionName: name, city: where, detail: note });
  return { institutionName: name };
}

async function requestSummary({ limit = 50 } = {}) {
  const rows = await InstitutionRequest.aggregate([
    { $group: { _id: '$institutionName', count: { $sum: 1 }, lastRequested: { $max: '$createdAt' } } },
    { $sort: { count: -1, lastRequested: -1 } },
    { $limit: limit },
  ]);
  return rows.map(row => ({ institutionName: row._id, count: row.count, lastRequested: row.lastRequested }));
}

module.exports = {
  MAX_PREFERENCES,
  forEmail,
  domainOf,
  activeList,
  staffList,
  get,
  byIds,
  publicList,
  labelFor,
  normalizePreferences,
  create,
  update,
  ensurePilot,
  recordRequest,
  requestSummary,
};
