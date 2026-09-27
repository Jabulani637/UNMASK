import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { api } from '../api.js';
import { subscribeChat } from '../socket.js';
import { ago } from '../time.js';

/**
 * FR-4.1 — the conversations a student is in.
 *
 * Each row is a pair, and each row says what a pair is allowed to say: the year,
 * faculty and institution the two of them were shown on the card that started it, and
 * — only once both of them have said yes — the reveal name the other one chose
 * (FR-5.2). Before that there is no name in this list because the API does not
 * send one (FR-4.3): the screen is not hiding anything, it simply was never told.
 *
 * A row that has been closed stays here. FR-4.5 keeps the history until the
 * student deletes it, and a conversation you ended is still one you may want to
 * read again, so the honest answer is to list it and label it.
 */
export default function Chats() {
  const [state, setState] = useState({ status: 'loading' });
  const [live, setLive] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const data = await api.chats.list();
        if (mounted) setState({ status: 'ready', threads: data.threads });
      } catch (err) {
        if (mounted) setState({ status: 'error', message: err.message });
      }
    }

    load();

    // A thread that opens while this list is on screen should appear in it.
    const unsubscribe = subscribeChat(frame => {
      if (!mounted) return;
      if (frame.type === 'socket-open') setLive(true);
      if (frame.type === 'socket-closed') setLive(false);
      if (frame.type === 'message' || frame.type === 'closed' || frame.type === 'reveal') load();
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const threads = state.threads || [];

  return (
    <AppShell
      title="Your chats"
      intro="Every conversation you have started. A row has no name on it until you both agree to reveal — and the moment one appears, it is because the two of you said yes."
    >
      {state.status === 'loading' ? <p className="server-line">Opening your threads…</p> : null}

      {state.status === 'error' ? (
        <p className="server-error" role="alert">{state.message}</p>
      ) : null}

      {state.status === 'ready' && !threads.length ? (
        <div className="stack">
          <p className="server-line">
            No conversations yet. When you press <b>Start chatting</b> on a suggestion, the thread appears here — and
            the other student sees it the same moment.
          </p>
          <Link className="btn pink block" to="/match">
            Find my match
          </Link>
        </div>
      ) : null}

      {threads.length ? (
        <>
          <p className="chat-live" aria-live="polite">
            {live ? 'Live — new messages arrive while this page is open.' : 'Reconnecting… your messages still send.'}
          </p>
          <ul className="thread-list">
            {threads.map(thread => (
              <li key={thread.id}>
                <Link className="thread-row" to={`/chats/${thread.id}`}>
                  <span className="silhouette small" aria-hidden="true">
                    🎭
                  </span>
                  <span className="thread-body">
                    <span className="thread-who">
                      {thread.peer.revealed
                        ? thread.peer.name || 'Revealed without a name'
                        : thread.peer.faculty
                          ? `${thread.peer.year} · ${thread.peer.faculty}`
                          : 'A student who has gone'}
                      {thread.peer.revealed ? <em className="thread-revealed">revealed</em> : null}
                      {thread.status === 'closed' ? <em className="thread-closed">closed</em> : null}
                    </span>
                    <span className="thread-last">
                      {thread.last ? `${thread.last.from === 'me' ? 'You: ' : ''}${thread.last.body}` : 'No messages yet.'}
                    </span>
                  </span>
                  <span className="thread-when">{ago(thread.lastActivity)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {state.status === 'ready' && threads.length ? (
        <Link className="btn ghost block" to="/match">
          Look for someone new
        </Link>
      ) : null}
    </AppShell>
  );
}
