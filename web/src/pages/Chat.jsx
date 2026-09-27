import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import SafetyActions from '../components/SafetyActions.jsx';
import { api } from '../api.js';
import { sendChatFrame, subscribeChat, watchThread } from '../socket.js';
import { clockTime } from '../time.js';

/**
 * FR-4.1 to FR-4.5 — one anonymous thread, live.
 *
 * The bubble on the right is yours and the one on the left is theirs. Until both
 * of you press yes to a reveal, that is the entire extent of what this screen
 * knows about the other person: the server's frames say `me` and `them`, and
 * carry no account id, no name and no photo (FR-4.3, NFR-3.3). So the page has no
 * avatar to hide, no name to blank out and nothing in its state that could be
 * read out of devtools. What it cannot see, it cannot leak.
 *
 * FR-5.2 is the one exception, and it is gated twice over: this screen fetches a
 * name only after the thread's own state says `revealed`, and the only name the
 * server can answer with is the one the other student typed into their own
 * profile. An account id, an email address and a photo filename still never
 * appear here, before or after.
 *
 * There is no typing indicator, no "seen" tick and no online dot. Each of those
 * is a timestamp about one specific person's habits, and NFR-3.3 bans identity
 * that can be inferred from metadata — a seen receipt at 21:14 narrows a faculty
 * of a few thousand down to a body in a specific residence.
 *
 * Sending goes over the socket and falls back to REST. A phone on a lecture-hall
 * connection is the normal case for this product, not the exception, so the
 * socket being down has to be a slower send rather than a broken one.
 */
export default function Chat() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [status, setStatus] = useState('loading');
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState(null);
  // One line for the last thing the server said, tagged with whether it was good news:
  // a reveal landing and a refused send are not the same announcement and must not be
  // painted the same colour or announced with the same urgency.
  const say = (text, ok = false) => setNotice({ text, ok });
  const [live, setLive] = useState(false);
  const [maxBody, setMaxBody] = useState(null);
  const [confirming, setConfirming] = useState(null);
  // FR-5.2: the other student's profile, once the pair's own row says both of you
  // said yes. null is "not revealed", and there is no local guess in between —
  // this screen never learns a name from anything but the reveal route.
  const [revealed, setRevealed] = useState(null);
  const [revealBusy, setRevealBusy] = useState(false);

  const log = useRef(null);
  const pinned = useRef(true);
  const restoreScroll = useRef(null);
  // A frame that lands while this student is on another screen has to reach their
  // ears too, so the newest one from `them` is kept for a live region below.
  const [announce, setAnnounce] = useState('');
  const lastAnnounced = useRef(null);

  /**
   * Re-read the thread's *state* — not its messages.
   *
   * A reveal frame says one word, and this goes and asks the API what it means,
   * because the answer that matters (has one side asked, have both) is the pair's
   * row and not anything the socket is allowed to carry. The message list is left
   * exactly as it stands, so a bubble still waiting for its echo is not wiped by a
   * refresh that happened to arrive first.
   */
  async function refreshReveal() {
    try {
      const data = await api.chats.thread(id);
      setThread(data.thread);
    } catch (err) {
      say(err.message);
    }
  }

  useEffect(() => {
    watchThread(id);
    return () => watchThread(null);
  }, [id]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const data = await api.chats.thread(id);
        if (!mounted) return;
        setThread(data.thread);
        setMessages(data.messages);
        setHasMore(data.hasMore);
        setStatus('ready');
      } catch (err) {
        if (mounted) setStatus(err.status === 404 ? 'gone' : 'error');
        if (mounted) say(err.message);
      }
    }

    load();
    api.meta().then(meta => mounted && setMaxBody(meta.minimums.messageMax)).catch(() => {});

    const unsubscribe = subscribeChat(frame => {
      if (!mounted || !frame) return;

      if (frame.type === 'socket-open') return setLive(true);
      if (frame.type === 'socket-closed') return setLive(false);
      if (frame.threadId && frame.threadId !== id) return;

      if (frame.type === 'message') {
        settle(frame.message, frame.tempId);
      }

      if (frame.type === 'closed') {
        // FR-4.4: the thread is over and this says so — without a name, because
        // the server never sent one.
        setThread(row => (row ? { ...row, status: 'closed', closedNotice: 'This conversation has been closed. You can still read it.' } : row));
      }

      if (frame.type === 'reveal') {
        // FR-5.3: the request arrives by itself, and the state behind it is read
        // back from the API. Nobody is forced into answering on the spot — this
        // only moves the band from "ask" to "answer".
        refreshReveal();
        if (frame.event === 'revealed') {
          say('You both said yes. Your names and photos are open to each other now.', true);
        }
      }

      if (frame.type === 'error' && frame.tempId) {
        const failed = frame;
        setMessages(list => {
          const row = list.find(item => item.tempId === failed.tempId);
          if (row) setDraft(row.body);
          return list.filter(item => item.tempId !== failed.tempId);
        });
        say(failed.retryAfterSeconds ? `${failed.error} (wait ${failed.retryAfterSeconds}s)` : failed.error);
      }

      return undefined;
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [id]);

  /**
   * The name and the face, read from the one route allowed to give them — and
   * only once the thread's own state says both of you agreed. Before that this
   * fetch does not happen at all, so a screen cannot show a name by being tricked
   * into asking for it early: there is nothing in its state to show.
   */
  useEffect(() => {
    if (thread?.reveal?.status !== 'revealed') {
      setRevealed(null);
      return undefined;
    }

    let alive = true;
    api.reveals
      .profile(id)
      .then(data => alive && setRevealed(data.profile))
      .catch(() => alive && setRevealed(null));

    return () => {
      alive = false;
    };
  }, [id, thread?.reveal?.status]);

  /** A frame is placed by id, or a pending bubble is replaced by its temp id. */
  function settle(message, tempId) {
    if (!tempId && message.from === 'them' && lastAnnounced.current !== message.id) {
      lastAnnounced.current = message.id;
      setAnnounce(message.body);
    }
    setMessages(list => {
      if (tempId) {
        const at = list.findIndex(row => row.tempId === tempId);
        if (at >= 0) {
          const next = [...list];
          next[at] = message;
          return next;
        }
      }
      if (list.some(row => row.id === message.id)) return list;
      return [...list, message];
    });
  }

  // Keeping up with yourself: scroll to the newest message, unless the student
  // has scrolled up to read something older — then leave them where they are.
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    if (restoreScroll.current !== null) {
      el.scrollTop = el.scrollHeight - restoreScroll.current;
      restoreScroll.current = null;
      return;
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll() {
    const el = log.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  async function onOlder() {
    const oldest = messages[0];
    if (!oldest) return;
    setNotice(null);
    try {
      const data = await api.chats.thread(id, { before: oldest.at, beforeId: oldest.id });
      restoreScroll.current = (log.current?.scrollHeight || 0) - (log.current?.scrollTop || 0);
      setMessages(list => [...data.messages, ...list]);
      setHasMore(data.hasMore);
    } catch (err) {
      say(err.message);
    }
  }

  async function onSend(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || thread?.status !== 'open') return;

    const tempId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    pinned.current = true;
    setMessages(list => [...list, { tempId, from: 'me', body: text, at: new Date().toISOString(), pending: true }]);
    setDraft('');
    setNotice(null);

    if (sendChatFrame({ type: 'send', matchId: id, body: text, tempId })) return;

    // No socket: the same write, over HTTP. The API pushes it to the other
    // student from here too, so a send never depends on a live connection.
    try {
      const data = await api.chats.send(id, text);
      settle(data.message, tempId);
    } catch (err) {
      setMessages(list => list.filter(row => row.tempId !== tempId));
      setDraft(text);
      say(err.message);
    }
  }

  /** FR-4.4 — end it. Two presses, because the word "end" means what it says. */
  async function onLeave() {
    try {
      const data = await api.chats.leave(id);
      setThread(row => ({ ...row, status: 'closed', closedNotice: 'This conversation has been closed. You can still read it.' }));
      say(data.message, true);
    } catch (err) {
      say(err.message);
    }
    setConfirming(null);
  }

  /** FR-4.5 — clear my copy. The other student keeps theirs, and says so. */
  async function onClear() {
    try {
      const data = await api.chats.clear(id);
      setMessages([]);
      setHasMore(false);
      setThread(row => ({ ...row, clearedNotice: data.message }));
      say(data.message, true);
    } catch (err) {
      say(err.message);
    }
    setConfirming(null);
  }

  /**
   * One press of one of the three buttons below.
   *
   * The API answers with the pair's whole reveal state, so the band re-renders
   * from what the server actually recorded rather than from what this click was
   * meant to cause. That matters most when both students press at the same
   * moment: the second write returns `revealed`, and this screen shows that.
   */
  function applyReveal(data) {
    setThread(row => (row ? { ...row, reveal: data.reveal } : row));
    if (data.message) say(data.message, true);
    setRevealBusy(false);
  }

  async function runReveal(action) {
    setRevealBusy(true);
    setNotice(null);
    try {
      applyReveal(await action());
    } catch (err) {
      say(err.message);
      setRevealBusy(false);
    }
  }

  /** FR-5.1 / FR-5.3 — ask, answer, or take the ask back. */
  function onAsk() {
    return runReveal(() => api.reveals.ask(id));
  }
  function onAnswer(accept) {
    return runReveal(() => api.reveals.answer(id, accept));
  }
  function onRevoke() {
    return runReveal(() => api.reveals.revoke(id));
  }

  /**
   * FR-6.2, from this screen's side.
   *
   * The block itself closes the thread through the same service an End-chat calls,
   * and the other student's browser gets the same one-word `closed` frame it would
   * have got either way. Locally this writes the identical banner, because from the
   * blocker's own point of view a block and a walk-away are the same result: a
   * conversation that is over and still readable.
   */
  function onBlocked() {
    setThread(row =>
      row ? { ...row, status: 'closed', closedNotice: 'This conversation has been closed. You can still read it.' } : row
    );
  }

  const open = thread?.status === 'open';
  // FR-6.1's message target: only the other student's own, already-loaded bubbles
  // can be named, and only the ones with a server id behind them. The API re-reads
  // the body from the database either way — a report is not made of words this page
  // typed into a request — so the picker is a convenience, not evidence.
  const theirs = messages.filter(row => row.from === 'them' && row.id);
  const remaining = maxBody ? maxBody - draft.length : null;
  // FR-4.5: this student's copy is emptied, so the page must not claim the
  // thread is untouched — nor invite them to "say something" into a blank that
  // the other student can already fill.
  const clearedAndEmpty = messages.length === 0 && Boolean(thread?.clearedNotice);

  const reveal = thread?.reveal || null;
  const askedByMe = reveal?.askedBy === 'me';
  // A declined or revoked ask falls back to status 'none', and the timestamps the
  // pair's row kept are what lets this say what happened instead of offering the
  // same button again as if nothing had.
  const answered = reveal?.status === 'none' ? reveal.answeredBy : null;
  const prior = answered
    ? answered.action === 'declined'
      ? answered.by === 'me'
        ? 'You said not yet. They have been told the answer, not a reason.'
        : 'They said not yet. Nothing is unlocked, and you can keep chatting.'
      : answered.by === 'me'
        ? 'You cancelled your own request.'
        : 'They took their request back.'
    : null;

  /**
   * The one band between the log and the composer (FR-5.1, FR-5.3, FR-5.4).
   *
   * It shows whatever the pair's row currently says and nothing else: it never
   * infers that an answer is owed, and it never promises a reveal the other
   * student has not agreed to.
   */
  let band = null;
  if (open && reveal) {
    if (reveal.status === 'revealed') {
      band = (
        <div className="reveal-prompt done">
          <p>You both said yes. Their name, their profile and their photo are open to you now.</p>
          <Link className="btn ghost small" to={`/chats/${id}/reveal`}>
            See what you unlocked
          </Link>
        </div>
      );
    } else if (reveal.status === 'pending' && askedByMe) {
      band = (
        <div className="reveal-prompt">
          <p>You asked. Nothing unlocks until they answer, and they can take as long as they want.</p>
          <button className="btn ghost small" type="button" onClick={onRevoke} disabled={revealBusy}>
            {revealBusy ? 'Cancelling…' : 'Cancel my request'}
          </button>
        </div>
      );
    } else if (reveal.status === 'pending') {
      band = (
        <div className="reveal-prompt">
          <p>They would like to reveal. Say yes only if you want your profile, your photo and your reveal name to reach them.</p>
          <div className="row">
            <button className="btn pink small" type="button" onClick={() => onAnswer(true)} disabled={revealBusy}>
              {revealBusy ? 'Opening…' : 'Yes, reveal us'}
            </button>
            <button className="btn ghost small" type="button" onClick={() => onAnswer(false)} disabled={revealBusy}>
              Not yet
            </button>
          </div>
        </div>
      );
    } else if (reveal.canAsk) {
      band = (
        <div className="reveal-prompt">
          {prior ? <p className="reveal-prior">{prior}</p> : null}
          <p>Feeling it? You can ask to reveal profiles now — nothing happens unless they say yes.</p>
          <button className="btn ghost small" type="button" onClick={onAsk} disabled={revealBusy}>
            {revealBusy ? 'Asking…' : 'Ask to reveal'}
          </button>
        </div>
      );
    } else if (reveal.askBlocked) {
      band = (
        <div className="reveal-prompt quiet">
          {prior ? <p className="reveal-prior">{prior}</p> : null}
          <p>{reveal.askBlocked}</p>
        </div>
      );
    }
  }

  if (status === 'gone') {
    return (
      <AppShell title="No such chat" intro="That conversation is not one you can open.">
        <Link className="btn block" to="/chats">
          Back to your chats
        </Link>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Chat"
      intro={
        reveal?.status === 'revealed'
          ? 'You have both agreed, so their reveal name, their profile and their photo show here. What you signed in with still never does.'
          : "An anonymous thread. Neither of you can see the other's name or photo here until you both agree to a reveal."
      }
      wide
    >
      {/* While the thread itself failed to open, the block below carries the sentence;
          showing it here too would have a screen reader say it twice. */}
      {notice && status !== 'error' ? (
        <p className={notice.ok ? 'server-ok' : 'server-error'} role={notice.ok ? 'status' : 'alert'}>
          {notice.text}
        </p>
      ) : null}

      {status === 'loading' ? <p className="server-line">Opening the thread…</p> : null}

      {status === 'error' ? (
        <p className="server-error" role="alert">{notice?.text || 'That thread would not open.'}</p>
      ) : null}

      {thread ? (
        <div className="chat-shell">
          <header className="chat-head">
            {revealed?.hasPhoto ? (
              <span className="silhouette">
                <img src={api.reveals.photoUrl(id, reveal?.revealedAt)} alt={`${revealed.name || 'Their'} photo`} />
              </span>
            ) : (
              <span className="silhouette" aria-hidden="true">
                🎭
              </span>
            )}
            <div className="chat-head-text">
              <b>
                {revealed
                  ? `${revealed.name || 'No name given'}${revealed.age ? `, ${revealed.age}` : ''}`
                  : thread.peer.faculty
                    ? `${thread.peer.year} · ${thread.peer.faculty}`
                    : 'Anonymous student'}
              </b>
              <span>
                {thread.peer.institution ? `${thread.peer.institution} · ` : ''}
                {revealed ? 'revealed — you both said yes' : 'still anonymous until you both reveal'}
              </span>
            </div>
            <span className={`chat-wire ${live ? 'on' : ''}`}>{live ? 'live' : 'offline'}</span>
          </header>

          {!open ? (
            <div className="chat-banner">
              {thread.closedNotice || 'This conversation has been closed.'}
              <Link to="/match">Find someone new</Link>
            </div>
          ) : null}

          {/* The log is not a live region: it loads older messages at the top, and
              those would then be read out as if they had just arrived. This line
              carries only the newest frame from the other student. */}
          <p className="sr-only" role="status">
            {announce ? `Them: ${announce}` : ''}
          </p>

          <div className="chat-log" ref={log} onScroll={onScroll}>
            {hasMore ? (
              <button className="btn ghost small block" type="button" onClick={onOlder}>
                Older messages
              </button>
            ) : null}

            {hasMore ? null : (
              <p className="chat-start">
                {clearedAndEmpty
                  ? thread.clearedNotice
                  : 'This is the start of your conversation, opened from a match.'}
              </p>
            )}

            {messages.map(row => (
              <p
                key={row.id || row.tempId}
                className={`bubble ${row.from} ${row.pending ? 'pending' : ''}`}
                title={clockTime(row.at)}
              >
                {row.body}
                <span className="bubble-time">{clockTime(row.at)}</span>
              </p>
            ))}

            {!messages.length && !hasMore && !clearedAndEmpty ? (
              <p className="server-line">No messages yet. Say something.</p>
            ) : null}
          </div>

          {band}

          {open ? (
            <form className="chat-input-row" onSubmit={onSend}>
              <label className="sr-only" htmlFor="draft">
                Your message
              </label>
              <input
                id="draft"
                autoComplete="off"
                maxLength={maxBody || undefined}
                placeholder="Say something…"
                value={draft}
                onChange={event => setDraft(event.target.value)}
              />
              {remaining !== null && draft.length > remaining - 120 ? (
                <span className="chat-count">{remaining}</span>
              ) : null}
              <button className="send-btn" type="submit" aria-label="Send message" disabled={!draft.trim()}>
                ➤
              </button>
            </form>
          ) : (
            <p className="chat-closed-note">Closed threads keep their history and take no new messages.</p>
          )}
        </div>
      ) : null}

      {thread ? (
        <div className="thread-actions">
          {open ? (
            confirming === 'leave' ? (
              <div className="stack">
                <p className="server-line">
                  End this chat? The other student is told the conversation closed — not that you closed it, and not
                  why.
                </p>
                <div className="row">
                  <button className="btn pink" type="button" onClick={onLeave}>
                    Yes, end it
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setConfirming(null)}>
                    Keep chatting
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn ghost" type="button" onClick={() => setConfirming('leave')}>
                End chat
              </button>
            )
          ) : null}

          {confirming === 'clear' ? (
            <div className="stack">
              <p className="server-line">
                Clear your copy of this conversation? Nothing is deleted from the other student's side — that is their
                copy to keep.
              </p>
              <div className="row">
                <button className="btn pink" type="button" onClick={onClear}>
                  Yes, clear mine
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirming(null)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button className="btn ghost" type="button" onClick={() => setConfirming('clear')} disabled={!messages.length}>
              Clear my copy
            </button>
          )}

          <Link className="btn ghost" to="/chats">
            All chats
          </Link>

          {/*
            FR-6.1 and FR-6.2 beside FR-4.4's own button, because a student who is
            being harassed reads this row looking for a way out. Both of these work
            on a closed thread too: something said weeks ago can still be reported,
            and a block that arrives late is still a block.
          */}
          <div className="thread-safety">
            <SafetyActions
              matchId={id}
              targets={[
                { kind: 'profile', label: 'Their profile' },
                ...(theirs.length
                  ? [{ kind: 'message', label: 'One of their messages', messages: theirs.map(row => ({ id: row.id, body: row.body })) }]
                  : []),
              ]}
              onBlocked={onBlocked}
              label="Something wrong here?"
            />
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
