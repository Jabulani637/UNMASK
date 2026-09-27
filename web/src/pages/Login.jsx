import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Field from '../components/Field.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useAction } from '../hooks/useAction.js';
import { api } from '../api.js';

/**
 * FR-1.5.
 *
 * The sentences on this screen are the API's, not the page's: an address with no
 * account and a wrong password answer identically, and that only survives if the
 * client prints what came back instead of inventing its own. The one branch that
 * gets extra treatment is `email_unverified`, because there the student needs a
 * button rather than a line of text — and it is keyed on the response's code,
 * never on its wording.
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { busy, error, code, run } = useAction();
  const resend = useAction();

  async function submit(event) {
    event.preventDefault();
    const signedIn = await run(() => signIn(email, password));
    if (signedIn) navigate(location.state?.from || '/me', { replace: true });
  }

  async function sendLinkAgain(event) {
    event.preventDefault();
    await resend.run(() => api.auth.resend(email));
  }

  return (
    <AppShell title="Sign in" intro="Nothing about you is visible to another student until the email address is confirmed.">
      <form className="stack" onSubmit={submit}>
        <Field
          label="Your student email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username email"
          inputMode="email"
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />

        {error ? <p className="server-error" role="alert">{error}</p> : null}

        <button className="btn pink block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="hint center">
          <Link to="/forgot">Forgot password</Link> · <Link to="/signup">Create a profile</Link>
        </p>
      </form>

      {code === 'email_unverified' ? (
        <form className="stack" onSubmit={sendLinkAgain}>
          <button className="btn block" type="submit" disabled={resend.busy}>
            {resend.busy ? 'Sending…' : 'Send the confirmation link again'}
          </button>
          {resend.error ? <p className="server-error" role="alert">{resend.error}</p> : null}
          {resend.result ? <p className="server-ok" role="status">{resend.result.message}</p> : null}
        </form>
      ) : null}
    </AppShell>
  );
}
