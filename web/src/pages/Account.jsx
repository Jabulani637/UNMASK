import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Field from '../components/Field.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useAction } from '../hooks/useAction.js';
import { useMeta } from '../hooks/useMeta.js';
import { api } from '../api.js';

/**
 * FR-1.5, FR-1.6, FR-7.4 — and FR-6.2's undo, all on the one screen a student
 * reaches when something about their account is wrong.
 *
 * Changing a password is listed beside deleting the account on purpose. A student
 * who can only find deletion in the app has one reason to reach for it that a
 * password change would have solved, and POPIA's right to erasure is worth more
 * when it is not the only door.
 *
 * Both ask for the current password. A cookie proves a browser was here; it does
 * not prove the person holding it is the account's owner.
 *
 * The blocked list is here for the same reason as those two forms: a panic press
 * deserves a way back that is not "delete your account and start over".
 *
 * The FR-7.4 switches are the only part of this product where a student can say
 * "less", which is why they are on the account screen rather than buried in the
 * bell: a setting that hides itself is how an app ends up mailing people who wanted
 * it to stop three screens ago.
 */

const SWITCHES = [
  {
    field: 'inApp',
    label: 'In-app bell',
    hint: 'On by default. Off means nothing collects on your Bell screen — the message still arrives inside the chat itself, and if you have asked for email too, that still goes.',
  },
  {
    field: 'email',
    label: 'Email me too',
    hint: 'Off by default. Your inbox is not our channel to fill, so this one is opt-in, and a mail that is sent names nobody and quotes nothing.',
  },
  {
    field: 'suggestions',
    label: 'Tell me when someone new fits',
    hint: 'The one notice that is not an answer to something a person did, so it is the one that can be switched off on its own. Messages and reveals are unaffected.',
  },
];

/**
 * Hand the bytes to the browser as a file.
 *
 * The name carries the date rather than the account's address, because a download
 * folder is a shared thing on a lab machine and a filename is the one part of this
 * that anybody browsing over a shoulder can read.
 */
function saveAsFile(doc) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `unmask-my-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function Account() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { meta } = useMeta();
  const passwordMin = (meta && meta.passwordMinLength) || 10;

  const [current, setCurrent] = useState('');
  const [replacement, setReplacement] = useState('');
  const change = useAction();

  const [confirmWord, setConfirmWord] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const remove = useAction();

  const [exportPassword, setExportPassword] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState(null);
  const [held, setHeld] = useState(null);

  const [blocked, setBlocked] = useState(null);
  const [blockNotice, setBlockNotice] = useState(null);
  const [lifting, setLifting] = useState(null);

  const [settings, setSettings] = useState(null);
  const [settingsNotice, setSettingsNotice] = useState(null);
  const [savingSwitch, setSavingSwitch] = useState(null);

  useEffect(() => {
    let alive = true;
    api.notifications
      .settings()
      .then(data => alive && setSettings(data.notifications))
      .catch(() => alive && setSettings({}));
    return () => {
      alive = false;
    };
  }, []);

  /**
   * One switch per write, saved the moment it is moved. The API reads these at the
   * instant an event happens rather than caching them, so a switch thrown now counts
   * for the next thing — and a form with a Save button at the bottom would let a
   * student believe otherwise.
   */
  async function onToggle(field, value) {
    const previous = settings;
    setSavingSwitch(field);
    setSettingsNotice(null);
    setSettings({ ...settings, [field]: value });
    try {
      const data = await api.notifications.setSettings({ [field]: value });
      setSettings(data.notifications);
      setSettingsNotice({ ok: true, text: data.message });
    } catch (err) {
      setSettings(previous);
      setSettingsNotice({ ok: false, text: err.message });
    } finally {
      setSavingSwitch(null);
    }
  }

  useEffect(() => {
    let alive = true;
    api.safety
      .blocks()
      .then(data => alive && setBlocked(data.blocked))
      .catch(() => alive && setBlocked([]));
    return () => {
      alive = false;
    };
  }, []);

  async function onLift(id) {
    setLifting(id);
    setBlockNotice(null);
    try {
      const data = await api.safety.unblock(id);
      setBlockNotice(data.message);
      setBlocked(list => (list || []).filter(row => row.id !== id));
    } catch (err) {
      setBlockNotice(err.message);
    } finally {
      setLifting(null);
    }
  }

  async function onChangePassword(event) {
    event.preventDefault();
    const done = await change.run(() => api.auth.changePassword({ currentPassword: current, newPassword: replacement }));
    if (done) {
      setCurrent('');
      setReplacement('');
      signOut();
      navigate('/login', { replace: true });
    }
  }

  async function onDelete(event) {
    event.preventDefault();
    const gone = await remove.run(() => api.auth.deleteAccount({ password: deletePassword, confirmText: confirmWord }));
    if (gone) {
      await signOut();
      navigate('/', { replace: true });
    }
  }

  /**
   * NFR-3.1. The numbers shown under the button are the file's own `summary`, which
   * is built by the same service that lists the rows — so this screen cannot show a
   * tidy count that the downloaded file contradicts.
   */
  async function onExport(event) {
    event.preventDefault();
    setExportBusy(true);
    setExportNotice(null);
    try {
      const doc = await api.auth.exportData({ password: exportPassword });
      saveAsFile(doc);
      setHeld(doc.summary);
      setExportPassword('');
      setExportNotice({
        ok: true,
        text: 'Saved to your downloads. Check that your browser kept it — some ask first.',
      });
    } catch (err) {
      setHeld(null);
      setExportNotice({ ok: false, text: err.message });
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <AppShell title="Account" intro={`Signed in as ${user.email}.`}>
      <form className="stack" onSubmit={onChangePassword}>
        <h2 className="card-title">Change password</h2>
        <Field
          label="Current password"
          type="password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          required
        />
        <Field
          label="New password"
          type="password"
          value={replacement}
          onChange={setReplacement}
          autoComplete="new-password"
          required
          hint={`At least ${passwordMin} characters.`}
        />
        {change.error ? <p className="server-error" role="alert">{change.error}</p> : null}
        <button className="btn block" type="submit" disabled={change.busy}>
          {change.busy ? 'Saving…' : 'Change password'}
        </button>
        <p className="hint">This signs every device out, including this one.</p>
      </form>

      <hr className="rule" />

      {/*
        FR-7.4. Native checkboxes rather than a styled toggle: a switch a student can
        only read visually is a switch they cannot be sure they have thrown.
      */}
      <section className="stack">
        <h2 className="card-title">Notifications</h2>
        {settings === null ? <p className="server-line">Checking…</p> : null}
        {settingsNotice ? (
          <p
            className={settingsNotice.ok ? 'server-ok' : 'server-error'}
            role={settingsNotice.ok ? 'status' : 'alert'}
          >
            {settingsNotice.text}
          </p>
        ) : null}
        {SWITCHES.map(({ field, label, hint }) => (
          <label className="switch-row" key={field}>
            <input
              type="checkbox"
              checked={Boolean(settings && settings[field])}
              onChange={event => onToggle(field, event.target.checked)}
              disabled={settings === null || savingSwitch === field}
            />
            <span className="switch-text">
              <b>{label}</b>
              <span className="hint">{hint}</span>
            </span>
          </label>
        ))}
        <p className="hint">
          Whichever way these are set, a notification never contains another student&apos;s name, their email, or a word
          of what they wrote — there is nothing in it to leak, because the server writes the sentence itself.
        </p>
      </section>

      <hr className="rule" />

      {/*
        FR-6.2's escape hatch, listed as a person rather than an id: the block rows
        carry no account id anywhere, which is why unblocking is the only thing you
        can do from here and finding them again is not.
      */}
      <section className="stack">
        <h2 className="card-title">Students you have blocked</h2>
        {blocked === null ? <p className="server-line">Checking…</p> : null}
        {blocked && !blocked.length ? (
          <p className="hint">Nobody. If a conversation turned ugly, blocking is the button at the bottom of it.</p>
        ) : null}
        {blockNotice ? <p className="server-ok" role="status">{blockNotice}</p> : null}
        {(blocked || []).map(row => (
          <div className="blocked-row" key={row.id}>
            <div>
              <b>{row.peer.name || 'An anonymous student'}</b>
              <p className="hint">
                {[row.peer.year, row.peer.faculty, row.peer.institution].filter(Boolean).join(' · ') ||
                  'Their profile is gone from Unmask.'}
                {row.peer.revealed ? '' : ' · never revealed to you'}
              </p>
            </div>
            <button
              className="btn ghost small"
              type="button"
              onClick={() => onLift(row.id)}
              disabled={lifting === row.id}
            >
              {lifting === row.id ? 'Undoing…' : 'Unblock'}
            </button>
          </div>
        ))}
        <p className="hint">
          Unblocking only stops the two of you being kept apart. A conversation that closed when you blocked them stays
          closed — you would have to be suggested to each other again.
        </p>
      </section>

      <hr className="rule" />

      {/*
        NFR-3.1, listed beside NFR-3.2's erasure for the reason the header gives: the
        two rights are one conversation about the same rows, and this file is the only
        place a student can read what is about to be deleted. The password is asked for
        because the answer is the whole record — a cookie proves a browser, not a person
        holding it.
      */}
      <form className="stack" onSubmit={onExport}>
        <h2 className="card-title">Download everything we hold about you</h2>
        <p className="hint">
          One readable file: your sign-in record, your profile, every conversation with every message in it, the
          suggestions you declined, the blocks you made, the reports you filed and the reports filed about you, your
          notices, and the log entries about your account. Other students in it are named nobody — each one is the word
          “another student”, because their side of a thread is theirs. What is deliberately left out is listed inside
          the file, with the reason for each line.
        </p>
        <Field
          label="Your password"
          type="password"
          value={exportPassword}
          onChange={setExportPassword}
          autoComplete="current-password"
          required
          hint="Nothing is changed by this, and nothing is written down that we did not already know. It is asked for because this is the same size of secret as deletion."
        />
        {exportNotice ? (
          <p
            className={exportNotice.ok ? 'server-ok' : 'server-error'}
            role={exportNotice.ok ? 'status' : 'alert'}
          >
            {exportNotice.text}
          </p>
        ) : null}
        {held ? (
          <ul className="held-list">
            <li>{held.conversations} conversation(s), {held.messages} message(s)</li>
            <li>{held.suggestionsYouDeclined} suggestion(s) you passed on</li>
            <li>{held.reportsFiled} report(s) you filed, {held.reportsAgainstYou} filed about you</li>
            <li>{held.notices} notice(s), {held.logEntries} log entr(ies)</li>
            <li>{held.photoOnFile ? 'one profile photo (its date and size are in the file; the picture is not)' : 'no profile photo'}</li>
            <li>{held.signedInDevices} device(s) signed in</li>
          </ul>
        ) : null}
        <button className="btn block" type="submit" disabled={exportBusy || exportPassword.length === 0}>
          {exportBusy ? 'Reading…' : 'Download my data (JSON)'}
        </button>
        <p className="hint">
          Six downloads an hour, so a stolen cookie cannot empty itself into a file by accident. <Link to="/privacy">The
          privacy notice</Link> says what any of it is for.
        </p>
      </form>

      <hr className="rule" />

      <form className="stack danger" onSubmit={onDelete}>
        <h2 className="card-title">Delete this account</h2>
        <p className="hint">
          This is immediate. Your account, and every profile, match, message and photo attached to it, are
          gone from this moment. It cannot be undone from here.
        </p>
        <Field
          label="Type DELETE to confirm"
          value={confirmWord}
          onChange={setConfirmWord}
          autoComplete="off"
          required
        />
        <Field
          label="Your password"
          type="password"
          value={deletePassword}
          onChange={setDeletePassword}
          autoComplete="current-password"
          required
        />
        {remove.error ? <p className="server-error" role="alert">{remove.error}</p> : null}
        <button
          className="btn pink block"
          type="submit"
          disabled={remove.busy || confirmWord !== 'DELETE' || deletePassword.length === 0}
        >
          {remove.busy ? 'Deleting…' : 'Delete my account and everything in it'}
        </button>
      </form>
    </AppShell>
  );
}
