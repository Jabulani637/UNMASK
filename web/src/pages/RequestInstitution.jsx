import { useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Field from '../components/Field.jsx';
import { useAction } from '../hooks/useAction.js';
import { useMeta, institutionNames } from '../hooks/useMeta.js';
import { api } from '../api.js';

/**
 * NFR-SCALE-1's other half — "my college isn't on the list".
 *
 * The staff screen can add an institution, but a list only grows if somebody asks
 * for the next one, and the person who knows which college is missing is a student
 * at it. So this page is open to a stranger: no account, no verified address, no
 * session, because the whole reason they are here is that their address does not
 * verify yet.
 *
 * **It holds no way to contact the sender, and says so out loud.** There is no email
 * field on this form, and that is not an oversight — a box that could take one would
 * fill a staff screen with phone numbers and handles, and the record was designed
 * with nothing in it to fingerprint a person by. What comes back instead is the
 * server's own sentence about where the answer will appear: on the sign-up page, not
 * in an inbox.
 *
 * Five requests an hour per address is the only limit behind this form, since there
 * is no account to suspend. When one is spent the screen says how long to wait, in
 * the API's own number rather than an invented one.
 */
export default function RequestInstitution() {
  const { meta } = useMeta();
  const { busy, error, result, run } = useAction();
  const [form, setForm] = useState({ institutionName: '', city: '', detail: '' });

  const offered = institutionNames(meta);

  function set(field, value) {
    setForm(current => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    await run(() => api.requestInstitution({
      institutionName: form.institutionName.trim(),
      city: form.city.trim(),
      detail: form.detail.trim(),
    }));
  }

  if (result) {
    return (
      <AppShell title="Asked" intro="It is on the list staff read.">
        <p className="server-line">{result.message}</p>
        <p className="hint">
          Nothing was sent to you, because nothing about you was kept. <Link to="/signup">Back to sign up</Link>.
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Ask for your college"
      intro={
        offered
          ? `Unmask currently verifies students at ${offered}. If yours is not on that list, say what it is called and staff can add it.`
          : 'Unmask verifies students institution by institution. If yours is not on the list yet, say what it is called and staff can add it.'
      }
    >
      <form className="stack" onSubmit={submit}>
        <Field
          label="Your institution"
          value={form.institutionName}
          onChange={value => set('institutionName', value)}
          required
          maxLength={100}
          placeholder="The name students actually use for it."
          hint="Its full name, or the abbreviation everyone answers to. Spelling it the way two students would is enough."
        />
        <Field
          label="Town or city"
          value={form.city}
          onChange={value => set('city', value)}
          maxLength={60}
          placeholder="King William's Town"
          hint="Optional. It carries a small part of a match score, so a college in another city is worth saying."
        />
        <Field
          label="Anything staff should know"
          value={form.detail}
          onChange={value => set('detail', value)}
          maxLength={240}
          placeholder="Your student email addresses end in …"
          hint="Optional. The domain your addresses use (@example.ac.za) is the single most useful thing you can write here — it is what lets staff add the college and have your address verify the moment they press save. Your own name, email address, phone number or a link is refused, because this form cannot answer you."
        />

        {error ? <p className="server-error" role="alert">{error}</p> : null}

        <button className="btn pink block" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Ask for it'}
        </button>

        <p className="hint center">
          Already at one of the institutions on the list? <Link to="/signup">Create your profile</Link> ·
          {' '}<Link to="/login">Sign in</Link>
        </p>
      </form>
    </AppShell>
  );
}
