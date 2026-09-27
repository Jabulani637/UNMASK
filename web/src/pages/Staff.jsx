import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import InstitutionsPanel from '../components/InstitutionsPanel.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { api, ApiError } from '../api.js';
import { ago, clockTime } from '../time.js';

/**
 * FR-6.3 to FR-6.5 — the moderation queue, in a browser.
 *
 * This page is the only student-facing-looking screen in the app that ever holds an
 * account id, and that is the point of it: the rest of the product hides who a
 * profile belongs to, and a person deciding somebody's account has to be able to say
 * which account they decided. So the ids live here and nowhere else, they came from
 * the queue's own response rather than a typed-in guess, and every route behind this
 * page answers 404 to anybody who is not an active admin — which is also what this
 * page shows when a student types `/staff` into the address bar, because that is the
 * honest answer to a door that is not theirs.
 *
 * **Nothing on a row is a name.** A reporter reads as year / faculty / institution and
 * "reported you"-shape, not as an email address: the queue holds hundreds of these a
 * shift and a shared staff-room screen does not need to display who complained. The
 * one exception is the reveal name, which appears only where the API itself decided
 * the pair had revealed.
 *
 * **A decision is a press with a sentence attached.** "Remove content" cannot be
 * submitted without a reason, because that text is what the student is shown on their
 * own profile screen (FR-6.4) — the API refuses the empty version, and the button is
 * disabled to match rather than letting a moderator discover the rule by failing.
 *
 * **A face is opened, not rendered.** The photo route writes an audit row on every
 * read, so this page never mounts that `<img>` until a moderator presses for it, and
 * says so once when they do. A queue that displayed every reported photo on load
 * would be a wall of students' faces, which is not what FR-6.3 asked for.
 *
 * **Two questions about an account, kept apart.** Suspend, ban and reinstate answer
 * "what did this person do". Verify and revoke answer "is this person a student at a
 * verified institution" (FR-8.2) — the rule the whole site is built on, and the one
 * decision whose reason the student is handed directly, at their own next sign-in
 * attempt. They are separate controls because a wrong answer to one must not undo the
 * other: confirming somebody enrols here does not lift a pause a report decided.
 */
const TABS = [
  ['open', 'Waiting'],
  ['actioned', 'Actioned'],
  ['dismissed', 'Dismissed'],
  ['all', 'Everything'],
];

const VIEWS = [
  ['queue', 'Report queue'],
  ['institutions', 'Institutions'],
];

const DECISIONS = [
  ['dismissed', 'Dismiss', 'Close it with nothing done. Nobody is told either way.'],
  ['removed-content', 'Remove content', 'Put the profile on hold and tell its owner why.'],
  ['suspended', 'Suspend account', 'Sign them out everywhere and stop suggesting them.'],
  ['banned', 'Ban account', 'The same, recorded as a ban.'],
];

function ViewTabs({ view, onView }) {
  return (
    <div className="row staff-tabs">
      {VIEWS.map(([value, label]) => (
        <button
          key={value}
          className={`btn small ${view === value ? 'pink' : 'ghost'}`}
          type="button"
          aria-pressed={view === value}
          onClick={() => onView(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Staff() {
  const { user } = useAuth();
  const mounted = useRef(true);

  const [view, setView] = useState('queue');
  const [tab, setTab] = useState('open');
  const [rows, setRows] = useState(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [notes, setNotes] = useState({});
  const [pending, setPending] = useState(null);
  const [photos, setPhotos] = useState({});
  const [record, setRecord] = useState(null);
  const [stats, setStats] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [studentNote, setStudentNote] = useState('');

  const load = useCallback(async status => {
    try {
      const data = await api.staff.queue(status);
      if (!mounted.current) return;
      setRows(data.reports);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      // 404 is the staff area's own answer to a non-admin, and it is the same 404 it
      // gives an unknown path — so this page says "no such page" rather than
      // confirming that a staff area exists for the person who cannot open it.
      if (err instanceof ApiError && err.status === 404) setDenied(true);
      else setError(err.message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load(tab);
    return () => {
      mounted.current = false;
    };
  }, [tab, load]);

  async function decide(id, action) {
    setPending(`${id}:${action}`);
    setNotice(null);
    try {
      const data = await api.staff.decide(id, { action, note: notes[id] || null });
      setNotice(data.message);
      await load(tab);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setPending(null);
    }
  }

  async function setStatus(userId, status) {
    setPending(`${userId}:${status}`);
    setNotice(null);
    try {
      const data = await api.staff.setStatus(userId, { status });
      setNotice(`${data.message}${data.threadsClosed ? ` ${data.threadsClosed} open conversation${data.threadsClosed === 1 ? '' : 's'} closed.` : ''}`);
      await load(tab);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setPending(null);
    }
  }

  async function setStudent(userId, status) {
    setPending(`${userId}:student:${status}`);
    setNotice(null);
    try {
      const data = await api.staff.setStudent(userId, {
        status,
        note: status === 'revoked' ? studentNote : null,
      });
      setNotice(data.message);
      setStudentNote('');
      setRecord(await api.staff.account(userId));
      await load(tab);
    } catch (err) {
      setNotice(err.message);
    } finally {
      setPending(null);
    }
  }

  async function openRecord(userId) {
    setPending(`record:${userId}`);
    setNotice(null);
    try {
      setRecord(await api.staff.account(userId));
    } catch (err) {
      setNotice(err.message);
    } finally {
      setPending(null);
    }
  }

  async function loadStats() {
    setPending('stats');
    setNotice(null);
    try {
      setStats(await api.staff.stats());
    } catch (err) {
      setNotice(err.message);
    } finally {
      setPending(null);
    }
  }

  if (denied || (user && !user.staff)) {
    return (
      <AppShell title="No such page" intro="Nothing lives at that address.">
        <Link className="btn block" to="/me">
          Back to my profile
        </Link>
      </AppShell>
    );
  }

  if (view === 'institutions') {
    return (
      <AppShell
        title="Institutions"
        intro="Every college Unmask verifies students at, and the email domains that decide it. Adding one here is the whole of onboarding it — no code, no deploy, no server."
        wide
      >
        <ViewTabs view={view} onView={setView} />
        <InstitutionsPanel />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Staff queue"
      intro="Reports in the order they arrived. What you can see here — who reported whom, the words as they stood, an account's whole log — is visible to no student, on any screen, for any reason."
      wide
    >
      <ViewTabs view={view} onView={setView} />
      <div className="row staff-tabs">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            className={`btn small ${tab === value ? 'blue' : 'ghost'}`}
            type="button"
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
        <button className="btn small ghost" type="button" onClick={() => load(tab)}>
          Refresh
        </button>
        <button
          className={`btn small ${showStats ? 'blue' : 'ghost'}`}
          type="button"
          aria-expanded={showStats}
          onClick={() => {
            const next = !showStats;
            setShowStats(next);
            if (next && !stats) loadStats();
          }}
        >
          {showStats ? 'Hide platform numbers' : 'Platform numbers'}
        </button>
      </div>

      {showStats ? (
        <section className="stats">
          {stats ? (
            <Stats data={stats} refreshing={pending === 'stats'} onRefresh={loadStats} />
          ) : (
            <p className="server-line">{pending === 'stats' ? 'Counting…' : error || 'The numbers could not be read.'}</p>
          )}
        </section>
      ) : null}

      {error ? <p className="server-error" role="alert">{error}</p> : null}
      {notice ? <p className="server-ok" role="status">{notice}</p> : null}
      {!rows && !error ? <p className="server-line">Reading the queue…</p> : null}
      {rows && !rows.length ? (
        <p className="server-line">
          Nothing here right now. That is the good state — try the other tabs to read what has already been decided.
        </p>
      ) : null}

      {(rows || []).map(row => (
        <article className="queue-row" key={row.id}>
          <header className="queue-head">
            <b className="queue-kind">{row.kind}</b>
            <span className="queue-reason">{row.reason}</span>
            <span className="queue-when">{ago(row.at)}</span>
            {row.openAgainst > 1 ? <span className="queue-flag">{row.openAgainst} open reports against this account</span> : null}
          </header>

          <div className="queue-cols">
            <div>
              <p className="queue-sub">Reported content</p>
              <blockquote className="queue-excerpt">{row.excerpt}</blockquote>
              {row.detail ? <p className="queue-detail">From the reporter: {row.detail}</p> : null}
              {row.promptIndex !== null && row.promptIndex !== undefined ? (
                <p className="hint">Answer {row.promptIndex + 1} on their profile.</p>
              ) : null}
            </div>
            <div className="queue-cards">
              <Card title="Reported student" card={row.reported} />
              <Card title="Reporter" card={row.reporter} />
            </div>
          </div>

          {row.status === 'open' ? (
            <div className="stack">
              <div className="field">
                <label htmlFor={`note-${row.id}`}>Note (required for a removal; kept on the record either way)</label>
                <textarea
                  id={`note-${row.id}`}
                  rows={2}
                  maxLength={400}
                  value={notes[row.id] || ''}
                  onChange={event => setNotes(prev => ({ ...prev, [row.id]: event.target.value }))}
                  placeholder="What was wrong with it, in the sentence the student will read."
                />
              </div>
              <div className="row">
                {DECISIONS.map(([action, label, hint]) => (
                  <button
                    key={action}
                    className={`btn small ${action === 'dismissed' ? 'ghost' : 'pink'}`}
                    type="button"
                    title={hint}
                    disabled={Boolean(pending) || (action === 'removed-content' && !(notes[row.id] || '').trim())}
                    onClick={() => decide(row.id, action)}
                  >
                    {pending === `${row.id}:${action}` ? 'Deciding…' : label}
                  </button>
                ))}
              </div>
              <p className="hint">
                A removal holds the profile, not the account. Suspend and ban sign the student out everywhere and close
                their open conversations — and the other half of each one is told only that it closed, never why.
              </p>
            </div>
          ) : (
            <p className="queue-decided">
              Decided: {row.decision} · {clockTime(row.decidedAt)}
              {row.decisionNote ? ` — “${row.decisionNote}”` : ''}
            </p>
          )}

          <div className="row queue-account">
            <button
              className="btn small ghost"
              type="button"
              disabled={Boolean(pending)}
              onClick={() => openRecord(row.reported.userId)}
            >
              {pending === `record:${row.reported.userId}` ? 'Reading…' : 'Their whole record'}
            </button>
            {row.reported.account.status !== 'active' ? (
              <button
                className="btn small blue"
                type="button"
                disabled={Boolean(pending)}
                onClick={() => setStatus(row.reported.userId, 'active')}
              >
                {pending === `${row.reported.userId}:active` ? 'Reinstating…' : 'Reinstate this account'}
              </button>
            ) : null}
            {row.reported.hasPhoto ? (
              <button
                className="btn small ghost"
                type="button"
                onClick={() => setPhotos(prev => ({ ...prev, [row.reported.userId]: true }))}
              >
                {photos[row.reported.userId] ? 'Photo opened below' : 'Open their photo'}
              </button>
            ) : (
              <span className="hint">No photo on file.</span>
            )}
          </div>

          {photos[row.reported.userId] ? (
            <div className="queue-photo">
              {/*
                Mounting this tag is the audited act: the request it makes writes
                `photo.viewed` with your own id and this timestamp.
              */}
              <img src={api.staff.photoUrl(row.reported.userId)} alt="The reported student's profile photo" />
              <p className="hint">
                This is the photo on their profile <i>now</i>, not the one filed with the report, and opening it has
                been recorded.
              </p>
            </div>
          ) : null}
        </article>
      ))}

      {record ? (
        <section className="record">
          <header className="queue-head">
            <b className="queue-kind">Account record</b>
            <span className="queue-reason">
              {[record.year, record.faculty, record.institution && record.institution.shortName]
                .filter(Boolean)
                .join(' · ') || 'no profile on file'}
            </span>
            <span className={`queue-flag ${record.account.status === 'active' ? '' : 'bad'}`}>
              {record.account.status}
              {record.account.reason ? ` — ${record.account.reason}` : ''}
            </span>
            <button className="btn small ghost" type="button" onClick={() => setRecord(null)}>
              Close
            </button>
          </header>

          <div className="row">
            {record.account.status !== 'suspended' ? (
              <button className="btn small pink" type="button" onClick={() => setStatus(record.userId, 'suspended')}>
                Suspend
              </button>
            ) : null}
            {record.account.status !== 'banned' ? (
              <button className="btn small pink" type="button" onClick={() => setStatus(record.userId, 'banned')}>
                Ban
              </button>
            ) : null}
            {record.account.status !== 'active' ? (
              <button className="btn small blue" type="button" onClick={() => setStatus(record.userId, 'active')}>
                Reinstate
              </button>
            ) : null}
          </div>

          <div className="stack">
            <p className="queue-sub">
              Student status: {record.account.student ? record.account.student.status : 'unknown'}
              {record.account.student && record.account.student.note ? ` — “${record.account.student.note}”` : ''}
            </p>
            <div className="field">
              <label htmlFor={`student-${record.userId}`}>
                Reason — required before a revocation, and it is the sentence the student is shown when they next try
                to sign in
              </label>
              <textarea
                id={`student-${record.userId}`}
                rows={2}
                maxLength={400}
                value={studentNote}
                onChange={event => setStudentNote(event.target.value)}
                placeholder="What you checked, and what it showed."
              />
            </div>
            <div className="row">
              <button
                className="btn small pink"
                type="button"
                title="Record that this is not a student at a verified institution. The account is paused, and they are told your reason when they sign in."
                disabled={Boolean(pending) || !studentNote.trim()}
                onClick={() => setStudent(record.userId, 'revoked')}
              >
                {pending === `${record.userId}:student:revoked` ? 'Revoking…' : 'Revoke student status'}
              </button>
              <button
                className="btn small blue"
                type="button"
                title="Record that you have checked they are a student at a verified institution, and take back a pause this screen made."
                disabled={Boolean(pending)}
                onClick={() => setStudent(record.userId, 'verified')}
              >
                {pending === `${record.userId}:student:verified` ? 'Verifying…' : 'Verify student status'}
              </button>
            </div>
            <p className="hint">
              Revoking a student status pauses the account, signs it out everywhere and stops it being suggested.
              Verifying takes back a pause <i>this</i> screen made — it never lifts one that a report decided, because
              those are different questions.
            </p>
          </div>

          <p className="queue-sub">Every report against them</p>
          {record.reports.length ? (
            <ul className="record-list">
              {record.reports.map(row => (
                <li key={row.id}>
                  <b>{row.kind}</b> · {row.reason} · {row.status}
                  {row.decision ? ` (${row.decision})` : ''} · {ago(row.at)}
                  <p className="hint">{row.excerpt}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">None.</p>
          )}

          <p className="queue-sub">What has been done to this account</p>
          {record.log.length ? (
            <ul className="record-list">
              {record.log.map((row, index) => (
                <li key={`${row.at}-${index}`}>
                  <b>{row.action}</b> · {clockTime(row.at)}
                  {row.note ? <p className="hint">{row.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Nothing yet.</p>
          )}
        </section>
      ) : null}
    </AppShell>
  );
}

/**
 * One person's card, in the words the API chose to give: a year, a faculty, an
 * institution, a status, and the profile text that a report about this profile is
 * actually about. No email address and no photo filename appears here because none
 * is sent to this page, and no race appears here either — the identity line a
 * student writes about themselves is on no card, in no queue and in no excerpt,
 * because a moderation screen is the one place a third party could read it.
 */
function Card({ title, card }) {
  return (
    <div className="queue-card">
      <p className="queue-sub">
        {title}
        {card.held ? ' · on hold' : ''}
      </p>
      <b>{[card.year, card.faculty, card.institution && card.institution.shortName].filter(Boolean).join(' · ') || 'no profile on file'}</b>
      <p className="hint">
        {card.account.status === 'active' ? 'account active' : `account ${card.account.status}`}
        {card.account.reason ? ` — ${card.account.reason}` : ''}
      </p>

      {(card.prompts || []).map(row => (
        <p className="queue-detail" key={row.prompt}>
          {row.prompt} {row.answer}
        </p>
      ))}
      {card.typeNote ? <p className="queue-detail">Who they are after: {card.typeNote}</p> : null}
    </div>
  );
}

const dash = value => (value === null || value === undefined ? '—' : value);
const pc = value => (value === null || value === undefined ? '—' : `${value}%`);

/**
 * FR-8.1 — the aggregate numbers, rendered as counts.
 *
 * Two things are deliberate here. **Every figure is a total, and there is no way to
 * drill into one.** A staff member who wants to know why a number moved follows the
 * queue and the account records, which are audited; a statistics panel that let you
 * click a count into the list behind it would be a way of asking "which students are
 * these" of a screen nobody logs. And **a rate is printed with the counts it came
 * from**, because "match rate 12%" without a denominator invites a decision that the
 * engine cannot actually support — the API sends its `basis` sentences for the same
 * reason, and they are shown here rather than hidden in a tooltip.
 */
function Stats({ data, refreshing, onRefresh }) {
  return (
    <>
      <header className="queue-head">
        <b className="queue-kind">Platform numbers</b>
        <span className="queue-reason">
          Counts of everything, contents of nothing: no name, message, photo, address or account id is in any figure
          below. Read at {clockTime(data.generatedAt)}.
        </span>
        <button className="btn small ghost" type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Counting…' : 'Recount'}
        </button>
      </header>

      <Group
        title="Accounts"
        items={[
          [dash(data.accounts.active), 'active accounts'],
          [dash(data.accounts.total), 'accounts ever made'],
          [dash(data.accounts.signedInLast7Days), 'signed in this week'],
          [pc(data.accounts.shareActiveThisWeek), 'of active accounts'],
          [dash(data.accounts.createdLast30Days), 'joined in 30 days'],
          [dash(data.accounts.emailVerified), 'emails confirmed'],
          [dash(data.accounts.over18Attested), 'over 18 attested'],
          [dash(data.accounts.studentVerified), 'student status checked'],
          [dash(data.accounts.studentRevoked), 'student status revoked'],
          [dash(data.accounts.suspended), 'suspended'],
          [dash(data.accounts.banned), 'banned'],
          [dash(data.accounts.staff), 'staff sign-ins'],
        ]}
      />

      <Group
        title="Profiles"
        items={[
          [dash(data.profiles.total), 'profiles on file'],
          [dash(data.profiles.matchable), 'complete enough to suggest'],
          [pc(data.profiles.shareMatchable), 'of all profiles'],
          [dash(data.profiles.withPhoto), 'with a photo'],
          [dash(data.profiles.onHold), 'held by staff'],
        ]}
      />

      <Group
        title="Matching"
        items={[
          [dash(data.matching.chatsOpened), 'chats ever opened'],
          [dash(data.matching.chatsOpen), 'chats still open'],
          [dash(data.matching.chatsEnded), 'chats ended'],
          [dash(data.matching.declinesOnFile), 'declines still hidden'],
          [pc(data.matching.matchRate), 'match rate'],
          [dash(data.matching.chatsPerActiveStudent), 'chats per active account'],
        ]}
      />

      <Group
        title="Reveals"
        items={[
          [dash(data.reveal.asked), 'asks sent'],
          [dash(data.reveal.waiting), 'waiting on a second yes'],
          [dash(data.reveal.revealed), 'both said yes'],
          [dash(data.reveal.declinedAtLeastOnce), 'declined at least once'],
          [dash(data.reveal.revoked), 'undone after both said yes'],
          [pc(data.reveal.revealRate), 'reveal rate'],
          [dash(data.reveal.askedPerChat), 'asks per chat opened'],
        ]}
      />

      <Group
        title="Conversation"
        items={[
          [dash(data.conversation.messages), 'messages written'],
          [dash(data.conversation.messagesLast7Days), 'in the last 7 days'],
          [dash(data.conversation.messagesPerChat), 'average per chat'],
        ]}
      />

      <Group
        title="Safety"
        items={[
          [dash(data.safety.waiting), 'reports waiting'],
          [dash(data.safety.waitingOverAWeek), 'waiting over a week'],
          [dash(data.safety.reportsTotal), 'reports ever filed'],
          [dash(data.safety.byKind.profile), 'about a profile'],
          [dash(data.safety.byKind.prompt), 'about an answer'],
          [dash(data.safety.byKind.photo), 'about a photo'],
          [dash(data.safety.byKind.message), 'about a message'],
          [dash(data.safety.decisions.dismissed), 'closed with nothing done'],
          [dash(data.safety.decisions.removedContent), 'ended in a hold'],
          [dash(data.safety.decisions.suspended), 'ended in a suspension'],
          [dash(data.safety.decisions.banned), 'ended in a ban'],
          [dash(data.safety.blocks), 'blocks placed'],
        ]}
      />

      <Group
        title="Notices"
        items={[
          [dash(data.notices.total), 'notices written'],
          [dash(data.notices.unread), 'still unread'],
          [dash(data.notices.last7Days), 'in the last 7 days'],
          [dash(data.notices.byKind.suggestion), 'about a new card'],
          [dash(data.notices.byKind.message), 'about a message'],
          [dash(data.notices.byKind.revealRequested), 'about an ask'],
          [dash(data.notices.byKind.revealDone), 'about a reveal'],
          [dash(data.notices.studentsWithEmailNoticesOn), 'students on email notices'],
          [dash(data.notices.studentsWhoPausedSuggestions), 'students off new cards'],
        ]}
      />

      <p className="queue-sub">Last 14 days</p>
      <table className="stat-trend">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Joined</th>
            <th scope="col">Chats</th>
            <th scope="col">Messages</th>
            <th scope="col">Reveals</th>
          </tr>
        </thead>
        <tbody>
          {data.trend.map(row => (
            <tr key={row.date}>
              <th scope="row">{row.date}</th>
              <td>{row.accounts}</td>
              <td>{row.chats}</td>
              <td>{row.messages}</td>
              <td>{row.reveals}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="hint">{data.basis.trend}</p>
      <p className="hint">
        <b>Match rate.</b> {data.basis.matchRate}
      </p>
      <p className="hint">
        <b>Reveal rate.</b> {data.basis.revealRate}
      </p>
    </>
  );
}

function Group({ title, items }) {
  return (
    <div className="stat-group">
      <p className="queue-sub">{title}</p>
      <div className="stat-grid">
        {items.map(([value, label]) => (
          <div className="stat" key={label}>
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
