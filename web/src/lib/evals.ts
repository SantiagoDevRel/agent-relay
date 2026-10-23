// Relay Evals weekly report (evals/schema/report.schema.json) and its on-demand
// reader. Nothing here polls or listens to the live stream: the report is fetched
// only when the Evals page or the mission launch preview asks for it.
import { ApiError } from './api';

export interface EvalsPeriod { start: string; end: string; label: string }
export type EvalsCI = [number, number];
export interface EvalsKpi {
  id: string; label: string; value: number | null; previous: number | null;
  unit: 'percent' | 'count' | 'turns' | 'per10'; goodDirection: 'up' | 'down';
  trend: 'better' | 'worse' | 'same' | 'unknown'; meaning: string; n: number; insufficient: boolean;
}
export interface EvalsPredictor {
  factor: string; label: string; outcome: string; effect: number | null; ci95: EvalsCI | null;
  nWith: number; nWithout: number; status: 'ok' | 'insufficient'; validated: boolean;
}
export interface EvalsModelRow {
  dimension: 'model' | 'effort' | 'spec' | 'taskType' | 'project' | 'provider'; value: string; chats: number;
  correctionRate: number | null; falseDoneRate: number | null; fixRevertRate: number | null;
  medianTurnsToVerifiedCommit: number | null; insufficient: boolean;
}
export interface EvalsBenchmarkRun {
  variant: string; tasks: number; passedFirstTry: number; medianTurns: number | null;
  medianMinutes: number | null; medianTokens: number | null; interventions: number;
}
export interface EvalsLabelCheckKind {
  kind: 'correction' | 'broken-done' | 'not-correction'; label: string; total: number; answered: number; confirmed: number; rate: number | null; ci95: EvalsCI | null;
}
/** Who labeled corrections (a model or the text rules) and the label check answers. claudeChats counts model-labeled chats (named before Codex labels). Older reports lack it. */
export interface EvalsLabels {
  model: string | null; claudeChats: number; ruleChats: number;
  check: { total: number; answered: number; checkedBy?: string[]; labeledBy?: string[]; kinds: EvalsLabelCheckKind[] } | null;
}
export interface EvalsReport {
  schemaVersion: 1; generatedAt: string; period: EvalsPeriod; previousPeriod: EvalsPeriod;
  coverage: { chatsTotal: number; chatsInteractive: number; chatsInPeriod: number; filesScanned: number; filesPartial: number; firstChatAt: string | null; lastChatAt: string | null };
  summary: string[]; kpis: EvalsKpi[];
  experiment: { title: string; action: string; why: string; measure: string };
  predictors: EvalsPredictor[];
  corrections: { total: number; byCategory: { category: string; label: string; count: number; previous: number }[]; examples: { category: string; text: string }[] };
  models: { scope: string; rows: EvalsModelRow[] };
  benchmark: { catalogTasks: number; excludedTasks: number; reproducibleTasks: number; holdoutTasks: number; estimate: { turns: number; days: number; turnsPerDay: number } | null; runs: EvalsBenchmarkRun[] };
  judge: { status: 'not-calibrated' | 'calibrated'; labeled: number; kappa: number | null; correlation: { r: number; ci95: EvalsCI; n: number; outcome: string } | null; note: string };
  labels?: EvalsLabels;
  methodology: { term: string; explanation: string }[];
  missing: string[];
  run?: { durationMs: number; peakRssBytes: number; trigger?: 'weekly' | 'manual' };
}
export type LatestEvals = { report: EvalsReport; generatedAt: string; date: string } | { report: null; reason: 'no-report' | 'invalid-report' };

/** Same minimum group size as evals/stats.mjs MIN_N. */
export const MIN_GROUP = 10;
/** Same minimums as PREDICTOR_MIN_N and PREDICTOR_MIN_STRATUM in evals/report.mjs. */
export const PREDICTOR_MIN_GROUP = 30, PREDICTOR_MIN_STRATUM = 5;

/** One plain sentence on who labeled the corrections, or null for reports without the field. */
export function labelsNote(labels: EvalsLabels | undefined): string | null {
  if (!labels) return null;
  const chats = labels.claudeChats + labels.ruleChats;
  if (!labels.claudeChats) return `Corrections come from fixed text rules in all ${chats} chats.`;
  const who = !labels.model ? 'A model (unknown)' : `${/^claude/i.test(labels.model) ? 'Claude' : 'Codex'} (${labels.model})`;
  return `${who} labeled corrections and broken “done” claims in ${labels.claudeChats} of ${chats} chats${labels.ruleChats ? '; the rest use fixed text rules' : ''}.`;
}

const token = document.querySelector<HTMLMetaElement>('meta[name="chats-token"]')?.content ?? '';
let cached: Promise<LatestEvals> | null = null;

/** Reads the newest report once per page load; `reload` asks the server again. Failures are never cached. */
export function fetchLatestEvals({ reload = false }: { reload?: boolean } = {}): Promise<LatestEvals> {
  if (!cached || reload) {
    const request = fetch(`/api/evals/latest?t=${encodeURIComponent(token)}`, { cache: 'no-store' }).then(async response => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: unknown };
        throw new ApiError(response.status, String(error.error ?? 'failed'));
      }
      return response.json() as Promise<LatestEvals>;
    });
    cached = request;
    request.catch(() => { if (cached === request) cached = null; });
  }
  return cached;
}

/** Predictors E5/E6 validated with enough data: ok status, CI excluding zero, Holm-validated and n ≥ 30 in both groups. */
export function validatedPredictors(report: EvalsReport | null): EvalsPredictor[] {
  if (!report) return [];
  return report.predictors.filter(p => p.validated === true && p.status === 'ok' && p.effect !== null && p.ci95 !== null
    && (p.ci95[0] > 0 || p.ci95[1] < 0) && p.nWith >= PREDICTOR_MIN_GROUP && p.nWithout >= PREDICTOR_MIN_GROUP);
}

export function formatKpiValue(value: number, unit: EvalsKpi['unit']) {
  const rounded = Math.round(value * 10) / 10;
  if (unit === 'percent') return `${rounded}%`;
  return String(rounded);
}

export const formatRate = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
export const formatNumber = (value: number | null) => value === null ? '—' : String(Math.round(value * 10) / 10);

/** Mirrors ANALYSES in evals/analysis.mjs (test/evals-analysis.test.mjs keeps them equal). The server owns the prompts. */
export const EVALS_ANALYSES = [
  { id: 'next-changes', label: 'What to change next week', description: 'The three changes with the largest expected improvement, each with how to check it next week.' },
  { id: 'corrections', label: 'Why I correct agents', description: 'Groups real corrections by root cause and names the rule, skill or habit that would prevent each group.' },
  { id: 'broken-done', label: 'Broken “done” claims', description: 'What was actually missing when an agent said “done”, and the check that would have caught it.' },
  { id: 'models', label: 'Which model and effort to use', description: 'Compares models and reasoning effort within the same kind of task, and says where the data cannot tell.' },
  { id: 'friction', label: 'Tool errors and compactions', description: 'Where tool errors and context compactions come from, and the fix that removes the biggest share.' },
] as const;
export type EvalsAnalysisId = typeof EVALS_ANALYSES[number]['id'];
/** Mirrors ANALYSIS_PROVIDERS in evals/analysis.mjs; the server maps the ID to the model. */
export const EVALS_ANALYSIS_PROVIDERS = [
  { id: 'claude', label: 'Claude', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5' },
  { id: 'codex', label: 'Codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol' },
] as const;
export type EvalsAnalysisProvider = typeof EVALS_ANALYSIS_PROVIDERS[number]['id'];
