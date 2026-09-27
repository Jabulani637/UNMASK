import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { stopChatSocket } from '../socket.js';

/**
 * Who is signed in, right now.
 *
 * The answer comes from the API, never from anything saved in the browser: the
 * session is an httpOnly cookie the page cannot read, so the only honest check is
 * to ask /api/auth/me. That also means a session revoked server-side — password
 * changed, account suspended, account deleted — is reflected on the next load
 * rather than when a stored token happens to expire.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const me = await api.auth.me();
      setUser(me);
      return me;
    } catch (err) {
      // 401 is the ordinary answer for a visitor who is not signed in, so it is
      // not worth a console warning on every page load.
      if (err.status !== 401) console.warn(err);
      setUser(null);
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      checking,
      refresh,
      async signIn(email, password) {
        const result = await api.auth.signIn({ email, password });
        await refresh();
        return result;
      },
      async signOut() {
        await api.auth.signOut();
        stopChatSocket();
        setUser(null);
      },
    }),
    [user, checking, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
