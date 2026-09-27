import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import SafetyActions from '../components/SafetyActions.jsx';
import { api, ApiError } from '../api.js';

/**
 * FR-3.1 to FR-3.6 — one suggested student, and two things to do about it.
 *
 * What this screen holds is exactly what the server decided a match may be shown:
 * year, faculty, institution, one prompt answer, up to five shared interests, what
 * this student said about how they look and what they are after, a score, and a
 * token. There is no name, no age, no gender, no photo, no race and no id here, so
 * there is nothing on this page that could be read back as a person — and the
 * buttons send the token rather than an id, which is why a tampered page still
 * cannot ask about somebody it was never shown (NFR-3.3).
 */
/**
 * The two appearance rows on a card, worked out once rather than inlined twice.
 *
 * A blank is left out instead of printed: a card that reads "Curvy · drinks
 * socially" says something, and one that reads "— · — · nothing said" is a form
 * asking to be filled in. Someone who answered none of it simply has no row, which
 * is the same outcome as a student who has written no prompt answer.
 */
function lookRows(card) {
  const look = card.look || {};
  const about = [
    look.bodyType,
    look.height,
    look.drinks && `drinks: ${look.drinks}`,
    look.smokes && `smokes: ${look.smokes}`,
    look.gym && `gym: ${look.gym}`,
  ].filter(Boolean);

  const after = card.after || {};
  const seeks = [
    ...(after.bodyTypes || []),
    ...(after.heights || []),
    ...(after.drinks || []).map(value => `drinks: ${value}`),
    ...(after.smokes || []).map(value => `smokes: ${value}`),
    ...(after.gym || []).map(value => `gym: ${value}`),
  ];

  return { about, seeks, note: after.note || null };
}

export default function Match() {
  const mounted = useRef(true);
  const [state, setState] = useState({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function load() {
    setBusy(true);
    setNotice(null);
    try {
      const data = await api.matching.suggestion();
      if (mounted.current) apply(data);
    } catch (err) {
      if (!mounted.current) return;
      setState(
        err instanceof ApiError && err.code === 'profile_incomplete'
          ? { status: 'not-ready', message: err.message }
          : { status: 'error', message: err.message }
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** The suggestion and the pass answer carry the same shape, so both land here. */
  function apply(data) {
    setState(
      data.suggestion
        ? { status: 'card', suggestion: data.suggestion, waiting: data.waiting }
        : { status: 'empty', message: data.message }
    );
  }

  async function onPass() {
    const token = state.suggestion?.token;
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      const data = await api.matching.pass(token);
      if (mounted.current) apply(data);
    } catch (err) {
      if (!mounted.current) return;
      // A declined-elsewhere or edited card is not a dead end: the next line asks
      // for the current suggestion, which is the one this screen should show.
      setNotice(err.message);
      if (err instanceof ApiError && err.code === 'stale_suggestion') await load();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function onConnect() {
    const token = state.suggestion?.token;
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      const data = await api.matching.connect(token);
      if (!mounted.current) return;
      setState({ status: 'connected', message: data.message, threadId: data.match.id });
    } catch (err) {
      if (!mounted.current) return;
      setNotice(err.message);
      // A closed pair means the same thing as a stale card: this suggestion is no
      // longer the one to show, so ask for the current one.
      if (err instanceof ApiError && (err.code === 'stale_suggestion' || err.code === 'thread_closed')) await load();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const card = state.suggestion;
  const look = card ? lookRows(card) : null;

  return (
    <AppShell
      title="One suggested student"
      intro="We show you one person at a time, chosen on what your two profiles actually share. Their name, age and photo stay hidden — from this screen and from them."
    >
      {notice ? <p className="server-error" role="alert">{notice}</p> : null}

      {state.status === 'loading' ? <p className="server-line">Looking for the best fit…</p> : null}

      {state.status === 'not-ready' || state.status === 'error' ? (
        <div className="stack">
          <p className="server-line">{state.message}</p>
          {state.status === 'not-ready' ? (
            <Link className="btn pink block" to="/profile">
              Finish my profile
            </Link>
          ) : null}
          <button className="btn ghost block" type="button" onClick={load} disabled={busy}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === 'empty' ? (
        <div className="stack">
          <p className="server-line">{state.message}</p>
          <Link className="btn blue block" to="/profile">
            Edit my profile
          </Link>
          <button className="btn ghost block" type="button" onClick={load} disabled={busy}>
            Check again
          </button>
        </div>
      ) : null}

      {state.status === 'connected' ? (
        <div className="stack">
          <p className="server-ok" role="status">{state.message}</p>
          <p className="server-line">
            Your chat is open, and it opens for them the same second. Neither of you can see the other's name or photo
            yet — that takes both of you saying yes, inside the conversation.
          </p>
          <Link className="btn pink block" to={`/chats/${state.threadId}`}>
            Open the chat
          </Link>
          <Link className="btn ghost block" to="/chats">
            All my chats
          </Link>
          <button className="btn ghost block" type="button" onClick={load} disabled={busy}>
            Show me another
          </button>
        </div>
      ) : null}

      {card ? (
        <div aria-live="polite">
          <div className="match-header">
            <h2>Your suggestion</h2>
            <span className="compat-badge">{card.score}% match</span>
          </div>

          <div className="match-card">
            <div className="silhouette" aria-hidden="true">
              🎭
            </div>
            <p className="match-meta">
              <b>{card.year}</b> · {card.faculty} · {card.institution}
            </p>
            {look.about.length ? <p className="match-look">{look.about.join(' · ')}</p> : null}
            {card.prompt ? (
              <>
                <p className="match-ask">{card.prompt.prompt}</p>
                <p className="match-prompt">&ldquo;{card.prompt.answer}&rdquo;</p>
              </>
            ) : null}
            <div className="shared-interests">
              {card.sharedInterests.length ? (
                card.sharedInterests.map(interest => (
                  <span className="tag" key={interest}>
                    {interest}
                  </span>
                ))
              ) : (
                <span className="match-none">Nothing on the list in common — which is not the same as nothing to say.</span>
              )}
            </div>

            {/*
              Whose preference this is, said in the heading rather than left to be
              guessed: a row of pills under a stranger's profile reads, without a
              label, like a description of *them*. It is the opposite — this is what
              they would like to meet, and it is only ever a nudge in their own list,
              never a rule about anybody else's.
            */}
            {look.seeks.length ? (
              <>
                <p className="match-ask">Who they are after</p>
                <div className="match-seeks">
                  {look.seeks.map((text, index) => (
                    <span className="tag ghost" key={`${text}-${index}`}>
                      {text}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            {look.note ? (
              <>
                <p className="match-ask">In their words</p>
                <p className="match-note">&ldquo;{look.note}&rdquo;</p>
              </>
            ) : null}
          </div>

          <p className="server-line match-count">
            {state.waiting > 1 ? `${state.waiting - 1} other student${state.waiting - 1 === 1 ? '' : 's'} also fit you right now.` : 'This is the only student who fits you right now.'}
          </p>

          <div className="match-actions">
            <button className="btn ghost" type="button" onClick={onPass} disabled={busy}>
              {busy ? 'Working…' : 'Show another'}
            </button>
            <button className="btn blue" type="button" onClick={onConnect} disabled={busy}>
              Start chatting
            </button>
          </div>

          {/*
            FR-6.1's most important report, filed before anybody has agreed to chat:
            "this is not a student at a verified institution" has to be sayable while the card is still the
            only thing you know about them. It is keyed to the token so the panel is
            rebuilt when the card changes — a report must name the card on screen, and
            after a pass that is a different student.
          */}
          <SafetyActions
            key={card.token}
            token={card.token}
            targets={[{ kind: 'profile', label: 'This profile, before I connect' }]}
            label="Something wrong with this card?"
          />
        </div>
      ) : null}
    </AppShell>
  );
}
