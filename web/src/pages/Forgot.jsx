import { useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Field from '../components/Field.jsx';
import { useAction } from '../hooks/useAction.js';
import { api } from '../api.js';

/**
 * FR-1.4 — password recovery.
 *
 * The answer on this screen is the API's sentence, which reads the same whether or
 * not the address has an account. A locally-worded "we found your account!" would
 * hand anyone a way to test which student addresses are on Unmask, and on a
 * students-only site the address is the identity (NFR-3.3).
 */
export default function Forgot() {
  const [email, setEmail] = useState('');
  const { busy, error, result, run } = useAction();

  async function submit(event) {
    event.preventDefault();
    await run(() => api.auth.forgot(email));
  }

  return (
    <AppShell
      title="Reset your password"
      intro="Enter the student address you signed up with. If it can be used, a link that expires in 30 minutes is on its way."
    >
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
        {error ? <p className="server-error" role="alert">{error}</p> : null}
        <button className="btn pink block" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
        {result ? (
          <p className="server-ok" role="status">
            {result.message}
          </p>
        ) : null}
        <p className="hint center">
          Remembered it? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AppShell>
  );
}
