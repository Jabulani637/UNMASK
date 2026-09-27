import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ago } from '../time.js';

/**
 * NFR-SCALE-1 — the institutions list, edited in a browser.
 *
 * The requirement is that a new college can be added without a deploy. That is only
 * literally true if this screen exists: an "institution" that lived in a source file
 * would make every new campus a code change, and a code change is a server you have
 * to reach. So every fact the product keys on — which address verifies which college,
 * which faculties its students choose from, which city decides a same-city score —
 * is a row here, and the five fields that are not a list are boxes on this page.
 *
 * **Two lists, one rule.** `emailDomains` is the part after the @, one per line. It is
 * the only thing that makes an institution real rather than a label, and the API
 * refuses a row without one, because a college nobody can prove they attend is a
 * college that cannot stop an outsider joining it. `faculties` is a courtesy: an
 * institution with an empty list gets a free-text faculty box on its students'
 * profile instead, which is the honest answer for a college whose school names Unmask
 * has not been told.
 *
 * **Switching off is not deleting.** A row set to inactive leaves every profile that
 * points at it in place — deleting one would delete students' profiles with it — but
 * its domain stops verifying new sign-ups, it drops out of everyone's preference
 * list, and its students stop being suggested. That is the whole of what "we have
 * stopped working with this college" can safely mean, and the message under each row
 * says it rather than letting the toggle look like a bin.
 *
 * **Requests are anonymous by design.** The box a student uses to ask for their
 * college holds no contact field, and the list below holds no sender, because a
 * request that could be replied to is a request that can be used to leave a phone
 * number on a staff screen.
 *
 * **The examples in the form are invented.** This screen is the one place a college's
 * name is displayed to anybody, and it is displayed from the API — so a placeholder
 * naming a college that is already a row would do two bad things at once: invite a
 * moderator to add it a second time, and ship an institution's name inside the
 * JavaScript bundle, which is the thing the rest of the site is built not to do.
 */

const TYPES = [
  ['university', 'University'],
  ['tvet', 'TVET college'],
];

const EMPTY = {
  id: null,
  name: '',
  shortName: '',
  type: 'university',
  city: '',
  isActive: true,
  emailDomains: '',
  faculties: '',
};

/** One per line in the box, an array on the wire. Commas are accepted too. */
function toList(text) {
  return String(text || '')
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

export default function InstitutionsPanel() {
  const [rows, setRows] = useState(null);
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState(null);

  const load = useCallback(async () => {
    try {
      const [institutions, asked] = await Promise.all([api.staff.institutions(), api.staff.institutionRequests()]);
      setRows(institutions.institutions);
      setRequests(asked.requests);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function press(key, work, done) {
    setBusy(key);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      setError(null);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(null);
    }
  }

  function saveDraft(event) {
    event.preventDefault();
    const body = {
      name: draft.name.trim(),
      shortName: draft.shortName.trim(),
      type: draft.type,
      city: draft.city.trim(),
      isActive: draft.isActive,
      emailDomains: toList(draft.emailDomains),
      faculties: toList(draft.faculties),
    };
    const editing = Boolean(draft.id);
    press(editing ? `edit:${draft.id}` : 'new', async () => {
      const data = editing
        ? await api.staff.updateInstitution(draft.id, body)
        : await api.staff.createInstitution(body);
      setNotice(data.message);
      setDraft(null);
    }, editing ? null : 'Adding…');
  }

  if (!rows && !error) return <p className="server-line">Reading the institutions…</p>;

  return (
    <div className="stack">
      {error ? <p className="server-error" role="alert">{error}</p> : null}
      {notice ? <p className="server-ok" role="status">{notice}</p> : null}

      <div className="row">
        <button className="btn small ghost" type="button" onClick={load} disabled={Boolean(busy)}>
          Refresh
        </button>
        <button
          className="btn small blue"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => setDraft({ ...EMPTY })}
        >
          Add an institution
        </button>
        <span className="hint">
          {rows ? `${rows.filter(row => row.isActive).length} of ${rows.length} taking students` : ''}
        </span>
      </div>

      <table className="stat-trend institution-table">
        <thead>
          <tr>
            <th scope="col">Institution</th>
            <th scope="col">Type</th>
            <th scope="col">City</th>
            <th scope="col">Email domains</th>
            <th scope="col">Faculties</th>
            <th scope="col">State</th>
            <th scope="col"> </th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).map(row => (
            <tr key={row.id}>
              <th scope="row">
                {row.shortName}
                <p className="hint">{row.name}</p>
              </th>
              <td>{row.type === 'tvet' ? 'TVET college' : 'University'}</td>
              <td>{row.city || '—'}</td>
              <td>
                {row.emailDomains.map(domain => (
                  <span className="tag" key={domain}>
                    {domain}
                  </span>
                ))}
              </td>
              <td>
                {row.faculties.length ? (
                  <span className="hint">{row.faculties.join(', ')}</span>
                ) : (
                  <span className="hint">none — its students type their own</span>
                )}
              </td>
              <td>{row.isActive ? 'taking students' : 'switched off'}</td>
              <td>
                <span className="row-gap">
                  <button
                    className="btn small ghost"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => setDraft({ ...row, emailDomains: row.emailDomains.join('\n'), faculties: row.faculties.join('\n') })}
                  >
                    Edit
                  </button>
                  <button
                    className={`btn small ${row.isActive ? 'pink' : 'blue'}`}
                    type="button"
                    disabled={Boolean(busy)}
                    title={
                      row.isActive
                        ? 'Stop its domain verifying new sign-ups and stop its students being suggested. Nothing is deleted.'
                        : 'Let it verify addresses and be suggested again. Its students keep their profiles.'
                    }
                    onClick={() =>
                      press(
                        `switch:${row.id}`,
                        () => api.staff.updateInstitution(row.id, { isActive: !row.isActive }),
                        null
                      )
                    }
                  >
                    {busy === `switch:${row.id}`
                      ? 'Working…'
                      : row.isActive
                        ? 'Switch off'
                        : 'Switch on'}
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="hint">
        A row is switched off rather than deleted, because there is no delete here: a profile that points at an
        institution would have to go with it, and a student would lose a profile over somebody else's contract.
      </p>

      {draft ? (
        <form className="stack panel-form" onSubmit={saveDraft}>
          <p className="queue-sub">{draft.id ? `Edit ${draft.shortName || 'this institution'}` : 'Add an institution'}</p>
          <div className="field">
            <label htmlFor="inst-name">Full name</label>
            <input
              id="inst-name"
              type="text"
              required
              maxLength={120}
              value={draft.name}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
              placeholder="Example Technikon"
            />
          </div>
          <div className="row2">
            <div className="field">
              <label htmlFor="inst-short">Short name</label>
              <input
                id="inst-short"
                type="text"
                required
                maxLength={20}
                value={draft.shortName}
                onChange={event => setDraft({ ...draft, shortName: event.target.value })}
                aria-describedby="inst-short-hint"
                placeholder="EXAMPLE"
              />
              <p className="hint" id="inst-short-hint">
                What a match sees on a card. Stored in capitals.
              </p>
            </div>
            <div className="field">
              <label htmlFor="inst-type">Type</label>
              <select id="inst-type" value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value })}>
                {TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="inst-city">City</label>
            <input
              id="inst-city"
              type="text"
              maxLength={60}
              value={draft.city}
              onChange={event => setDraft({ ...draft, city: event.target.value })}
              aria-describedby="inst-city-hint"
              placeholder="King William's Town"
            />
            <p className="hint" id="inst-city-hint">
              Only used for the small same-city part of a score. Left empty, this institution gets none of it.
            </p>
          </div>
          <div className="field">
            <label htmlFor="inst-domains">Email domains — one per line</label>
            <textarea
              id="inst-domains"
              rows={3}
              required
              value={draft.emailDomains}
              onChange={event => setDraft({ ...draft, emailDomains: event.target.value })}
              aria-describedby="inst-domains-hint"
              placeholder={'example.ac.za\nmy.example.ac.za'}
            />
            <p className="hint" id="inst-domains-hint">
              The part after the @, with no @ of its own. At least one is required, and one domain can only ever belong
              to one institution — that is what makes an address proof of where somebody studies.
            </p>
          </div>
          <div className="field">
            <label htmlFor="inst-faculties">Faculties — one per line</label>
            <textarea
              id="inst-faculties"
              rows={4}
              value={draft.faculties}
              onChange={event => setDraft({ ...draft, faculties: event.target.value })}
              aria-describedby="inst-faculties-hint"
              placeholder={'Engineering\nApplied Sciences'}
            />
            <p className="hint" id="inst-faculties-hint">
              Optional. With a list, its students choose from it; without one they type their own faculty or school
              name. Leave it empty for a college whose school names nobody at Unmask has been told yet.
            </p>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={event => setDraft({ ...draft, isActive: event.target.checked })}
            />
            <span>Taking students on Unmask</span>
          </label>
          <div className="row">
            <button className="btn pink" type="submit" disabled={Boolean(busy)}>
              {busy === 'new' || busy === `edit:${draft.id}` ? 'Saving…' : draft.id ? 'Save changes' : 'Add it'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setDraft(null)} disabled={Boolean(busy)}>
              Cancel
            </button>
          </div>
          <p className="hint">
            Every change here is written to the staff log with your name on it, including the domains that were added
            and taken away.
          </p>
        </form>
      ) : null}

      <section className="stack">
        <p className="queue-sub">Colleges students have asked for</p>
        {!requests ? (
          <p className="server-line">Reading…</p>
        ) : !requests.length ? (
          <p className="hint">Nobody has asked yet.</p>
        ) : (
          <ul className="record-list">
            {requests.map(row => (
              <li key={row.institutionName}>
                <b>{row.institutionName}</b> · asked {row.count} {row.count === 1 ? 'time' : 'times'} · last {ago(row.lastRequested)}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          These names are typed by students and nothing else about them is kept — there is no address, no message and
          no way to reply, which is why nobody can leave a phone number in here. Add a college that appears more than
          once, and its students can register the moment you press save.
        </p>
      </section>
    </div>
  );
}
