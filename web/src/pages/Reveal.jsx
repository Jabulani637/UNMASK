import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import SafetyActions from '../components/SafetyActions.jsx';
import { api } from '../api.js';
import { subscribeChat } from '../socket.js';

/**
 * FR-5.2 and FR-5.6 — the other side of the door, and the only screen in this app
 * that can show a name or a photo.
 *
 * Both students arrive here from inside their own chat, and each sees the same
 * thing: the profile the other one built, plus the one name they chose to hand
 * over. Nothing on this page is assembled from what the client already had. The
 * whole card comes from GET /api/reveals/:id/profile, which the server answers
 * only when the pair's own row holds two consent timestamps — so this screen
 * cannot be talked into showing a face early, because the request that would have
 * to make it happen is the one that returns 403.
 *
 * The three not-yet states are shown rather than skipped. A reveal is not a
 * loading screen: "they have been asked and have not answered" is the true
 * position, and FR-5.4 says saying not yet is allowed and ends nothing, so this
 * page must be able to say it plainly.
 */
/**
 * Every appearance answer, with the words the form used to ask for it, in the order
 * it asked. Blank answers are dropped rather than printed as a dash: a revealed
 * profile is somebody's own writing, and eleven rows with six of them saying
 * &ldquo;—&rdquo; reads like a mark against them instead of six choices not to say.
 *
 * The identity line is in here and nowhere else it could be used. Both students
 * have said yes at this point, which is the only circumstance this product shows a
 * race to anybody — never on a card, never in a queue, never to a filter.
 */
const LOOK_ROWS = [
  ['I describe myself as', 'identity'],
  ['My body type', 'bodyType'],
  ['My height', 'height'],
  ['How much I drink', 'drinks'],
  ['Smoking', 'smokes'],
  ['How often I am at the gym', 'gym'],
  ['Body types I am after', 'seekBodyTypes'],
  ['Heights I am after', 'seekHeights'],
  ['Drinking I am after', 'seekDrinks'],
  ['Smoking I am after', 'seekSmokes'],
  ['Gym I am after', 'seekGym'],
];

function lookRows(profile) {
  return LOOK_ROWS.map(([label, field]) => {
    const value = profile[field];
    if (!value || (Array.isArray(value) && !value.length)) return null;
    return { label, value: Array.isArray(value) ? value.join(', ') : value };
  }).filter(Boolean);
}

export default function Reveal() {
  const { id } = useParams();

  const mounted = useRef(true);
  const [status, setStatus] = useState('loading');
  const [reveal, setReveal] = useState(null);
  const [profile, setProfile] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * Read the pair's state, then — and only then — their identity.
   *
   * The state comes from the chat thread route because that is the one route a
   * student needs to see this screen at all. The name comes from the reveal
   * route, so the fetch that could return one is never issued while the answer
   * is still 'none' or 'pending'.
   */
  async function load() {
    setBusy(true);
    try {
      const threadData = await api.chats.thread(id);
      if (!mounted.current) return;
      const state = threadData.thread.reveal;
      setReveal(state);

      if (state.status !== 'revealed') {
        setProfile(null);
        setStatus(
          state.status === 'pending' ? (state.askedBy === 'me' ? 'waiting' : 'their-turn') : 'not-yet'
        );
        return;
      }

      const profileData = await api.reveals.profile(id);
      if (!mounted.current) return;
      setProfile(profileData.profile);
      setStatus('ready');
    } catch (err) {
      if (!mounted.current) return;
      setNotice(err.message);
      setStatus(err.status === 404 ? 'gone' : 'error');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    load();

    // The other student's answer lands as one word on the socket, and this screen
    // re-reads the whole position from the API rather than trusting that word.
    const unsubscribe = subscribeChat(frame => {
      if (frame?.type === 'reveal' && (!frame.threadId || frame.threadId === id)) load();
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [id]);

  if (status === 'gone') {
    return (
      <AppShell title="No such chat" intro="That conversation is not one you can open.">
        <Link className="btn block" to="/chats">
          Back to your chats
        </Link>
      </AppShell>
    );
  }

  const awaiting = status === 'waiting' || status === 'their-turn' || status === 'not-yet';
  const look = status === 'ready' && profile ? lookRows(profile) : [];

  return (
    <AppShell
      title={status === 'ready' ? 'Revealed' : 'A reveal takes two yeses'}
      intro={
        status === 'ready'
          ? 'You both said yes, so this is their profile as they wrote it — including the name they chose for this moment.'
          : 'Nothing on this screen unlocks on one press. Until both of you have said yes, there is no name and no photo to show here.'
      }
    >
      {notice ? <p className="server-error" role="alert">{notice}</p> : null}
      {status === 'loading' ? <p className="server-line">Checking whether you have both said yes…</p> : null}

      {status === 'error' ? (
        <div className="stack">
          <p className="server-error" role="alert">{notice || 'That reveal could not be read.'}</p>
          <button className="btn ghost block" type="button" onClick={load} disabled={busy}>
            Try again
          </button>
        </div>
      ) : null}

      {awaiting ? (
        <div className="reveal-stage">
          <p className="reveal-sub">
            {status === 'waiting'
              ? 'Waiting for them to answer'
              : status === 'their-turn'
                ? 'Waiting for you to answer'
                : 'Not revealed'}
          </p>
          <h2 className="reveal-title">{status === 'their-turn' ? 'They asked you' : 'Reveal requested'}</h2>
          <div className="reveal-avatar" aria-hidden="true">
            🎭
          </div>
          <p className="waiting-row">
            {status === 'waiting'
              ? 'Your request is open. They decide when — nobody is made to answer on the spot.'
              : status === 'their-turn'
                ? 'Answer in the chat: yes reveals you both, not yet says so and keeps the conversation open.'
                : 'You have not both said yes yet, so there is nothing here but a mask. Ask from inside the chat when you feel like it.'}
          </p>
          <Link className="btn pink block" to={`/chats/${id}`}>
            Back to the chat
          </Link>
        </div>
      ) : null}

      {status === 'ready' && profile ? (
        <>
          <div className="reveal-stage done">
            <p className="reveal-sub">Revealed — you both said yes</p>
            <h2 className="reveal-title">No more masks</h2>
            <div className="reveal-avatar">
              {profile.hasPhoto ? (
                <img src={api.reveals.photoUrl(id, reveal?.revealedAt)} alt={`${profile.name || 'Their'} photo`} />
              ) : (
                <span aria-hidden="true">🎭</span>
              )}
            </div>
            <p className="reveal-name">
              {profile.name || 'No name given'}
              {profile.age ? `, ${profile.age}` : ''}
            </p>
            <p className="reveal-meta">
              {profile.year} · {profile.faculty} · {profile.institution}
            </p>
            {!profile.name ? (
              <p className="reveal-meta">They left the name field empty, so this is all there is to show.</p>
            ) : null}
          </div>

          <div className="reveal-detail">
            {profile.interests.length ? (
              <div className="shared-interests">
                {profile.interests.map(interest => (
                  <span className="tag" key={interest}>
                    {interest}
                  </span>
                ))}
              </div>
            ) : null}

            {look.length ? (
              // `dt` and `dd` go straight into the grid, which lays them out two
              // columns wide by direct child — a wrapper div around each pair would
              // turn the list into one-column rows.
              <dl className="facts">
                {look.flatMap(row => [
                  <dt key={`${row.label}-q`}>{row.label}</dt>,
                  <dd key={`${row.label}-a`}>{row.value}</dd>,
                ])}
              </dl>
            ) : null}

            {profile.typeNote ? (
              <div>
                <p className="match-ask">Who they are after, in their words</p>
                <p className="match-prompt">&ldquo;{profile.typeNote}&rdquo;</p>
              </div>
            ) : null}

            {profile.prompts.map(row => (
              <div key={row.prompt}>
                <p className="match-ask">{row.prompt}</p>
                <p className="match-prompt">&ldquo;{row.answer}&rdquo;</p>
              </div>
            ))}
          </div>

          <p className="server-line">
            A reveal cannot be taken back — that is what makes it worth something.{' '}
            {profile.name ? `${profile.name} can ` : 'They can '}
            still close the conversation at any time, and your password, your email address and your student number were
            never part of this.
          </p>

          {/*
            FR-6.1 from the one screen that shows a face: this is where a photo or a
            particular answer can actually be *seen*, so it is where they can be named.
            The prompt picker carries an index into the card on screen, and the server
            re-reads that answer from the reported profile rather than from here.
          */}
          <SafetyActions
            matchId={id}
            targets={[
              { kind: 'profile', label: 'Their whole profile' },
              ...(profile.prompts.length
                ? [{ kind: 'prompt', label: 'One of their answers', prompts: profile.prompts }]
                : []),
              ...(profile.hasPhoto ? [{ kind: 'photo', label: 'Their profile photo' }] : []),
            ]}
            label="Something wrong with what you unlocked?"
          />

          <div className="bottom-actions">
            <Link className="btn pink" to={`/chats/${id}`}>
              Keep chatting
            </Link>
            <Link className="btn ghost" to="/chats">
              All my chats
            </Link>
          </div>
        </>
      ) : null}
    </AppShell>
  );
}
