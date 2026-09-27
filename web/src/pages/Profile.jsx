import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { api } from '../api.js';
import { useAction } from '../hooks/useAction.js';
import { useMeta } from '../hooks/useMeta.js';
import { encodePhoto } from '../encodePhoto.js';

/**
 * The profile builder — FR-2.1, FR-2.2, FR-2.4, FR-2.5, FR-2.7, and the name
 * FR-5.2 needs in order to mean something.
 *
 * Nothing here asks for a legal name, a surname or a student number, because the
 * database has nowhere to put them. Nor does it ask where you study: that was
 * answered by the address you verified, and a form that could restate it is a form
 * that lets one student present as another institution's — so the institution on
 * this screen is a line to read, not a field to fill, and `institutionId` is
 * nothing the save payload carries.
 *
 * What it does ask for is the five things a match is filtered on, plus the ranked
 * list of *other* institutions you would like to be shown, plus prompt answers.
 * The completion meter is the same arithmetic the server runs
 * (services/profile.js) — so the screen cannot tell someone they are ready while
 * the API still excludes them. The preference list is not in that arithmetic: it
 * changes who *you* are shown, and nobody has to fill it in to be matched.
 *
 * Below that sit two more blocks, and neither of them is in the meter either.
 * &ldquo;What you look like&rdquo; is a self-description — body type, height, how
 * much you drink — and &ldquo;who you are after&rdquo; is up to three picks on each
 * of the same questions. Two rules hold them both, and they are not just copy: a
 * pick can only ever <b>lift</b> a candidate a few points (`lookPoints` has no
 * branch that subtracts), and the one field in the block that is never read by any
 * scorer is `identity`. A student may say what they are; nobody can ask to be shown
 * only some of them, and the field is not even in the projection the engine loads.
 *
 * Faculty is the one control whose shape is not chosen here. When your
 * institution's own record carries a faculty list you pick from it; when it does
 * not, you type what your registrar calls it. Both go through the same contact
 * guard on the way in.
 *
 * The reveal name is the one field that is neither filtered on nor hidden
 * forever: optional, shown to nobody until both students have said yes, and
 * refused outright if it reads like a way to be contacted.
 *
 * The photo is the one place the prototype and the requirements disagree. The
 * design mocked it up blurred on a match's card; FR-2.3 says a photo is not
 * reachable before both students agree, so a match sees a placeholder instead
 * and there is no blurred file for anyone to unblur. Yours is shown to you, in
 * full, because you are the one person allowed to see it.
 */

const FIELD_ORDER = ['faculty', 'year', 'gender', 'lookingFor', 'age'];

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Select({ label, field, value, options, onChange }) {
  return (
    <div className="field">
      <label htmlFor={field}>{label}</label>
      <select id={field} name={field} value={value} onChange={event => onChange(field, event.target.value)}>
        <option value="">Choose one…</option>
        {options.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A heading that breaks this form into parts a student can read. The page has one
 * h1 and every block under it is an h2, so a screen reader listing headings gets
 * the shape of the form rather than one long page of controls.
 */
function SectionTitle({ id, children, sub }) {
  return (
    <h2 className="section-title form-section" id={id}>
      {children}
      {sub ? <span className="section-sub"> {sub}</span> : null}
    </h2>
  );
}

/**
 * A short chip list with the server's cap on it. The line under the chips is the
 * part that matters: an empty list has to read as an answer — "anyone suits me" —
 * and not as a field the student got to and gave up on.
 */
function Picks({ label, field, options, picked, onToggle, max }) {
  return (
    <div className="field">
      <span className="field-label" id={`${field}-label`}>
        {label}
        <span className="hint"> optional, up to {max}</span>
      </span>
      <div className="chips" role="group" aria-labelledby={`${field}-label`}>
        {options.map(option => {
          const on = picked.includes(option);
          return (
            <button
              type="button"
              key={option}
              className={on ? 'chip on' : 'chip'}
              aria-pressed={on}
              onClick={() => onToggle(field, option)}
            >
              {option}
            </button>
          );
        })}
      </div>
      <p className="hint">
        {picked.length
          ? `${picked.length} of ${max} picked — press one again to take it off.`
          : 'Nothing picked, which means any answer to this one suits you.'}
      </p>
    </div>
  );
}

export default function ProfileBuilder() {
  const { meta } = useMeta();
  const { busy, error, result, run, reset } = useAction();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saved, setSaved] = useState(null);
  // What the server currently holds about where you study and what you look like.
  // `saved` is cleared on every edit so the "you are ready" band cannot go stale,
  // and this is not: the institution is not an answer you are in the middle of
  // changing, and the faculty list has to survive a keystroke to be a list at all.
  const [stored, setStored] = useState(null);
  const [form, setForm] = useState({
    faculty: '',
    year: '',
    gender: '',
    lookingFor: '',
    age: '',
    // The optional look-like block. Every one of these starts empty, and empty is
    // the answer "I am not saying", not a half-filled form.
    identity: '',
    bodyType: '',
    height: '',
    drinks: '',
    smokes: '',
    gym: '',
    seekBodyTypes: [],
    seekHeights: [],
    seekDrinks: [],
    seekSmokes: [],
    seekGym: [],
    typeNote: '',
    revealName: '',
    interests: [],
    prompts: {},
    preferred: [],
  });
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNote, setPhotoNote] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    let alive = true;
    api.profile
      .get()
      .then(data => {
        if (!alive) return;
        setLoading(false);
        setStored(fromProfile(data.profile, data.institution));
        if (!data.profile) return;
        setSaved(data.profile);
        setForm(formFrom(data.profile));
      })
      .catch(err => {
        if (!alive) return;
        setLoading(false);
        setLoadError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  function set(field, value) {
    reset();
    setSaved(null);
    setForm(current => ({ ...current, [field]: value }));
  }

  function setPrompt(prompt, answer) {
    reset();
    setSaved(null);
    setForm(current => ({ ...current, prompts: { ...current.prompts, [prompt]: answer } }));
  }

  function toggleInterest(interest) {
    const max = (meta && meta.minimums && meta.minimums.maxInterests) || 10;
    setForm(current => {
      const picked = current.interests.includes(interest)
        ? current.interests.filter(item => item !== interest)
        : [...current.interests, interest];
      if (picked.length > max) picked.splice(0, picked.length - max);
      return { ...current, interests: picked };
    });
    reset();
    setSaved(null);
  }

  /** The five "who I am after" lists, all capped by the server's own number. */
  function togglePick(field, value) {
    const max = (meta && meta.minimums && meta.minimums.maxPicks) || 3;
    setForm(current => {
      const picked = current[field].includes(value)
        ? current[field].filter(item => item !== value)
        : [...current[field], value];
      if (picked.length > max) picked.splice(0, picked.length - max);
      return { ...current, [field]: picked };
    });
    reset();
    setSaved(null);
  }

  /** Ranks are the order; the server assigns them the same way from the same list. */
  function addPreference(id) {
    if (!id) return;
    setForm(current => ({ ...current, preferred: [...current.preferred.filter(item => item !== id), id] }));
    reset();
    setSaved(null);
  }

  function removePreference(id) {
    setForm(current => ({ ...current, preferred: current.preferred.filter(item => item !== id) }));
    reset();
    setSaved(null);
  }

  function movePreference(index, delta) {
    setForm(current => {
      const list = [...current.preferred];
      const to = index + delta;
      if (to < 0 || to >= list.length) return current;
      [list[index], list[to]] = [list[to], list[index]];
      return { ...current, preferred: list };
    });
    reset();
    setSaved(null);
  }

  /** The server's own minimums, so the meter and the API cannot disagree. */
  const minimums =
    (meta && meta.minimums) || { interests: 2, prompts: 1, promptAnswerMax: 220, revealNameMax: 30, maxPicks: 3, typeNoteMax: 200 };
  const ageRange = (meta && meta.ageRange) || { min: 18, max: 30 };
  const maxPreferred = minimums.maxPreferredInstitutions || 3;
  const facultyMax = minimums.facultyMax || 80;
  const maxPicks = minimums.maxPicks || 3;

  // The look-like vocabularies, with a short fallback so the block still renders if
  // /api/meta has not answered yet. The self lists are the server's; the seek lists
  // get "never mind either way" added, which is the one answer that is only ever a
  // thing to say about somebody you have not met.
  const either = (meta && meta.lifestyle && meta.lifestyle.either) || 'Never mind either way';
  const lookOptions = {
    identity: (meta && meta.identity) || [],
    bodyType: (meta && meta.bodyTypes) || [],
    height: (meta && meta.heights) || [],
    drinks: ((meta && meta.lifestyle && meta.lifestyle.drinks) || []).slice(),
    smokes: ((meta && meta.lifestyle && meta.lifestyle.smokes) || []).slice(),
    gym: ((meta && meta.lifestyle && meta.lifestyle.gym) || []).slice(),
  };
  const afterOptions = {
    seekBodyTypes: lookOptions.bodyType,
    seekHeights: lookOptions.height,
    seekDrinks: lookOptions.drinks.concat([either]),
    seekSmokes: lookOptions.smokes.concat([either]),
    seekGym: lookOptions.gym.concat([either]),
  };

  const institution = stored && stored.institution;
  const ownId = institution ? institution.id : null;

  /** Every active institution that is not the one you already belong to. */
  const preferenceOptions = useMemo(() => {
    const list = (meta && meta.institutions) || [];
    return list.filter(entry => entry.id !== ownId);
  }, [meta, ownId]);

  const nameOf = id => {
    const entry = preferenceOptions.find(option => option.id === id);
    return entry ? entry.shortName : 'an institution no longer on Unmask';
  };

  const offeredFaculties = (institution && institution.faculties) || [];
  // Staff can edit an institution's list while a student is signed up. The answer
  // on file is kept as a choice so loading this form cannot quietly blank it and
  // make the next save refuse a faculty the student never set out to change.
  const facultyOptions =
    offeredFaculties.length && form.faculty && !offeredFaculties.includes(form.faculty)
      ? [...offeredFaculties, form.faculty]
      : offeredFaculties;

  const done = useMemo(() => {
    const answers = Object.values(form.prompts).filter(text => text.trim().length >= 10).length;
    return {
      fields: FIELD_ORDER.filter(field => form[field] !== '').length,
      interests: form.interests.length >= minimums.interests ? 1 : 0,
      prompts: answers >= minimums.prompts ? 1 : 0,
      total: FIELD_ORDER.length + 2,
      answers,
    };
  }, [form, minimums]);

  const percent = Math.round((Math.min(done.fields, FIELD_ORDER.length) + done.interests + done.prompts) / (FIELD_ORDER.length + 2) * 100);

  async function onSave(event) {
    event.preventDefault();
    await run(
      () =>
        api.profile.save({
          faculty: form.faculty,
          year: form.year,
          gender: form.gender,
          lookingFor: form.lookingFor,
          age: Number(form.age),
          // Sent on every save, empty included. The API reads a key that is absent
          // as "this client does not know about the field" and leaves the stored
          // answer alone, so a form that shows all twelve has to name all twelve —
          // otherwise pressing "say nothing" on a chip would change nothing.
          identity: form.identity,
          bodyType: form.bodyType,
          height: form.height,
          drinks: form.drinks,
          smokes: form.smokes,
          gym: form.gym,
          seekBodyTypes: form.seekBodyTypes,
          seekHeights: form.seekHeights,
          seekDrinks: form.seekDrinks,
          seekSmokes: form.seekSmokes,
          seekGym: form.seekGym,
          typeNote: form.typeNote.trim(),
          // An empty string is the student's own "no name", and services/profile.js
          // turns it into nothing stored — not a failed save.
          revealName: form.revealName.trim(),
          interests: form.interests,
          prompts: Object.entries(form.prompts)
            .filter(([, answer]) => answer.trim())
            .map(([prompt, answer]) => ({ prompt, answer: answer.trim() })),
          // Not `institutionId`: the API takes that from the verified address and
          // has no branch that would accept it from here.
          preferredInstitutions: form.preferred.map(id => ({ institutionId: id })),
        }),
      data => {
        setSaved(data.profile);
        setStored(fromProfile(data.profile));
        setForm(formFrom(data.profile));
      }
    );
  }

  async function onPickPhoto(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    setPhotoBusy(true);
    setPhotoNote(null);
    reset();
    try {
      const before = file.size;
      const encoded = await encodePhoto(file);
      const packet = new FormData();
      packet.append('photo', encoded, 'photo.jpg');
      const data = await api.profile.uploadPhoto(packet);
      setSaved(data.profile);
      setStored(fromProfile(data.profile));
      setPhotoNote(
        `Saved. Your ${humanSize(before)} picture became ${humanSize(data.size)}, with the location data taken out.`
      );
    } catch (err) {
      setPhotoNote(err.message || 'That photo could not be sent.');
    } finally {
      setPhotoBusy(false);
    }
  }

  async function onRemovePhoto() {
    setPhotoBusy(true);
    try {
      const data = await api.profile.removePhoto();
      setSaved(data.profile);
      setStored(fromProfile(data.profile));
      setPhotoNote('Photo removed. Nobody can see it any more.');
    } catch (err) {
      setPhotoNote(err.message || 'The photo could not be removed.');
    } finally {
      setPhotoBusy(false);
    }
  }

  const hasPhoto = Boolean(stored && stored.hasPhoto);
  const photoStamp = stored && stored.photoUploadedAt ? String(stored.photoUploadedAt) : '';

  // A hold has its own band, so it is not repeated as a to-do item.
  const todoLines = saved ? saved.missing.filter(line => !line.startsWith('a staff member')) : [];

  return (
    <AppShell
      title="Build the part of you a match sees"
      intro="No name, no surname, no student number — this site never asks for them. What it asks for is what you want to be matched on."
    >
      {loading ? <p className="server-line">Loading your profile…</p> : null}
      {loadError ? <p className="server-error" role="alert">{loadError}</p> : null}

      {!loading && !loadError ? (
        <form className="stack" onSubmit={onSave}>
          <div className="meter" role="img" aria-label={`Profile ${percent} percent complete`}>
            {/* The width is set through the DOM, not a style attribute: an inline
                attribute needs 'unsafe-inline' in the page's content security policy,
                and this was the one place in the app that asked for it. */}
            <div className="meter-bar" ref={el => { if (el) el.style.width = `${percent}%`; }} />
            <span className="meter-text">{percent}% ready to match</span>
          </div>

          {saved && saved.held ? (
            <p className="server-error" role="alert">
              <b>A staff member paused your profile.</b> Their note: “{saved.held}” You are not being matched until
              you change something, so edit whatever you disagree with and press save — that alone puts you back in
              play.
            </p>
          ) : null}
          {todoLines.length ? (
            <p className="hint">
              Still needed before a match: {todoLines.join('; ')}.
            </p>
          ) : null}
          {saved && saved.matchable ? (
            <p className="server-ok" role="status">Your profile is complete — you are eligible to be matched. Open Match to see your first suggestion.</p>
          ) : null}

          <div className="field">
            <span className="field-label">Where you study</span>
            {stored && stored.institution ? (
              <p className="server-line">
                <b>{stored.institution.name}</b>
                {stored.institution.shortName && stored.institution.shortName !== stored.institution.name
                  ? ` — shown to a match as ${stored.institution.shortName}`
                  : ''}
              </p>
            ) : (
              <p className="server-error" role="alert">
                Your address no longer points at an institution on Unmask, so this profile cannot be saved or matched.
              </p>
            )}
            <p className="hint">
              This is not a field, because it is not a question: the student address you verified already answered it,
              and letting this form restate it would let anyone become another college's student. If it is wrong, sign
              out and register with the right address — or ask staff to fix your account.
            </p>
          </div>

          <div className="row2">
            <Select label="Year of study" field="year" value={form.year} options={meta ? meta.years : []} onChange={set} />
            <div className="field">
              <label htmlFor="age">
                Age<span className="req" aria-hidden="true"> *</span>
              </label>
              <input
                id="age"
                name="age"
                type="number"
                min={ageRange.min}
                max={ageRange.max}
                inputMode="numeric"
                value={form.age}
                onChange={event => set('age', event.target.value)}
                aria-describedby="age-hint"
              />
              <p className="hint" id="age-hint">
                {ageRange.min}–{ageRange.max}. Unmask is only for adult students, and this is checked, not assumed.
              </p>
            </div>
          </div>

          {!institution ? null : facultyOptions.length ? (
            <Select label="Faculty" field="faculty" value={form.faculty} options={facultyOptions} onChange={set} />
          ) : (
            <div className="field">
              <label htmlFor="faculty">Faculty or school</label>
              <input
                id="faculty"
                name="faculty"
                type="text"
                autoComplete="off"
                maxLength={facultyMax}
                value={form.faculty}
                onChange={event => set('faculty', event.target.value)}
                aria-describedby="faculty-hint"
                placeholder="Whatever your own registrar calls it."
              />
              <p className="hint" id="faculty-hint">
                Your institution has not been given a faculty list on Unmask, so this is typed rather than chosen — a
                staff member can add one and it becomes a dropdown here. It is checked like everything else: a phone
                number, an @handle or a link is refused, because a match reads this line.
              </p>
            </div>
          )}

          <div className="row2">
            <Select label="I am" field="gender" value={form.gender} options={meta ? meta.genders : []} onChange={set} />
            <Select
              label="Looking for"
              field="lookingFor"
              value={form.lookingFor}
              options={meta ? meta.lookingFor : []}
              onChange={set}
            />
          </div>

          <hr className="rule" />

          <SectionTitle id="look-title" sub="every line optional, and none of it decides who you are shown">
            What you look like
          </SectionTitle>
          <p className="hint">
            These are yours to leave empty. An empty answer is not a disadvantage here: the engine reads a blank as
            &ldquo;this student did not say&rdquo; and scores them exactly as it would have scored anybody else, so
            nobody is pushed down a list for skipping a box.
          </p>

          <div className="row2">
            <Select
              label="I describe myself as"
              field="identity"
              value={form.identity}
              options={lookOptions.identity}
              onChange={set}
            />
            <Select label="My body type" field="bodyType" value={form.bodyType} options={lookOptions.bodyType} onChange={set} />
          </div>
          <p className="hint">
            The first of those two is a sentence about yourself and nothing more. There is no matching box beside it on
            purpose: Unmask never sorts, scores, hides or shows anybody because of a race, and on a site where every
            account is a verified student at a named college, a race filter is not a feature that can be added later and
            explained away. Pick it if you want to say it — it goes onto your profile, and it plays no part in who you
            meet or who meets you.
          </p>

          <div className="row2">
            <Select label="My height" field="height" value={form.height} options={lookOptions.height} onChange={set} />
            <Select label="How much I drink" field="drinks" value={form.drinks} options={lookOptions.drinks} onChange={set} />
          </div>
          <div className="row2">
            <Select label="Smoking" field="smokes" value={form.smokes} options={lookOptions.smokes} onChange={set} />
            <Select label="How often I am at the gym" field="gym" value={form.gym} options={lookOptions.gym} onChange={set} />
          </div>

          <hr className="rule" />

          <SectionTitle id="after-title" sub="up to three each, all optional">Who you are after</SectionTitle>
          <p className="hint">
            This list can only ever move somebody <b>up</b> your list a little. It cannot remove anyone, it cannot be
            seen by the person it describes as a rejection, and a student you have said nothing about still turns up
            exactly as they did before. That is the whole of what a preference does here — it is a nudge, not a gate.
          </p>

          <Picks
            label="Body types you would like to meet"
            field="seekBodyTypes"
            options={afterOptions.seekBodyTypes}
            picked={form.seekBodyTypes}
            onToggle={togglePick}
            max={maxPicks}
          />
          <Picks
            label="Heights you would like to meet"
            field="seekHeights"
            options={afterOptions.seekHeights}
            picked={form.seekHeights}
            onToggle={togglePick}
            max={maxPicks}
          />
          <Picks
            label="How much they drink"
            field="seekDrinks"
            options={afterOptions.seekDrinks}
            picked={form.seekDrinks}
            onToggle={togglePick}
            max={maxPicks}
          />
          <Picks
            label="Smoking"
            field="seekSmokes"
            options={afterOptions.seekSmokes}
            picked={form.seekSmokes}
            onToggle={togglePick}
            max={maxPicks}
          />
          <Picks
            label="How often they are at the gym"
            field="seekGym"
            options={afterOptions.seekGym}
            picked={form.seekGym}
            onToggle={togglePick}
            max={maxPicks}
          />

          <div className="field">
            <label htmlFor="typeNote">In your own words, what is your type?</label>
            <textarea
              id="typeNote"
              value={form.typeNote}
              maxLength={minimums.typeNoteMax}
              rows={3}
              onChange={event => set('typeNote', event.target.value)}
              aria-describedby="type-note-hint"
              placeholder="Two sentences about the sort of person you hope to meet."
            />
            <p className="hint" id="type-note-hint">
              {form.typeNote.trim().length}/{minimums.typeNoteMax}. This one is the only place your own words go on this
              block, so it carries the same two rules as every other sentence here: a phone number, an @handle or a link
              is refused, because a match reads it, and it changes nothing about who you are shown — the engine never
              reads a note. A staff member can pause your profile over it the same way they can over a prompt answer.
            </p>
          </div>

          <hr className="rule" />

          <div className="field">
            <span className="field-label" id="prefs-label">
              Which institutions you would like to be shown
              <span className="hint"> optional, up to {maxPreferred}</span>
            </span>
            {form.preferred.length ? (
              <ol className="pref-list">
                {form.preferred.map((id, index) => (
                  <li key={id}>
                    <span className="pref-name">{nameOf(id)}</span>
                    <span className="hint">
                      {index === 0 ? 'first choice' : index === 1 ? 'second choice' : 'third choice'}
                    </span>
                    <span className="row-gap">
                      <button type="button" className="btn small ghost" onClick={() => movePreference(index, -1)} disabled={index === 0}>
                        Up
                      </button>
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => movePreference(index, 1)}
                        disabled={index === form.preferred.length - 1}
                      >
                        Down
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => removePreference(id)}>
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">Nothing picked — you are open to every institution on Unmask.</p>
            )}
            {form.preferred.length < maxPreferred ? (
              preferenceOptions.length ? (
                <select
                  aria-label="Add an institution to your list"
                  value=""
                  onChange={event => addPreference(event.target.value)}
                >
                  <option value="">Add an institution…</option>
                  {preferenceOptions.map(entry => (
                    <option key={entry.id} value={entry.id}>
                      {entry.shortName} — {entry.city || 'no city given'}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="hint">You are the only institution on Unmask right now, so there is nothing to add.</p>
              )
            ) : (
              <p className="hint">
                That is all {maxPreferred}. Take one off to swap it for another.
              </p>
            )}
            <p className="hint">
              Your own institution is already in every pool, so it is not offered here and does not spend one of these
              slots. This list decides who you are shown and in what order — it never decides who sees you, so leaving
              it empty costs you nothing but the ordering.
            </p>
          </div>

          <div className="field">
            <label htmlFor="revealName">
              If you both agree to reveal, what should they be told you are called?
              <span className="hint"> optional</span>
            </label>
            <input
              id="revealName"
              name="revealName"
              type="text"
              autoComplete="off"
              maxLength={minimums.revealNameMax}
              value={form.revealName}
              onChange={event => set('revealName', event.target.value)}
              aria-describedby="reveal-name-hint"
              placeholder="A first name, a nickname, whatever you answer to."
            />
            <p className="hint" id="reveal-name-hint">
              Nobody sees this until the two of you both press yes, and leaving it empty is a real answer — a reveal
              can still happen with no name in it. It plays no part in who you are shown, and it is checked like
              everything else here: a phone number, an @handle or a link is refused, because a name a stranger is
              handed must not be a way to reach you.
            </p>
          </div>

          <div className="field">
            <span className="field-label" id="interests-label">
              What are you into? <span className="hint">pick at least {minimums.interests}, up to {minimums.maxInterests}</span>
            </span>
            <div className="chips" role="group" aria-labelledby="interests-label">
              {(meta ? meta.interests : []).map(interest => {
                const picked = form.interests.includes(interest);
                return (
                  <button
                    type="button"
                    key={interest}
                    className={picked ? 'chip on' : 'chip'}
                    aria-pressed={picked}
                    onClick={() => toggleInterest(interest)}
                  >
                    {interest}
                  </button>
                );
              })}
            </div>
            <p className="hint">
              {form.interests.length} picked
              {form.interests.length < minimums.interests ? ` — ${minimums.interests - form.interests.length} more to go` : ''}.
            </p>
          </div>

          {(meta ? meta.prompts : []).map((prompt, index) => {
            const answer = form.prompts[prompt] || '';
            return (
              <div className="field" key={prompt}>
                <label htmlFor={`prompt-${index}`}>{prompt}</label>
                <textarea
                  id={`prompt-${index}`}
                  value={answer}
                  maxLength={minimums.promptAnswerMax}
                  rows={3}
                  onChange={event => setPrompt(prompt, event.target.value)}
                  aria-describedby={`prompt-${index}-hint`}
                  placeholder="Leave it empty if you do not want to answer this one."
                />
                <p className="hint" id={`prompt-${index}-hint`}>
                  {answer.trim().length}/{minimums.promptAnswerMax}. A match reads this before they read anything else,
                  so it is allowed to be an opinion.
                </p>
              </div>
            );
          })}

          <div className="photo-block">
            <div className="photo-row">
              <div className="avatar">
                {hasPhoto ? (
                  <img src={api.profile.url(photoStamp)} alt="Your profile photo, which only you can see right now" />
                ) : (
                  <span aria-hidden="true">?</span>
                )}
              </div>
              <div className="photo-text">
                <b>Your photo</b>
                <p className="hint">
                  {hasPhoto
                    ? 'Only you can see this. A match sees nothing until you both agree to reveal, and the picture is resized with its location data stripped before it is stored.'
                    : 'Optional. A match never sees it until you both agree to reveal — there is no blurred version in between.'}
                </p>
                <div className="row-gap">
                  <button type="button" className="btn small" onClick={() => fileInput.current && fileInput.current.click()} disabled={photoBusy}>
                    {photoBusy ? 'Working…' : hasPhoto ? 'Replace photo' : 'Add a photo'}
                  </button>
                  {hasPhoto ? (
                    <button type="button" className="btn small ghost" onClick={onRemovePhoto} disabled={photoBusy}>
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={onPickPhoto}
                  disabled={photoBusy}
                  hidden
                />
                {photoNote ? <p className="server-line">{photoNote}</p> : null}
              </div>
            </div>
          </div>

          <hr className="rule" />

          {error ? <p className="server-error" role="alert">{error}</p> : null}
          {result && !error ? <p className="server-ok" role="status">{result.message}</p> : null}

          <button className="btn pink block" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save my profile'}
          </button>

          <p className="hint center">
            Saved at any level of completion — half an answer tonight is not thrown away. It only takes part in
            matching once it is finished. <Link to="/me">Back to your account</Link>
          </p>
        </form>
      ) : null}
    </AppShell>
  );
}

/**
 * The three things this screen shows that a student cannot edit.
 *
 * `fallback` is the institution sent beside a profile that does not exist yet — the
 * state of every account the first time it opens this form. Which college you belong
 * to is read off your verified address, so it is known before you have written a
 * word, and the faculty field needs it to know whether to be a list or a box.
 */
function fromProfile(profile, fallback) {
  return {
    institution: (profile && profile.institution) || fallback || null,
    hasPhoto: Boolean(profile && profile.hasPhoto),
    photoUploadedAt: (profile && profile.photoUploadedAt) || null,
  };
}

function formFrom(profile) {
  return {
    faculty: profile.faculty || '',
    year: profile.year || '',
    gender: profile.gender || '',
    lookingFor: profile.lookingFor || '',
    age: profile.age == null ? '' : String(profile.age),
    identity: profile.identity || '',
    bodyType: profile.bodyType || '',
    height: profile.height || '',
    drinks: profile.drinks || '',
    smokes: profile.smokes || '',
    gym: profile.gym || '',
    seekBodyTypes: profile.seekBodyTypes || [],
    seekHeights: profile.seekHeights || [],
    seekDrinks: profile.seekDrinks || [],
    seekSmokes: profile.seekSmokes || [],
    seekGym: profile.seekGym || [],
    typeNote: profile.typeNote || '',
    revealName: profile.revealName || '',
    interests: profile.interests || [],
    prompts: Object.fromEntries((profile.prompts || []).map(entry => [entry.prompt, entry.answer])),
    preferred: [...(profile.preferredInstitutions || [])]
      .sort((a, b) => a.rank - b.rank)
      .map(entry => String(entry.institutionId)),
  };
}
