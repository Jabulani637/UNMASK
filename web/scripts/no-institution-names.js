/**
 * No institution may be named in the client.
 *
 * NFR-SCALE-1 is the claim that a staff member adding a college at `/staff` is the
 * whole of the work — no deploy, no edit, no rebuild. The claim dies the moment a
 * college's name or email domain is typed into a page: that page then lists five
 * colleges while the database lists six, and the sixth college's students are told,
 * politely, that nobody has heard of them. It is the same failure the product had
 * before the `institutions` collection existed, so it is checked at build time
 * rather than remembered.
 *
 * The deny list is not written here. It is the API's own seed —
 * `api/src/domain/pilotInstitutions.js` — so a name cannot be added to the product
 * without being added to the guard, and the only way to pass is to not name colleges
 * in the client at all. Every string the seed carries is checked, plus the words of
 * every long name (" Peninsula " is what leaks out of a headline that dropped the
 * university off the front), each at a word boundary and case-sensitively: `UCT` in
 * uppercase is the abbreviation, `uct` inside "product" is English.
 *
 * A local fixture in a test is not a claim about the world, so `*.test.*` files are
 * skipped — they need *an* institution to assert against. Anything else in `src/` is
 * copy the build ships, and copy has to come from the API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB_ROOT, 'dist');
const SRC = path.join(WEB_ROOT, 'src');
const SEED = path.resolve(WEB_ROOT, '..', 'api', 'src', 'domain', 'pilotInstitutions.js');

const { PILOT_INSTITUTIONS } = require(SEED);

function words(name) {
  return name
    .split(/\s+/)
    .map(word => word.replace(/[^\p{L}\p{N}&'-]/gu, ''))
    // A single word from a name only means the name when it is not a word an
    // interface has to be allowed to say: "Town" out of "University of Cape Town"
    // is not a claim about a college, and it fires on the label "Town or city".
    .filter(word => word.length >= 8 && !GENERIC.has(word.toLowerCase()));
}

// The shape of every institution's name, rather than anything particular about one.
const GENERIC = new Set([
  'university',
  'technology',
  'polytechnic',
  'institute',
  'central',
  'western',
  'eastern',
  'northern',
  'southern',
]);

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const atBoundary = (value, flags = '') => new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, `u${flags}`);

const banned = [];
for (const row of PILOT_INSTITUTIONS) {
  banned.push({ needle: row.name, kind: 'institution name', re: atBoundary(row.name) });
  // Lowercase is the same bug: "chat with cput students" names a college the API
  // owns. The word boundary is what stops "uct" being found inside "product".
  banned.push({ needle: row.shortName, kind: 'institution short name', re: atBoundary(row.shortName, 'i') });
  for (const word of words(row.name)) banned.push({ needle: word, kind: 'word from an institution name', re: atBoundary(word) });
  for (const domain of row.emailDomains) {
    banned.push({ needle: domain, kind: 'email domain', re: new RegExp(escape(domain), 'i') });
  }
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const checked = [];
if (fs.existsSync(DIST)) checked.push(...filesUnder(DIST).filter(f => /\.(html|css|js)$/i.test(f)));
if (fs.existsSync(SRC)) {
  checked.push(...filesUnder(SRC).filter(f => !/\.test\.[cm]?js$/.test(f) && /\.(jsx?|css|html)$/i.test(f)));
}

/**
 * Comment blocks out, so a guard about shipped copy cannot be answered by prose.
 *
 * A doc comment naming colleges to explain why they must not be named is exactly the
 * documentation this project wants, and it never reaches a student's screen — Vite
 * strips it. Only a line that is *nothing but* a comment is ignored: a name after a
 * trailing `//` on a line of code is still read, so writing copy and hiding it under
 * a comment is not a way through.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|\*\/)/;

function withoutComments(text) {
  return text
    .split('\n')
    .filter(line => !COMMENT_LINE.test(line))
    .join('\n');
}

if (!checked.length) {
  console.error('nothing to check — no web/dist and no web/src');
  process.exit(1);
}

const found = [];
for (const file of checked) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = file.startsWith(DIST) ? raw : withoutComments(raw);
  for (const item of banned) {
    if (item.re.test(text)) found.push(`${item.needle} (${item.kind}) — in ${path.relative(WEB_ROOT, file)}`);
  }
}

console.log(`${checked.length} files scanned against ${PILOT_INSTITUTIONS.length} seeded institutions, ${banned.length} strings.`);
if (found.length) {
  console.log('\nFAIL — an institution is written into the client instead of served by the API:');
  for (const f of [...new Set(found)]) console.log(`  - ${f}`);
  console.log('\nRead it from /api/meta, or from the institution on the profile. A name typed');
  console.log('into this folder is a name a staff member can no longer change.');
  process.exit(1);
}
console.log('PASS — every institution the client mentions, it was told about by the API.');
