import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, GitMerge, MessageSquare, Network, Pause, Play, RefreshCw, Send, Square, Terminal, X } from 'lucide-react';
import { ApiError, createMission, extendMission, getMissionCatalog, getMissionLog, messageMissionTask, missionAction, openMissionTerminal, planMission, retryMissionTask } from '@/lib/api';
import type { Mission, MissionCatalog, MissionCheck, MissionLimits, MissionSpec, MissionStatus, MissionTask, MissionTaskStatus, Notify, Snapshot, Tool } from '@/lib/types';
import { Button, Segmented } from './Controls';
import { ModelSelector, modelSelectionReady } from './ModelSelector';
import { ProjectSelector } from './ProjectSelector';
import { PromptRefinement } from './PromptRefinement';
import { EvalsLaunchAdvisory } from './EvalsPanel';

const DEFAULT_LIMITS: MissionLimits = { concurrency: 3, maxSessions: 16, maxTurns: 24, taskMinutes: 60, missionMinutes: 720 };
const CLOSED = new Set<MissionStatus>(['stopped', 'expired', 'applied']);
const MISSION_LABELS: Record<MissionStatus, string> = { draft: 'Draft', running: 'Running', paused: 'Paused', attention: 'Needs attention', stopped: 'Stopped', expired: 'Time expired', ready: 'Verified · ready to integrate', applied: 'Integrated' };
const TASK_LABELS: Record<MissionTaskStatus, string> = { pending: 'Queued', running: 'Implementing', checking: 'Verifying', completed: 'Verified', attention: 'Needs attention' };
const MISSION_NEXT: Record<MissionStatus, string> = {
  draft: 'Review the goal, tasks and limits, then choose Start mission.',
  running: 'Follow the agents below. Read their conversations to inspect progress.',
  paused: 'Review the current work, then choose Continue mission when you are ready. Active turns may finish.',
  attention: 'Read the conversation and final checks. Resolve the blocker before retrying a task or continuing.',
  stopped: 'The mission is stopped. Its work and conversations are kept for review.',
  expired: 'Read the saved work and checks. Extend the deadline, then explicitly continue or retry unfinished tasks.',
  ready: 'Final checks passed. Review the result, then choose Integrate verified changes.',
  applied: 'Changes are integrated and verified. Review Final checks and log for the evidence.',
};
const ERRORS: Record<string, string> = {
  paused: 'Tracking is paused. Resume it before starting.',
  'mission active': 'A mission is already active. Check its progress before starting another.',
  'mission not found': 'This mission was not found. Refresh the dashboard.',
  'task busy': 'The agent is still working. Wait for its turn to finish.',
  'session budget exhausted': 'This mission has reached its chat limit.',
  'turn budget exhausted': 'This mission has reached its turn limit.',
  'planning busy': 'A chat is already planning a mission. Wait for its result.',
};
function errorMessage(cause: unknown) {
  if (cause instanceof ApiError) return cause.detail || ERRORS[cause.code] || `The action was rejected: ${cause.code || `HTTP ${cause.status}`}.`;
  if (cause instanceof SyntaxError) return 'The contract is not valid JSON. Check its commas and quotation marks.';
  return cause instanceof Error && cause.message ? cause.message : 'Could not complete the action. Check the connection and try again.';
}
const checkText = (check: MissionCheck) => Array.isArray(check) ? check.join(' ') : String(check);
const providerName = (provider: Tool) => provider === 'claude' ? 'Claude' : 'Codex';

function readSpec(text: string): { spec: MissionSpec | null; error: string } {
  if (!text.trim()) return { spec: null, error: '' };
  try {
    const value = JSON.parse(text) as MissionSpec;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.title !== 'string' || typeof value.project !== 'string' || typeof value.goal !== 'string' || !Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.some(task => !task || typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !Array.isArray(task.files) || !Array.isArray(task.checks))) {
      return { spec: null, error: 'The contract needs a project, title, goal, and tasks with an id, title, prompt, files, and checks.' };
    }
    return { spec: value, error: '' };
  } catch { return { spec: null, error: 'The contract is not valid JSON. Check its commas and quotation marks.' }; }
}

function TaskScope({ task, titles }: { task: Pick<MissionTask, 'files' | 'checks' | 'dependsOn'>; titles: Map<string, string> }) {
  return <div className="mission-scope">
    <p><strong>Depends on:</strong> {task.dependsOn?.length ? task.dependsOn.map(id => titles.get(id) || id).join(' · ') : 'Can start without waiting for another task'}</p>
    <p><strong>Files:</strong> {task.files?.length ? task.files.join(' · ') : 'No files specified'}</p>
    <ul aria-label="Task checks">{(task.checks ?? []).map((check, index) => <li key={index}><code>{checkText(check)}</code></li>)}</ul>
  </div>;
}

function DeadlineExtension({ taskId, disabled, onExtend }: { taskId?: string; disabled: boolean; onExtend: (minutes: number, taskId?: string) => void }) {
  const [minutes, setMinutes] = useState(taskId ? 60 : 720);
  return <details className="mission-evidence deadline-extension"><summary>Extend deadline {taskId ? 'for this task' : 'for the mission'}</summary><div className="deadline-extension-fields relay-fields"><label>Additional minutes<input type="number" min={1} max={1440} required disabled={disabled} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label><Button type="button" disabled={disabled || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440} onClick={() => onExtend(minutes, taskId)}>Extend deadline</Button></div><p className="dialog-note">Keeps the work and extends the time. It does not create chats or raise chat and turn limits. Continue the task explicitly afterward.</p></details>;
}

function MissionChatDialog({ job, taskId, connected, onClose, onNotify }: { job: Mission; taskId: string; connected: boolean; onClose: () => void; onNotify: Notify }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [text, setText] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(''), [sending, setSending] = useState(false), [refresh, setRefresh] = useState(0);
  const task = job.tasks.find(item => item.id === taskId);
  const orchestrator = taskId === 'orchestrator';
  const canMessage = Boolean(task && task.status === 'attention' && connected && !CLOSED.has(job.status));
  const titleId = `mission-chat-${job.id}-${taskId}`;
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!connected) { setError('Offline. The displayed conversation may be outdated.'); setLoading(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await getMissionLog(job.id, taskId, controller.signal);
        if (!controller.signal.aborted) { setText(result.text); setError(''); setLoading(false); }
      } catch (cause) {
        if (!controller.signal.aborted) { setError(errorMessage(cause)); setLoading(false); }
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 4000);
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job.id, taskId, connected, refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canMessage || !message.trim()) return;
    setSending(true); setError('');
    try {
      await messageMissionTask(job.id, taskId, message.trim());
      if (mounted.current) { setMessage(''); setRefresh(value => value + 1); onNotify('Message sent. It counts as one turn within the mission limit.', 'info'); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setSending(false); }
  }
  return createPortal(<dialog ref={dialog} className="summary-dialog mission-chat-dialog" aria-labelledby={titleId} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="dialog-body">
      <header className="dialog-head"><div className="dialog-heading"><span className={orchestrator ? 'mission-role' : 'dialog-note'}>{orchestrator ? 'Orchestrator' : `${providerName(task?.provider ?? job.provider)} · ${TASK_LABELS[task?.status ?? 'pending']}`}</span><h2 id={titleId}>{orchestrator ? job.title : task?.title || taskId}</h2></div><Button className="dialog-close" aria-label="Close conversation" onClick={() => dialog.current?.close()}><X size={16} /></Button></header>
      <p className="dialog-note">Local conversation · refreshes every 4 seconds while open. Reading it uses no turns.</p>
      {error ? <p className="assistant-warning" role="alert">{error}</p> : null}
      {loading ? <p role="status">Reading conversation…</p> : <pre className="mission-transcript" tabIndex={0} aria-label="Agent conversation">{text || 'This chat has no messages yet.'}</pre>}
      <Button disabled={!connected} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh conversation</Button>
      {!orchestrator ? <form className="mission-message relay-fields" onSubmit={submit}><label>Message for the agent<textarea maxLength={10000} rows={3} value={message} disabled={!canMessage || sending} onChange={event => setMessage(event.target.value)} placeholder="Clarify the task or answer the agent’s question" /></label><p className="dialog-note">You can send messages when the task needs attention. The agent keeps its context and mission limits.</p><Button type="submit" disabled={!canMessage || sending || !message.trim()}><Send size={14} />{sending ? 'Sending…' : 'Send and continue'}</Button></form> : null}
    </div>
  </dialog>, document.body);
}

function MissionProgress({ job, busy, connected, onAction, onRetry, onTerminal, onChat, onExtend }: {
  job: Mission; busy: boolean; connected: boolean;
  onAction: (id: string, action: 'start' | 'pause' | 'resume' | 'stop' | 'apply') => void;
  onRetry: (id: string, taskId: string) => void; onTerminal: (id: string, taskId: string) => void; onChat: (id: string, taskId: string) => void;
  onExtend: (id: string, minutes: number, taskId?: string) => void;
}) {
  const titles = new Map(job.tasks.map(task => [task.id, task.title]));
  const disabled = busy || !connected;
  const progress = job.progress ?? { completed: job.tasks.filter(task => task.status === 'completed').length, total: job.tasks.length, percent: 0 };
  return <article className={`mission-job mission-${job.status}`} aria-label={`Mission: ${job.title}`}>
    <div className="mission-orchestrator">
      <span className="mission-orchestrator-icon" aria-hidden="true"><Network size={23} /></span>
      <div className="mission-orchestrator-content"><div className="mission-job-heading"><span className="mission-role">Orchestrator</span><span className="mission-status">{MISSION_LABELS[job.status]}</span></div><h3>{job.title}</h3><p className="mission-meta">{providerName(job.provider)} · {job.model || 'Configured model'} · {job.effort || 'Configured reasoning'}</p><p className="mission-path">{job.project}</p></div>
    </div>
    <p>{job.goal}</p><p className="mission-detail" role="status">{job.detail}</p><p className="dialog-note">Next: {MISSION_NEXT[job.status]}</p>
    <div className="mission-progress"><label htmlFor={`mission-progress-${job.id}`}>{progress.completed} of {progress.total} verified tasks</label><progress id={`mission-progress-${job.id}`} max={progress.total || 1} value={progress.completed} /></div>
    <p className="mission-meta">Up to {job.limits.concurrency} agents at once · Chats {job.sessionsUsed}/{job.limits.maxSessions} · Turns {job.turnsUsed}/{job.limits.maxTurns} · {job.deadline ? `Deadline ${new Date(job.deadline).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}` : 'Time starts when you start'}</p>
    <div className="mission-actions">
      <Button disabled={disabled} onClick={() => onChat(job.id, 'orchestrator')}><MessageSquare size={14} />View orchestrator chat</Button>
      <Button disabled={disabled} onClick={() => onTerminal(job.id, 'orchestrator')}><Terminal size={14} />Open orchestrator</Button>
      {job.status === 'draft' ? <Button className="mission-primary" disabled={disabled} onClick={() => onAction(job.id, 'start')}><Play size={14} />Start mission</Button> : null}
      {job.status === 'running' ? <Button disabled={disabled} onClick={() => onAction(job.id, 'pause')}><Pause size={14} />Pause new agents</Button> : null}
      {job.status === 'paused' || job.status === 'attention' ? <Button disabled={disabled} onClick={() => onAction(job.id, 'resume')}><Play size={14} />Continue mission</Button> : null}
      {job.status === 'ready' ? <Button className="mission-primary" disabled={disabled} onClick={() => onAction(job.id, 'apply')}><GitMerge size={14} />Integrate verified changes</Button> : null}
      {!CLOSED.has(job.status) && job.status !== 'ready' ? <Button className="danger-button" disabled={disabled} onClick={() => onAction(job.id, 'stop')}><Square size={14} />Stop mission</Button> : null}
    </div>
    {job.status === 'paused' ? <p className="dialog-note">Pausing prevents new agents from starting. Active turns finish within their limits.</p> : null}
    {job.deadlineReached || job.status === 'expired' ? <p className="dialog-note">Time has expired; work and conversations are kept. Extend the deadline and continue when you choose.</p> : null}
    {job.status === 'attention' || job.status === 'paused' || job.status === 'expired' ? <DeadlineExtension disabled={disabled} onExtend={(minutes, taskId) => onExtend(job.id, minutes, taskId)} /> : null}
    {job.status === 'ready' ? <p className="dialog-note">Final checks passed. Integration applies the changes to the project; the integration branch keeps the work.</p> : null}
    <ol className="mission-task-tree" aria-label="Agents and dependencies">{job.tasks.map(task => <li className={`mission-task mission-task-${task.status}`} key={task.id}>
      <div className="mission-task-heading"><h4>{task.title}</h4><span className="mission-task-status">{task.status === 'completed' ? <Check size={14} aria-hidden="true" /> : null}{TASK_LABELS[task.status]}</span></div>
      <p className="mission-meta">{providerName(task.provider ?? job.provider)} · {task.model || job.model || 'Configured model'} · {task.effort || job.effort || 'Configured reasoning'} · {task.turnsUsed || 0} {task.turnsUsed === 1 ? 'turn' : 'turns'}</p>
      {task.detail ? <p className="mission-detail">{task.detail}</p> : null}
      {task.deadline ? <p className="mission-meta">Task deadline: {new Date(task.deadline).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}{task.deadlineReached ? ' · Time expired; work kept' : ''}</p> : null}
      <p className="mission-meta">{task.dependsOn?.length ? `Waiting for: ${task.dependsOn.map(id => titles.get(id) || id).join(' · ')}` : 'No dependencies'}</p>
      <div className="mission-actions">
        <Button disabled={disabled || (!task.sessionHandle && task.status === 'pending')} title={!task.sessionHandle && task.status === 'pending' ? 'The conversation appears when the agent starts its task.' : undefined} onClick={() => onChat(job.id, task.id)}><MessageSquare size={14} />View conversation</Button>
        <Button disabled={disabled} onClick={() => onTerminal(job.id, task.id)}><Terminal size={14} />Open terminal</Button>
        {task.status === 'attention' && !CLOSED.has(job.status) ? <Button disabled={disabled} onClick={() => onRetry(job.id, task.id)}><RefreshCw size={14} />Retry within its limits</Button> : null}
      </div>
      {task.status === 'attention' && job.status !== 'applied' && job.status !== 'stopped' ? <DeadlineExtension taskId={task.id} disabled={disabled} onExtend={(minutes, taskId) => onExtend(job.id, minutes, taskId)} /> : null}
      <details className="mission-evidence"><summary>Files and checks</summary><TaskScope task={task} titles={titles} /></details>
    </li>)}</ol>
    <details className="mission-evidence"><summary>Final checks and log</summary>{job.integrationBranch ? <p className="mission-path">Branch: {job.integrationBranch}</p> : null}<ul>{(job.checks ?? []).map((check, index) => <li key={index}><code>{checkText(check)}</code></li>)}</ul><ol>{(job.events ?? []).map((event, index) => <li key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString('en-US')}</time> {event.text}</li>)}</ol></details>
  </article>;
}

export function MissionPanel({ snapshot, connected, onNotify, page = false, active = true }: { snapshot: Snapshot; connected: boolean; onNotify: Notify; page?: boolean; active?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null), [mode, setMode] = useState<'goal' | 'json'>('goal');
  const [project, setProject] = useState(''), [title, setTitle] = useState(''), [goal, setGoal] = useState('');
  const [provider, setProvider] = useState<Tool>('codex'), [model, setModel] = useState(''), [effort, setEffort] = useState('high');
  const [limits, setLimits] = useState<MissionLimits>(DEFAULT_LIMITS), [contract, setContract] = useState('');
  const [catalog, setCatalog] = useState<MissionCatalog | null>(null), [catalogError, setCatalogError] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [planning, setPlanning] = useState(false);
  const [terminalViews, setTerminalViews] = useState(true);
  const [chat, setChat] = useState<{ id: string; taskId: string } | null>(null);
  const jobs = snapshot.missions?.jobs ?? [];
  const expanded = page || (open ?? jobs.some(job => !CLOSED.has(job.status)));
  const unavailable = !connected || !snapshot.missions || Boolean(snapshot.missions.error);
  const parsed = useMemo(() => readSpec(contract), [contract]);
  const modelSelection = { provider, model, effort };
  const chatJob = chat ? jobs.find(job => job.id === chat.id) : null;
  const activeCount = jobs.filter(job => !CLOSED.has(job.status)).length;
  useEffect(() => {
    if (!expanded || !active || !connected) return;
    const controller = new AbortController();
    getMissionCatalog(controller.signal).then(value => { if (!controller.signal.aborted) { setCatalog(value); setCatalogError(''); } }).catch(cause => { if (!controller.signal.aborted) setCatalogError(errorMessage(cause)); });
    return () => controller.abort();
  }, [expanded, active, connected]);
  async function run(label: string, action: () => Promise<unknown>, success: string) {
    if (busy || unavailable) return;
    setBusy(label); setError('');
    try { await action(); onNotify(success, 'info'); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(''); }
  }
  async function plan(event: FormEvent) {
    event.preventDefault();
    if (planning || busy || unavailable) return;
    setPlanning(true); setError('');
    try {
      const result = await planMission({ project: project.trim(), title: title.trim(), goal: goal.trim(), provider, model, effort, limits, terminalViews });
      setContract(JSON.stringify(result.spec, null, 2));
      onNotify('Plan prepared. Review the tasks and checks before starting.', 'info');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPlanning(false); }
  }
  async function start() {
    if (!parsed.spec) { setError(parsed.error || 'Prepare or paste a contract first.'); return; }
    await run('creating', async () => {
      const result = await createMission(parsed.spec!);
      const id = result.id || result.job?.id;
      if (!id) throw new Error('The mission was created without an ID. Refresh the dashboard before continuing.');
      await missionAction(id, 'start');
      setContract(''); setOpen(true);
    }, 'Mission started. Agents will follow dependencies and limits.');
  }
  const updateLimit = (key: keyof MissionLimits, value: string) => setLimits(current => ({ ...current, [key]: Number(value) }));
  const specTitles = new Map(parsed.spec?.tasks.map(task => [task.id, task.title]) ?? []);
  return <section className={`panel mission-panel ${page ? 'page-panel' : ''}`} aria-label="Agent missions">
    {page ? <header className="page-panel-heading"><h2><Network size={18} aria-hidden="true" />Missions</h2><p className="dialog-note">{activeCount ? `${activeCount} ${activeCount === 1 ? 'active mission' : 'active missions'}` : 'One goal · new tasks · coordinated agents'}</p></header> : <button type="button" className="insights-toggle mission-toggle" aria-expanded={expanded} aria-controls="mission-body" onClick={() => setOpen(!expanded)}><span><Network size={18} aria-hidden="true" /><strong>Missions</strong></span><span>{activeCount ? `${activeCount} ${activeCount === 1 ? 'active mission' : 'active missions'}` : 'One goal · coordinated agents'} · {expanded ? 'Hide' : 'Open'}</span></button>}
    {expanded ? <div className="mission-body" id="mission-body">
      <p>Describe what you want to build. The orchestrator splits the work, connects dependencies, and verifies each task before integration.</p>
      {error || snapshot.missions?.error || unavailable ? <p className="assistant-warning" role="alert">{error || snapshot.missions?.error || 'Missions are unavailable on this connection.'}</p> : null}
      {[...jobs].reverse().map(job => <MissionProgress key={job.id} job={job} busy={Boolean(busy)} connected={!unavailable} onAction={(id, action) => run(action, () => missionAction(id, action), action === 'pause' ? 'New agents paused. Active turns may finish.' : action === 'stop' ? 'Mission stopped. Its work and chats are kept.' : action === 'apply' ? 'Changes integrated and verified in the project.' : 'Mission updated.')} onRetry={(id, taskId) => run('retry', () => retryMissionTask(id, taskId), 'Task ready to retry within the limits.')} onTerminal={(id, taskId) => run('terminal', () => openMissionTerminal(id, taskId), 'Tracking terminal opened. Reading progress uses no turns.')} onChat={(id, taskId) => setChat({ id, taskId })} onExtend={(id, minutes, taskId) => run('extend', () => extendMission(id, { minutes, ...(taskId ? { taskId } : {}) }), 'Deadline extended. Continue the mission or retry the task when you choose.')} />)}
      <details className="mission-new" open={jobs.length === 0 || Boolean(contract)}><summary>New mission</summary>
        <ol className="flow-steps" aria-label="Mission setup"><li><span>1</span>Describe the goal</li><li><span>2</span>Prepare a plan</li><li aria-current={contract ? 'step' : undefined}><span>3</span>Review and start</li></ol>
        <Segmented label="How to define the mission" value={mode} options={[{ value: 'goal', label: 'Describe the goal' }, { value: 'json', label: 'JSON contract' }]} onChange={setMode} disabled={Boolean(busy) || planning} />
        {mode === 'goal' ? <form onSubmit={plan}><fieldset className="relay-fields mission-fields" disabled={Boolean(busy) || planning || unavailable || snapshot.paused}>
          <legend className="sr-only">Plan a new mission</legend>
          <div className="mission-pair"><ProjectSelector value={project} onChange={setProject} active={active} connected={connected} disabled={Boolean(busy) || planning} /><label>Mission name<input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="The 11 features for Sample App" /></label></div>
          <label>What you want to implement<textarea required minLength={10} maxLength={20000} rows={5} value={goal} onChange={event => setGoal(event.target.value)} placeholder="List the features, expected results, and how to check them. Include what must be preserved." /></label>
          <PromptRefinement kind="mission" project={project} goal={goal} catalog={catalog} disabled={Boolean(busy) || planning || unavailable} onAdopt={value => setGoal(value.goal)} />
          <details className="mission-evidence" open={catalog && !modelSelectionReady(catalog, modelSelection) || catalogError ? true : undefined}><summary>Implementation agents · {provider === 'codex' ? 'Codex' : 'Claude'} · {model || catalog?.[provider].currentModel?.id || 'Configured model'} · {effort || 'Model default'}</summary><ModelSelector catalog={catalog} value={modelSelection} onChange={value => { setProvider(value.provider); setModel(value.model); setEffort(value.effort); }} disabled={Boolean(busy) || planning || unavailable} error={catalogError} /></details>
          <details className="mission-evidence"><summary>Usage and time limits</summary><div className="mission-limit-fields">
            <label>Concurrent agents<input type="number" required min={1} max={4} value={limits.concurrency} onChange={event => updateLimit('concurrency', event.target.value)} /><span className="dialog-note">How many agents can work at once. With three agents, each takes the next task as it finishes.</span></label>
            <label>Maximum distinct chats<input type="number" required min={1} max={32} value={limits.maxSessions} onChange={event => updateLimit('maxSessions', event.target.value)} /><span className="dialog-note">How many new conversations the entire mission can create. Reusing a conversation does not create another one.</span></label>
            <label>Maximum turns<input type="number" required min={1} max={64} value={limits.maxTurns} onChange={event => updateLimit('maxTurns', event.target.value)} /><span className="dialog-note">How many times it can ask models to work, including clarifications and retries. A chat can have several turns.</span></label>
            <label>Minutes per task<input type="number" required min={1} max={720} value={limits.taskMinutes} onChange={event => updateLimit('taskMinutes', event.target.value)} /><span className="dialog-note">When time expires, work is kept so you can extend the deadline and continue.</span></label>
            <label>Minutes per mission<input type="number" required min={5} max={10080} value={limits.missionMinutes} onChange={event => updateLimit('missionMinutes', event.target.value)} /><span className="dialog-note">Total time for tasks and verification. Work is kept when the deadline expires.</span></label>
          </div><p className="dialog-note">A bounded queue keeps available agents busy without opening every chat at once. Native delegation is disabled. Limits apply to chats managed by Relay.</p></details>
          <label className="mission-terminal-option"><input type="checkbox" checked={terminalViews} onChange={event => setTerminalViews(event.target.checked)} /><span>Open chats in tabs of the same window</span></label>
          <p className="dialog-note">Tabs show live conversations when each task starts. Send a message when the agent is waiting. Reading them uses no turns.</p>
          <p className="dialog-note">Preparing a plan opens one read-only chat and uses the model’s usual quota. Opening this panel or waiting does not run models.</p>
          <Button type="submit" className="mission-primary" disabled={!modelSelectionReady(catalog, modelSelection) || snapshot.missions?.planning || project.trim().length === 0 || title.trim().length === 0 || goal.trim().length < 10}><Network size={15} />{planning || snapshot.missions?.planning ? 'Preparing plan…' : 'Prepare plan'}</Button>
        </fieldset></form> : <div className="relay-fields"><label>Mission contract<textarea className="mission-contract" rows={12} maxLength={200000} value={contract} disabled={Boolean(busy) || planning || unavailable} onChange={event => setContract(event.target.value)} placeholder="Paste a contract with project, title, goal, provider, limits, tasks, and checks. Each check is an argument list, for example: [&#34;npm.cmd&#34;, &#34;test&#34;]." /></label><p className="dialog-note">Each task defines id, title, prompt, dependsOn, files, and checks. Scoped folders end in /. The server validates limits, paths, and dependencies before creating agents.</p></div>}
        {contract && mode === 'goal' ? <details className="mission-evidence"><summary>Edit JSON contract</summary><label className="assistant-field">Generated contract<textarea className="mission-contract" rows={12} maxLength={200000} value={contract} disabled={Boolean(busy) || planning || unavailable} onChange={event => setContract(event.target.value)} /></label></details> : null}
        {contract ? <div className="mission-plan" aria-label="Plan for the mission">
          {parsed.error ? <p className="assistant-warning" role="alert">{parsed.error}</p> : parsed.spec ? <><h3>{parsed.spec.title} · {parsed.spec.tasks.length} tasks</h3><p className="mission-path">{parsed.spec.project}</p><ol className="mission-plan-tasks">{parsed.spec.tasks.map(task => <li key={task.id}><h4>{task.title}</h4><TaskScope task={task} titles={specTitles} /></li>)}</ol><EvalsLaunchAdvisory /><Button className="mission-primary" disabled={Boolean(busy) || planning || unavailable || snapshot.paused} onClick={start}><Play size={15} />{busy === 'creating' ? 'Starting…' : 'Create and start mission'}</Button></> : null}
        </div> : null}
      </details>
      {!jobs.length ? <p className="dialog-note">No missions yet. Prepare your first plan to see the orchestrator and its connected agents.</p> : null}
    </div> : null}
    {chat && chatJob ? <MissionChatDialog key={`${chat.id}-${chat.taskId}`} job={chatJob} taskId={chat.taskId} connected={!unavailable} onClose={() => setChat(null)} onNotify={onNotify} /> : null}
  </section>;
}
