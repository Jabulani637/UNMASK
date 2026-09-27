import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useBell } from '../hooks/useBell.jsx';

/**
 * The frame around every screen after the landing page.
 *
 * The nav says who is signed in rather than showing a generic avatar, because on
 * this site the email is the only part of you that exists before a reveal — and
 * it is the one thing the account screens let you act on.
 */
export default function AppShell({ title, intro, children, wide }) {
  const { user } = useAuth();
  // One count for the whole signed-in app, kept by the provider above the routes, so
  // the badge and /notifications can never disagree about how many you have not seen.
  const { unread } = useBell();

  return (
    <>
      <a className="skiplink" href="#main">
        Skip to content
      </a>

      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <Link className="wordmark" to="/">
            Unmask<span className="dot">.</span>
          </Link>
          <div className="nav-links">
            {user ? (
              <>
                <Link to="/account">{user.email}</Link>
                <Link className="keep" to="/match">
                  Match
                </Link>
                <Link className="keep" to="/chats">
                  Chats
                </Link>
                {/*
                  FR-7's badge. The number is the server's unread count, not a tally
                  kept in this tab, so another device's message is counted here too.
                */}
                <Link
                  className="keep bell"
                  to="/notifications"
                  aria-label={unread ? `Bell, ${unread} unread` : 'Bell'}
                >
                  Bell
                  {unread ? (
                    <span className="bell-count" aria-hidden="true">
                      {unread > 9 ? '9+' : unread}
                    </span>
                  ) : null}
                </Link>
                <Link className="keep" to="/profile">
                  Profile
                </Link>
                {/*
                  Offered to the accounts the server called staff and to nobody else.
                  This is a convenience, not a gate: the queue's own routes answer 404
                  to a student, so hiding the link keeps a confusing door out of the
                  nav rather than locking anything.
                */}
                {user.staff ? (
                  <Link className="keep" to="/staff">
                    Staff queue
                  </Link>
                ) : null}
                <Link className="btn pink small cta" to="/account">
                  Account
                </Link>
              </>
            ) : (
              <>
                <Link to="/login">Sign in</Link>
                <Link className="btn pink small cta" to="/signup">
                  Create profile
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      <main id="main" className="auth-page">
        <div className="wrap">
          <header className="auth-head">
            <h1 className="display">{title}</h1>
            {intro ? <p className="section-sub">{intro}</p> : null}
          </header>
          <div className={wide ? 'auth-card wide' : 'auth-card'}>{children}</div>
        </div>
      </main>

      <footer className="footer">
        <span>
          Unmask · for students at verified institutions · your name and photo stay hidden until you both say yes
        </span>
        <span className="footer-links">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </span>
      </footer>
    </>
  );
}
