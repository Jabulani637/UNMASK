import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Field from '../components/Field.jsx';
import { useAction } from '../hooks/useAction.js';
import { useMeta } from '../hooks/useMeta.js';
import { api } from '../api.js';

/**
 * FR-1.4 — the reset link's destination.
 *
 * The token is read from the URL and never displayed, and it is never written
 * anywhere the browser keeps: until it is spent it is the only thing standing
 * between whoever finds that email and a new password on someone else's account.
 */
export default function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const { meta } = useMeta();
  const { busy, error, result, run } = useAction();

  async function submit(event) {
    event.preventDefault();
    await run(() => api.auth.reset({ token, password }));
  }

  const passwordMin = (meta && meta.passwordMinLength) || 10;

  return (
    <AppShell
      title="Choose a new password"
      intro={
        token
          ? 'Setting this one signs every other device out, including any that is not yours.'
          : undefined
      }
    >
      {token ? (
        <form className="stack" onSubmit={submit}>
          <Field
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            required
            hint={`At least ${passwordMin} characters.`}
          />
          {error ? <p className="server-error" role="alert">{error}</p> : null}
          <button className="btn pink block" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
          {result ? (
            <p className="server-ok" role="status">
              {result.message}
            </p>
          ) : null}
          {result ? (
            <Link className="btn block" to="/login">
              Go to sign in
            </Link>
          ) : null}
        </form>
      ) : (
        <>
          <p className="server-error" role="alert">That link is missing its token. Ask for a new reset email.</p>
          <Link className="btn block" to="/forgot">
            Send me a reset link
          </Link>
        </>
      )}
    </AppShell>
  );
}
