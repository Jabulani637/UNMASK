import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiStatus } from '../hooks/useApiStatus.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { institutionNames, useMeta } from '../hooks/useMeta.js';

const STEPS = [
  {
    n: 1,
    title: 'Build a profile',
    body: 'Faculty, year of study, interests, a couple of honest prompts. Photo is optional and stays hidden either way.',
  },
  {
    n: 2,
    title: 'Get one match',
    body: 'We suggest one person at a time based on real compatibility, not a swipe deck full of strangers.',
  },
  {
    n: 3,
    title: 'Chat, then reveal',
    body: "Talk it out anonymously first. When you're both curious, request a reveal — it only unlocks if you both agree.",
  },
];

const OTHER_APPS = [
  'Judge a photo in 0.5 seconds, never read the bio',
  'Full of strangers nobody has checked are students',
  'Endless swiping, no real matching logic',
  'Catfish city — the photo is rarely current',
];

const UNMASK_WAYS = [
  'You match on compatibility, not a thumbnail',
  'Only students at verified institutions, proven by their own address',
  'One suggested match at a time, chosen for you',
  'No photo required — reveal is mutual, on your terms',
];

const FAQS = names => [
  {
    q: 'Which institutions can join right now?',
    a: names
      ? `${names}. If yours is not on that list, there is a link to ask for it under the sign-up buttons on this page — staff add it from inside the site, so a new college does not need a new version of the software.`
      : 'Whoever has been set up on Unmask by its staff. The list on the sign-up page is the answer, and it changes as colleges are added.',
  },
  {
    q: 'Do I have to add a photo?',
    a: 'No. Adding a photo is completely optional. If you do add one, it stays hidden until both you and your match agree to reveal.',
  },
  {
    q: 'How does matching actually work?',
    a: 'We look at your interests, your preferences, and your prompt answers to suggest one person at a time — not a wall of profiles to scroll through.',
  },
  {
    q: 'What happens after we reveal?',
    a: "You keep chatting, now knowing who's on the other end. Nothing forces you to meet up — the reveal just removes the anonymity from the conversation.",
  },
  {
    q: 'Who can see what I write?',
    a: 'Only the one person you are chatting with. Nothing you type becomes searchable, and your name, student number and contact details are never shown to anyone before you both agree to reveal.',
  },
];

function StatusStrip() {
  const { state, data } = useApiStatus();

  const databaseUp = state === 'up' && data.readiness.database;
  const institutions = state === 'up' ? data.readiness.activeInstitutions : 0;

  let text;
  if (state === 'checking') text = 'Checking the service…';
  else if (state === 'down') text = 'The service behind this page is not running yet.';
  else if (!databaseUp) text = 'The service is up but cannot reach its database yet.';
  else
    text = `The service is live on this machine · accounts are restricted to students at ${institutions} verif${institutions === 1 ? 'ied institution' : 'ied institutions'}`;

  return (
    <div className="status-strip" role="status">
      <div className="wrap">
        <span
          className={`status-dot ${state === 'up' && databaseUp ? 'ok' : state === 'down' ? 'down' : ''}`}
          aria-hidden="true"
        />
        <span>{text}</span>
      </div>
    </div>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const { meta } = useMeta();
  const [picked, setPicked] = useState('');

  /**
   * The hero names a college, so it can only ever name one the API is currently
   * verifying students at. Nothing here holds an institution's name, a domain or a
   * faculty: `meta.institutions` is the same list the sign-up form validates against,
   * which is what lets staff add a college without a new build of this page.
   */
  const options = (meta && meta.institutions) || [];
  const chosen = options.find(institution => institution.id === picked) || null;
  const names = institutionNames(meta);

  return (
    <>
      <a className="skiplink" href="#main">
        Skip to content
      </a>

      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <Link className="wordmark" to="/">
            Unmask<span className="dot">.</span>
          </Link>
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#faq">FAQ</a>
            {user ? (
              <Link className="btn blue small cta" to="/me">
                Signed in as {user.email.split('@')[0]}
              </Link>
            ) : (
              <>
                <Link to="/login">Sign in</Link>
                <Link className="btn pink small cta" to="/signup">
                  Create profile
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      <main id="main">
        <header className="hero">
          <div className="wrap hero-inner">
            <div>
              <div className="hero-tags">
                {/* The 🎭 from the prototype is decoration; the words carry the
                    meaning, so assistive tech is told to skip the glyph. */}
                <span className="sticker">
                  <span aria-hidden="true">🎭</span> ANONYMOUS FIRST
                </span>
                <span className="sticker">
                  <span aria-hidden="true">🎓</span> VERIFIED STUDENTS ONLY
                </span>
                <span className="sticker">
                  <span aria-hidden="true">🚫</span> NO CATFISH
                </span>
              </div>
              <h1 className="display">
                Find someone at{' '}
                <span className="hl">{chosen ? chosen.shortName : 'your college'}</span> before you
                see their <span className="hl2">face</span>.
              </h1>
              <p className="hero-sub">
                No photo pressure. No swiping on strangers. Build a real profile, get matched on
                what actually matters, and talk in a chatroom until you're both ready to reveal.
              </p>

              {options.length ? (
                <div className="field hero-pick">
                  <label htmlFor="hero-institution">
                    Which college are you at? We will show you its name instead.
                  </label>
                  <select
                    id="hero-institution"
                    aria-describedby="hero-institution-hint"
                    value={picked}
                    onChange={event => setPicked(event.target.value)}
                  >
                    <option value="">
                      {names ? `Any of these — ${names}` : 'Any institution on Unmask'}
                    </option>
                    {options.map(institution => (
                      <option key={institution.id} value={institution.id}>
                        {institution.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint" id="hero-institution-hint">
                    {chosen
                      ? `${chosen.shortName} students prove it with an address at ${chosen.emailDomains
                          .map(domain => `@${domain}`)
                          .join(
                            ' or '
                          )}. Choosing a name here only changes what this page says — nothing is saved.`
                      : `${
                          names
                            ? `Unmask is open to students at ${names}.`
                            : 'Unmask is open to students at the institutions listed above.'
                        } Your own address decides which one you belong to.`}
                  </span>
                </div>
              ) : null}

              <p className="hero-note">
                <Link to="/request-institution">Don't see your college? Ask for it →</Link>
              </p>

              <div className="hero-actions">
                <Link
                  className="btn pink"
                  to={chosen ? `/signup?institution=${chosen.id}` : '/signup'}
                >
                  Create my profile →
                </Link>
                <span className="hero-note">Free · Takes 2 minutes · Students only</span>
              </div>
            </div>

            <div className="hero-art" aria-hidden="true">
              <div className="art-card one">
                <div className="art-avatar" />
                <b>92% match</b>
                <span>
                  {chosen && chosen.faculties.length
                    ? `2nd year · ${chosen.faculties[0]} · ${chosen.shortName}`
                    : '2nd year · your faculty · your college'}
                </span>
              </div>
              <div className="art-card two">
                <b>"Say less"</b>
                <span>Anonymous chatroom, live before either of you knows who's who.</span>
              </div>
              <div className="art-card three">
                <b>Reveal</b>
                <span>Only happens when you BOTH say yes.</span>
              </div>
            </div>
          </div>
        </header>

        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head">
              <h2 className="section-title">How this actually works</h2>
              <p className="section-sub">
                Three steps. No bios full of gym selfies, no guessing if the photo is five years
                old.
              </p>
            </div>
            <div className="steps">
              {STEPS.map(step => (
                <div className="step-card" key={step.n}>
                  <div className="step-num" aria-hidden="true">
                    {step.n}
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <h2 className="section-title">Not another swipe app</h2>
              <p className="section-sub">
                Every other app on your phone starts with a photo. This one ends with one.
              </p>
            </div>
            <div className="compare">
              <div className="compare-col bad">
                <h3>Other apps</h3>
                <ul className="compare-list">
                  {OTHER_APPS.map(line => (
                    <li key={line}>
                      <span className="mark" aria-hidden="true">
                        ✕
                      </span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="compare-col good">
                <h3>Unmask</h3>
                <ul className="compare-list">
                  {UNMASK_WAYS.map(line => (
                    <li key={line}>
                      <span className="mark" aria-hidden="true">
                        ✓
                      </span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="section no-border" id="faq">
          <div className="wrap">
            <div className="section-head">
              <h2 className="section-title">Questions, answered</h2>
            </div>
            <div>
              {FAQS(names).map(faq => (
                <details className="faq-item" key={faq.q}>
                  <summary>
                    <span>{faq.q}</span>
                    <span className="plus" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <p>{faq.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="footer-cta">
          <div className="wrap">
            <h2>
              Stop swiping.
              <br />
              Start talking.
            </h2>
            <p className="hero-note">
              Registration is live in this build. Until a mail server is connected, verification
              links land in a folder on the server instead of your inbox.
            </p>
            <Link className="btn" to="/signup">
              Create my profile →
            </Link>
          </div>
        </section>

        <StatusStrip />
      </main>

      <footer className="footer">
        <span>Unmask — built for students at verified institutions · your name and photo stay hidden until you both say yes</span>
        <span className="footer-links">
          <Link to="/request-institution">Request a college</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </span>
      </footer>
    </>
  );
}
