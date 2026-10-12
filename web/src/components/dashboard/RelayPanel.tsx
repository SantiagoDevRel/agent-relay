import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, GitPullRequestArrow, Play, Square } from 'lucide-react';
import { ApiError, getMissionCatalog, startRelay, stopRelay } from '@/lib/api';
import type { MissionCatalog, Notify, RelayJob, RelayStatus, Snapshot } from '@/lib/types';
import { Button } from './Controls';
import { PromptRefinement } from './PromptRefinement';
import { ProjectSelector } from './ProjectSelector';

const terminal = new Set<RelayStatus>(['approved', 'stopped', 'attention', 'expired']);
const labels: Record<RelayStatus, string> = { queued: 'Queued', sending: 'Enviando', submitted: 'Confirming receipt', working: 'Running', recovering: 'Recovering context', approved: 'GO confirmed', stopped: 'Stopped by you', attention: 'Needs attention', expired: 'Time expired' };
const nextStep: Record<RelayStatus, string> = {
  queued: 'Wait for both chats to finish their turns. The cycle sends its next instruction only when they are idle.',
  sending: 'An instruction is being sent. Wait for its receipt before interacting with either chat.',
  submitted: 'Wait for the chat to confirm receipt. Do not repeat the instruction.',
  working: 'Follow the current implementation or review in its chat. You can inspect Criteria and log below.',
  recovering: 'Context recovery is in progress. Wait for the current turn to finish.',
  approved: 'Review the final result in the implementation chat. The review cycle has finished.',
  stopped: 'Future handoffs have stopped. Read both chats before deciding whether to start another cycle.',
  attention: 'Read Criteria and log, then inspect both chats before starting another cycle.',
  expired: 'The time limit was reached. Read the saved log and both chats before deciding how to continue.',
};
function RelayProgress({ job, busy, onStop }: { job: RelayJob; busy: boolean; onStop: (id: string) => void }) {
  return <article className={`relay-job relay-${job.status}`} aria-label={`Ciclo: ${job.goal}`}>
    <div className="relay-job-heading"><h3>{job.goal}</h3><span className="relay-status">{labels[job.status]}</span></div>
    <p className="relay-route"><span>{job.members.builder.title}</span><ArrowRight size={16} aria-hidden="true" /><span>{job.members.tester.title}</span></p>
    <p className="relay-detail" role="status">{job.detail}</p>
    <p className="dialog-note">Next: {nextStep[job.status]}</p>
    <p className="dialog-note">Review {job.round} of {job.maxRounds} · Until {new Date(job.deadline).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}{job.recoveryUsed ? ' · Recovery used' : ''}{job.questionCount ? ` · ${job.questionCount}/4 clarifications` : ''}</p>
    <details className="relay-evidence"><summary>Criteria and log</summary><p className="relay-acceptance">{job.acceptance}</p>{job.revision && <p className="relay-revision">Revision: <code>{job.revision}</code></p>}<ol>{job.events.map((event, index) => <li key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString('en-US')}</time> {event.text}</li>)}</ol></details>
    {!terminal.has(job.status) && <Button className="danger-button" disabled={busy} onClick={() => onStop(job.id)}><Square size={14} />Stop future handoffs</Button>}
  </article>;
}
export function RelayPanel({ snapshot, onNotify, connected, page = false, active: pageActive = true }: { snapshot: Snapshot; onNotify: Notify; connected: boolean; page?: boolean; active?: boolean }) {
  const [open, setOpen] = useState(false), [builderId, setBuilderId] = useState(''), [testerId, setTesterId] = useState('');
  const [goal, setGoal] = useState(''), [acceptance, setAcceptance] = useState(''), [maxRounds, setMaxRounds] = useState(4), [minutes, setMinutes] = useState(720);
  const [project, setProject] = useState(''), [catalog, setCatalog] = useState<MissionCatalog | null>(null), [catalogError, setCatalogError] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const jobs = snapshot.relays?.jobs ?? [], active = jobs.find(job => !terminal.has(job.status));
  const eligible = snapshot.chats.filter(chat => chat.alive && !chat.automated && (chat.state === 'working' || chat.state === 'waiting'));
  const selected = builderId !== testerId && eligible.some(chat => chat.id === builderId) && eligible.some(chat => chat.id === testerId);
  const unavailable = !snapshot.relays || Boolean(snapshot.relays.error) || !connected;
  useEffect(() => {
    if (!(page || open) || !pageActive || !connected) return;
    const controller = new AbortController();
    getMissionCatalog(controller.signal).then(value => { if (!controller.signal.aborted) { setCatalog(value); setCatalogError(''); } }).catch(cause => { if (!controller.signal.aborted) setCatalogError(cause instanceof ApiError ? cause.detail || cause.code : 'Could not load models for preparing the request.'); });
    return () => controller.abort();
  }, [page, open, pageActive, connected]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await startRelay({ builderId, testerId, goal, acceptance, maxRounds, minutes }); setOpen(true); onNotify('Cycle created. It will wait for both chats to finish their turns.', 'info'); }
    catch (cause) { setError(cause instanceof ApiError && cause.code === 'relay active' ? 'A cycle is already active. Wait for its result or stop future handoffs.' : 'Could not create the cycle. Check that both chats are still open and the dashboard is connected.'); }
    finally { setBusy(false); }
  }
  async function stop(id: string) {
    setBusy(true); setError('');
    try { await stopRelay(id); onNotify('Future handoffs stopped. Chats remain open.', 'info'); }
    catch { setError('Could not stop future handoffs. Check the connection and retry.'); }
    finally { setBusy(false); }
  }
  return <section className={`panel relay-panel ${page ? 'page-panel' : ''}`}>
    {page ? <header className="page-panel-heading"><h2><GitPullRequestArrow size={18} aria-hidden="true" />Orchestrator</h2><p className="dialog-note">Two existing conversations · implementation and review</p></header> : <button type="button" className="insights-toggle relay-toggle" aria-expanded={open} aria-controls="relay-body" onClick={() => setOpen(!open)}><span><GitPullRequestArrow size={18} aria-hidden="true" /><strong>Orchestrate chats</strong></span><span>{active ? `${labels[active.status]} · ${active.turn === 'builder' ? 'Implementation' : 'Review'}` : 'Only when you start it'} · {open ? 'Hide' : 'Open'}</span></button>}
    {(page || open) && <div id="relay-body" className="relay-body">
      <p>Connect two chats you already have open: one implements and the other reviews. Each round hands a revision to the tester; unmet criteria return to the builder. You choose up to ten reviews.</p>
      <p className="dialog-note">Each turn uses its model’s usual quota. Waiting does not run models. If two reviews do not reduce blockers, context is compacted once and the cycle continues within the same limit. Technical questions are resolved with evidence between the chats, up to four clarifications; new permissions remain your decision.</p>
      {(error || snapshot.relays?.error || unavailable) && <p role="alert" className="assistant-warning">{error || snapshot.relays?.error || 'Orchestration is unavailable on this connection.'}</p>}
      {active && <RelayProgress job={active} busy={busy || !connected} onStop={stop} />}
      {!active && <form onSubmit={submit}>
        <fieldset className="relay-fields" disabled={busy || snapshot.paused || unavailable}>
          <legend className="sr-only">New implementation and review cycle</legend>
          <ol className="flow-steps" aria-label="Cycle setup"><li><span>1</span>Choose chats</li><li><span>2</span>Define goal and checks</li><li><span>3</span>Start cycle</li></ol>
          <div className="relay-pair">
            <label>Implementation chat<select required value={builderId} onChange={event => setBuilderId(event.target.value)}><option value="">Select an open chat</option>{eligible.filter(chat => chat.id !== testerId).map(chat => <option key={chat.id} value={chat.id}>{chat.title} · {chat.tool === 'codex' ? 'Codex' : 'Claude'}</option>)}</select></label>
            <label>Review chat<select required value={testerId} onChange={event => setTesterId(event.target.value)}><option value="">Select an open chat</option>{eligible.filter(chat => chat.id !== builderId).map(chat => <option key={chat.id} value={chat.id}>{chat.title} · {chat.tool === 'codex' ? 'Codex' : 'Claude'}</option>)}</select></label>
          </div>
          {eligible.length < 2 && <p role="status">You need two open interactive chats. Open the chats you want to connect.</p>}
          <details className="mission-evidence"><summary>Reference project for preparing the request (optional)</summary><ProjectSelector value={project} onChange={setProject} active={pageActive && (page || open)} connected={connected} required={false} disabled={busy || unavailable} /></details>
          <label>What you want to achieve<textarea required minLength={10} maxLength={4000} rows={2} placeholder="For example: fix MCP authentication errors" value={goal} onChange={event => setGoal(event.target.value)} /></label>
          <label>What the tester must verify<textarea required minLength={10} maxLength={6000} rows={4} placeholder="Define checks, expected behavior, and what is out of scope. These criteria stay fixed during the cycle." value={acceptance} onChange={event => setAcceptance(event.target.value)} /></label>
          {catalogError ? <p className="assistant-warning" role="alert">{catalogError} You can use your text without AI refinement.</p> : null}
          <PromptRefinement kind="relay" project={project || undefined} goal={goal} acceptance={acceptance} catalog={catalog} disabled={busy || unavailable} onAdopt={value => { setGoal(value.goal); setAcceptance(value.acceptance); }} />
          <details className="relay-evidence" onInvalid={event => { event.currentTarget.open = true; }}><summary>Review and time limits · {maxRounds} reviews · {minutes} minutes</summary><div className="relay-pair relay-limits"><label>Maximum reviews<select value={maxRounds} onChange={event => setMaxRounds(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => index + 1).map(n => <option key={n} value={n}>{n}</option>)}</select><span className="dialog-note">Each review checks one builder revision. The cycle ends when it meets the criteria or reaches this maximum.</span></label><label>Total time (minutes)<input type="number" required min={10} max={720} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /><span className="dialog-note">Includes implementation, review, and clarifications. Chat work is kept when time expires.</span></label></div></details>
          <Button type="submit" className="power-on" disabled={!selected || goal.trim().length < 10 || acceptance.trim().length < 10}><Play size={15} />Start cycle</Button>
        </fieldset>
      </form>}
      <p className="dialog-note">Instructions are sent to the open chats when both are idle. Stopping the cycle cancels future handoffs; each chat keeps its work and stays open. After a dashboard restart, check the last handoff before starting another cycle.</p>
      {jobs.some(job => terminal.has(job.status)) && <details className="relay-history"><summary>Ciclos anteriores ({jobs.filter(job => terminal.has(job.status)).length})</summary>{[...jobs].reverse().filter(job => terminal.has(job.status)).map(job => <RelayProgress key={job.id} job={job} busy={busy} onStop={stop} />)}</details>}
    </div>}
  </section>;
}
