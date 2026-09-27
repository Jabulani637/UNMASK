import { Link } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';

/**
 * NFR-8.3 — the terms of use: who may join, what counts as using this badly, and
 * what happens when somebody does.
 *
 * Written as three lists a person can actually hold in their head, because the
 * requirement is an <i>accessible</i> one. The consequences section is the part
 * that matters most and the part a real site usually hides: every outcome named
 * below is a button a staff member has in the queue, and every one of them is
 * described in the words a suspended student sees when they try to sign in.
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

export default function Terms() {
  return (
    <AppShell
      title="Terms of use"
      intro="The rules for using Unmask. Short enough to read once, specific enough to tell you what happens if they are broken."
      wide
    >
      <div className="legal">
        <p className="legal-lead">
          By creating an account you agree to what is on this page. If you do not agree, do not register — deleting
          afterwards works, but it deletes the conversation the two of you had, so signing up to test the exit is
          unkind to whoever matched you.
        </p>
        <p className="hint">Last written for this build: 26 September 2026.</p>

        <Section id="who" title="Who may use this">
          <ul>
            <li>You are 18 years or older. This is asked for at sign-up and attested to, not proven.</li>
            <li>
              You have a current email address at one of the institutions Unmask has been set up for, and you are the
              person it belongs to. Registration is closed to every other domain. If your college is not on the list,
              there is a form to ask for one, linked from the landing page and from the sign-up screen — registering
              around the list is the same as not being a student on a site for students.
            </li>
            <li>One account per person. A second account to reach someone who blocked or reported you is the clearest
              way to be closed out.</li>
            <li>Everything you write here is true about you — your year, your faculty, your age, your interests.</li>
          </ul>
          <p>
            A staff member who is given a reason can mark an account as not a student here, or under age. That stops
            the account, takes it out of everyone&apos;s suggestions and tells you, in their words, the next time you
            try to sign in. It is not a document check, and this site does not claim it is one.
          </p>
        </Section>

        <Section id="use" title="Using it properly">
          <ul>
            <li>
              <b>Say what you mean.</b> The whole product is prompt answers and interests. Padding a profile with
              nothing, or writing a prompt answer that is a phone number or a link to elsewhere, defeats it.
            </li>
            <li>
              <b>Take no when it is given.</b> A passed-on suggestion does not come back. A closed conversation does
              not reopen. Following someone off the site after they stopped replying is harassment, and it is a
              reportable thing here even though the words happened elsewhere.
            </li>
            <li>
              <b>Nothing that is not yours to post.</b> No screenshots of other people&apos;s conversations, no photos
              of somebody who is not you, no other student&apos;s details.
            </li>
            <li>
              <b>No hatred, no threats, no soliciting.</b> Content that attacks a person for who they are, threatens
              harm, or asks for money, sex or personal information from someone who has not offered it.
            </li>
            <li>
              <b>Do not try to unmask anyone.</b> Guessing who a card is from its details is a risk two students take
              on themselves. Building a tool, a script or a campaign to identify someone who has not chosen to reveal
              themselves is using this against its one purpose.
            </li>
            <li>
              <b>One request at a time.</b> Automated registration, mass messaging, scraping suggestions, or anything
              that spends someone else&apos;s rate limit on purpose.
            </li>
          </ul>
          <p>
            A photo here is not a permission slip. If a reveal is accepted, the name and face you see belong to a
            person, not to you — and nothing on this page can technically stop a screenshot, which is why the reveal is
            a mutual decision and not a default.
          </p>
        </Section>

        <Section id="harassment" title="Harassment, and what you can do about it">
          <p>Three doors, and none of them needs your name:</p>
          <ul>
            <li>
              <b>Block.</b> At the bottom of a conversation, or from a profile card. They are told nothing; the thread
              simply reads as ended. You can undo a block from your account screen, and undoing it will not restart the
              conversation.
            </li>
            <li>
              <b>Report.</b> From a message, a prompt answer, a photo or a profile. You pick a reason and write what
              happened. A staff member sees the words, both profiles and the thread it came from. You are not sent the
              outcome, and the other student is never told who reported them — what they are shown is the staff
              member&apos;s own sentence about what must change, which is the part they can act on.
            </li>
            <li>
              <b>Leave.</b> Close a conversation, or delete your account from the same screen that changes your
              password. Both are available without explaining yourself to anyone.
            </li>
          </ul>
          <p>
            If somebody is in immediate danger, contact your institution&apos;s own security services or the South
            African Police Service first. This site has a moderation queue, not a control room, and no report here is
            monitored around the clock.
          </p>
        </Section>

        <Section id="consequences" title="What happens when these are broken">
          <p>
            These are the consequences of breaking the rules above. A staff member has exactly four of them, and two
            cannot be recorded without writing the sentence the student will read: taking a profile out of the pool,
            and deciding somebody is not a student here.
          </p>
          <ul>
            <li>
              <b>Nothing</b> — the report is closed as dismissed. It is written down in the staff log, and the student
              it was about is told nothing, because a complaint that reached no finding is not a fact about them.
            </li>
            <li>
              <b>Content held</b> — the profile stops being suggested to anyone until it is fixed, and the staff
              member&apos;s sentence about what is wrong is shown to its owner on the profile screen. The words
              themselves are not edited by anyone: a profile belongs to the student who wrote it, and this site will
              not rewrite sentences on their behalf.
            </li>
            <li>
              <b>Suspended</b> — signed out on every device, every open conversation closed, and no signing back in
              until a staff member lifts it. There is no waiting period in the software, so the note is the only way to
              learn how long is meant.
            </li>
            <li>
              <b>Banned</b> — the same, with no lift in sight. The record is not erased: a closed account&apos;s data is
              still that student&apos;s personal information, and the way it goes is the delete button on their own
              account screen, not a staff decision.
            </li>
          </ul>
          <p>
            The sentence explaining a decision is written by the staff member who made it, so its quality is theirs and
            not the software&apos;s. If you think a decision about you is wrong, the route is a staff member of Unmask
            rather than this page: a staff account cannot delete its own audit trail, and nobody running this site
            edits decisions after the fact.
          </p>
        </Section>

        <Section id="yours" title="What you keep, and what you let us hold">
          <p>
            Your words and your photo stay yours. You give Unmask permission to do only the things the site cannot
            work without: store them, show a profile card to another student who is being introduced to you, and show
            your name and photo to one specific person if and only if both of you agree to the reveal. That permission
            ends when the data is deleted — there is no clause that survives your own erasure.
          </p>
          <p>
            We do not sell or share personal information, we do not advertise, and we do not train anything on your
            messages. How any of this is stored, seen, exported and destroyed is on the{' '}
            <Link to="/privacy">privacy notice</Link>, which these terms are read together with.
          </p>
        </Section>

        <Section id="as-is" title="What this site is not">
          <ul>
            <li>
              It is not verified. Nobody checks your student card, your age, or what another student tells you about
              theirs. An address at a domain this site has been told to accept, and a promise, are the whole of the
              gate.
            </li>
            <li>
              It is not a safety service. Moderation happens when a staff member opens the queue. Meetings happen
              between two adults who are responsible for them; the usual advice about a first meeting in a public
              place applies to a site that never showed you a face.
            </li>
            <li>
              It is provided as it is, with no warranty of availability. It can be taken down, changed or broken while
              you are using it, and nobody here has signed anything promising otherwise.
            </li>
          </ul>
        </Section>

        <Section id="changes" title="Changes, and which law this sits under">
          <p>
            If a rule on this page changes, the date above changes and the page says what moved. Continued use after a
            change means the new version. A change that takes something away from you — a new reason to suspend, for
            instance — should be read, not discovered later, so those are the sentences worth paying attention to.
          </p>
          <p>
            Unmask is run under South African law, and its handling of your personal information is governed by POPIA.
            It is open to whichever institutions its operator has set up, and the two are the same decision: whoever
            deploys a copy of Unmask becomes the body that verifies colleges, staffs the queue and answers for the
            data. There is no support inbox in this build; whoever deploys a copy adds their own details here before
            students use it.
          </p>
        </Section>
      </div>
    </AppShell>
  );
}
