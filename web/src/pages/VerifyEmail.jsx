import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { api } from '../api.js';

/**
 * FR-1.2 — the other half of the emailed link.
 *
 * The link arrives as /verify?token=…, so the token is read from the URL and sent
 * straight back to the API. It is deliberately never rendered on screen: the token
 * is a live credential until it is used, and a page that prints it puts it in a
 * screenshot, a screen-reader buffer and anyone's shoulder-surf.
 */

// The link works once, so the request belongs to the token rather than to a
// component instance: React's dev-mode double mount, or a refresh of the same
// URL, must not spend the one use on a request whose answer got thrown away.
const sent = new Map();

function verifyOnce(token) {
  let request = sent.get(token);
  if (!request) {
    request = api.auth.verify(token);
    sent.set(token, request);
  }
  return request;
}

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const [state, setState] = useState({ phase: 'working' });
  const token = params.get('token') || '';

  useEffect(() => {
    if (!token) {
      setState({ phase: 'failed', message: 'That link is missing its token. Open the newest email and try again.' });
      return;
    }

    verifyOnce(token)
      .then(result => setState({ phase: 'done', message: result.message }))
      .catch(err => setState({ phase: 'failed', message: err.message }));
  }, [token]);

  const body =
    state.phase === 'working' ? (
      <p className="server-line">Confirming your address…</p>
    ) : state.phase === 'done' ? (
      <>
        <p className="server-ok" role="status">{state.message}</p>
        <Link className="btn pink block" to="/login">
          Sign in
        </Link>
      </>
    ) : (
      <>
        <p className="server-error" role="alert">{state.message}</p>
        <p className="hint">
          This usually means the link has already done its job. Try <Link to="/login">signing in</Link> — that
          screen can send you a new link if your address really is still unconfirmed.
        </p>
      </>
    );

  const titles = {
    working: 'Confirming',
    done: 'Email confirmed',
    failed: 'Could not confirm',
  };

  return (
    <AppShell title={titles[state.phase]} intro="One link, one use — so a forwarded email cannot confirm you twice.">
      {body}
    </AppShell>
  );
}
