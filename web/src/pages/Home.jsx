import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api.js';
import { useAction } from '../hooks/useAction.js';

/**
 * Where a signed-in student lands.
 *
 * It reports what the account can do today rather than showing an empty version
 * of the finished product: the profile is what a match is built from, so it is
 * the one card worth stating the state of, and the buttons go to the two places
 * a finished profile can reach — a suggestion, and the threads it has opened.
 */
export default function Home() {
  const { user, signOut } = useAuth();
  const { busy, error, run } = useAction();
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading');
  const [profile, setProfile] = useState(null);
  // Read from /api/notifications/settings rather than trusted from the sign-in
  // answer: a switch moved on the Account screen is true from the next event, and
  // this page should not show the stale one.
  const [settings, setSettings] = useState(user && user.notifications ? user.notifications : null);

  useEffect(() => {
    let alive = true;
    api.notifications
      .settings()
      .then(data => alive && setSettings(data.notifications))
      .catch(() => alive && setSettings(user && user.notifications ? user.notifications : null));
    return () => {
      alive = false;
    };
  }, [user]);

  useEffect(() => {
    let alive = true;
    api.profile
      .get()
      .then(data => {
        if (!alive) return;
        // A student who has never saved gets { profile: null }, which is an
        // answer, not a failure — the two need to stay distinguishable.
        setStatus('ready');
        setProfile(data.profile);
      })
      .catch(() => {
        if (alive) setStatus('unreachable');
      });
    return () => {
      alive = false;
    };
  }, []);

  async function onSignOut(event) {
    event.preventDefault();
    await run(() => signOut(), () => navigate('/', { replace: true }));
  }

  return (
    <AppShell title="You are signed in" intro="This is everything the site knows about you so far.">
      <dl className="facts">
        <dt>Student email</dt>
        <dd>{user.email}</dd>
        <dt>Institution</dt>
        <dd>
          {status === 'loading'
            ? 'Checking…'
            : profile && profile.institution
              ? `${profile.institution.name} — your address decided it, you never chose it`
              : 'Not readable from your profile yet'}
        </dd>
        <dt>Confirmed</dt>
        <dd>Yes — that is what lets you in</dd>
        <dt>Profile</dt>
        <dd>
          {status === 'loading' ? 'Checking…' : null}
          {status === 'unreachable' ? 'Could not be read right now' : null}
          {status === 'ready' && !profile ? 'Not started — nothing a match could read yet' : null}
          {profile ? (
            profile.held
              ? `On hold — a staff member’s note: “${profile.held}” Edit your profile and save to be shown again.`
              : profile.matchable
              ? 'Complete — you are eligible to be matched'
              : `Started, not finished: ${profile.missing.join('; ')}`
          ) : null}
        </dd>
        <dt>Photo</dt>
        <dd>
          {profile && profile.hasPhoto
            ? 'Uploaded, and hidden from every match until you both agree'
            : 'None — it is optional, and a match never sees it until you both agree'}
        </dd>
        <dt>Name a match could be shown</dt>
        <dd>
          {profile && profile.revealName
            ? `“${profile.revealName}” — only after the two of you both say yes`
            : 'None — you left it empty, so a reveal would show no name'}
        </dd>
        <dt>Notifications</dt>
        <dd>
          {settings
            ? [
                settings.inApp ? 'in-app bell on' : 'in-app bell off',
                settings.email ? 'email on' : 'email off',
                settings.suggestions ? 'new-match nudges on' : 'new-match nudges off',
              ].join(' · ') + ' — change them on Account'
            : 'Could not be read right now'}
        </dd>
      </dl>

      <p className="server-line">
        {profile && profile.institution
          ? `Unmask knows you as a student at ${profile.institution.name}, because that is the domain your address sits on. `
          : ''}
        Unmask never asked for your legal name or your student number, so there is nothing here that could identify
        you to another student — the only name anyone can ever be shown is the one you type yourself, and only once
        you have both said yes.
      </p>

      <div className="stack">
        <Link className="btn pink block" to="/match">
          Find my match
        </Link>
        <Link className="btn blue block" to="/chats">
          My chats
        </Link>
        <Link className="btn blue block" to="/profile">
          {profile ? 'Edit my profile' : 'Build my profile'}
        </Link>
        <Link className="btn blue block" to="/account">
          Account settings
        </Link>
        <form onSubmit={onSignOut}>
          <button className="btn ghost block" type="submit" disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          {error ? <p className="server-error" role="alert">{error}</p> : null}
        </form>
      </div>
    </AppShell>
  );
}
