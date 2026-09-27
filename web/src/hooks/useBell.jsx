import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { subscribeChat } from '../socket.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * The nav's unread count, held once for the whole signed-in app.
 * FR-7.
 *
 * It lives above the router screens rather than inside AppShell because the bell in
 * the nav and the list on /notifications are two readers of one number, and a badge
 * that disagrees with the list underneath it is worse than no badge. The page that
 * marks things read is the one that has to tell the nav.
 *
 * The count is always read from the server, never incremented here: a notice can be
 * written by another tab, another device, or by an event that happened while this
 * browser was closed, and a local counter would be wrong in all three cases.
 */

const BellContext = createContext(null);

export function BellProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    if (!user) {
      setUnread(0);
      return;
    }
    try {
      // One row is the cheapest answer /api/notifications gives, and the `unread`
      // beside it is the same count the list screen reads.
      const data = await api.notifications.list(1);
      setUnread(data.unread);
    } catch {
      // A bell that could not be counted keeps showing its last number. Saying "0"
      // on a failed read would be the one wrong answer available here.
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setUnread(0);
      return undefined;
    }

    refresh();

    const deferred = [];
    const later = fn => {
      deferred.push(setTimeout(fn, 1200));
    };

    // The nav is on every signed-in screen, so this subscriber is also what makes
    // the badge live on Match and Profile, where no chat is open. subscribeChat
    // shares one socket, so the chat screens keep working on the same connection.
    const unsubscribe = subscribeChat(frame => {
      if (frame.type !== 'message' && frame.type !== 'reveal') return;
      // The frame goes out before its notice is written — a live message must not
      // wait on a mail server — so this read can land a few milliseconds early. The
      // second one catches the notice that arrived in between.
      refresh();
      later(refresh);
    });

    return () => {
      unsubscribe();
      for (const id of deferred) clearTimeout(id);
    };
  }, [user, location.pathname, refresh]);

  const value = useMemo(() => ({ unread, refresh }), [unread, refresh]);

  return <BellContext.Provider value={value}>{children}</BellContext.Provider>;
}

export function useBell() {
  return useContext(BellContext);
}
