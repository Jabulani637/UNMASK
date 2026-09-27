/* MI-5 live proof: the payload web/src/pages/Profile.jsx posts, against the
   :4100 server that is running the code. No mocks, no in-process requires —
   every assertion below is a response the running API actually gave. */
import { readdirSync, readFileSync, statSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4100';
const OUTBOX = 'C:/Users/hp/Desktop/UNMASK/api/outbox';
const PASSWORD = 'correct horse battery staple';

let pass = 0;
const failures = [];
function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const jars = new Map();
async function call(path, { method = 'GET', body, who = 'a' } = {}) {
  const cookie = (jars.get(who) || []).map(c => c.split(';')[0]).join('; ');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) jars.set(who, [...(jars.get(who) || []), ...set]);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

function newestOutbox(after) {
  const files = readdirSync(OUTBOX)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ f, m: statSync(`${OUTBOX}/${f}`).mtimeMs }))
    .filter(e => e.m >= after)
    .sort((x, y) => y.m - x.m);
  if (!files.length) throw new Error('no outbox file written');
  return readFileSync(`${OUTBOX}/${files[0].f}`, 'utf8');
}

async function signUp(email, who) {
  const start = Date.now() - 2000;
  const reg = await call('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, over18Attested: true }, who });
  ok(`register ${email}`, reg.status === 200, `status ${reg.status} ${reg.data && reg.data.error || ''}`);
  if (reg.status !== 200) return null;
  const mail = newestOutbox(start);
  const code = (mail.match(/^\s{4}(\d{6})\s*$/m) || [])[1];
  const ver = await call('/api/auth/verify-code', { method: 'POST', body: { email, code }, who });
  ok(`confirm ${email} with ${code}`, ver.status === 200 && ver.data && ver.data.signedIn === true, `status ${ver.status}`);
  const login = await call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD }, who });
  ok(`sign in ${email}`, login.status === 200, `status ${login.status}`);
  return login.status === 200;
}

const meta = (await call('/api/meta')).data;
const byShort = new Map(meta.institutions.map(i => [i.shortName, i]));
const cput = byShort.get('CPUT');
const northlink = byShort.get('NORTHLINK');
const uct = byShort.get('UCT');
const stamp = Date.now();

console.log('\n[1] the CPUT form: faculty from the institution list, two ranked preferences');
if (!(await signUp(`mi5-cput-${stamp}@mycput.ac.za`, 'a'))) process.exit(1);

// Exactly what Profile.jsx builds in onSave().
const payload = {
  faculty: cput.faculties[1],
  year: meta.years[1],
  gender: meta.genders[0],
  lookingFor: meta.lookingFor[0],
  age: 21,
  revealName: 'Mi5',
  interests: meta.interests.slice(0, 3),
  prompts: [{ prompt: meta.prompts[0], answer: 'I would rather cook badly for friends than eat well alone.' }],
  preferredInstitutions: [{ institutionId: uct.id }, { institutionId: northlink.id }],
};
const save = await call('/api/profile', { method: 'PUT', body: payload, who: 'a' });
ok('save posts a valid payload', save.status === 200, `status ${save.status} ${save.data && save.data.error || ''}`);

const read = await call('/api/profile', { who: 'a' });
const p = read.data.profile;
ok('read back 200', read.status === 200);
ok('institution comes back as an object with a faculty list', p.institution && p.institution.shortName === 'CPUT' && p.institution.faculties.length === 6,
  p.institution && `${p.institution.shortName}, ${p.institution.faculties.length} faculties`);
ok('faculty stored as chosen', p.faculty === payload.faculty, p.faculty);
ok('ranks follow the order the form sent', JSON.stringify(p.preferredInstitutions.map(e => e.rank)) === '[1,2]',
  JSON.stringify(p.preferredInstitutions));
ok('preferences map back to the ids in order', p.preferredInstitutions.map(e => e.institutionId).join() === [uct.id, northlink.id].join(),
  p.preferredInstitutions.map(e => e.institutionId).join());
ok('no campus field anywhere in the answer', !JSON.stringify(read.data).includes('campus'));
ok('meter arithmetic matches the server', p.matchable === true && p.missing.length === 0, JSON.stringify(p.missing));

console.log('\n[2] a client that restates its institution is ignored, not trusted');
const forged = await call('/api/profile', {
  method: 'PUT',
  body: { ...payload, institutionId: northlink.id, faculty: cput.faculties[1] },
  who: 'a',
});
const after = (await call('/api/profile', { who: 'a' })).data.profile;
ok('save still 200', forged.status === 200, `status ${forged.status}`);
ok('institution still CPUT', after.institution && after.institution.shortName === 'CPUT', after.institution && after.institution.shortName);

console.log('\n[3] the refusals the form must surface');
const badFaculty = await call('/api/profile', { method: 'PUT', body: { ...payload, faculty: 'Sailing' }, who: 'a' });
ok('a faculty off the institution list is refused', badFaculty.status === 400, `${badFaculty.status}: ${badFaculty.data && badFaculty.data.error}`);
const tooMany = await call('/api/profile', {
  method: 'PUT',
  body: { ...payload, preferredInstitutions: [uct, northlink, byShort.get('UWC'), cput].map(i => ({ institutionId: i.id })) },
  who: 'a',
});
ok(`more than ${meta.minimums.maxPreferredInstitutions} preferences refused`, tooMany.status === 400, `${tooMany.status}: ${tooMany.data && tooMany.data.error}`);
const withOwn = await call('/api/profile', {
  method: 'PUT',
  body: { ...payload, preferredInstitutions: [{ institutionId: cput.id }, { institutionId: uct.id }] },
  who: 'a',
});
const own = withOwn.status === 200 ? (await call('/api/profile', { who: 'a' })).data.profile : null;
ok('own institution spends no slot', withOwn.status === 200 && own && own.preferredInstitutions.length === 1
  && own.preferredInstitutions[0].institutionId === uct.id,
  `${withOwn.status} ${own && JSON.stringify(own.preferredInstitutions)}`);

console.log('\n[4] the suggestion card a student with preferences is shown');
const s = await call('/api/matches/suggestion', { who: 'a' });
ok('suggestion 200', s.status === 200, `status ${s.status}`);
const card = s.data && s.data.suggestion;
if (card) {
  ok('card carries an institution string', typeof card.institution === 'string', JSON.stringify(card.institution));
  ok('card carries no campus key', !('campus' in card));
  ok('card is addressed by a sealed token only', Boolean(card.token) && !('userId' in card) && !('profileId' in card));
  ok('card leaks no age, gender or city', !('age' in card) && !('gender' in card) && !('city' in card));
} else {
  ok('a card was available to prove', false, `status ${s.status} ${JSON.stringify(s.data).slice(0, 160)}`);
}

console.log('\n[5] the free-text faculty branch (an institution with no list)');
if (await signUp(`mi5-nl-${stamp}@northlink.ac.za`, 'b')) {
  const free = await call('/api/profile', {
    method: 'PUT',
    body: { ...payload, faculty: 'Hospitality and Tourism', preferredInstitutions: [{ institutionId: cput.id }] },
    who: 'b',
  });
  ok('a typed faculty is accepted', free.status === 200, `${free.status}: ${free.data && free.data.error}`);
  const bp = free.status === 200 ? free.data.profile : null;
  ok('typed faculty stored as typed', bp && bp.faculty === 'Hospitality and Tourism', bp && bp.faculty);
  ok('its own institution list is empty', bp && bp.institution && bp.institution.faculties.length === 0,
    bp && String(bp.institution.faculties.length));
  const clue = await call('/api/profile', { method: 'PUT', body: { ...payload, faculty: 'find me at 0821234567' }, who: 'b' });
  ok('the contact guard reaches a typed faculty', clue.status === 400, `${clue.status}: ${clue.data && clue.data.error}`);

  const del = await call('/api/auth/account', { method: 'DELETE', body: { password: PASSWORD, confirmText: 'DELETE' }, who: 'b' });
  ok('cleanup: northlink account deleted', del.status === 200, `${del.status}`);
}

const delA = await call('/api/auth/account', { method: 'DELETE', body: { password: PASSWORD, confirmText: 'DELETE' }, who: 'a' });
ok('cleanup: cput account deleted', delA.status === 200, `${delA.status}`);

console.log(`\n${failures.length ? 'FAILURES:\n - ' + failures.join('\n - ') : `ALL PASS (${pass} assertions)`}`);
process.exit(failures.length ? 1 : 0);
