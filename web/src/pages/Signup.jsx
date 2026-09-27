import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Field from '../components/Field.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useAction } from '../hooks/useAction.js';
import { useMeta, institutionNames } from '../hooks/useMeta.js';
import { api } from '../api.js';

/**
 * FR-1.1, FR-1.3, FR-1.4.
 *
 * Email, password, and a yes on being 18. That is all it asks, and the missing
 * fields are the design: no name, no surname, no date of birth. The faculty, year
 * and interests come later, on the profile screen, because they are what a match is
 * built from — not what an account is built from. Where you study is not asked for
 * at all: the address you verify here already answered it.
 *
 * The hero on the landing page can arrive here with `?institution=`, and it is
 * treated as a word from the student about which address they are about to type, not
 * as a decision. Nothing is saved from it, it cannot make an address acceptable, and
 * the server refuses any domain it has not been told about regardless of what this
 * page said — so a stale link to a college staff switched off says so instead of
 * quietly promising a signup that will fail.
 *
 * After the account is created this page shows the second half of sign-up: the six
 * digits emailed to that address, typed back. That is the whole of FR-1.2 — the
 * screen never sees the code before the mail does, and the API answers the same
 * sentence whether the address is wrong or the digits are, so this page cannot be
 * used to find out who is registered.
 *
 * When the API answers with `devAutoVerified` — which only happens on a developer's
 * machine with DEV_AUTO_VERIFY on, and which the API refuses to start with in
 * production — there is no code to type, so the page signs the student in with the
 * password they just chose and takes them to their profile. The decision lives on the
 * server; this page only obeys the code it was given.
 */
export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [attested, setAttested] = useState(false);
  const [stage, setStage] = useState('form');
  const [code, setCode] = useState('');
  const [devNotice, setDevNotice] = useState(null);
  const [params] = useSearchParams();
  const { meta } = useMeta();
  const { signIn, refresh } = useAuth();
  const navigate = useNavigate();
  const { busy, error, result, run } = useAction();
  const verify = useAction();
  const resend = useAction();

  const asked = params.get('institution');
  const chosen = ((meta && meta.institutions) || []).find(institution => institution.id === asked) || null;

  async function submit(event) {
    event.preventDefault();
    const registered = await run(
      () => api.auth.register({ email, password, over18Attested: attested }),
      value => {
        if (value.devAutoVerified) setDevNotice(value.message);
        else setStage('code');
      }
    );
    if (!registered || !registered.devAutoVerified) return;

    const signedIn = await run(() => signIn(email, password), () => navigate('/me', { replace: true }));
    if (!signedIn) setStage('code');
  }

  async function confirmCode(event) {
    event.preventDefault();
    // No second password: /api/auth/verify-code answered with a session cookie of its
    // own, so the honest thing here is to ask who the browser now is, not to log in
    // again with the credentials this screen still happens to be holding.
    await run(
      () => api.auth.verifyCode({ email, code }),
      async () => {
        await refresh();
        navigate('/me', { replace: true });
      }
    );
  }

  if (stage !== 'form') {
    return (
      <AppShell
        title={devNotice ? 'Confirmed, no code needed' : `Confirm ${email}`}
        intro={
          devNotice
            ? 'Nothing was emailed on this machine, so there is nothing to read.'
            : 'The six digits expire in 10 minutes and work once. Five wrong entries and a new code is needed.'
        }
      >
        {/* When the address already had an account, registering left its password
            alone and the sign-in this page then attempted was refused. The sentence
            saying so is the only thing that tells a returning student what actually
            happened, so it is repeated here rather than dropped on the way to this
            screen — it is the same sentence /login shows for the same refusal. */}
        {error ? (
          <p className="server-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="server-line">{devNotice || (result ? result.message : '')}</p>
        {devNotice ? (
          <p className="hint">
            Continue to <Link to="/login">sign in</Link> — or, if this address already had an account with a
            password you do not have, <Link to="/forgot">set a new one</Link>.
          </p>
        ) : (
          <>
            <form className="stack" onSubmit={confirmCode}>
              <Field
                label="Confirmation code"
                type="text"
                value={code}
                // Anything that is not a digit is dropped as it is typed, so a paste of
                // "Your code is 481902" lands as six digits rather than as a rejected
                // string. Leading zeros are kept: 048190 is a code.
                onChange={value => setCode(value.replace(/\D/g, '').slice(0, 6))}
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                required
                hint="Exactly the six digits from the email. Unmask will never ask you for this code by phone or message."
              />
              {verify.error ? <p className="server-error" role="alert">{verify.error}</p> : null}
              <button className="btn pink block" type="submit" disabled={verify.busy || code.length !== 6}>
                {verify.busy ? 'Checking…' : 'Confirm and continue'}
              </button>
            </form>
            <form
              className="stack"
              onSubmit={async event => {
                event.preventDefault();
                await resend.run(() => api.auth.resend(email));
              }}
            >
              <button className="btn block" type="submit" disabled={resend.busy}>
                {resend.busy ? 'Sending…' : 'Send another code'}
              </button>
              {resend.error ? <p className="server-error" role="alert">{resend.error}</p> : null}
              {resend.result ? <p className="server-ok" role="status">{resend.result.message}</p> : null}
              <p className="hint center">
                Nothing in the inbox? It can take a minute to arrive, and a new code only goes out a minute after
                the last one. Or <Link to="/login">sign in</Link> if this address already had an account.
              </p>
            </form>
          </>
        )}
      </AppShell>
    );
  }

  const passwordMin = (meta && meta.passwordMinLength) || 10;
  const offered = institutionNames(meta);

  return (
    <AppShell title="Create your profile" intro="Two minutes. Your name is never part of it — that is the point.">
      <form className="stack" onSubmit={submit}>
        <Field
          label="Your student email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          inputMode="email"
          required
          hint={
            chosen ? (
              <>
                {chosen.shortName} students sign up with an address at{' '}
                {chosen.emailDomains.map(domain => `@${domain}`).join(' or ')}. Not there?{' '}
                <Link to="/request-institution">Ask for your college</Link> — staff read the requests
                before they choose where to go next.
              </>
            ) : asked ? (
              <>
                That college is no longer on Unmask, so no address at it can be verified. An address at
                one of these will be accepted: {offered || 'the institutions Unmask has verified'}. Or{' '}
                <Link to="/request-institution">ask for your college</Link>.
              </>
            ) : (
              <>
                {offered
                  ? `Only an address at one of these: ${offered}. `
                  : 'Only an address at an institution Unmask has verified. '}
                Not on the list? <Link to="/request-institution">Ask for your college</Link> — staff read
                the requests before they choose where to go next.
              </>
            )
          }
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          required
          hint={`At least ${passwordMin} characters. A short phrase you can remember beats a complex one you will reuse.`}
        />

        <label className="check">
          <input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)} required />
          <span>I am 18 or older. Unmask is only for adult students.</span>
        </label>

        <p className="hint center">
          By creating an account you agree to the <Link to="/terms">terms of use</Link> and read how your data is
          handled in the <Link to="/privacy">privacy notice</Link>.
        </p>

        {error ? <p className="server-error" role="alert">{error}</p> : null}

        <button className="btn pink block" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>

        <p className="hint center">
          Already have an account? <Link to="/login">Sign in</Link> · <Link to="/forgot">Forgot password</Link>
        </p>
      </form>
    </AppShell>
  );
}
