<<<<<<< HEAD
# Unmask

An anonymity-first matching site for students. You match on interests and
honest prompt answers, chat without names or photos, and identity unlocks only when
**both** people agree to a reveal.

CPUT is the pilot, not the boundary: the colleges that may register, the email domains
that prove a student and the faculties each one offers are rows in one collection, and
adding a college is a staff member filling a form — no redeploy, no edit to this
repository (NFR-SCALE-1).

The specifications live in `PLAN\`:
`PLAN\DOCUMENT\unmask-requirements.md` (every FR and NFR by ID),
`PLAN\DOCUMENT\unmask-project-brief.docx`, `unmask-file-architecture.docx`,
`unmask-work-breakdown.docx`, and the approved design in
`PLAN\DESIGN\unmask-v2.html`.

---

## What this build does today

**Stages 1 to 8 — the site, a real account, the profile everything is matched on, the
one suggestion at a time, the anonymous chat two matched students share, the mutual
reveal that ends the anonymity when both of them agree, the safety layer over all of
it — reports, blocks, and a staff queue that has to say what it did — the bell that
tells a student something happened while they were not looking, with the three switches
that let them say less, the platform-wide numbers a staff member can read without opening
any individual student's life, and the two levers that let staff decide both who counts
as a student at all — a decision the student is told about, in the deciding
staff member's own words, the next time they try to sign in — and which institutions exist,
with what domains, what faculties, and whether each one is taking students. Then stage 9:
the response headers and rate limits that stop a shared library computer from keeping a copy
of you, the two rights POPIA gives a student over their own record — read it, or have it
erased — both of which are now buttons on their own account screen, answered out of one
list, and the accessibility pass, where every colour, every focus ring and every target on
every screen was measured rather than looked at. And 9d, the last of it: the same API
serving the built site so one process holds one idea of who is signed in, the eight
production-only boot gates that refuse to start a server on a configuration that would
leak or lock, a backup that is only believed because a restore was run against it and the
words it brought back were read, and a `deploy\` folder rehearsed as an actual stack on
this laptop.**

| Working | Not built yet |
|---|---|
| MongoDB in Docker, with a password of its own | |
| `GET /api/health` — honest readiness, never a secret or a path | |
| `GET /api/meta` carries the institutions, each with its own email domains and faculty list, plus years, genders, 20 interests, prompts, the five appearance lists (body type, height band, drinking, smoking, the gym) and the one identity list, the account rules, and the ceilings the profile routes enforce | |
| Sign up with an address at an institution Unmask knows (`@mycput.ac.za` and `@cput.ac.za` today, whoever staff add next), 18+ attestation, emailed confirmation link | |
| Sign in, sign out, "who am I" — session cookies, not tokens | |
| Eight wrong passwords lock an account for 15 minutes | |
| Forgot password → emailed link → new password, and every old device is signed out | |
| Change password from inside the account, and delete the account with everything in it | |
| The profile builder at `/profile`: which institution you are at — read off the address you verified, never a field you fill — faculty from that institution's own list, or a box to type when it keeps no list, year, who you are, who you are looking for, age, interests as chips, three prompt answers, up to three other institutions ranked, and a completion meter that names what is still missing | |
| **Twelve optional answers about what you look like and what you are after**, on the same form: how you describe yourself, your body type, your height band, whether you drink, smoke or go to the gym, and then the same five as "I am after …" lists — up to three picks each — plus one free-text sentence about your type. Every one of the twelve can be left empty: none of them appears on the completion meter, and none of them is a minimum for matching | A pick list is a chip picker with a ceiling the server enforces, not a suggestion: asking for a fourth body type is refused with the number in the message, and the form counts chips against the same `minimums.maxPicks` the API reads |
| One optional photo, re-sized in your own browser, stored where no URL reaches it, replaceable and deletable | |
| **Race is said, never sorted.** The "I describe myself as" line is the one field on a profile that the matching engine is forbidden to read: it is in no projection `services/matching.js` loads, there is deliberately no matching "I am after …" list for it in `/api/meta`, and no vocabulary key a client could invent one from. A student writes it, sees it on their own profile, and it reaches another person only on `/chats/:id/reveal` after both yeses | Three guards say so rather than a comment: the loaded-field set is asserted not to carry the key, three students who differ only in that line come out with identical scores, and a scan of the suggestion card, the report excerpt, the report document and the staff payload fails the run if a race word appears in any of them. What it costs is honesty — a student who wants to date within their community cannot ask for it, and that is the chosen trade, not an oversight |
| A profile that mentions a phone number, an email, a link, an `@handle` or "whatsapp" is refused, with the reason said out loud — and the same guard runs over the new free-text sentence about your type, because a box that reads as the friendly one is exactly where a contact detail gets left | |
| `/match`: one suggested student at a time, scored on shared interests, age closeness, same city, faculty, year, where their college sits in the list you ranked, and — as a small lift only — how well their body type, height band and drinking/smoking/gym answers fit the lists you filled in, with **Show another** and **Start chatting**. The card carries their own line of appearance answers and their "after" picks, so what somebody asked for is on the card and not in a filter you cannot see | The look-like weights add 3, 2 and 1 point and cannot take one away: an answer you did not pick moves a card up a little or leaves it exactly where it was, and never removes a person. `services/matching.js` is proven to be unable to see the race line at all — the field is in no projection it loads |
| A decline that hides that person for 30 days and then lifts itself, and a connection that hides the pair from each other for good | |
| `/chats`: every thread you have ever opened, each one labelled by year, faculty and institution only, and marked closed where it is closed | |
| `/chats/:id`: the thread itself, live over a WebSocket that rides on the same session cookie — a message the other student sends appears without a refresh | |
| The same send over plain HTTP when the socket is down, so a lecture-hall connection costs a fraction of a second rather than a broken screen | |
| **End chat**: both halves are told the conversation closed, and neither is told who closed it or why | |
| **Clear my copy**: this screen empties and says so, while the other student's copy keeps every word | |
| A long history that pages backwards without losing a line, even when two messages land in the same millisecond | |
| Nothing on the chat wire names anyone: no account id, no email, no photo — and no typing indicator, "seen" tick or online dot either, because each of those is a timestamp about one person | |
| **Ask to reveal**, once you have sent three of your own messages in that thread — a rule the API enforces, not just a hidden button | |
| The other student answers **yes** or **not yet**, and the one who asked can **cancel** before an answer arrives; a no ends nothing but the request, and the chat and every message stay | |
| Two consents stored as two timestamped rows on the pair, so "did they *both* really say yes, and when" is answered from the data | |
| `/chats/:id/reveal`: the name, the photo, the interests and the prompt answers, plus the appearance table — body type, height, drinking, smoking, the gym, what each of them was after, the sentence about their type, and the one line describing who they are — and nothing on that screen can be fetched until the pair's own row carries both yeses | The race line reaches another student in exactly one place, on this screen, after both yeses. It is on no suggestion card, in no message, in no report excerpt and in no staff payload, and there is no preference list for an institution's `identity` vocabulary to fill |
| **One optional reveal name** on the profile: what other students see *if* you both agree. It is never used to match you and never shown before the second yes | |
| A pair that presses ask at the same moment reveals without either of them being asked twice, and a reveal cannot be taken back | |
| **Report** on a suggestion card, a profile, one prompt answer, one chat message or a revealed photo — from the screen showing it, and the server builds the evidence copy itself rather than trusting what the browser sent (FR-6.1) | |
| **Block** the student behind a card, a thread or a reveal: their profile stops appearing, their requests to reveal are refused, an open thread closes looking exactly like an **End chat**, and nothing tells the other person they were blocked (FR-6.2) | |
| A block listed on `/account`, liftable in one press — and lifting it does **not** reopen the conversation that ended | |
| `/staff`: the waiting queue, what each report was about, and the exact words that were reported, tabbed into waiting / actioned / dismissed / everything (FR-6.3, FR-6.5) | |
| Four decisions a staff member can make — dismiss, remove content, suspend, ban — each of which writes the report row, the thing it touched, and an audit entry, and each needing a note before it will save | |
| A profile put on hold disappears from matching and tells **its own owner** why, in the staff member's words, the next time they open it; editing and saving is what releases it (FR-6.4) | |
| A banned or suspended student has every open thread closed by the system, with a `threads.closed` row saying so and no name attached to it (FR-6.3, FR-6.5) | |
| An account record showing one student's reports and their log, reachable only from `/staff` — and their photo, which no staff screen displays until someone presses for it, and which is served `no-store` with a `photo.viewed` entry written as it goes out | |
| A student who types `/staff` gets the same "No such page" as any other address that does not exist, because the API answers that way rather than with a "not allowed" it would have to mean | |
| **Bell** in the navigation: an unread count that moves the second the thing it counts happens, without a reload, and a `/notifications` list whose rows open the chat they came from (FR-7.1 to FR-7.3) | |
| Three notices, and only three: a new message, somebody asking to reveal, and a reveal that finished. A **not yet**, a cancelled request and an ended chat say nothing, because a bell that rings when someone turns you down is worse than the small convenience of it | |
| A thread that is on your screen is not news: the message arrives in the chat itself and writes no notice, and the moment you leave the next one does tell you (FR-7.2) | |
| No notice carries a name, an email, an account id or a quote — the sentences live in the API and no caller can put a string into one, because a notice is the only place this site pushes words at someone who is not looking | |
| Someone new entering your pool is a nudge, said once: a second change while the first is unread is not a second row, and re-typing your interests tells nobody, because interests decide what a card says, not who is shown it (FR-7.1) | |
| Three switches on `/account` — the in-app bell, email copies, and new-match nudges on their own — read afresh on every event, so a switch thrown in the last second counts (FR-7.4) | |
| An email twin that exists only because you asked for it: off by default, one mail per event, naming nobody in its body, and saying so to the reader | |
| A suspended account is told nothing in either channel, and deleting your account deletes the bell with it — the count that went is reported back, so "everything" is checkable (FR-1.6, NFR-3.5) | |
| **Platform numbers** on `/staff`: 52 figures in seven groups plus a 14-day table — accounts, profiles, matching, reveals, conversation, safety, notices — and every one of them a count. No name, message, photo, email address or account id appears anywhere in the payload or on the panel (FR-8.1) | A breakdown of any of those figures by faculty, institution or year. At this site's size a cell of one student *is* that student, and this screen writes no audit row — the queue and the account records are where a person is looked at |
| The match rate and the reveal rate are printed next to the counts they came from, and the panel shows the three sentences naming each denominator instead of hiding them in a tooltip — including the honest one: the engine keeps no count of **Show another** presses, so the match rate is a rate over the decisions still on file | |
| **The eligibility lever** on an account record: **Verify student status** and **Revoke student status**. Revoking needs a reason first — the button stays dead while the box is empty — pauses the account, signs it out of every device, takes it out of everybody's match pool, and shows that same sentence to the student when they next try to sign in, so a decision they cannot read the reason for is not one they are left with (FR-8.2) | This is not a fifth moderation button. Suspensions from a report are a different question — conduct — and verifying a student never lifts one of those: the pause a report decided stays until a staff member decides otherwise, which is the one guard in this feature that was proven by breaking it |
| Student status lives on the account as one field with three values (`attested`, `verified`, `revoked`), so "is this person allowed to be here" is still asked of exactly one place in the database — and both counts of it appear on the numbers panel, where a revocation shows up as `student status revoked` beside the `suspended` it caused | There is no document check and no upload a staff member can look at. The status records *a staff member decided, and said why*; it cannot record that they were right |
| **The `institutions` collection is the eligibility rule.** One query answers "may this address register": the domain, on a document that is switched on. A college a staff member adds is, from the moment its row is written, a college students register at, a name on each other's cards, a place a preference can rank — nothing restarts, and the test that proves it goes through HTTP rather than a seed script (NFR-SCALE-1, MI-1, MI-2). It was then proven twice more by hand, in a browser, against the built site: two colleges added over HTTP were registered at, resolved to, and named on a suggestion card scored 86 within the same minute, a student at one ranked the other and its card rose to 94, and a staff account at `/staff` added "Browser Panel Polytechnic", watched the sign-up sentence name it seconds later, then switched it off and watched it leave `/api/meta` — with every account, card row and college from that run erased afterwards | Nothing in the client names a college: `npm run build` runs `scripts/no-institution-names.js`, which fails the build when any name, short name or email domain from the API's own seed appears in shipped copy. It caught the case it was written for by being run against a planted string, not by being trusted. And the product has no delete for a college, on purpose — a row a staff member switches off keeps its students' profiles — so the college that run created was removed from the database by hand, which is the one move here that is not a product feature |
| **Institutions** on `/staff`: add a college with its name, short name, type, city, email domains and faculty list, edit any of it, and **switch it off** — which takes new registrations and suggestions away while every account already there keeps its sign-in, its profile and its conversations (MI-4) | There is no delete, and that is deliberate: a college with students in it cannot be un-typed, only stopped. And every domain except CPUT's two in the seed was written down by somebody who could not check it — a wrong one fails safe (nobody from there registers, and the request form catches the complaint), but staff read the live list, not a spec |
| **One domain, one college.** A staff member handing `mycput.ac.za` to a second institution is refused with the short name of the college that already owns it, because "whose student is this" cannot have two answers — and every add and edit writes an audit row naming the staff member, the college and the domain (MI-1) | The uniqueness is enforced on the domains a document holds, not on look-alikes: `cput.ac.za` and `cpuf.ac.za` are different rows, and nothing but a person reading the list tells a typo from a new college |
| **"Don't see yours? Request it."** on the sign-up page takes a name, a city and one optional line, and says plainly that the answer is the list on that page, not an email. A phone number, an address, a link, an `@handle` or another app's name in it is refused with the reason out loud, and five requests an hour per address is the whole defence a write from a stranger has. Staff read the queue grouped by name with a count, so "which college next" is one glance (MI-4) | Nothing answers a request automatically, and nothing can: the box holds no way back to the person who filled it in, which is the point. Until a staff member adds the college, the requester sees the same list they saw before |
| **Every response says what it is**: a strict content security policy, `nosniff`, no framing, same-origin resource policy, no referrer, no camera/microphone/location permissions, and `Cache-Control: no-store` — on the 200, and on the 401, the 404 and the 413 that never reach a route at all. A student's profile, their messages and the mere fact that an address is in this database are not things a library computer keeps a copy of (NFR-2.1 to NFR-2.3) | `Strict-Transport-Security` is deliberately absent until the deployment is actually HTTPS: promising it over a plain development port would make a browser refuse its own localhost for a month afterwards. It appears the moment `NODE_ENV=production` |
| **A client cannot choose which rate-limit bucket it spends.** `X-Forwarded-For` is believed only when `TRUST_PROXY_HOPS` says a proxy is writing it — otherwise a guesser simply names a new address per attempt, which is exactly what the probe that opened this hole did twelve times in a row | Behind a real host, leaving `TRUST_PROXY_HOPS` at 0 makes every student arrive as one address, so one busy person could lock the site out of logging in. The setting has two right answers depending on the network, and `.env.example` says which is which |
| **A Mongo operator in a request body reaches no query.** Login, register, forgot, reset, pass, connect, mark-read, settings and profile-save are each fired with `{"$ne": null}` in their one field, and the database is read afterwards: no session issued, no account made, no conversation opened, no password changed, no unread notice silently marked read, no profile field rewritten | This is a standing test, not a filter. Nothing strips `$` from a body — every door already coerces what it is given, and the test is here so the day a new route forgets to is a red run rather than a hole |
| **Suspicious behaviour leaves one line in the server log** when a limiter is first crossed, naming the bucket and a salted fingerprint of the address — never the address itself, because an address is personal data and a log file is the one place in this project with no deletion path (NFR-2.5) | It is one line per window, not a ledger: a client hammering an endpoint cannot use the log as a write amplifier. There is no dashboard and no alerting, and the retention is a ceiling rather than a history: `deploy\docker-compose.prod.yml` sets `logging:` to `json-file`, `max-size: 20m`, `max-file: 5`, so the line survives on a server for as long as the process writes 100 MB of anything and is then dropped, unrecoverably, by Docker. |
| **Download everything we hold about you**, on `/account` and at `POST /api/auth/export`: one JSON file holding the sign-in record, the profile — with the whole appearance block in it, race line included, because that is the one copy of it a student is ever handed — every conversation with every message in it, the suggestions declined, the blocks made, reports in both directions, notices and log entries. It asks for your password, because the secret behind that door is the same size as the one behind deletion, and it writes nothing — no row, no "you exported" event (NFR-3.1) | There is no emailed copy and no hosted archive: the file exists only in the moment you asked for it, in your own downloads. A student who cannot reach a browser — or a paper request someone else has to answer — still has to sit at their own signed-in session; no route lets a second person collect it for them |
| **The access file and the deletion promise read from one definition of "yours".** `eraseDataFor` keeps no filter map of its own: both rights call `ownData`, and the test asserts the per-collection counts the file reports *equal* the per-collection counts the deletion reports afterwards, down to the one photo file removed from disk (NFR-3.1, NFR-3.5) | A collection added to the database later has to be added to `User.dataCollections` and given a filter, or deletion falls back to matching on `userId`/`userA`/`userB` and that equality assertion goes red. That is deliberate: the guard is a tally, not a list of names someone has to remember to extend |
| **Nobody else appears in your file.** Each peer is the words `(another student)`, each staff actor `(a staff member)`, an automated thread-close `(the system)`, and whoever reported you is not named even to you. Blocks made *against* your account are listed nowhere while still being deleted, because a block's entire design is to read as an ended chat (FR-6.2, NFR-3.3). Seven lines at the end of the file name every omission and the reason for it | The redaction is not a courtesy: an id is anonymous only until somebody pastes the file into a support email, and an id is the one thing in here this database can join straight back to a person. Message bodies of the other student *are* included, because a thread you were in is your copy too |
| `/privacy` and `/terms`, readable with no account and no cookie: what is collected and why, who can see what at each stage of a match, what a report does to the other person's copy, the four things staff can actually decide, and each right named as the button that exercises it. Linked from the footer of every screen and from the line under the 18+ box on `/signup` (NFR-3.4, NFR-8.3) | No version history — one "written for this build" date line, and no record that anyone read either page. The signup line is a link, not a second attestation: a checkbox the API cannot produce later is a claim, not a record |
| **Six downloads an hour per address.** The export door is rate-limited like the dangerous ones, and the sixth crossing writes the same single salted-fingerprint log line as a guessed password | The budget is per address, so behind a campus NAT it is six an hour for the whole building unless `TRUST_PROXY_HOPS` is set for the real proxy — the same two-right-answers problem as every other limiter here. `deploy\docker-compose.prod.yml` ships `TRUST_PROXY_HOPS=1` because it assumes the proxy in `deploy\`, and "What 9d does not do" below names what that still costs a whole residence hall on one address |
| **The site read by measurement, not by eye.** Every colour pair written into `unmask.css` is checked against WCAG 2.1 AA in both schemes by `npm run a11y` — 293 declaration blocks, 16 named pairs, the cascade re-layered the way a browser layers it — and the result is re-proved in a live browser across 14 routes and both schemes: 199 focusable controls, 0 rings under 3:1, 0 text nodes under their own threshold, 0 unnamed controls, 0 images without alt, one `h1` and 0 heading jumps per page, a `main`, a `nav` and a `footer` on every screen (stage 9c, NFR-4.1 to NFR-4.3) | No accessibility *scanner* is wired in — no axe, no Lighthouse. The numbers come from reading computed styles off real DOM nodes in Chromium, which is stronger than a stylesheet guess and weaker than a scanner's rule set. And nobody has read this site aloud: how the reveal announcement sounds in a screen reader is manual review, still open |
| **One keyboard ring, and every band that repaints itself says which ring its controls wear.** A focus outline is drawn *outside* the control, so the colour it has to beat is the surface behind it — which is why `:focus-visible` reads `var(--ring)`, and why the seven bands that paint their own fill (the footer, the blue ask-to-reveal panel, the ink reveal stage, the finished-pink one, the quiet variant) re-declare it for whatever sits inside them. Found by this pass, not before it: the page ring on a dark card measured **2.81:1** and the same ring on a saturated blue panel **1.00:1** — a keyboard user had no visible focus there at all | The guard can only judge a band that spoke: a rule that paints itself a colour and holds controls without re-declaring `--ring` is invisible to a stylesheet read, and is caught by the live sweep instead. There is also no in-app theme switch — `:root[data-theme]` exists purely so a scheme can be forced for measurement |
| **Nothing you press is smaller than a thumb, and nothing is lost at a third of a window.** Every button, chip, nav link, wordmark, footer link and the chat box carry a 44 px minimum; the two links inside sentences in `/privacy` grew to that by padding rather than by type size, because a mid-sentence link is exempt from the rule and is still not a 44 px block. At a 320 px viewport the widest page in the build measures **305 px**: no horizontal overflow anywhere, at either scheme, on any route | 44×44 is WCAG 2.2's *AAA* target, not its AA gate — what AA asks (SC 2.5.8) is 24 px. The 44 px floor here is the project's own NFR-4.2 promise, so a future reviewer checking the letter of AA will find a stricter build than AA requires, by choice |
| The landing page, transcribed from the approved design, at `http://localhost:5273` | |
| **`npm run a11y` is a standing check, not a one-off report.** It reads `unmask.css`, resolves every `var()` through the token blocks, and fails the run when any declared pair falls under AA in *either* scheme — including the pairs no single rule writes down, where one rule sets a colour and an earlier, narrower rule sets the background under it. Proven non-vacuous by re-breaking it twice: setting a band's ring back to `var(--blue)` failed the run at 1.00:1, and setting the page's ring back failed it at 2.81:1 in the dark scheme | It judges what is *declared*. 47 rules set a colour with no background of their own and are only answerable in a browser, so they are left to the live sweep rather than guessed at from the file |
| **One process, one idea of who is signed in**: `npm run build`, then `SERVE_WEB=1` and the API answers `/`, every client route, the hashed assets and the four self-hosted font files — no request leaves a browser for a font, a CDN or an analytics script. The page policy and the API policy are **different strings on purpose** (`default-src 'self' … connect-src 'self' ws: wss:` for the site, `default-src 'none'` plus `no-store` for `/api` and `/ws`) and a test asserts they are not equal, so neither half can quietly take over the other; a hashed file may be cached for a year while the un-hashed fonts get a week; a path that matches no file 404s instead of being handed `index.html` with a 200; and a page route answers GET and HEAD and refuses to be a POST (stage 9d) | A client route the server has never heard of still gets the app, because that is what a single-page site has to do — so a mistyped *page* address is a blank screen that reads 200. Only the API's unknown paths answer with the "no such page" that carries the safe headers |
| **Eighteen configuration refusals, ten of them production-only**: an http `PUBLIC_APP_URL` (the session cookie is `Secure`, so every login would look like a wrong password), an http entry anywhere in `WEB_ORIGIN`, the site served at an origin the socket handshake will not accept — the failure where chat is silently dead and nothing else looks broken — no SMTP, the template database password still in place, `PHOTO_DIR` inside the served build, `DEV_AUTO_VERIFY` on (see "Where the emails go while you are developing"), `TRUST_PROXY_HOPS` unset or not a whole number, `SERVE_WEB` on with nothing built, a `SESSION_SECRET` empty or under 32 characters, an empty `MONGO_URL`, an SMTP host with no credentials, a `PHOTO_STORE` that is neither `disk` nor `r2` (a store that fell back to disk by itself would put the pictures back on the machine that was meant to stop holding them), `PHOTO_STORE=r2` with any of its endpoint / bucket / access key / secret missing, an http `R2_ENDPOINT` (every read and write signs itself with `R2_SECRET_ACCESS_KEY`, so an unencrypted line would carry the signature of somebody holding the whole bucket), and no `.env` at all with nothing supplied by the environment. `/api/health` reports which store is live and whether it answered, so a photo problem says so somewhere other than as a blank profile. Proven in both directions: a correct production config boots and says nothing, and the *same* keys under `NODE_ENV=development` do not borrow the production gates (stage 9d) | A gate can only refuse to start. Nothing watches a running server: `restart: unless-stopped` is the whole of the supervision, and there is no alerting of any kind. All eighteen sentences are proven to fire in `test\boot.test.js`, including the last one, which is reached by holding `fs.existsSync` down for this project's own `.env` path — so the developer's real file is never moved or read: both keys missing, only `SESSION_SECRET` missing, and a complete environment with no file, which must say nothing. That last gate's advice was also wrong for a platform host until now — on Render, Railway or Fly, or inside the shipped image, there is no `.env` to create, so the refusal names both routes: copy `.env.example` on a laptop, set the missing keys as environment variables in the host's dashboard |
| **A backup is believed because it was restored.** `npm run backup` writes `<stamp>-<db>/` holding `archive.gz`, `photos/` and a `manifest.json` that counts every collection *before* anything is compressed and records which store the photos came from; `npm run restore --into <other-db>` reads it back, and refuses to write over the database the backup came from, to run with no `--into`, to trust a folder this tool did not write, or to restore bytes that do not match the manifest's hash. `--keep N` prunes the older folders, and photos come back by one of two flags — `--photos-into <folder>` for a disk restore, `--push-photos` for a bucket, which checks every name against what the bucket already holds *before* writing any of them. Against a container both tools stream through `docker exec`, so the archive never has to sit anywhere a password can be guessed at; a hosted database has no container here, so `MONGODUMP_BIN` points at an installed `mongodump` and the same code runs against `MONGO_URL` directly. The whole thing was run against the real 98-document database, then a student was signed in through the restored copy and the source was read back to prove it never saw that write (stage 9d, NFR-5.2) | mongorestore 100.18 exits **0** having restored **zero documents** unless `--nsInclude` names the source database: the rename flags alone match nothing, and "success" is the sound of an empty room. Found by running both spellings by hand; `restore.js` carries the flag and the sentence explaining it. The hosted half of this has been read and unit-proven against an Atlas-shaped connection string, never run against a real Atlas |
| **`deploy\` is the shape of a real server, and was rehearsed as one**: a two-stage Dockerfile that builds the site and then throws the toolchain away, so the runtime image holds `api/` and `web/dist/` and nothing else; a production compose file that takes its `MONGO_URL` from `deploy\prod.env` and starts a database of its own only when asked — resolved both ways, one service by default and two with `--profile local-db`, the container publishing **no port** either way — while the API binds `127.0.0.1:`, so the only way in is through a proxy; named volumes for the data and for the photos, the second unused once `PHOTO_STORE=r2`; a `/api/health` healthcheck the API has to pass before the site starts; `init: true` with a 15-second grace period so a closing chat socket gets its goodbye; and Caddy and nginx configs that pass `Upgrade`, turn off `proxy_buffering` and raise the body limit to 10 MB so a live thread and a photo survive the hop — with both saying out loud to set **no** CSP and no HSTS in the proxy, because those belong to the app (stage 9d) | The rehearsal reached the API on loopback, so the TLS half of those proxy configs was written and read and never carried a byte. And none of this is *on* a server: the first real deployment will be the first time `NODE_ENV=production` meets a network |
| | **A load test.** **NFR-1.3** (2,000 concurrent students) has never been measured — the most this build has held is one rehearsal stack and one browser. **NFR-6.1** (matching and messaging scaled independently) is not met, and that is a decision, not an oversight: the chat runs inside the API process on `ws`, which is what the file-architecture document's separate Python chat service would have bought instead. Both limits are restated under "What 9d does not do" | |
| 238 automated tests across 19 files, with the safety guards proven to fail when the rule they guard is broken — including twelve that were checked by deliberately re-breaking them: a socket that stops answering the heartbeat, a history page that loses a line, a reveal door mutated to let a single consent through, a bell that rings for a thread already on screen, a statistics panel asked to call an empty database a 0% match rate, a **Verify student status** mutated so that it undid a suspension a report had decided, the response-header middleware taken off the front of the app, `trust proxy` set back to 1 so a forged `X-Forwarded-For` bought a fresh login budget, the export's block filter widened to `filter(block => true)` so the data file named a block made *against* its own requester — which failed two subtests, one on the redaction and one on the access/deletion tally — and the copy guard, which was proven by typing a real college's name and its two email domains into a page and watching `npm run build` fail with all three named and an exit code of 1. The eleventh re-broken one is the race line on a staff card: writing `identity: 1` into the projection in `src\services\staff.js` and onto the card made the queue subtest fail, and the service was then put back. The twelfth is a database password in an error message: `scripts\backupLib.js` was set back to interpolating the raw `MONGO_URL` into its "names no database" refusal, and the subtest failed on exactly that word — the string Atlas prints is the one most likely to trip the refusal, and its password is in it. The rest of what the appearance answers brought are **outside** guards — assertions on what a suggestion card, a report excerpt, a staff payload and the matching projection do or do not carry, including that no race word appears in any of them and that three students differing only in that line come out on the same score | |

The `/signup`, `/login`, `/forgot`, `/reset`, `/verify`, `/profile`, `/match`, `/chats`,
`/chats/:id`, `/chats/:id/reveal`, `/me`, `/notifications`, `/account` and `/staff` screens
all work now — the last one only for a staff account. `/privacy` and `/terms` work with no
account and no cookie at all. `/me` shows
what an account holds — an email address, and a profile whose only name-like field is the
reveal name you chose and can leave empty — and links to the profile that sits beside it.

### Where the emails go while you are developing

`SMTP_HOST` is empty by default, so nothing can be sent. Instead of failing quietly,
the API writes each email to `api\outbox\` as a text file with the link in it, and the
account stays unverified until someone opens that link. Nothing skips that on a server
someone else uses: an unverified account cannot sign in, and if `NODE_ENV` is
production the API refuses to start until a real `SMTP_HOST` is configured.

That is the rule everywhere but on your own machine. `DEV_AUTO_VERIFY=1` in `.env`
removes the mailbox from the sign-up: the address is confirmed the moment the account
is created, nothing is written to `api\outbox\`, and **Create account** finishes by
signing you in and opening `/me` — no link to find, no file to open. What it does not
touch is the part that matters: a wrong password is still refused, `/api/auth/register`
still hands out no session (so typing a stranger's address buys nothing they could not
buy by reading their inbox), an address left unconfirmed from *before* you turned the
switch on is confirmed by the person who proves the password, and `NODE_ENV=test`
ignores the key entirely so no suite's result depends on your `.env`. A real server
cannot catch it: `DEV_AUTO_VERIFY` is one of the fifteen refusals above, so
`NODE_ENV=production` will not boot with it on.

Proven both ways in a browser against the built site — once with the switch on, which
landed on `/me` with an empty outbox folder, and once with `DEV_AUTO_VERIFY=0` forced
into the process, which put the "check your inbox" screen and the 403 back, with the
letter in `api\outbox\` to prove it. Eight checks in
`test\devAutoVerify.test.js`, over real HTTP, cover the same ground — including the
one this change nearly introduced: while the switch was on, a brand-new address and an
address that already had an account answered *differently*, which is an account-exists
oracle for anyone who cares to type emails and read the wording. Every exit path out of
`register()` now returns the same sentence and the same flag, whatever it just did.

To try an account without touching the outbox folder at all:

```
npm run seed
```

That writes four throwaway, already-confirmed sign-ins — `demo1@` to `demo4@` on your
first allowed domain — all with the password `unmask-demo-2026`, each with a finished
profile so `/match` has somebody to show you, and each with a reveal name (`Thando`,
`Sipho`, `Nama`, `Zanele`) so a pair that reveals shows a name instead of "no name
given". On a real profile that field is optional, and matching never reads it. Set
`DEMO_PASSWORD` in `.env` to choose your own. The seeder refuses to run in production,
and it only ever touches addresses that begin with `demo` or `staff`.

The fifth account, `staff1@` on your first allowed domain and with the same password, is
a **reviewer**: it has a role and no profile, so it cannot appear in anyone's match list,
and signing in with it is how you see `/staff`. To hand the queue to a real account of
your own instead — one you registered and confirmed by email — run:

```
npm run staff you@mycput.ac.za
```

That adds the role to an address that already exists; it is not a way to register, and a
typo there gives a queue to nobody. `npm run staff you@mycput.ac.za --revoke` hands it
back. There is deliberately no route that does this over HTTP: an admin who could mint
another admin is the shape of every privilege-escalation story.

Matching is stateful in only two ways, so a demo that has run down can be wound up
again:

```
npm run seed -- --reset
```

That runs the same sweep a student's own deletion runs, scoped to the four demo accounts:
their profiles, declines, matches, messages, blocks, reports and bell notifications, plus
the photo file behind a profile picture. Then it rebuilds the four. It is the command to
run after you have pressed **Show another** through the whole list, connected two demo
accounts while trying the screens, or left a stack of notices on a demo bell. Nothing about
a real account is touched, and the output lists which collections lost rows so you can see
it worked.

### How to try a chat

Sign in as `demo1@mycput.ac.za` in one browser window and open `/match`, then press
**Start chatting**. In a **second, separate window** — a private window, or a different
browser — sign in as `demo2@mycput.ac.za`. One browser holds one sign-in, so this is the
only way to be both students at once; it is not a bug in the site.

Type in either window and the line appears in the other within about a second, with no
refresh. Press **End chat** in one and both screens show that the conversation closed,
and neither says who closed it. Press **Clear my copy** and only your own bubbles go.

`npm run seed -- --reset` at the end puts the pair back so you can try it again.

### How to try a reveal

Keep both windows on that chat. In one of them, send until you have written **three of
your own messages** in the thread — the button under the chat counts down what is left,
and the API refuses an ask that has not waited, so the floor is a rule and not only a
hidden button.

**Ask to reveal** appears under the messages. Pressing it tells the other window, in the
same second, that somebody asked — and it does **not** unlock anything. That window now
has two answers: **Yes, reveal us** or **Not yet**. Neither one closes the chat, and the
window that asked can **Cancel the request** before an answer arrives.

Both say yes and the name, the photo and the whole profile open on both sides at once: the
header above the messages, a **See what you unlocked** band, the chat list row, and
`/chats/:id/reveal`. Until the second yes, the two routes that serve a name and a face
answer `403` for both students — that is checked from the browser and from the test suite.

A reveal cannot be undone; that is what makes it worth something. To try the flow a second
time, run `npm run seed -- --reset` and connect a fresh pair.

### How to try a report, a block and the staff queue

Open `/match` in any signed-in window. Under the suggestion, *Something wrong with this
card?* sits beside two buttons: **Report it** and **Block this student**. Press **Report
it**, pick a reason, say more if you want to, and press **Send report**. On a chat or a
reveal the panel asks one thing first — *What are you reporting?* — because that screen
shows a profile, two prompt answers, a photo and a page of messages all at once, and
"this one" has to mean something specific by the time a staff member reads it.

What gets filed is not what your browser claims. The server takes its own copy of the
profile, answer, photo or message you pointed at and stores that with the report, so the
words a staff member reads later are the words that were on screen, not a description of
them. The panel says the rest out loud: a report sends staff what was on your screen, and
it does **not** stop the other student reaching you — only a block does that. There is a
budget on it too: five reports per ten minutes and twenty a day per account.

**Block this student**, then **Yes, block them**. From a suggestion card the two of you are
simply never paired again; from a chat or a reveal the thread closes as well. The
other student is told the conversation ended and nothing more — not that they were blocked,
not by whom. On a blocked student's own screen it is byte-for-byte the same banner as an
ordinary **End chat**. Your blocks are listed on `/account`, and **Unblock** there stops
them appearing to you again without reopening the conversation that ended.

Now sign in as `staff1@mycput.ac.za` in a third window. **Staff queue** appears in the top
navigation: the waiting report, what it was about, the reason, and the captured snapshot
beside it. Four decisions, and three of them refuse to save without a note:

- **Dismiss** — nothing happened, and that is recorded too.
- **Remove content** — the profile leaves matching at once, and its owner is told why, in
  the staff member's own words, the next time they open `/profile`. Editing and saving the
  profile is what puts it back; that is a promise the screen makes out loud, and a save
  keeps it.
- **Suspend account** and **Ban account** — the account is signed out everywhere and every
  thread it has is closed by the system, with a row saying the system did it and no
  student's name attached.

On the same queue, **Their whole record** shows that one student's reports and their log in
order, and it is where a suspended or banned account is reinstated. **Open their photo**
sits there unpressed: a staff screen does not load a student's
face on its own, and when somebody does press it the image is sent with `no-store` and a
`photo.viewed` entry is written at the same moment, so "who looked, when" is answerable
afterwards.

A student who guesses that `/staff` exists gets the same "No such page" as any other
invented address. The API answers that way on purpose — a `403` would confirm the queue is
real.

**What stage 7 does not do.** FR-6.4 asks staff to remove content that breaks the rules, and
this build gives them the queue and the levers — but nothing looks at a photo before anyone
sees it. A picture is stored and shown as fetched; the only thing that catches an
identifying or indecent image is a student pressing **Report** and a person reading it. Text
is the opposite, because a phone number, email address, link, `@handle` or "whatsapp" is
refused by the contact guard while the profile is being written, so the queue is a backstop
for words rather than the first line of defence. Adding an image classifier would mean
running every student's face through a third party, which is its own POPIA question — it is
listed as a known gap for stage 9, not treated as solved.

### How to try the bell and the switches

Sign in as `demo1@mycput.ac.za` in one window and `demo2@mycput.ac.za` in a second, and get
a thread open between them the way **How to try a chat** does.

Sit on that thread in demo1's window and have demo2 write a line. It appears in the
conversation within about a second — and the **Bell** in demo1's navigation does not move.
A notice about a conversation you are reading is a duplicate of the conversation, so it is
never written (FR-7.2). Leave the thread, or press **Bell**, and demo2's next line does tell
demo1: the count in the navigation changes with no reload, `/notifications` lists *"A new
message is waiting in one of your chats."*, and pressing the row — or **Mark all read** —
clears it. That is the whole of what the other student can learn from this: nobody is told
that you looked, and nothing here is a read receipt.

**Ask to reveal** in one window and the other gets *"Someone in one of your chats has asked
to reveal themselves to you."* — that sentence, and nothing identifying, even though a name
exists on the profile that asked. Answer **Not yet** and neither bell says anything: a
request somebody turned down is not news the site pushes at them.

Now open `/account` in demo1's window. Three switches, and each one takes effect from the
next thing that happens rather than from a reload:

- **In-app bell** — off, and notices stop being written. An email you opted into still
  goes, because that is a separate channel you asked for by name.
- **Email me too** — off by default, and it stays off until a student says otherwise. Turn
  it on and the next event also writes a copy to `api\outbox\` while `SMTP_HOST` is empty.
  Open that file: it carries the same sentence the bell shows, it names nobody, and it says
  so to the reader as well.
- **Tell me when someone new fits** — the switch over the one notice nobody is waiting on.
  Off, and a profile entering your pool is silent; on, and it is said **once**: a second
  change while the first nudge is still unread is not a second row, and re-typing an
  interest tells nobody, because interests decide what a card says, not who is shown it.

**What stage 8 does not do.** There is no browser push notification and no SMS: the two
channels are the bell and the inbox, because FR-7.4 names those two and nothing else. The
new-match sweep tells at most sixty students about one profile change, and logs that it
stopped early if it does — a nudge nobody is waiting on is not worth an unbounded scan of
every profile in the database. And the unread count lives in the navigation only: it is not
put in the tab title, where it would sit in a screen share and a browser history for the
whole world to read.

---

### How to try the platform numbers

Sign in as `staff1@mycput.ac.za` (password `unmask-demo-2026`) and open
`http://localhost:5273/staff`. Press **Platform numbers** in the row of tabs at the top.

The panel opens above the queue with seven groups — Accounts, Profiles, Matching, Reveals,
Conversation, Safety, Notices — and a 14-day table underneath them. Every figure is a
count, and it is checkable against the database: press **Recount** after doing something
and the number for it moves. Send a message in a chat and *messages written* goes up by one;
file a report and *reports waiting* goes up by one; decide it and it moves into *ended in a
hold*. The table's rows are UTC days, oldest first, and the days nobody did anything are
printed as zeros rather than skipped — a gap in a table invites a story about it.

Two figures are rates, and each one is printed next to the counts it was divided out of,
with the sentence naming its denominator shown on the panel itself: the **match rate** is
chats opened over chats opened plus declines still on file, and the **reveal rate** is pairs
where both said yes over pairs ever opened. The first of those sentences carries an
admission — the engine keeps no count of **Show another** presses, so a rate over every card
shown is not a number this site can produce honestly.

Now sign in as `demo1@mycput.ac.za` in another window, type
`http://localhost:5273/api/staff/stats` into *that* window's address bar, and read what
comes back. It is the same 404 every staff route gives a student: the panel is a staff
screen, not a public one, and a figure here is the platform's shape, not anybody's business.

**What FR-8.1 does not do.** No number can be clicked into the list behind it, and none can
be broken down by faculty, institution or year. At this site's size a group of one student *is*
that student, and unlike the queue and the account records this screen writes no audit row
at all — so the door stays shut on purpose. A moderator who wants to know why a number moved
follows the reports and the log, which name who did what.

---

### How to try the eligibility lever

This is the one switch on `/staff` that answers *"is this person allowed to be here at
all"* rather than *"did they misbehave"*. It needs a student with a profile, so run
`npm run seed` first if you have deleted the demo accounts.

1. Sign in as `staff1@mycput.ac.za` (password `unmask-demo-2026`) and open
   `http://localhost:5273/staff`.
2. Press the **Everything** tab, then **Their whole record** on any row that has a student
   on it — or press a student's address on the **Accounts** tab list if you have one
   reported. The record opens below the queue and reads `Student status: attested`, which
   is what a confirmed `@mycput.ac.za` address gives you at signup.
3. Look at the two buttons under the reason box. **Revoke student status** is greyed out
   while the box is empty, and it stays greyed out until you type a sentence. That is not
   a UI nicety: the server refuses the request too, so no client can talk its way past it.
4. Type a reason — something you would stand behind, e.g. *"Checked the 2026 register and
   the faculty office. No record of this student."* — and press **Revoke student status**.
   The header flips to `suspended`, the line under it reads
   `Student status: revoked — "<your sentence>"`, the queue card for that student now says
   *account suspended*, and two rows appear in their log: `student.revoked` and
   `account.suspended`.
5. Now sign in as that student in another window — `demo3@mycput.ac.za` if you revoked
   demo3 — and try to use the site. Any open tab loses its session on the next request.
   Signing in again gives a plain 403 on the login screen:
   *"Our records no longer show you as a CPUT student, so this account is paused. Said by
   staff: "<your sentence>". Open a support request if that is wrong."* Your own account
   name never appears in that message, and nobody else can see it: only the person whose
   password just compared good reaches that line.
6. Back in the staff window, press **Verify student status** (no reason needed). The
   account returns to `active`, the sign-in works again, the student reappears in
   `/match` pools, and the reason box is cleared. Press **Platform numbers** and then
   **Recount**: *student status checked* moves up and *student status revoked* goes back
   down.

**What FR-8.2 does not do.** It is not a fifth moderation button, and it cannot undo one
that a report pressed. Verifying a student lifts only the pause this screen made: an
account a report suspended stays suspended, and signing in still says
`account_inactive`. That guard is the difference between "this person is not a student"
and "this person was rude", and it is the one question the app keeps asking of exactly one
field. There is also no evidence trail beyond your sentence — no document upload, no
verification from the registrar — so what the record proves is that a staff member decided
and said why, never that they were right.

---

### How to try the response headers

Nobody signs in for this one, and nothing needs a second window: it is about what the
API says about itself on the way out.

1. Open `http://localhost:5273` and press **F12** to open the browser's developer tools,
   then click the **Network** tab (in Chrome: the tab strip at the top of the drawer; if
   you cannot see it, press the `»` arrow).
2. Reload the page with the drawer open, click the first row whose name starts with `api`,
   and look under **Response Headers**. You will see:
   `cache-control: no-store`, `content-security-policy: default-src 'none'; …`,
   `x-content-type-options: nosniff`, `x-frame-options: DENY`,
   `cross-origin-resource-policy: same-origin`, `referrer-policy: no-referrer`,
   `permissions-policy: camera=(), microphone=(), …`, and no `x-powered-by` anywhere.
3. Now type `http://localhost:5273/api/staff/stats` into the *address bar* while signed in
   as `demo1@mycput.ac.za`. You get the same unknown-page answer as any address that does
   not exist — and if you look at that 404 in the Network tab, it carries the same headers
   as a success. That is the part most frameworks get backwards: the responses that reach
   no route are the ones a browser is most likely to render as something else.
4. Sign in as `demo1@` and open a chat. Send a message, then click its `api/chats/…` row:
   the response says `no-store`. On a shared machine, "back" and "the cache folder" should
   not be able to produce another student's words.

**What 9a does not do.** It cannot make a plain HTTP connection private — TLS belongs to
wherever this is deployed, and `Strict-Transport-Security` is withheld until that is true
(9d). It does not add a web-application firewall, an intrusion system or a dashboard: one
line in the server log per rate-limit window is the whole of the monitoring. And it does
not strip `$` from request bodies — the operator-payload test passes because every route
already coerces what it is handed, which is a rule a future route can break, so the test
is the guard.

### How to try your own data

This one is the right of access (NFR-3.1): a student asking the site what it holds about
them, and getting an answer they can read. Two windows, no database tooling.

1. Sign in at `http://localhost:5273/login` as `demo1@mycput.ac.za` with the password
   `unmask-demo-2026`, then click **Account** in the navigation.
2. Scroll to **"Download everything we hold about you"**. The button is dead until you type
   something into the password box above it — that is the whole design of the door: the file
   on the other side is the same size as the one deletion opens, so it asks for the same proof.
3. Type `unmask-demo-2026` and press **Download my data (JSON)**. Chrome saves
   `unmask-my-data-2026-09-26.json` into your own `Downloads` folder (some browsers ask
   first; the notice under the button tells you to check). The password box empties itself
   as it goes.
4. Six lines appear under the button: how many conversations, messages, declines, reports in
   both directions, notices, log entries, whether a photo is on file, and how many devices
   are signed in. Those numbers are read out of the file that just arrived, not counted
   again on the screen — so this page cannot show you a tidy total the download contradicts.
5. Open the file in Notepad. What to look for, in this order:
   - `format` is `unmask-data-export/1`, and `about` is your own address.
   - `conversations` — each one says `with: "(another student)"`, and every message in it is
     the real words, both sides, in order. You know who you talked to; the file is not the
     place anybody else finds out.
   - `profile.photo` gives size and date and no file name. The picture is on your own profile
     screen; a face does not belong buried in a text file that gets forwarded.
   - `whatIsNotInThisFileAndWhy` is seven lines, each naming one thing left out and the reason.
     Search the file for `@mycput`: your own address is there and nobody else's is. Search for
     `passwordHash` and for any 24-character id: neither appears.
6. Optional, and only if you want to see the headers a browser hides: while signed in, open
   the developer tools (F12), find the `api/auth/export` row under **Network**, and read its
   Response Headers. It says `Content-Disposition: attachment; filename="unmask-my-data-….json"`,
   `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. `no-store` matters more
   here than anywhere else in the app: a lab computer should not keep a copy of a whole
   personal record after the student closes the tab. The same door from a terminal, if you
   would rather have it — it needs the session cookie, so sign in with `-c jar.txt` first and
   send it back with `-b jar.txt`:

   ```
   curl -i -c jar.txt -X POST http://localhost:4100/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"demo1@mycput.ac.za\",\"password\":\"unmask-demo-2026\"}"
   curl -i -b jar.txt -X POST http://localhost:4100/api/auth/export -H "Content-Type: application/json" -d "{\"password\":\"unmask-demo-2026\"}"
   ```

7. The other half of the same promise, on a spare account only: press **Download my data**,
   keep the six numbers in view, then use **Delete my account** underneath and finish it. The
   API answers that deletion with a count of what it removed, collection by collection, and
   the numbers match the file line for line — including `photoFile: 1` if that account had a
   photo. The account screen signs you out before you can read that answer, so the equality is
   what the standing test checks instead (`api\test\access.test.js` asserts every collection's
   exported count against what the deletion then reports). Both rights read their idea of
   "yours" from `api\src\services\personal-data.js`, which is the only reason the two can stay
   in step. Run `npm run seed` in `C:\Users\hp\Desktop\UNMASK\api` afterwards to get the demo
   accounts back.
8. Open `http://localhost:5273/privacy` and `http://localhost:5273/terms` in a private
   window, signed out. Both render, and neither asks. They are the pages POPIA and the brief
   ask for (NFR-3.4, NFR-8.3), and the footer of every screen in the build links them.

**What 9b does not do.** It does not do anything *automatically* about a request: there is no
inbox that receives a POPIA access request, no staff screen that answers one on a student's
behalf, and no regulator-facing complaint form — the Information Regulator's own contact
details belong on the page, and this build names the office without inventing a URL. It does
not anonymise the other student's message bodies, because a thread you were in is your copy
too; it only refuses to say who wrote them beyond "another student". The export writes no log
entry, which is honest but also means there is no record that a student ever used the right —
if a request has to be provable to somebody outside the site, that changes with a real
deployment. And the file is a download, not an archive: nothing about it survives the browser
until you keep the copy yourself.

### How to try the accessibility pass

This one is not a screen you press; it is a claim about every screen, so it is tried by
measuring. WCAG 2.1 AA is the bar the brief sets (NFR-4.1 to NFR-4.3), and the rule this pass
worked to is that nothing counts until a number came out of a browser or out of the file.

1. The cheap half first. In `C:\Users\hp\Desktop\UNMASK\web`, run:

   ```
   npm run a11y
   ```

   It reads `src\styles\unmask.css`, resolves every `var()` through both token blocks, and
   prints what it measured: `293 declaration blocks …, 22 light tokens, 22 dark tokens, 16
   named pairs, two schemes`, then `PASS — no declared colour pair falls below WCAG 2.1 AA in
   either scheme`. The exit code is 0 on that line and 1 otherwise, so it belongs in a CI run
   and not only in a terminal. To see that it can fail, change `--ring: var(--blue-text);` to
   `--ring: var(--blue);` in the light `:root` block and run it again: it stops the run with
   `keyboard ring on the paper-2 … 2.81 : 1 (needs 3)`. Put it back.
2. The claim about the keyboard ring is the interesting one, because a focus outline is drawn
   *outside* the control. The last step broke it on purpose; this step looks at what fixed it.
   There is one token for the ring (`--ring`, in `unmask.css`, which defaults to `--blue-text`
   — the brand blue lightened where the page is dark), and every band that paints itself a
   colour re-declares it for the controls sitting inside it: the footer and the dark
   call-to-action band on the landing page take `--ring-on-ink`, the blue "ask to reveal"
   panel and the pink "you both said yes" panel take their own ink, and the finished reveal
   stage takes `--on-pink` because `--blue` on that pink measured **1.08:1**. Press
   **Tab** from the top of `http://localhost:5273/privacy` and keep pressing: the first stop is
   the skip link, which is invisible until it has focus and that is the intended behaviour, and
   every stop after it is a 3 px ring with a visible gap. Then open a thread's reveal screen and
   tab through the panel at the bottom — the ring there is white on blue, and it was invisible
   before this pass.
3. Both schemes, since the site follows the operating system and has no switch of its own.
   In the developer tools (F12) open the **Rendering** drawer (Esc → the `⋯` menu → Rendering)
   and set **Emulate CSS media feature prefers-color-scheme** to `dark`; everything you just
   tabbed through re-measures itself, including the ring. The guard in step 1 covers both
   schemes because `:root[data-theme="dark"]` exists in the stylesheet — note that nothing in
   the app ever sets that attribute, so it is a hook for measurement, not a theme switch.
4. Text contrast against a fixed-colour surface, which is where the two real defects were. On
   a chat thread, right-click the small time under your own message and **Inspect**. It is a
   yellow bubble that never changes with the scheme, and the timestamp's colour is
   `--on-yellow-dim` (`#55524b`): **5.53:1** in both schemes. Before the pass it inherited the
   page's dim text, which is a light grey in the dark scheme — **1.48:1** on that yellow. The other one
   was `.btn.ghost`, whose near-black inherited colour landed on the dark scheme's near-black
   paper at **1.03:1**, on the buttons that say *Show another* and *Start chatting*.
5. 320 px, the width a zoomed phone really is. Drag the window narrow until the developer
   tools report 320 px of viewport, and walk `/`, `/login`, `/signup`, `/privacy`, `/match` and
   `/account`. The page content measures **305 px** at that width, so there is no horizontal
   scrollbar and no text you have to pan for — the check the guard cannot do, because reflow
   is a browser fact and not a stylesheet fact.
6. Structure, in the **Accessibility** drawer of the developer tools: each screen has exactly
   one `h1`, no heading level is skipped on the way down, and there is a `main`, a `nav` and a
   `footer` region to jump between. The live sweep over 14 routes and both schemes — every
   screen plus one chat thread, its reveal, and a page that does not exist — found 199 focusable
   controls per scheme with **0** of them lacking a name, 0 text nodes below their own threshold
   (4.5:1, or 3:1 above 24 px), 0 images without alt text and 0 unlabelled form fields.
7. Motion. Everything that moves in this build is three short transitions — the buttons'
   press-lift (`0.12s`), the `+` that turns into a `−` when a landing-page question opens
   (`0.2s`) and the profile completion meter filling to its new width (`0.25s`) — and there is
   not one `@keyframes` rule in the stylesheet, so nothing animates by itself, nothing loops and
   nothing autoplays. The reduce block the guard prints as line 1460 of `unmask.css` sets both
   `animation-duration` and `transition-duration` to `0.001ms !important` for every element, so those three stop too.
   To see it rather than read it: with the **Rendering** drawer still open, set **Emulate CSS
   media feature prefers-reduced-motion** to `reduce` and press a button — it lifts nothing.

**What 9c does not do.** It does not include a scanner: no axe, no Lighthouse, no Playwright
a11y run. Every number above was measured by reading computed styles off real nodes in a real
Chromium, which catches what a browser paints and misses rules a scanner would have asked about
and a browser cannot answer. Nobody has read this site aloud either, and that is the gap that
matters most here: the wording of the announcement that fires when the *other* student sends a
message lives in a live region that has never been heard through a screen reader, and the
two-session check that would exercise it was not completed in this pass. There is no in-app dark
mode — the scheme follows the operating system, so a student on a campus machine cannot choose
it against the machine's setting. What this pass measured about motion is the stylesheet: the
reduce block exists, names both duration properties and is marked `!important`; whether a real
operating-system setting reaches it is step 7's emulation, which the reader can run and which
no tool available here could flip on its own. Two things the sweep flagged and this pass deliberately did not
"fix", because both were measurement artefacts rather than barriers: the file chooser on
`/profile` appears to a naive checker as an input with no label, and it is — one with
`hidden` on it, sitting behind the labelled **Add a photo** button, which is how a styled photo
upload has to be built; and the app template has two `<header>` tags, which is not two banner
landmarks, because a `<header>` inside the main region is not a banner at all. The 44 px minimum
is stricter than AA asks (SC 2.5.8 wants 24 px) and the two links inside sentences on
`/privacy` still stand 18 px tall — WCAG exempts a mid-sentence link, so their *hit area* grew
with padding and their type did not. The guard sees only what the stylesheet declares: 47 rules
set a colour with no background of their own, and those are judged live or not at all, which is
why step 1 and steps 4 to 6 are both needed. There are no modals anywhere in the build, so
there is no focus trap to test and nothing that pulls a keyboard user out of the page order.

---

## The stack, and where it differs from the plan documents

The documents specify three services: a React site, a Node/Express API, and a
**separate Python/FastAPI WebSocket chat service** sharing a JWT secret, with
`docker-compose.yml` running four containers. Your own `unmask-work-breakdown.docx`
calls that handshake "the fiddliest part" and lists "two backends to keep in sync" as
a risk.

Because this is a real product rather than a coursework submission, chat runs
**inside the Node API** over `ws`. One backend, one place that checks who is allowed
to see what. The documents' file layout otherwise holds.

```
UNMASK\
  docker-compose.yml     the database container
  .env                   your machine's secrets (created below, never committed)
  .env.example           the template, every key explained
  api\                   Node + Express + WebSockets  → http://localhost:4100
    src\config.js        reads and validates .env
    src\db.js            the one Mongo connection, and the indexes it creates
    src\app.js           the Express app: CORS, JSON, routes, the error translator
    src\index.js         starts it, retries the database, then builds the indexes
    src\domain\          vocabulary — interests, prompts, and the five institutions to start the collection with
    src\models\User.js   the account: no name field, hashed tokens only
    src\models\Institution.js one per college: its email domains, its faculty list, its city, and whether it is switched on
    src\models\InstitutionRequest.js "don't see yours?", kept apart from everything else because a stranger wrote it
    src\models\Profile.js one per account, and the minimum that makes it matchable
    src\models\Match.js  one row per connected pair — and the two reveal consents, on that row
    src\models\Message.js one line of chat: who sent it and what it said, nothing else
    src\models\Pass.js   a decline, with the 30-day expiry Mongo enforces itself
    src\services\        auth.js (register → delete), sessions.js, mail.js
    src\services\        profile.js (the form's rules, the contact guard), photos.js (the photo rules no store may weaken)
    src\services\photo-store\  index.js picks the driver — disk.js (a folder) | r2.js (a private Cloudflare bucket)
    src\services\        institutions.js (who may register, the preference ranking, the staff edits)
    src\services\        matching.js (compatibility, scoring, the sealed suggestion token)
    src\services\        chat.js (the thread, the message budget, what may go on a wire)
    src\services\        pair.js (the one place "is this your pair?" is answered)
    src\services\        reveal.js (the two consents, and the only doors to a name and a face)
    src\realtime.js      the WebSocket: same process, same cookie, one frame per reader
    src\routes\          health, meta, auth, profile, matches, chats, institution-requests
    src\routes\staff.js  the review queue, the numbers, the eligibility lever, and the institutions screen
    src\routes\reveals.js the only router in the API that serves one student's name or face to another
    src\storage\photos\  uploaded pictures while PHOTO_STORE=disk — gitignored, and served by no URL
    scripts\seed.js      the starting institutions and the four demo accounts, and --reset
    test\api.test.js     the guards that must never be able to slip
    test\institutions.test.js  a college added by staff over HTTP is one the whole product already handles (NFR-SCALE-1), against unmask_test_institutions
    test\auth.test.js    the whole account lifecycle, against unmask_test_auth
    test\devAutoVerify.test.js what the no-link developer shortcut may skip, and the four things it may not, against unmask_test_devauto
    test\profile.test.js the profile builder and the private photo, against unmask_test_profile
    test\match.test.js   who is suggested to whom, and what a card may say, against unmask_test_match
    test\chat.test.js    two students and a real socket, with every frame read, against unmask_test_chat
    test\reveal.test.js  two consents, two doors and the raw socket bytes, against unmask_test_reveal
    test\fixtures\images.js real PNG and JPEG bytes, so each suite can make its own pictures
  web\                   React (Vite)                  → http://localhost:5273
    src\styles\unmask.css  the design tokens from the prototype
    src\App.jsx          the routes, and the screen that waits on /api/auth/me
    src\auth\            AuthContext — who is signed in, from the server's answer
    src\api.js           the only thing that calls the API
    src\socket.js        the one WebSocket, and the browser's side of reconnecting
    src\time.js          a message timestamp, shown the way the prototype shows it
    src\encodePhoto.js   resize and re-encode in the browser, so EXIF GPS dies here
    src\hooks\           useAction (busy/error/result), useMeta (the rules, once), useApiStatus (the band that says when the API is not answering), useBell (the unread count)
    src\components\      AppShell (the nav, which changes when you sign in), Field, SafetyActions, InstitutionsPanel (the staff screen)
    src\pages\           Landing, Signup, VerifyEmail, Login, Forgot, Reset, Home, Profile, Match, Chats, Chat, Reveal, Notifications, Account, Staff, RequestInstitution, Privacy, Terms
    scripts\no-foreign-origins.js  the build fails if any absolute URL in it points off this origin
    scripts\no-institution-names.js  the build fails if a college's name, short name or email domain is typed into the client
```

---

## First time only

Open **Command Prompt** (press the Windows key, type `cmd`, Enter). Then paste these
lines one at a time and press Enter after each:

```
cd /d C:\Users\hp\Desktop\UNMASK
npm run setup
copy .env.example .env
docker compose up -d
```

`npm run setup` installs dependencies for the API and the site. `copy` creates your
own `.env`. Two lines in it must be filled in before the API will start — it refuses
to run without them, and tells you so in plain words:

1. `SESSION_SECRET` — paste the output of this command in after the `=`:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. `MONGO_PASSWORD` — type any phrase you like, then make `MONGO_URL` match it. The
   line has to read `mongodb://unmask:YOUR-PHRASE@127.0.0.1:27017/unmask?authSource=admin`.

To edit `.env`: `notepad .env`.

Then start the API and the site in **two separate Command Prompt windows**:

```
cd /d C:\Users\hp\Desktop\UNMASK
npm run dev
```
```
cd /d C:\Users\hp\Desktop\UNMASK
npm run dev:web
```

Open **http://localhost:5273**. The strip at the bottom of the page tells you whether
the service and the database are actually connected.

### On first run the database may look broken for a few minutes

`docker compose up -d` creates the database, then creates its own user. On a cold
Docker that took **about four minutes** here, and until it finishes the API prints:

```
• Database not reachable yet (attempt 1): Authentication failed.
```

That is the database still initialising, not a wrong password. Check the page at
http://localhost:5273/api/health — when it says `"status":"ok"` the wait is over, and
the API connects on its own without a restart.

---

## Everyday

```
docker compose up -d      start the database (Docker Desktop must be running)
npm run dev               API  → http://localhost:4100
npm run dev:web           site → http://localhost:5273
```

Stop a server with `Ctrl+C` in its window. Stop the database with `docker compose down`
— that keeps every byte of data. `docker compose down -v` **deletes all user data** and
is not something to type twice.

```
npm test                  the API's automated tests
npm --prefix web run a11y  every colour pair in the stylesheet, measured against WCAG 2.1 AA in both schemes
npm run seed              four demo students + one staff sign-in, if you do not want to chase the outbox
npm run seed -- --reset   the same, after wiping every row about those four accounts
npm run staff you@mycput.ac.za   make an account that already exists a reviewer
npm run build             a production build of the site into web\dist
npm run backup            a copy of the whole database + every photo, into api\backups — see "Backups" below
npm run restore --        put one of those copies into a database you name, and check it against its own manifest
```

---

## Backups

NFR-5.2 asks for "automated daily backups of user data, **with tested restore
procedures**". The second half is the reason this section is long. A backup you have
never restored is a file with a claim on it, so this project ships two scripts, and
the second one exists to check the first:

```
npm run backup                                        → api\backups\<stamp>-unmask
npm run backup -- --to D:\backups --keep 30           onto a disk the server is not on
npm run backup -- --no-photos                         the database only
npm run restore -- <that folder> --into unmask_rehearsal
npm run restore -- <that folder> --into unmask_rehearsal --photos-into D:\rehearsal-photos
npm run restore -- <that folder> --into unmask_rehearsal --push-photos
```

Each folder holds three things: `dump.archive.gz` (the whole database, one gzip
stream), `photos\` (a copy of every photo the configured store holds — same relative
paths from `PHOTO_DIR`, one `photos/<name>` prefix from a bucket), and
`manifest.json`. The manifest is the point. It records the count of every collection
**before** the dump ran, which store the pictures came and would go back to, the byte
size of the archive and its SHA-256 — so a restore can be *checked* rather than
believed, and so a bucket is never restored into a folder by accident. `restore.js`
verifies the hash before it writes anything, then reads the target back and prints
`expected` against `restored` per
collection. Any disagreement is exit 1, not a paragraph you have to read. The archive
also refuses to be restored over the database it came from: `--into` is required, and
a real disaster recovery is done by pointing `MONGO_URL` at the rehearsal name and
restarting, which is one deliberate decision instead of one flag away from an
overwrite. `--photos-into` and `--push-photos` are the two halves of that same care on
the photo side, and giving both is a usage error; a push checks every name against the
bucket before it writes any of them, because half a restored set of photos is worse
than none.

`mongodump` and `mongorestore` are not installed on this machine — they are inside the
`unmask-mongo` container, next to the database, and their `--dir` would be a folder
the host cannot see. So the archive streams through `docker exec`'s stdout, and the
same pipe runs backwards for a restore. On a hosted database, set `MONGODUMP_BIN` to a
real binary path and the Docker step disappears.

`--keep` (14 by default) deletes folders after the new one is written, and only folders
this script wrote: the name has to match the stamp pattern *and* contain a
`manifest.json`. Anything else sitting in the destination is left alone and named out
loud. `api\backups\` is gitignored, because a backup folder is the one file in this
project that is *entirely* other people's personal information.

### What running it here actually measured, 26 September 2026

- `npm run backup` on the real development database: **98 documents across 9
  collections**, an 8,625-byte archive (`sha256 ce4f2b64…`), 2 photos, 86,776 bytes.
- `npm run restore -- … --into unmask_rehearsal`: every collection matched its manifest
  row, `98 document(s) restored successfully`.
- The content check, not the count check: demo1's chat thread read out of
  `unmask_rehearsal` is byte-identical to the one in `unmask`, and the two restored
  photo files hash identically to the originals in `api\storage\photos`.
- Then the API was started against the restored database alone (`MONGO_URL` aimed at
  `unmask_rehearsal`, port 4113) and demo1 **signed in** — `200` with a session cookie —
  and `GET /api/profile` returned that student's real profile. A copy you can log into
  is a different thing from a copy with the right number of rows in it.
- And the live database never saw that write: diffing demo1's sessions left one present
  only in the rehearsal (the curl sign-in, `20:17:43`) and one present only in the live
  copy. The rehearsal database was then dropped and the copied photos deleted.
- `node --test test/backup.test.js` does the same round trip on a scratch database in
  **10 assertions**: seed six collections + a photo, back up, delete a student and the
  exact sentence they typed, restore into a third database, and read that sentence back
  — while asserting the *source* is still missing it, so a restore that wrote to the
  wrong place could not pass. Plus the four refusals (the source as its own target, no
  `--into`, a folder it did not write, an archive with one byte changed) and the
  retention prune.

One of those runs is the reason the count check exists. `mongorestore` 100.18 reads the
database named in its `--uri` as a filter on what to restore: with only `--nsFrom` and
`--nsTo` renaming the namespaces, it printed **exit 0 and "0 document(s) restored"** —
a backup that looked like it had come back, into an empty database. `--nsInclude` on
the source name is what makes the rename work. Nothing but the expected/restored table
would ever have caught that, which is why the table is the exit code.

### Every day

The backup has to run when nobody is thinking about it. On the server:

```
# cron (Linux) — 20:00 South African time is 18:00 UTC
0 18 * * *  cd /srv/unmask && /usr/bin/npm run backup -- --to /mnt/backups --keep 30 >> /var/log/unmask-backup.log 2>&1
```

On Windows, Task Scheduler → "Create Basic Task", daily, at a quiet hour:

- **Program/script:** `npm.cmd`
- **Add arguments:** `run backup -- --to D:\backups --keep 30`
- **Start in:** `C:\Users\hp\Desktop\UNMASK`

Then two rules that are not code:

1. `--to` must name a disk the database is **not** on. A backup folder next to the
   database it backs up is one disk failure away from being nothing — which is why the
   script says so on the way out every time it runs.
2. Once a month, run the `restore.js` line against the newest folder into a rehearsal
   name and read the table. A backup that has not been restored in six months is a
   hope, not a plan.

---

## Taking this to a server

**The shape, before the steps.** One process serves the site *and* the API, on one
origin, and the only thing in front of it is a proxy whose job is HTTPS. There is no
second web server, no separate frontend host and no CDN to keep in step with a CSP the
API already sets. That is a privacy decision as much as an operational one: a student's
session cookie stays first-party on `https://unmask.example.ac.za`, no CORS pre-flight
runs on any request, the chat socket is same-origin `wss://` on the port the page came
from, and there is exactly one place where the response headers are decided.

### The database and the photographs do not have to be on that machine

Two keys decide where they live, and neither one is assumed any more:

- **`MONGO_URL`** may be an Atlas string (`mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/unmask`)
  instead of the local container. Nothing else in the code knows or cares where the
  database runs — one rule applies: the `/unmask` before the `?` is **not optional**,
  because `sourceDbName()` in `scripts\backupLib.js` refuses a connection string that names
  no database rather than guessing at `test`, which is how an archive gets labelled with the
  wrong database. `serverSelectionTimeoutMS` is 10,000 ms, which is what a DNS
  round trip to a hosted cluster costs on a first connect and is not what a local socket does.
- **`PHOTO_STORE=r2`** with `R2_ENDPOINT` (or `R2_ACCOUNT_ID`) + `R2_BUCKET` +
  `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` moves the pictures into a Cloudflare R2
  bucket with no custom domain on it — so its objects have **no public URL** —
  spoken to over its S3 API with a signature this repository
  writes itself (`api\src\services\photo-store\r2.js`) — there is no cloud SDK in the
  dependency tree. The bytes still stream
  through the API — the browser never learns an object URL, and the two photo doors are the
  same two doors — so the rule named in "The one rule this product cannot afford to break"
  below is untouched by the move. `PHOTO_DIR` is then
  simply unused, and `/api/health` says which store is live and whether it answered.

What is proven and what is not: both paths are proven **offline**, against a stand-in for
the storage API and an Atlas-shaped connection string (`test\photoStoreR2.test.js`,
`test\boot.test.js`, `test\backup.test.js`). The stand-in re-derives every AWS Signature
Version 4 header from the bytes it received, by its own reference implementation, and the
suite includes the case that proves it actually rejects a bad signature. None of it has
been pointed at a real Atlas
cluster or a real bucket — that needs the two accounts to exist first, and it is the first
thing to check after creating them.

On a host that deploys from git — Render, Railway, Fly — there is no `.env` file to edit,
and the boot refusal says so instead of telling you to copy a template you cannot see.
Those keys go in the host's environment tab. `PLAN\DEPLOY-RENDER.md` is the
click-by-click version of that route, including why the **site cannot be split off onto a
second frontend host**: the session is a first-party cookie and the chat socket is opened
against `window.location.host`, so a Vercel page and a Render API can never share a login.

| File | What it is |
|---|---|
| `deploy\Dockerfile` | two stages: compile the site, then put it inside the API image. The build context is the **project root**, because `config.js` resolves the build folder as a sibling of `api\` |
| `deploy\docker-compose.prod.yml` | that one process, plus the database **only when asked**: the API is the default service and publishes `127.0.0.1:4100` and nothing else; `--profile local-db` adds a database container, which publishes no port either way — with Atlas there is nothing to add |
| `deploy\prod.env.example` | the handful of values a server needs, each one commented with what breaks if it is wrong. Copy it to `deploy\prod.env` |
| `deploy\Caddyfile` | TLS, automatic certificates, the socket pass-through — the shortest correct answer, and the file this project ships |
| `deploy\nginx.unmask.conf` | the same shape for a server already running nginx, including the two lines that are easy to forget |
| `PLAN\DEPLOYMENT-AZURE.md` | the same steps as an operations plan for one Azure VM: portal clicks, DNS, Docker, the first boot, HTTPS, the first accounts, backups, a rollback and an availability probe, each with the command that proves it worked. An operations plan, not a specification — it changes nothing the product promises |
| `PLAN\Unmask-Deployment-Brief-Azure.docx` | that plan as a Word document, for reading away from the code |
| `PLAN\DEPLOY-RENDER.md` | the same deployment aimed at a host that deploys from git, with Atlas for the database and a Cloudflare R2 bucket for the photos instead of a Docker container and a disk folder: the config refusals such a host prints and which key each one wants, where every value goes in that dashboard, the order to do the first-boot tasks in (seeding still has to run from a laptop, because `npm run seed` refuses in production), and what the free tiers actually cost you — the open network allow list, the 512 MB database, the spin-down that drops a chat socket |

1. **Get the code onto the server**, and install Docker. Copy the folder excluding
   `api\storage` and `api\backups` — those are students' data and copies of it, not code.
2. **Copy `deploy\prod.env.example` to `deploy\prod.env`** and fill in five values. Two of
   them you generate on the spot:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"    → SESSION_SECRET
   ```
   `MONGO_PASSWORD` cannot be changed after the database's first start without editing the
   deployment by hand, so decide it before step 3, not after.
3. **Start it:**
   ```
   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build
   ```
   The first build takes a few minutes (it installs the site's dependencies and runs
   `npm run build` inside the image, which includes the check that refuses any third-party
   origin in the output).
4. **Read what it says about itself:**
   ```
   docker compose -f deploy/docker-compose.prod.yml logs api
   ```
   Five lines: the port, the health address, the chat address, the origins a socket
   handshake may come from, and whether the site is being served from this process. If any
   of the production gates refused the boot, you will not get these lines — you will get
   the sentence naming the key to edit and the thing that would have gone quietly wrong.
5. **Put the proxy in front of it.** Point the DNS A record at the server, then either
   copy `deploy\Caddyfile` to `/etc/caddy/Caddyfile` with the hostname edited (Caddy asks
   Let's Encrypt for the certificate and renews it forever) or install
   `deploy\nginx.unmask.conf` and run `certbot --nginx -d <your-hostname>`. Either way set
   `TRUST_PROXY_HOPS=1` — already done in the compose file, and wrong on any machine where
   there is no proxy.
6. **Turn on the daily backup** (see the cron line in the section above), with one extra
   variable on a server, because the database container has its own name there:
   ```
   MONGO_CONTAINER=unmask-server-mongo npm run backup -- --to /mnt/backups --keep 30
   ```
   The two scripts are Node programs that read the model list to count collections, so the
   server also needs `node` and one `npm --prefix api install`.
7. **To deploy an update later:** replace the code and run step 3 again. Nobody is signed
   out by it, because a session lives in the database rather than in the process's memory —
   what you lose is the few seconds the old container takes to stop, which drops open chat
   sockets. The browser reconnects on its own, and a message that did not make it is still
   in the sender's composer.

### What the rehearsal on this laptop measured, 26 September 2026

Not a description of the files — the files were run, with the development API left alone.

- The image built from a clean context, and the container **started with no `.env` file in
  it at all**, configured entirely by its environment. It printed
  `site http://localhost:4100 (serving /srv/unmask/web/dist)`, so the compiled React app is
  inside the image and this process is serving it.
- `/` returned the app shell with `default-src 'self'` and
  `upgrade-insecure-requests` — both production-only — `Cache-Control: no-store`, and a
  `Strict-Transport-Security` header that development deliberately withholds.
- `/assets/index-Dy7IJrU3.js` returned `public, max-age=31536000, immutable`, and
  `/fonts/anton-400-latin.woff2` returned `max-age=604800` with `font/woff2`: the two
  self-hosted fonts are served by this build, and nothing the page asks for goes to Google.
- `/api/health` answered `"status":"ok"` with every readiness boolean true, and
  `/api/nothing-at-all` answered with the **API** CSP (`default-src 'none'`), `no-store` and
  JSON — the two header regimes, kept apart by one process.
- `demo1@mycput.ac.za` signed in through the production process: `200`, and the cookie came
  back `HttpOnly; Secure; SameSite=Lax`. `GET /api/profile` then returned that student's
  profile.
- The chat socket was probed with three handshakes. `https://unmask.example.ac.za` — the
  configured origin — got **101**. `https://somewhere-else.test` and
  `http://localhost:5273` both got **403** before the upgrade completed.
- The gates were then fired on purpose, in the deployed shape: the same image run with
  `WEB_ORIGIN` left at the development value refused to start and printed two sentences,
  one about a `Secure` cookie not surviving an http origin and one about the socket being
  refused on every connection.
- `npm run seed` **refused** to run inside it while `NODE_ENV=production` — demo accounts do
  not belong on a live site — which is a stage-2 gate still doing its job a year later.
- Both containers reached Docker's `(healthy)` state, which is the image's own
  `HEALTHCHECK` polling `/api/health`, and `down -v` removed the rehearsal's volumes. The
  development database was left standing with its 8 accounts: the production file names its
  containers `unmask-server-*` specifically so it cannot claim the name the development
  database answers to.

**What 9d does not do.** It does not prove **NFR-1.3** (2,000 concurrent students) or
**NFR-6.1** (matching and messaging scaled separately): there is no load test anywhere in
this project, and the architecture is deliberately one process — the chat rooms and the
rate-limit windows live in that process's memory, so a second copy of it would hold half
the sockets and count each bucket twice. The account lockout still works across copies
because it lives in the database; the per-IP limits do not. **NFR-5.1** (99.5% uptime) is
`restart: unless-stopped` and nothing else: one database, one node, no failover, no
monitoring and nobody paged when it stops — 99.5% is about three and a half hours a month
of allowance, and this deployment has never been measured against it. **NFR-6.3** asks for
rolling deployment without extended downtime; what ships here is a restart of one
container, which is seconds rather than minutes and is *not* zero-downtime. **NFR-7.1**
(the latest two versions of Chrome, Safari, Firefox and Edge) has not been run: every
browser measurement in stage 9 was taken in one Chromium-based browser, and no Safari or
Firefox pass has happened anywhere. The campus-NAT consequence is real and unmitigated: a
login bucket is **10 attempts per address per 15 minutes**, and a whole residence hall on
one IPv4 shares it, so ten students signing in inside a quarter of an hour can be joined
by an eleventh who gets a 429 — `TRUST_PROXY_HOPS` cannot fix that, only a bigger bucket or
a per-account one can. SMTP is whatever you put in `prod.env`, and this rehearsal used a
host that does not exist: no email has ever left a production-shaped Unmask, and no SPF,
DKIM or relay agreement with CPUT has been arranged. There is no CI, so `npm test` is run
by a person, and the build only refuses a third-party origin because a script in the build
step says to. The TLS proxy configs are written and reviewed and were **not** exercised —
the rehearsal reached the API directly on loopback, so `wss://` through Caddy or nginx is a
configuration someone has to press once, on the day, before students do it for real.

---

## The one rule this product cannot afford to break

No name and no photo may be reachable by anyone before **both** users have consented.
That is a backend rule, not a CSS rule: `PLAN\DOCUMENT\unmask-requirements.md` FR-2.3
and NFR-2.3, and your architecture note "never trust the frontend to hide it".

Concretely, this is held by design:

- Photos live behind one seam, and the rule sits **above** it. With `PHOTO_STORE=disk`
  they are written to `api\storage\photos\`, which is outside the folder the web server
  serves, is gitignored, and is refused outright by a boot gate if you point it inside
  the build. With `PHOTO_STORE=r2` they are objects in a Cloudflare R2
  bucket, put and read over its S3 API with a signature computed inside the API
  process from `R2_SECRET_ACCESS_KEY`, which no other process and no response ever
  carries — the bucket has no public URL, and the only listing this build asks for is a
  backup's, page by page under that same `photos/` prefix. There is no URL that reaches a photo under either
  store: the only door is `/api/profile/photo`, which serves the bytes to the account
  that uploaded them and `no-store` so no proxy keeps a copy. The stored filename is never returned
  by any response and never accepted from a URL, which a test asserts by planting a
  name in the database and trying to read it back. Stage 6 added the one second door,
  `/api/reveals/:id/photo`, and it reads the pair's own row for two consents before it
  opens. A driver has to answer `put`, `get`, `del`, `probe` and a copy in and out, and
  `test\photoStoreR2.test.js` holds the bucket to that against a stand-in for the
  storage API which re-derives every signature from the bytes it was handed: a filename
  that is not one this store would have written never goes out over the
  network at all, a write that would overwrite an existing object is refused rather than
  silently replaced, every object sits under a `photos/` prefix that is the only thing
  ever listed, a delete reports false unless a head first found the object, a listing is
  followed over every page it hands back, and no error message or health line carries the
  secret key or the bucket's address.
- The browser re-encodes the picture before uploading it, so the location a phone
  wrote into the file never reaches the server — and the server would not read it if
  it did, because it only ever stores the bytes it was handed.
- A prompt answer containing what reads like a phone number, an email address, a
  link, an `@handle` or the name of another app is refused on the way in, with the
  reason said out loud (FR-2.6). The guard is asserted in both directions: nine ways
  to leak a contact detail are caught, and seven honest answers that mention numbers
  or times get through.
- `/api/health` answers with booleans. It is unauthenticated, so a test asserts that
  its own output can never contain the session secret, the database URL, the mail
  password, or a filesystem path.
- The API answers CORS only for the web origin. A test proves an unfamiliar origin
  gets no permission header at all.
- The account document has **no name field of any kind**. There is nothing in the
  database to leak, rather than something being careful about whom it shows.
- A suggestion is a **sealed capability, not a person**. `GET /api/matches/suggestion`
  returns year, faculty, institution, one prompt answer, up to five shared interests, a
  score, and a token; nothing else. There is no route anywhere in the API that takes a
  profile id or an email as input, so there is nothing to enumerate, and a test asserts
  the card's exact key set against a candidate whose database row does have a photo and
  a planted filename. The token is AES-256-GCM with the *viewer's own account id* as
  its authenticated data: a card copied to a second signed-in account does not
  decrypt, and a test proves that and the forged and empty variants with it.
- Two students who connect are never suggested to each other again, in either
  direction, from the one sorted pair row — so there is no second list that could
  disagree with the first.
- The order is recomputed on every request and no suggestion is cached or stored
  anywhere (FR-3.5). Editing your profile changes who sees you on the next call, with
  nothing to invalidate and therefore nothing to forget to invalidate; a test edits a
  profile mid-journey to prove it.
- A chat frame is **built once per reader**. The same message arrives as `'me'` to the
  writer and `'them'` to the other student, and the only other things on it are the
  message's own id, its text and its time — no account id, no profile id, no email
  (FR-4.3). The suite proves that by opening a real socket and searching the bytes, and
  it was proved again in the browser by reading the page's own text.
- The WebSocket **authenticates on the handshake**, from the same session cookie the
  REST routes use, and a socket that cannot show a live session never gets a connection
  to talk on. No credential is ever put in a URL, where a proxy would log it. A foreign
  `Origin` is refused before the upgrade completes.
- There is **no typing indicator, no "seen" receipt and no online dot** — not because
  nobody asked, but because each is a timestamp about one specific person's habits, and
  NFR-3.3 bans identity inferable from metadata. The prototype's typing dots are
  therefore the one part of the design that was deliberately not transcribed.
- The message budget (25 a minute, 200 a day, per account) lives in the chat **service**,
  not in route middleware, so the REST door and the socket door cannot drift apart; a
  test floods one account through both doors and gets the same refusal from each. A flood
  of socket frames is also capped, one layer down, before it becomes database writes.
- **Consent is two rows, not one flag.** A pair's reveal holds one timestamped entry per
  student, and both identity routes re-read that row from the database before they answer,
  so "may you see this?" is a question about stored facts rather than about what the
  caller claims. An ask writes only the asker's own row, and a test proves that at that
  moment the other student — and the asker, and a stranger holding the pair id — all get
  the same `403`.
- **A reveal frame carries one word.** `asked`, `declined`, `revoked`, `revealed` — plus
  the thread it happened in. No name, no email, no account id, no consent list, so a
  student's screen cannot learn the answer from a push and then be wrong about it; it asks
  the authenticated route instead. The suite reads the socket's raw bytes and searches
  them for exactly those leaks.
- **The reveal name has nowhere to travel.** The matching engine never reads it, so it
  cannot influence who is suggested to whom, and a test asserts it is absent from a
  suggestion payload. It is absent from every chat payload too, until the pair's row holds
  both yeses — checked by asserting each field's value, not by searching for the word
  "name". And the revealed profile itself returns no `id` key, no email and no filename.
- **A face is never cached.** `/api/reveals/:id/photo` answers `no-store`, for the same
  reason as the owner's own copy: this is a student's picture behind a session cookie on a
  university computer, and it should not outlive the pair that agreed to it.
- Confirmation links, reset links and session cookies are stored as SHA-256 hashes
  only. A database dump cannot confirm an address, spend a link, or forge a sign-in.
- Changing a password, being suspended, or deleting an account empties that user's
  `sessions` array. Tests prove the old cookie stops working and, for deletion, that
  the address can no longer sign in at all and the photo file is gone from the disk.
- Register, forgot-password and resend all answer with one identical sentence, and a
  wrong address and a wrong password return byte-identical 401s. A test asserts the two
  answers are the same, so this site cannot be used to look up who has registered.

---

## Ports

`4100` the API · `5273` the site · `27017` MongoDB, bound to `127.0.0.1` so it is
reachable only from this machine. Nothing here listens on `3000` or `3020`.
=======
# UNMASK
mating application. finding a companion 
>>>>>>> 440ab3f666693404ebe9865df601730594d1793b
