import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, RefreshCw, WandSparkles } from 'lucide-react';
import { ApiError, getPromptHistory, getPromptLog, refinePrompt } from '@/lib/api';
import type { MissionCatalog, ModelSelection, PromptRefinementHistory, PromptRefinementLog, PromptRefinementResult } from '@/lib/types';
import { Button } from './Controls';
import { ModelSelector, modelSelectionReady } from './ModelSelector';

export function PromptRefinement({ kind, goal, acceptance = '', project, catalog, disabled, onAdopt }: {
  kind: 'mission' | 'relay'; goal: string; acceptance?: string; project?: string; catalog: MissionCatalog | null; disabled?: boolean;
  onAdopt: (value: { goal: string; acceptance: string }) => void;
}) {
  const [selection, setSelection] = useState<ModelSelection>({ provider: 'codex', model: '', effort: 'high' });
  const [result, setResult] = useState<PromptRefinementResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [finalGoal, setFinalGoal] = useState(''), [finalAcceptance, setFinalAcceptance] = useState(''), [answers, setAnswers] = useState<string[]>([]);
  const [source, setSource] = useState({ goal: '', acceptance: '' }), [adoptedGoal, setAdoptedGoal] = useState('');
  const [adoptedAcceptance, setAdoptedAcceptance] = useState('');
  const [expanded, setExpanded] = useState(false), [history, setHistory] = useState<PromptRefinementHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState(''), [historyRevision, setHistoryRevision] = useState(0);
  const [attemptId, setAttemptId] = useState(''), [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<PromptRefinementLog | null>(null), [logLoading, setLogLoading] = useState(false), [logError, setLogError] = useState('');
  const [logRevision, setLogRevision] = useState(0);
  const [copiedOriginal, setCopiedOriginal] = useState(false), [copyError, setCopyError] = useState('');
  const requestSeq = useRef(0);
  const attempt = history?.attempts.find(item => item.id === attemptId);
  const attemptStatus = { refining: 'Preparing', ready: 'Ready', needs_input: 'Needs your answers', attention: 'Needs attention' };
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setHistoryLoading(true); setHistoryError('');
    getPromptHistory(kind, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setHistory(value); setAttemptId(current => current && value.attempts.some(item => item.id === current) ? current : value.attempts[0]?.id || '');
    }).catch(cause => {
      if (!controller.signal.aborted) setHistoryError(cause instanceof ApiError ? cause.detail || cause.code : 'Could not load saved preparations. Check the connection and refresh.');
    }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [expanded, kind, historyRevision]);
  useEffect(() => {
    if (!expanded || !logOpen || !attemptId) return;
    const controller = new AbortController();
    setLogLoading(true); setLog(null); setLogError(''); setCopiedOriginal(false); setCopyError('');
    getPromptLog(attemptId, controller.signal).then(value => { if (!controller.signal.aborted) setLog(value); })
      .catch(cause => { if (!controller.signal.aborted) setLogError(cause instanceof ApiError ? cause.detail || cause.code : 'Could not load this log. Check the connection and refresh.'); })
      .finally(() => { if (!controller.signal.aborted) setLogLoading(false); });
    return () => controller.abort();
  }, [expanded, logOpen, attemptId, logRevision]);
  const maxGoal = kind === 'relay' ? 4000 : 20000;
  const maxAcceptance = kind === 'relay' ? 6000 : 20000;
  const combined = kind === 'mission' ? finalGoal : `${finalGoal}\n${finalAcceptance}`;
  const omitted = result?.spec.requirements.filter(item => item.literal.trim() && !combined.includes(item.literal.trim())) ?? [];
  const questions = result?.spec.questions ?? [];
  const answered = result?.status !== 'needs_input' || (questions.length > 0 && questions.every((_, index) => answers[index]?.trim()));
  const stale = Boolean(result && ((goal !== source.goal && goal !== adoptedGoal) || (kind === 'relay' && acceptance !== source.acceptance && acceptance !== adoptedAcceptance)));
  const valid = Boolean(result && finalGoal.trim().length >= 10 && finalGoal.length <= maxGoal && finalAcceptance.length <= maxAcceptance && (kind !== 'relay' || finalAcceptance.trim().length >= 10) && omitted.length === 0 && answered && !stale);
  async function improve() {
    if (busy || disabled || goal.trim().length < 10 || !modelSelectionReady(catalog, selection)) return;
    const seq = ++requestSeq.current, original = { goal, acceptance };
    setBusy(true); setError(''); setAdoptedGoal(''); setResult(null); setLogOpen(false);
    try {
      const entry = await refinePrompt({ kind, goal, acceptance, ...(project ? { project } : {}), ...selection });
      if (seq !== requestSeq.current) return;
      setSource(original); setResult(entry); setAnswers(entry.spec.questions.map(() => ''));
      setFinalGoal(entry.spec.goal);
      setFinalAcceptance(entry.spec.acceptance);
      setAttemptId(entry.id);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof ApiError ? cause.detail || cause.code : 'The connection ended before a result arrived. Check the saved preparation and log before retrying. Your original text is unchanged.');
      if (cause instanceof ApiError && cause.refinementId) { setAttemptId(cause.refinementId); setLogOpen(true); setLogRevision(current => current + 1); }
    }
    finally { if (seq === requestSeq.current) { setBusy(false); setHistoryRevision(current => current + 1); } }
  }
  function adopt() {
    if (!valid || disabled) return;
    const clarification = questions.map((question, index) => answers[index]?.trim() ? `${question}\nAnswer: ${answers[index].trim()}` : '').filter(Boolean).join('\n\n');
    const adopted = `${finalGoal.trim()}${clarification ? `\n\nUser clarifications:\n${clarification}` : ''}`;
    if (adopted.length > maxGoal) { setError(`The final request exceeds ${maxGoal.toLocaleString('en-US')} characters. Shorten the explanation while keeping the original requirements.`); return; }
    onAdopt({ goal: adopted, acceptance: finalAcceptance.trim() }); setAdoptedGoal(adopted); setAdoptedAcceptance(finalAcceptance.trim()); setError('');
  }
  async function copyOriginal() {
    if (!log?.original) return;
    try {
      await navigator.clipboard.writeText(log.original.goal + (log.original.acceptance ? `\n\nOriginal criteria:\n${log.original.acceptance}` : ''));
      setCopiedOriginal(true); setCopyError('');
    } catch { setCopiedOriginal(false); setCopyError('Clipboard access failed. Open Your original request and select its text to copy it.'); }
  }
  return <details className="prompt-refinement" onToggle={event => setExpanded(event.currentTarget.open)}><summary><WandSparkles size={16} aria-hidden="true" />Prepare request with AI</summary>
    <div className="prompt-refinement-body">
      <p className="dialog-note">Turn your text into testable requirements and criteria. Review and apply the result before starting.</p>
      <ModelSelector label="AI that prepares the request" catalog={catalog} value={selection} onChange={setSelection} disabled={disabled || busy} />
      <p className="dialog-note">This model only prepares the request in one read-only turn. {kind === 'relay' ? 'Implementation and review use the models of the two chats you select.' : 'Implementation agents have a separate model selection below.'} It uses your usual quota only when you press the button.</p>
      <Button type="button" disabled={disabled || busy || goal.trim().length < 10 || !modelSelectionReady(catalog, selection)} onClick={improve}><WandSparkles size={14} />{busy ? 'Preparing request…' : 'Improve request with AI'}</Button>
      {busy ? <p className="dialog-note" role="status">The model can inspect the selected project for up to 15 minutes. This is one request; no retry starts automatically.</p> : null}
      {error ? <p className="assistant-warning" role="alert">{error}</p> : null}
      <div className="prompt-refinement-history">
        <h3>Preparation history</h3>
        <p className="dialog-note">Saved attempts survive a reload. Reading logs uses no model quota.</p>
        {historyLoading ? <p className="dialog-note" role="status">Loading saved preparations…</p> : null}
        {historyError ? <p className="assistant-warning" role="alert">{historyError}</p> : null}
        {history?.attempts.length ? <label className="assistant-field">Saved preparation<select value={attemptId} disabled={historyLoading} onChange={event => { setAttemptId(event.target.value); setLog(null); setLogError(''); }}>
          {history.attempts.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('en-US')} · {item.provider === 'claude' ? 'Claude' : 'Codex'} · {item.model || 'default model'} · {attemptStatus[item.status]}</option>)}
        </select></label> : history && !historyLoading ? <p className="dialog-note">No saved preparations yet.</p> : null}
        {history && history.total > history.attempts.length ? <p className="dialog-note">Showing the latest {history.attempts.length} of {history.total} saved preparations.</p> : null}
        {attempt ? <>
          <p className="dialog-note">{attempt.provider === 'claude' ? 'Claude' : 'Codex'} · {attempt.model || 'default model'} · {attempt.effort || 'default reasoning'} · {attemptStatus[attempt.status]}</p>
          {attempt.detail && attempt.detail !== error ? <p className={attempt.status === 'attention' ? 'assistant-warning' : 'dialog-note'}>{attempt.detail}</p> : null}
          {attempt.diagnostic?.reason ? <p className="dialog-note">{attempt.diagnostic.reason}</p> : null}
        </> : null}
        <div className="refinement-log-actions">
          {attemptId ? <Button type="button" onClick={() => setLogOpen(current => !current)} aria-expanded={logOpen}><FileText size={14} />{logOpen ? 'Hide log' : 'View log'}</Button> : null}
          <Button type="button" disabled={historyLoading || logLoading} onClick={() => { setHistoryRevision(current => current + 1); setLogRevision(current => current + 1); }}><RefreshCw size={14} />Refresh saved preparations</Button>
        </div>
        {logOpen && attemptId ? <div className="refinement-log" aria-label="Preparation execution log">
          <h3>Execution log</h3>
          {logLoading ? <p className="dialog-note" role="status">Loading log…</p> : null}
          {logError ? <p className="assistant-warning" role="alert">{logError}</p> : null}
          {log ? <>
            {log.diagnostic?.reason && log.diagnostic.reason !== attempt?.diagnostic?.reason ? <p className="dialog-note">{log.diagnostic.reason}</p> : null}
            {log.truncated ? <p className="dialog-note">Showing the last 128 KiB of the saved log.</p> : null}
            <pre className="refinement-original" tabIndex={0}>{log.text || 'No provider output was saved for this attempt.'}</pre>
            {log.original ? <details className="mission-evidence"><summary>Your original request</summary>
              {log.context ? <p className="dialog-note">Original project folder: <code>{log.context}</code></p> : null}
              <pre className="refinement-original" tabIndex={0}>{log.original.goal}{log.original.acceptance ? `\n\nOriginal criteria:\n${log.original.acceptance}` : ''}</pre>
              <Button type="button" onClick={copyOriginal}><Copy size={14} />{copiedOriginal ? 'Original request copied' : 'Copy original request'}</Button>
              {copyError ? <p className="assistant-warning" role="alert">{copyError}</p> : null}
            </details> : null}
          </> : null}
        </div> : null}
      </div>
      {result ? <div className="prompt-refinement-result">
        <h3>Review the prepared request</h3>
        <p className="dialog-note">Prepared with {result.provider === 'claude' ? 'Claude' : 'Codex'} · {result.model || 'default model'} · {result.effort || 'default reasoning'}</p>
        <ol className="refinement-requirements">{result.spec.requirements.map(item => <li key={item.id}><p><strong>{item.id}</strong> · {item.literal}</p><p className="dialog-note">Criterion: {item.criterion}</p></li>)}</ol>
        {result.spec.verification.length ? <details className="mission-evidence"><summary>Verification plan</summary><ul>{result.spec.verification.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
        {result.spec.assumptions.length ? <details className="mission-evidence"><summary>AI assumptions</summary><ul>{result.spec.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
        {questions.length ? <div className="refinement-questions relay-fields"><h3>Clarify these decisions</h3>{questions.map((question, index) => <label key={index}>{question}<textarea rows={2} disabled={disabled || busy} value={answers[index] || ''} onChange={event => setAnswers(current => current.map((answer, position) => position === index ? event.target.value : answer))} placeholder="Your decision for this request" /></label>)}</div> : null}
        <label className="assistant-field">Editable final request<textarea rows={6} disabled={disabled || busy} value={finalGoal} onChange={event => setFinalGoal(event.target.value)} /></label>
        {kind === 'relay' ? <label className="assistant-field">Final review criteria<textarea rows={4} disabled={disabled || busy} value={finalAcceptance} onChange={event => setFinalAcceptance(event.target.value)} /></label> : null}
        <details className="mission-evidence"><summary>Your original text</summary><pre className="refinement-original">{source.goal}{source.acceptance ? `\n\nOriginal criteria:\n${source.acceptance}` : ''}</pre></details>
        {omitted.length ? <p className="assistant-warning" role="alert">Keep the original requirements in the final request: {omitted.map(item => item.id).join(', ')}.</p> : null}
        {finalGoal.length > maxGoal || finalAcceptance.length > maxAcceptance ? <p className="assistant-warning" role="alert">The text exceeds the form limit. Shorten the explanation while keeping the original requirements.</p> : null}
        {kind === 'relay' && finalAcceptance.trim().length < 10 ? <p className="dialog-note">Define review criteria before applying the request.</p> : null}
        {stale ? <p className="dialog-note">You changed the original text after preparing it. Improve it again to include those changes.</p> : null}
        <Button type="button" className="mission-primary" disabled={disabled || busy || !valid} onClick={adopt}><Check size={14} />Apply prepared request</Button>
        {adoptedGoal && goal === adoptedGoal ? <p className="dialog-note" role="status">Request applied to the form. You can review it before starting.</p> : null}
      </div> : null}
    </div>
  </details>;
}
