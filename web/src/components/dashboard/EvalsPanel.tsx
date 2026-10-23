import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, FlaskConical, Gauge, MessageSquareText, Minus, RefreshCw } from 'lucide-react';
import { ApiError, openEvalsAnalysis } from '@/lib/api';
import { EVALS_ANALYSES, EVALS_ANALYSIS_PROVIDERS, fetchLatestEvals, formatKpiValue, formatNumber, formatRate, labelsNote, MIN_GROUP, PREDICTOR_MIN_GROUP, PREDICTOR_MIN_STRATUM, validatedPredictors, type EvalsAnalysisId, type EvalsAnalysisProvider, type EvalsKpi, type EvalsLabels, type EvalsModelRow, type EvalsPredictor, type EvalsReport, type LatestEvals } from '@/lib/evals';
import { Button, Segmented } from './Controls';

type Methodology = EvalsReport['methodology'];
type Load = { phase: 'idle' | 'loading' } | { phase: 'ready'; data: LatestEvals } | { phase: 'error'; disconnected: boolean };

const TREND_TEXT: Record<EvalsKpi['trend'], string> = { better: 'Better than last week', worse: 'Worse than last week', same: 'No clear change from last week', unknown: 'No comparison with last week yet' };
const DIMENSIONS: Record<EvalsModelRow['dimension'], string> = { model: 'Model', effort: 'Effort', spec: 'Written spec', taskType: 'Task type', project: 'Project', provider: 'Provider' };
const normalize = (text: string) => text.toLocaleLowerCase('en-US').replace(/["“”']/g, '').replace(/\s+/g, ' ').trim();

/** Methodology explanation for the first candidate term that the report defines. */
export function explain(methodology: Methodology, ...candidates: string[]) {
  for (const candidate of candidates.map(normalize).filter(Boolean)) {
    const exact = methodology.find(item => normalize(item.term) === candidate);
    if (exact) return exact.explanation;
  }
  for (const candidate of candidates.map(normalize).filter(value => value.length > 3)) {
    const partial = methodology.find(item => { const term = normalize(item.term); return term.length > 3 && (candidate.includes(term) || term.includes(candidate)); });
    if (partial) return partial.explanation;
  }
  return '';
}

/** A technical term with a short explanation on hover, keyboard focus or tap. Escape closes it. */
export function Term({ children, help }: { children: ReactNode; help: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const pointer = useRef<string>('');
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  if (!help) return <>{children}</>;
  return <span className="evals-term-wrap">
    <button ref={button} type="button" className="evals-term" aria-describedby={id}
      onPointerDown={event => { pointer.current = event.pointerType; }}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={event => { if (event.pointerType === 'mouse' && document.activeElement !== button.current) setOpen(false); }}
      onFocus={() => { if (!pointer.current) setOpen(true); }}
      onBlur={() => { setOpen(false); pointer.current = ''; }}
      onClick={() => { setOpen(current => pointer.current === 'mouse' ? true : !current); pointer.current = ''; }}>{children}</button>
    <span role="tooltip" id={id} className="evals-tooltip" hidden={!open}>{help}</span>
  </span>;
}

function KpiCard({ kpi, methodology }: { kpi: EvalsKpi; methodology: Methodology }) {
  const comparable = !kpi.insufficient && kpi.value !== null && kpi.previous !== null && kpi.trend !== 'unknown';
  const Arrow = !comparable || kpi.value === kpi.previous ? Minus : kpi.value! > kpi.previous! ? ArrowUp : ArrowDown;
  const trend = comparable ? kpi.trend : 'unknown';
  const labelHelp = explain(methodology, kpi.label, kpi.id.replace(/-/g, ' ')) || kpi.meaning;
  return <article className={`evals-kpi trend-${trend}`}>
    <h3 className="kpi-label"><Term help={labelHelp}>{kpi.label}</Term></h3>
    {kpi.insufficient || kpi.value === null ? <div className="evals-kpi-empty">
      <p className="evals-kpi-insufficient">Not enough data yet</p>
      <p className="dialog-note">{kpi.n} so far; a number appears once there are at least {MIN_GROUP}.</p>
    </div> : <div className="evals-kpi-number">
      <span className="evals-kpi-value">{formatKpiValue(kpi.value, kpi.unit)}</span>
      {kpi.unit === 'per10' ? <span className="evals-kpi-unit"><Term help={explain(methodology, 'corrections per 10 messages', 'per 10 messages') || 'Counted for every 10 messages you sent, so busy and quiet weeks compare fairly.'}>per 10 messages</Term></span>
        : kpi.unit === 'turns' ? <span className="evals-kpi-unit">turns</span> : null}
      <span className={`evals-trend trend-${trend}`}><Arrow size={20} aria-hidden="true" /></span>
    </div>}
    <p className="evals-kpi-compare">{TREND_TEXT[trend]}{kpi.previous !== null && !kpi.insufficient ? ` · last week ${formatKpiValue(kpi.previous, kpi.unit)}` : ''}</p>
    <p className="evals-kpi-meaning">{kpi.meaning}</p>
  </article>;
}

function Predictor({ predictor }: { predictor: EvalsPredictor }) {
  const sign = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value * 10) / 10}`;
  return <li>
    <strong>{predictor.label}</strong>
    {predictor.status === 'insufficient' || predictor.effect === null || predictor.ci95 === null
      ? <p>Insufficient data: {predictor.nWith} chats with it and {predictor.nWithout} without. Each group needs at least {PREDICTOR_MIN_GROUP} chats, with {PREDICTOR_MIN_STRATUM} or more per chat length.</p>
      : <p>{sign(predictor.effect)} percentage points in “{predictor.outcome}” (95% interval {sign(predictor.ci95[0])} to {sign(predictor.ci95[1])}) · {predictor.nWith} chats with it, {predictor.nWithout} without{predictor.validated ? ' · validated' : ' · not validated: the interval includes zero or the result could be chance among the factors tested'}.</p>}
  </li>;
}

function LabelCheck({ labels }: { labels: EvalsLabels }) {
  const kinds = labels.check?.kinds.filter(kind => kind.total > 0) ?? [];
  if (!labels.check || !labels.check.answered) return <>
    <p>{labels.check ? `The label check has ${labels.check.total} rows and none are answered yet.` : 'No label check yet.'}</p>
    <p className="dialog-note">Run node evals/cli.mjs label-check, answer yes or no in the last column of the file it writes, and the next report shows how often the model’s labels are right.</p>
  </>;
  const by = labels.check.checkedBy ?? [];
  return <>
    {by.length > 0 && <p className="dialog-note">{labels.check.labeledBy?.length ? `Labels by ${labels.check.labeledBy.join(', ')}, checked` : 'Checked'} by {by.join(', ')}{by.some(name => name !== 'owner') ? ' (a model review, not a human check)' : ''}.</p>}
    <ul className="evals-list">{kinds.map(kind => <li key={kind.kind}>
      <strong>{kind.label}</strong> · {kind.answered ? `${kind.confirmed} of ${kind.answered} confirmed (${kind.rate}%${kind.ci95 ? `, 95% interval ${kind.ci95[0]}–${kind.ci95[1]}%` : ''})` : 'not answered yet'}
    </li>)}</ul>
  </>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <details className="evals-section"><summary>{title}</summary><div className="evals-section-body">{children}</div></details>;
}

function ModelsTable({ rows }: { rows: EvalsModelRow[] }) {
  if (!rows.length) return <p>No chats with this information yet.</p>;
  // One block per dimension, in report order, so each row only names its value.
  const groups = [...rows.reduce((map, row) => map.set(row.dimension, [...(map.get(row.dimension) ?? []), row]), new Map<EvalsModelRow['dimension'], EvalsModelRow[]>())];
  return <div className="evals-table-scroll" tabIndex={0} role="region" aria-label="Models and settings table">
    <table className="evals-table">
      <thead><tr><th scope="col">Setting</th><th scope="col">Chats</th><th scope="col">Corrections per 10 messages</th><th scope="col">Broken “done”</th><th scope="col">Fixed or reverted within 72 h</th><th scope="col">Median turns to a verified commit</th></tr></thead>
      {groups.map(([dimension, items]) => <tbody key={dimension}>
        <tr className="evals-group"><th scope="colgroup" colSpan={6}>{DIMENSIONS[dimension]}</th></tr>
        {items.map(row => <tr key={row.value}>
          <th scope="row">{row.value}</th>
          <td>{row.chats}</td>
          {row.insufficient ? <td colSpan={4} className="evals-muted evals-insufficient">Not enough data yet</td> : <>
            <td>{formatNumber(row.correctionRate)}</td><td>{formatRate(row.falseDoneRate)}</td><td>{formatRate(row.fixRevertRate)}</td><td>{formatNumber(row.medianTurnsToVerifiedCommit)}</td>
          </>}
        </tr>)}
      </tbody>)}
    </table>
  </div>;
}

type Ask = { id: EvalsAnalysisId; agent: string; phase: 'opening' | 'opened' | 'error'; message?: string };

/** One click opens one Claude or Codex chat in the "agent-relay-evals" terminal window; nothing runs until then. */
function AskAgent() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [provider, setProvider] = useState<EvalsAnalysisProvider>('claude');
  const chosen = EVALS_ANALYSIS_PROVIDERS.find(item => item.id === provider)!;
  const open = (id: EvalsAnalysisId) => {
    const agent = `${chosen.label} (${chosen.modelLabel})`;
    setAsk({ id, agent, phase: 'opening' });
    openEvalsAnalysis(id, provider).then(() => setAsk({ id, agent, phase: 'opened' }))
      .catch(cause => setAsk({ id, agent, phase: 'error', message: cause instanceof ApiError && cause.code ? cause.code : 'Server disconnected. Turn the dashboard on and try again.' }));
  };
  const label = ask ? EVALS_ANALYSES.find(analysis => analysis.id === ask.id)?.label : '';
  const status = ask?.phase === 'opening' ? `Opening “${label}” with ${ask.agent}…`
    : ask?.phase === 'opened' ? `Opened “${label}” with ${ask?.agent} in the Relay Evals terminal window.` : `Could not open “${label}”: ${ask?.message}`;
  return <section className="evals-ask" aria-labelledby="evals-ask-title">
    <h3 id="evals-ask-title" className="evals-heading"><MessageSquareText size={18} aria-hidden="true" />Ask an agent about this report</h3>
    <Segmented<EvalsAnalysisProvider> label="Agent for the analysis" options={EVALS_ANALYSIS_PROVIDERS.map(item => ({ value: item.id, label: `${item.label} · ${item.modelLabel}` }))} value={provider} onChange={setProvider} />
    <p className="dialog-note">Each button opens one {chosen.label} chat ({chosen.modelLabel}, high effort) in a new terminal window with that analysis already asked. It uses your {chosen.label} subscription only when you click, reads the data without changing it and saves its answer next to this report.</p>
    <ul className="evals-ask-list">{EVALS_ANALYSES.map(analysis => <li key={analysis.id}>
      <Button onClick={() => open(analysis.id)} disabled={ask?.phase === 'opening'} aria-describedby={`evals-ask-${analysis.id}`}>{analysis.label}</Button>
      <p id={`evals-ask-${analysis.id}`}>{analysis.description}</p>
    </li>)}</ul>
    {ask ? <p className={ask.phase === 'error' ? 'evals-ask-status error' : 'evals-ask-status'} role={ask.phase === 'error' ? 'alert' : 'status'}>
      {status}
    </p> : null}
  </section>;
}

function Report({ report, date }: { report: EvalsReport; date: string }) {
  const { methodology } = report;
  const top = report.predictors.slice(0, 3);
  const generated = new Date(report.generatedAt);
  return <>
    <section className="evals-summary" aria-labelledby="evals-summary-title">
      <p className="kpi-label">{report.period.label}</p>
      <h3 id="evals-summary-title" className="evals-heading">How this week went</h3>
      <p className="evals-summary-text">{report.summary.join(' ')}</p>
      <p className="dialog-note">Based on {report.coverage.chatsInPeriod} chats this week, compared with {report.previousPeriod.label}. Generated {Number.isNaN(generated.getTime()) ? date : generated.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.{labelsNote(report.labels) ? ` ${labelsNote(report.labels)}` : ''}</p>
    </section>
    <div className={`evals-kpis count-${report.kpis.length}`}>{report.kpis.map(kpi => <KpiCard key={kpi.id} kpi={kpi} methodology={methodology} />)}</div>
    <section className="evals-experiment" aria-labelledby="evals-experiment-title">
      <h3 id="evals-experiment-title" className="evals-heading"><FlaskConical size={18} aria-hidden="true" />This week’s experiment</h3>
      <p className="evals-experiment-title">{report.experiment.title}</p>
      <p className="evals-experiment-action">{report.experiment.action}</p>
      <dl className="evals-pairs"><div><dt>Why</dt><dd>{report.experiment.why}</dd></div><div><dt>How it is measured</dt><dd>{report.experiment.measure}</dd></div></dl>
    </section>
    <AskAgent />
    <div className="evals-sections">
      <Section title="What predicts problems">
        {top.length ? <ol className="evals-list">{top.map(predictor => <Predictor key={predictor.factor} predictor={predictor} />)}</ol> : <p>Insufficient data: no factor has enough chats to compare yet.</p>}
        <p className="dialog-note">The 95% interval is the range where the real difference likely falls. If it includes zero, the factor may not matter.</p>
      </Section>
      <Section title="Most common corrections">
        <p>{report.corrections.total} corrections this week.</p>
        {report.corrections.byCategory.length ? <ul className="evals-list">{report.corrections.byCategory.map(item => <li key={item.category}><strong>{item.label}</strong> · {item.count} this week, {item.previous} last week</li>)}</ul> : <p>No corrections were found.</p>}
        {report.corrections.examples.length ? <><h4>Short examples</h4><ul className="evals-list evals-examples">{report.corrections.examples.map((example, index) => <li key={index}>“{example.text}”</li>)}</ul></> : null}
      </Section>
      {report.labels ? <Section title="Label check">
        <LabelCheck labels={report.labels} />
      </Section> : null}
      <Section title="Models and settings">
        <p>{report.models.scope}</p>
        <ModelsTable rows={report.models.rows} />
      </Section>
      <Section title="Benchmark">
        <dl className="evals-pairs evals-counts">
          <div><dt>Tasks in the catalog</dt><dd>{report.benchmark.catalogTasks}</dd></div>
          <div><dt>Excluded</dt><dd>{report.benchmark.excludedTasks}</dd></div>
          <div><dt>Reproducible</dt><dd>{report.benchmark.reproducibleTasks}</dd></div>
          <div><dt>Held out</dt><dd>{report.benchmark.holdoutTasks}</dd></div>
        </dl>
        <p>{report.benchmark.estimate ? `Running the whole suite would take about ${report.benchmark.estimate.turns} turns, roughly ${report.benchmark.estimate.days} days at ${report.benchmark.estimate.turnsPerDay} turns per day.` : 'No run estimate yet.'}</p>
        {report.benchmark.runs.length ? <div className="evals-table-scroll" tabIndex={0} role="region" aria-label="Benchmark runs table"><table className="evals-table">
          <thead><tr><th scope="col">Variant</th><th scope="col">Tasks</th><th scope="col">Passed first try</th><th scope="col">Median turns</th><th scope="col">Median minutes</th><th scope="col">Median tokens</th><th scope="col">Interventions</th></tr></thead>
          <tbody>{report.benchmark.runs.map(run => <tr key={run.variant}><th scope="row">{run.variant}</th><td>{run.tasks}</td><td>{run.passedFirstTry}</td><td>{formatNumber(run.medianTurns)}</td><td>{formatNumber(run.medianMinutes)}</td><td>{formatNumber(run.medianTokens)}</td><td>{run.interventions}</td></tr>)}</tbody>
        </table></div> : <p>No benchmark runs yet.</p>}
      </Section>
      <Section title="Spec judge">
        <p><strong>{report.judge.status === 'calibrated' ? 'Calibrated' : 'Not calibrated'}</strong> · {report.judge.labeled} labeled specs{report.judge.kappa !== null ? ` · agreement (kappa) ${formatNumber(report.judge.kappa)}` : ''}</p>
        {report.judge.correlation ? <p>Correlation with “{report.judge.correlation.outcome}”: {formatNumber(report.judge.correlation.r)} (95% interval {formatNumber(report.judge.correlation.ci95[0])} to {formatNumber(report.judge.correlation.ci95[1])}, n = {report.judge.correlation.n}).</p> : null}
        <p>{report.judge.note}</p>
      </Section>
      <Section title="How this is measured">
        {methodology.length ? <dl className="evals-pairs">{methodology.map(item => <div key={item.term}><dt>{item.term}</dt><dd>{item.explanation}</dd></div>)}</dl> : <p>No definitions in this report.</p>}
        <p className="dialog-note">Read {report.coverage.filesScanned} transcript files ({report.coverage.filesPartial} only partly). {report.coverage.chatsInteractive} of {report.coverage.chatsTotal} chats were interactive.</p>
      </Section>
      {report.missing.length ? <Section title="Missing this week"><ul className="evals-list">{report.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></Section> : null}
    </div>
  </>;
}

/** Read-only Evals page. It reads the latest report the first time the page is shown and on Reload only. */
export function EvalsPanel({ active }: { active: boolean }) {
  const [load, setLoad] = useState<Load>({ phase: 'idle' });
  const started = useRef(false);
  const read = useCallback((reload: boolean) => {
    setLoad({ phase: 'loading' });
    fetchLatestEvals({ reload }).then(data => setLoad({ phase: 'ready', data }))
      .catch(cause => setLoad({ phase: 'error', disconnected: !(cause instanceof ApiError) || cause.status === 403 }));
  }, []);
  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    read(false);
  }, [active, read]);
  const ready = load.phase === 'ready' ? load.data : null;
  return <section className="panel page-panel evals-panel" aria-label="Evals">
    <header className="page-panel-heading evals-header">
      <div><h2><Gauge size={18} aria-hidden="true" />Evals</h2><p className="dialog-note">Your weekly report on how agent work went. Read-only; analysis chats open only when you click.</p></div>
      <Button onClick={() => read(true)} disabled={load.phase === 'loading'}><RefreshCw size={15} />{load.phase === 'loading' ? 'Loading…' : 'Reload'}</Button>
    </header>
    <div className="evals-body">
      {load.phase === 'idle' || load.phase === 'loading' ? <p className="dialog-note" role="status">Loading the latest report…</p>
        : load.phase === 'error' ? <div className="notice notice-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><p>{load.disconnected ? 'Server disconnected.' : 'Could not load the report.'} <span>{load.disconnected ? 'Turn the dashboard on, then choose Reload.' : 'Choose Reload to try again.'}</span></p></div>
        : ready && ready.report ? <Report report={ready.report} date={ready.date} />
        : ready && ready.reason === 'invalid-report' ? <div className="notice notice-warning" role="status"><AlertTriangle size={18} aria-hidden="true" /><p>The latest report could not be read. <span>It may be incomplete or from another version. Generate it again, then choose Reload.</span></p></div>
        : <div className="evals-empty" role="status"><p className="evals-heading">No report yet.</p><p>It is generated every Sunday at 20:00, or run it manually: <code>node evals/cli.mjs weekly</code> in tools/chats-dashboard.</p></div>}
    </div>
  </section>;
}

/** Compact pre-launch note. Renders only predictors validated with enough data; never blocks the launch. */
export function EvalsLaunchAdvisory() {
  const [predictors, setPredictors] = useState<EvalsPredictor[]>([]);
  useEffect(() => {
    let current = true;
    fetchLatestEvals().then(data => { if (current) setPredictors(validatedPredictors(data.report).slice(0, 3)); }).catch(() => { if (current) setPredictors([]); });
    return () => { current = false; };
  }, []);
  if (!predictors.length) return null;
  return <aside className="evals-advisory" aria-label="Evals advisory">
    <p><Gauge size={15} aria-hidden="true" /><strong>From your Evals report</strong></p>
    <ul>{predictors.map(item => <li key={item.factor}>{item.label}: {item.effect! > 0 ? 'more' : 'fewer'} problems ({item.effect! > 0 ? '+' : ''}{Math.round(item.effect! * 10) / 10} points in “{item.outcome}”, {item.nWith} vs {item.nWithout} chats).</li>)}</ul>
    <p className="dialog-note">Advice only. It does not change or block the mission.</p>
  </aside>;
}
