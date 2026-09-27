/**
 * The built site must be able to render with no network but its own origin.
 *
 * This is not a performance rule. A page that phones a font host, an analytics
 * endpoint or a CDN on load tells that third party which IP is looking at an
 * anonymous dating-style profile — the one fact this product exists to keep
 * private. So the promise is checked at build time, against the file that
 * actually ships, and the build fails rather than warns.
 *
 * What it looks at: every absolute http(s) URL and every protocol-relative URL
 * in dist, plus the source that produced it. localhost is allowed, because the
 * development page is not the deployed one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB_ROOT, 'dist');

const URL_IN_TEXT = /https?:\/\/[^\s"'()<]+|\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\//gi;

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (/\.(html|css|js)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

// A URL inside a JavaScript string is only a request if something calls it, which
// a scan of a minified bundle cannot prove either way. So a foreign host found in
// script has to be named here, with the reason it is not a request — which is the
// point: a new one stops the build until somebody reads it and decides.
const ALLOWED = [
  {
    host: 'reactjs.org',
    why: 'React prints this documentation link inside its own minified error message. Nothing fetches it, and an error page is not a student being watched.',
  },
];

function ownOrigin(host) {
  return /^localhost(:\d+)?$/.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host);
}

const allowedHits = new Set();

function foreignUrlsIn(file) {
  const text = fs.readFileSync(file, 'utf8');
  const hits = new Set();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const raw = match[0];
    let host = '';
    try {
      host = new URL(raw.startsWith('//') ? 'https:' + raw : raw).hostname;
    } catch {
      continue;
    }
    if (!host) continue;
    // An SVG namespace is a string in markup, not a request the page makes.
    if (host === 'www.w3.org') continue;
    if (ownOrigin(host)) continue;
    const allowed = ALLOWED.find(a => a.host === host);
    if (allowed) {
      allowedHits.add(`${host} — allowed: ${allowed.why}`);
      continue;
    }
    hits.add(`${host} — in ${path.relative(WEB_ROOT, file)}`);
  }
  return [...hits];
}

if (!fs.existsSync(DIST)) {
  console.error('no dist/ to check — run npm run build first');
  process.exit(1);
}

const scanned = filesUnder(DIST).concat(
  filesUnder(path.join(WEB_ROOT, 'src')),
  [path.join(WEB_ROOT, 'index.html')]
);

const found = [];
for (const file of scanned) found.push(...foreignUrlsIn(file));

console.log(`${scanned.length} built and source files scanned for absolute URLs.`);
if (found.length) {
  console.log('\nFAIL — the site would ask somebody else to load it:');
  for (const f of [...new Set(found)]) console.log(`  - ${f}`);
  console.log('\nEither ship the asset in web/public, or say out loud in the README why');
  console.log('a student\'s browser should be reaching that host at all.');
  process.exit(1);
}
console.log('PASS — every absolute URL in the build points at this origin.');
if (allowedHits.size) {
  console.log('');
  console.log('Named and allowed (a string in the bundle, not a request):');
  for (const line of allowedHits) console.log(`  - ${line}`);
}
