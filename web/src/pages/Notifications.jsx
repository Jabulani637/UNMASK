import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { api } from '../api.js';
import { subscribeChat } from '../socket.js';
import { useBell } from '../hooks/useBell.jsx';
import { ago } from '../time.js';

/**
 * FR-7 — the bell, opened.
 *
 * Every sentence here was written by the server (services/notifications.js owns the
 * wording), which is why this screen has no idea who a notice is about. It renders
 * what it is told and links what it is given: a notice with a `threadId` can be
 * turned into a link to that conversation because the id is the pair's own, and the
 * chat API already refuses it to anyone who is not half of it. A notice with no
 * thread id is the "someone new fits you" nudge, and the only honest place to send
 * that is the Match screen.
 *
 * Nothing here says who sent a message or when they read one. NFR-3.3 bans a seen
 * receipt, and this list is the place a developer is most tempted to add one — the
 * server has a read marker per notice, and it stays out of the other student's
 * hands.
 */

const KIND_LABEL = {
  suggestion: 'A new match',
  message: 'A new message',
  'reveal-request': 'A reveal asked',
  'reveal-done': 'A reveal ready',
};

export default function Notifications() {
  const { refresh } = useBell();
  const [state, setState] = useState({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const data = await api.notifications.list();
        if (mounted) setState({ status: 'ready', rows: data.notifications, unread: data.unread });
      } catch (err) {
        if (mounted) setState({ status: 'error', message: err.message });
      }
    }

    load();

    const deferred = [];
    // Something arrived while this list is on screen.
    const unsubscribe = subscribeChat(frame => {
      if (!mounted) return;
      if (frame.type !== 'message' && frame.type !== 'reveal') return;
      load();
      // The frame is published before its notice is written, so a second read catches
      // the row that lands just after it.
      deferred.push(setTimeout(load, 1200));
    });

    return () => {
      mounted = false;
      unsubscribe();
      for (const id of deferred) clearTimeout(id);
    };
  }, []);

  async function onMarkAll() {
    setBusy(true);
    setProblem(null);
    try {
      await api.notifications.read('all');
      // The rows themselves change state, and the nav's badge has to agree with
      // them — one number, two readers.
      setState(prev => ({
        status: 'ready',
        rows: (prev.rows || []).map(row => ({ ...row, readAt: row.readAt || new Date().toISOString() })),
        unread: 0,
      }));
      await refresh();
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onMarkOne(id) {
    setProblem(null);
    try {
      await api.notifications.read([id]);
      setState(prev => ({
        ...prev,
        rows: (prev.rows || []).map(row => (row.id === id ? { ...row, readAt: new Date().toISOString() } : row)),
        unread: Math.max(0, (prev.unread || 1) - 1),
      }));
      await refresh();
    } catch (err) {
      setProblem(err.message);
    }
  }

  const rows = state.rows || [];
  const unread = state.unread || 0;

  return (
    <AppShell
      title="Your notifications"
      intro="What Unmask judged worth telling you. None of these sentences name anyone — a notice is written before any reveal has happened, and it stays true afterwards."
    >
      {state.status === 'loading' ? <p className="server-line">Opening your bell…</p> : null}
      {state.status === 'error' ? <p className="server-error" role="alert">{state.message}</p> : null}
      {problem ? <p className="server-error" role="alert">{problem}</p> : null}

      {state.status === 'ready' && !rows.length ? (
        <p className="server-line">
          Nothing yet. You will hear from this screen when a message arrives, when someone asks to reveal, or when the
          matching engine has someone new for you — and only through the channels you have switched on in{' '}
          <Link to="/account">Account</Link>.
        </p>
      ) : null}

      {rows.length ? (
        <>
          <div className="bell-head">
            <p className="chat-live" aria-live="polite">
              {unread ? `${unread} unread.` : 'All caught up.'}
            </p>
            {unread ? (
              <button className="btn ghost small" type="button" onClick={onMarkAll} disabled={busy}>
                {busy ? 'Marking…' : 'Mark all read'}
              </button>
            ) : null}
          </div>

          <ul className="notif-list">
            {rows.map(row => {
              const href = row.threadId ? `/chats/${row.threadId}` : '/match';
              const link = row.threadId ? (
                <Link className="notif-body" to={href} onClick={() => !row.readAt && onMarkOne(row.id)}>
                  <span className="notif-kind">{KIND_LABEL[row.kind] || 'Something happened'}</span>
                  <span className="notif-text">{row.body}</span>
                </Link>
              ) : (
                <div className="notif-body">
                  <span className="notif-kind">{KIND_LABEL[row.kind] || 'Something happened'}</span>
                  <span className="notif-text">{row.body}</span>
                </div>
              );

              return (
                <li key={row.id} className={row.readAt ? 'notif-row' : 'notif-row notif-unread'}>
                  {link}
                  <span className="notif-when">{ago(row.at)}</span>
                  {row.readAt ? (
                    <span className="notif-seen">read</span>
                  ) : (
                    <button className="btn ghost small" type="button" onClick={() => onMarkOne(row.id)}>
                      Mark read
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <p className="hint">
            The other student cannot see any of this. A notification is a note to you about your own inbox: there is no
            read receipt, no online dot, and nothing here that arrives sooner for one half of a conversation than the
            other.
          </p>
        </>
      ) : null}
    </AppShell>
  );
}
