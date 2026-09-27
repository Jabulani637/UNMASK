import { useState } from 'react';
import { api } from '../api.js';
import { useAction } from '../hooks/useAction.js';
import { useMeta } from '../hooks/useMeta.js';

/**
 * FR-6.1 and FR-6.2 — report something, or block somebody, from wherever it hurt.
 *
 * The three screens that can reach another student's content mount this instead of
 * writing their own panel, so that the same two rules hold everywhere:
 *
 * **A press only ever names something already on the screen.** The caller hands over
 * a thread id, a suggestion token, a message id, or a prompt index — the same handles
 * it already renders — and this component forwards them unchanged. It has no account
 * id to send and no way to ask for one, which is what keeps a report from being
 * aimed at a stranger (NFR-3.3).
 *
 * **Reporting and blocking stay two separate presses.** A report asks a person to
 * look; a block stops the other student reaching you, right now, without waiting for
 * anybody. Folding them together would mean a student who wanted something reviewed
 * silently cutting somebody off, and the API's own success sentence ends by pointing
 * at the block rather than performing it.
 *
 * The `targets` array is what each screen *can* name, and nothing else: the Match
 * card offers a profile by token, the chat offers a profile and individual messages,
 * the reveal page adds the prompt answers and the photo it is currently showing.
 */
export default function SafetyActions({
  matchId = null,
  token = null,
  targets = [],
  onBlocked = null,
  label = 'Something wrong here?',
}) {
  const { meta } = useMeta();
  const [open, setOpen] = useState(null);
  const [kind, setKind] = useState(targets[0]?.kind || '');
  const [promptIndex, setPromptIndex] = useState('');
  const [messageId, setMessageId] = useState('');
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');

  const report = useAction();
  const block = useAction();

  const blockable = Boolean(matchId || token);
  const choices = targets.filter(t => t.kind === kind);

  function pickKind(next) {
    setKind(next);
    setPromptIndex('');
    setMessageId('');
    report.reset();
  }

  function openPanel(which) {
    setOpen(which);
    report.reset();
    block.reset();
  }

  function closeAll() {
    setOpen(null);
    report.reset();
    block.reset();
  }

  async function onReport(event) {
    event.preventDefault();
    const target = choices[0];
    if (!target) return;

    const body = { kind: target.kind, reason, detail: detail.trim() || null };
    if (matchId) body.matchId = matchId;
    if (token) body.token = token;
    if (target.kind === 'prompt') body.promptIndex = Number(promptIndex);
    if (target.kind === 'message') body.messageId = messageId;

    const data = await report.run(() => api.safety.report(body));
    if (data && !data.already) setDetail('');
  }

  async function onBlock() {
    const data = await block.run(() => api.safety.block(matchId ? { matchId } : { token }));
    if (data && data.closedThread && onBlocked) onBlocked(data);
  }

  return (
    <div className="safety">
      <div className="row safety-row">
        <p className="safety-lead">{label}</p>
        {targets.length ? (
          <button
            className="btn ghost small"
            type="button"
            onClick={() => openPanel(open === 'report' ? null : 'report')}
            aria-expanded={open === 'report'}
          >
            {open === 'report' ? 'Close' : 'Report it'}
          </button>
        ) : null}
        {blockable ? (
          <button
            className="btn ghost small"
            type="button"
            onClick={() => openPanel(open === 'block' ? null : 'block')}
            aria-expanded={open === 'block'}
          >
            {open === 'block' ? 'Close' : 'Block this student'}
          </button>
        ) : null}
      </div>

      {open === 'report' ? (
        targets.length ? (
          <form className="stack safety-panel" onSubmit={onReport}>
            {targets.length > 1 ? (
              <div className="field">
                <label htmlFor="safety-kind">What are you reporting?</label>
                <select
                  id="safety-kind"
                  value={kind}
                  onChange={event => pickKind(event.target.value)}
                  disabled={report.busy}
                >
                  {targets.map(target => (
                    <option
                      key={`${target.kind}:${target.promptIndex ?? ''}:${target.messages ? 'msg' : ''}`}
                      value={target.kind}
                    >
                      {target.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="server-line">
                Reporting <b>{targets[0].label}</b> — a staff member is sent exactly what is on your screen, read back
                from the server.
              </p>
            )}

            {kind === 'prompt' ? (
              <div className="field">
                <label htmlFor="safety-prompt">Which answer?</label>
                <select
                  id="safety-prompt"
                  value={promptIndex}
                  onChange={event => setPromptIndex(event.target.value)}
                  disabled={report.busy}
                  required
                >
                  <option value="">Choose an answer</option>
                  {choices[0]?.prompts?.map((row, index) => (
                    <option key={row.prompt} value={index}>
                      {row.prompt}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {kind === 'message' ? (
              <div className="field">
                <label htmlFor="safety-message">Which message of theirs?</label>
                <select
                  id="safety-message"
                  value={messageId}
                  onChange={event => setMessageId(event.target.value)}
                  disabled={report.busy}
                  required
                >
                  <option value="">Choose a message</option>
                  {choices[0]?.messages?.map(row => (
                    <option key={row.id} value={row.id}>
                      {row.body.length > 60 ? `${row.body.slice(0, 60)}…` : row.body}
                    </option>
                  ))}
                </select>
                <p className="hint">Only their own messages are listed — we read the words from the server, not from this page.</p>
              </div>
            ) : null}

            <div className="field">
              <label htmlFor="safety-reason">Why?</label>
              <select
                id="safety-reason"
                value={reason}
                onChange={event => setReason(event.target.value)}
                disabled={report.busy}
                required
              >
                <option value="">Choose a reason</option>
                {(meta?.reportReasons || []).map(row => (
                  <option key={row} value={row}>
                    {row}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="safety-detail">Anything a staff member should know? (optional)</label>
              <textarea
                id="safety-detail"
                value={detail}
                onChange={event => setDetail(event.target.value)}
                maxLength={600}
                rows={3}
                placeholder="Dates, what was said, anything that helps. Nobody sees this but staff."
              />
            </div>

            {report.error ? <p className="server-error" role="alert">{report.error}</p> : null}
            {report.result ? (
              <p className="server-ok" role="status">
                {report.result.message}
              </p>
            ) : null}

            <div className="row">
              <button className="btn pink small" type="submit" disabled={report.busy || !reason || !choices.length}>
                {report.busy ? 'Sending…' : 'Send report'}
              </button>
              {report.result ? (
                <button className="btn ghost small" type="button" onClick={closeAll}>
                  Done
                </button>
              ) : null}
            </div>

            <p className="hint">
              A report sends a staff member what was on your screen at this moment. It does not stop the other student
              from reaching you — only a block does that.
            </p>
          </form>
        ) : (
          <p className="server-error" role="alert">There is nothing on this screen that can be reported.</p>
        )
      ) : null}

      {open === 'block' ? (
        <div className="stack safety-panel">
          {block.result ? (
            <>
              <p className="server-ok" role="status">
                {block.result.message}
              </p>
              <div className="row">
                <button className="btn ghost small" type="button" onClick={closeAll}>
                  Done
                </button>
                <button className="btn ghost small" type="button" onClick={() => setOpen('report')}>
                  Report them too
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="server-line">
                Blocking is immediate and it works both ways: neither of you will be suggested to the other again, and
                this conversation closes. What the other student sees is the same line they would see if you had simply
                ended the chat — they are not told that you blocked them, or why.
              </p>
              <p className="hint">
                You can undo it from your account screen, but the conversation that closed stays closed: lifting a block
                cannot quietly reopen the other person&rsquo;s walk-away.
              </p>
              {block.error ? <p className="server-error" role="alert">{block.error}</p> : null}
              <div className="row">
                <button className="btn pink small" type="button" onClick={onBlock} disabled={block.busy}>
                  {block.busy ? 'Blocking…' : 'Yes, block them'}
                </button>
                <button className="btn ghost small" type="button" onClick={closeAll}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
