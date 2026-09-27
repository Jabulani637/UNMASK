import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';

/**
 * NFR-3.4 — the privacy notice, in the words the site actually deserves.
 *
 * This page is a legal requirement written as product copy, so it holds to the
 * same rule the rest of the build does: it says what this code does and nothing
 * else. Every sentence below can be pointed at a file. Where the honest answer is
 * "not yet" — off-disk backups, a support inbox, a document check of student
 * status — the page says so rather than filling the gap with a clause.
 *
 * It is readable without signing in on purpose. A notice you have to register to
 * read is a notice nobody reads before deciding whether to register.
 */

function Section({ id, title, children }) {
  return (
    <section className="legal-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        {title}
      </h2>
      <div className="legal-body">{children}</div>
    </section>
  );
}

export default function Privacy() {
  return (
    <AppShell
      title="Privacy"
      intro="What Unmask keeps about you, who is allowed to see it, and how to take it back. Written for a person reading it once, in plain words, with nothing hidden at the bottom of a page."
      wide
    >
      <div className="legal">
        <p className="legal-lead">
          Unmask is a dating site for students at verified institutions that works the other way round: the things
          that usually identify you — your name and your face — are the last things anyone sees, not the first. That
          design decision is most of this notice already. The rest is what the site still has to hold in order to
          function, and what it does with it.
        </p>
        <p className="hint">
          Last written for this build: 26 September 2026. Each statement below describes code that is running, not
          intentions.
        </p>

        <Section id="collected" title="What we collect">
          <p>Eight groups, and nothing outside them:</p>
          <ul>
            <li>
              <b>Sign-in.</b> Your student email address, a scrambled (hashed) copy of your password, the date you
              confirmed the address, the date you attested you are 18 or older, and the last time you signed in.
            </li>
            <li>
              <b>Your profile.</b> Faculty, year, gender, who you are looking for, your age as a number, two to ten
              interests chosen from a fixed list, your written prompt answers (at least one), one optional profile
              photo, one optional name of up to 30 characters to show only if a reveal is accepted, the institution
              your confirmed address proved you study at (you cannot set this one, and it is never a free-text box),
              and up to three other institutions you would like to be shown at, in the order you ranked them.
            </li>
            <li>
              <b>What you look like, if you say so.</b> Body type, a height band, how much you drink, whether you
              smoke, how often you are at the gym, and up to three answers on each of those questions about the sort
              of person you would like to meet — plus one optional sentence or two in your own words. Every one of
              these is optional, and none of it decides whether you can be matched: leaving all of it empty is a
              complete profile.
            </li>
            <li>
              <b>Race, which is treated differently from everything above.</b> One optional line where you describe
              yourself. It is sensitive personal information, we hold it because you chose to say it, and it is
              collected for one purpose only: to appear on your profile, where you wrote it. There is no matching box
              beside it, so there is no way for it to be used to decide who anybody sees. It is not in the arithmetic
              that ranks a list, it is not on the anonymous card a stranger reads, and it is not on the staff screen
              that reviews a report. If a future version of this site ever wanted to sort people by it, the data to
              do so would have to be collected a second time and this paragraph rewritten.
            </li>
            <li>
              <b>What you do.</b> The suggestions you passed on, the conversations you opened, every message you
              wrote, whether you asked for or agreed to a reveal, and any block or report you filed.
            </li>
            <li>
              <b>Notices.</b> The unread counters on your bell, and the three switches on your account screen that
              decide whether you get them.
            </li>
            <li>
              <b>Keeping you signed in.</b> Up to five session records per account — a scrambled copy of the cookie,
              its expiry, and the browser string that created it. Change your password and all five are dropped.
            </li>
          </ul>
          <p>
            What is <b>not</b> collected: your name (unless you choose a reveal name), your phone number, your date of
            birth, where you are, your other accounts, what you read on other sites, or anything from another
            company. There is no advertising SDK, no analytics script and no tracker anywhere in the page, and no
            request leaves this site: the two fonts the page is drawn in are served from the same folder as the code
            that needs them, which used to be the one exception and is not any more. The API itself serves no scripts
            to a browser at all.
          </p>
        </Section>

        <Section id="used" title="What it is used for">
          <ul>
            <li>To match you with one student at a time, on the interests you share, how close your ages are, whether
              each of you asked to be shown at the other&apos;s institution, and whether the two institutions are in
              the same city — the city stored against a college, never anywhere you have personally been.</li>
            <li>
              To rank that list a little higher for the answers <b>you</b> picked under &ldquo;who you are after&rdquo;.
              It is the only thing those picks do, and it can only ever lift somebody in your own order: there is no
              number a profile can score that removes another profile from your list, and a student who said nothing
              about themselves is scored as if they had. Your race is used for nothing here at all — it is not read
              when a list is ranked, and it is not read when a card is written.
            </li>
            <li>To let the two of you talk, and to let the two of you decide together whether to reveal.</li>
            <li>To let a report reach a staff member who can act on it.</li>
            <li>To keep the site up: a rate limiter counts requests per address, and an over-limit attempt writes one
              log line with a scrambled copy of that address, never the address itself.</li>
          </ul>
          <p>
            Nothing is used for anything else. Your messages are not read to build profiles of you, no model is
            trained on them, and they are not sold, licensed, shared or shown to any third party — there is no third
            party to share them with, because the whole system is one database, one API and one website.
          </p>
        </Section>

        <Section id="seen" title="Who can see what">
          <p>
            Another student never sees your email address, your name, your photo, your user id or the exact time you
            did something. What they see is the card: your year, your faculty, the short name of your institution, up
            to five of the interests you have in common, one of your prompt answers, the appearance answers you chose
            to give — body type, height band, drinking, smoking, gym — the up-to-three picks you made about who you
            are after, your sentence about your type, and the score. Not your age, not your gender, not the city your
            college is in, and no way to reach your own record from the card — the opening link carries a one-time
            token instead of an id. Not your race either: that line reaches nobody until the two of you have both said
            yes, and then it reads as what it always was, something you said about yourself. After a reveal they also
            get the reveal name, if you chose one. Two people in the same faculty of the same college may still be able
            to guess who a card is — a small faculty makes that likelier than a large one, and it is a risk you both
            take, which is why the reveal is a choice rather than a default.
          </p>
          <p>
            A photo is not a URL a browser can fetch. It is stored outside the folder the website serves, under a
            random filename, and the API will only hand it over to the account it belongs to — or, after both of you
            have agreed, to the one person you agreed to reveal to. Nobody else has a path to it.
          </p>
          <p>
            A staff member of Unmask sees the report you or someone else files, the words inside it, and the two
            profiles it is about, because a decision needs both sides. They do not get a browseable list of
            everyone's messages, and their own queue screens carry no email addresses and no photo filenames — only
            the picture itself, opened by a deliberate click.
          </p>
        </Section>

        <Section id="emails" title="Email">
          <p>
            Three emails exist: confirming your address, resetting your password, and — only if you switch it on —
            a notice that something is waiting for you. The optional notice never contains another student's name,
            address or a word of what they wrote; the sentence is built by the server and says only that something
            happened on your bell.
          </p>
          <p>
            Honest note about this build: while no mail server is configured, those emails are written to a folder on
            the server instead of being sent. Nothing is delivered to an inbox, and an account stays unverified until
            somebody with access to that folder opens the link.
          </p>
        </Section>

        <Section id="rights" title="Your rights, as buttons">
          <p>POPIA gives you rights. Two of them are on your account screen, and one is on your profile screen:</p>
          <ul>
            <li>
              <b>Access.</b> <i>Account → Download everything we hold about you</i> gives you a single readable file:
              your sign-in record, your profile, every conversation with every message, the suggestions you declined,
              the blocks you made, the reports you filed and the reports filed about you, your notices, and the log
              entries about your account. It lists the same rows that a deletion would take, because both promises
              read one list. Other students stay unnamed in it — their side of a thread is theirs, not yours.
            </li>
            <li>
              <b>Deletion.</b> <i>Account → Delete this account</i> is immediate. Your account, profile, photo file,
              matches, messages, blocks, reports you filed and notices are erased at that moment, and the cookie is
              destroyed. There is no undo and no grace period.
            </li>
            <li>
              <b>Correction.</b> Your profile screen is editable at any time, and the notification switches take effect
              on the next event rather than the next restart.
            </li>
            <li>
              <b>Complaint.</b> If you think this site is processing your personal information outside POPIA, you may
              contact South Africa&apos;s Information Regulator. That right exists whatever this page says.
            </li>
          </ul>
        </Section>

        <Section id="deletion" title="What deletion does to the other person">
          <p>
            A conversation belongs to two people, so deleting your account deletes that thread for both of you. A
            thread with one deleted participant is not a thread, and the other half of it is their data too.
          </p>
          <p>
            A report is the same shape: it holds the reporter&apos;s words and the reported person&apos;s conduct, so
            it goes when either of those two accounts is deleted. What survives is the staff member&apos;s own log
            entry — the record that a decision was made, by them, on a day — because that is their working record
            and not your personal information.
          </p>
          <p>
            The consequence is worth saying plainly: if you delete your account while a report you filed is still
            undecided, that report disappears with you and nobody is told why. Deleting is not a way of withdrawing a
            complaint and it is not a way of making one go away — if you want a decision to stand, it has to be
            decided before you go.
          </p>
        </Section>

        <Section id="keeping" title="How long, and where">
          <p>
            Data is kept until you delete it, or until Unmask&apos;s staff close the account. It lives in one database
            in one deployment; nothing is exported to a partner, nothing is processed overseas, and the only other
            copy that exists is the backup folder described just below.
          </p>
          <p>
            POPIA&apos;s section 14 says personal data should not be kept longer than the purpose needs. Backups exist
            in this build — one command writes the whole database, and the photos with it, into a dated folder, and a
            restore has been proven to read such a folder back — so a copy of your data can exist outside the live
            database. A snapshot is not rewritten when you delete your account: the deletion clears every live row at
            that moment, and a folder written before it still holds them until whoever runs the server retires it.
            That is the operator&apos;s duty, not the software&apos;s promise — the same command takes a{' '}
            <code>--keep</code> number that deletes its own oldest snapshots, and a deployed copy is meant to run it on
            a schedule. Where that is not switched on, say so on this page before students register, rather than
            implying a deletion reaches further than it does.
          </p>
        </Section>

        <Section id="children" title="Age, and who may register">
          <p>
            18 and over, and an address at one of the institutions Unmask has been set up for. Both are asked for at
            sign-up. The address is checked against the domains its staff have recorded, and whichever institution
            owns that domain becomes the one on your profile — there is no list of colleges written into this site, so
            a college added last week is as real here as one added first. The age is an attestation, and a staff member
            who is shown a reason can take the account off the site again (that is the status on your account screen,
            with the staff member&apos;s own sentence attached to it). There is no document check, so this is an honest
            wall with a known gate, not proof.
          </p>
        </Section>

        <Section id="changes" title="Changes to this page">
          <p>
            If any of the above stops being true, this page changes before the code does, and the date at the top
            changes with it. Small wording fixes that do not move what is collected are not treated as news.
          </p>
          <p>
            There is no support inbox in this build. Whoever deploys a copy of Unmask is responsible for adding their
            own information-officer contact here before students register on it.
          </p>
        </Section>

        <hr className="rule" />
        <p className="hint">
          The rules this page describes are the code in <code>api/src/services</code>. If the two ever disagree, the
          code is the one that is actually running, and that is a bug worth reporting. See also{' '}
          <Link to="/terms">the terms of use</Link>.
        </p>
      </div>
    </AppShell>
  );
}
