// E6 weekly report: aggregates chat metrics into the report contract
// (evals/schema/report.schema.json) and writes report.json + report.html.
// Only aggregates and short redacted examples leave this module: no transcripts,
// chat ids, provider paths or repository roots.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stratifiedDifference, holm, bootstrapRatioDifference, MIN_N, excludesZero } from './stats.mjs';
import { assertValid } from './schema.mjs';
import { reportsDir } from './store.mjs';
import { renderReportHtml } from './report-html.mjs';

export { renderReportHtml };

const DAY_MS = 86_400_000;
const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Week boundaries

const partsCache = new Map();
function zonedParts(ms, timeZone) {
  if (!partsCache.has(timeZone)) {
    partsCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  const parts = Object.fromEntries(partsCache.get(timeZone).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute,
    second: +parts.second, weekday: WEEKDAYS[parts.weekday] };
}

// Offset (local minus UTC) of timeZone at instant ms, in milliseconds.
function zoneOffset(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// UTC instant of local midnight on the given calendar day in timeZone.
function localMidnight(year, month, day, timeZone) {
  const guess = Date.UTC(year, month - 1, day);
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone);
  return result;
}

const calendarDay = ms => { const d = new Date(ms); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };

function periodLabel(startMs, endMs, timeZone) {
  const a = zonedParts(startMs, timeZone), b = zonedParts(endMs - 1, timeZone);
  const fmt = p => `${MONTHS[p.month - 1]} ${p.day}`;
  return a.year === b.year ? `${fmt(a)} – ${fmt(b)}, ${b.year}` : `${fmt(a)}, ${a.year} – ${fmt(b)}, ${b.year}`;
}

function weekStarting(mondayUtcDay, timeZone) {
  const start = localMidnight(mondayUtcDay.year, mondayUtcDay.month, mondayUtcDay.day, timeZone);
  const next = calendarDay(Date.UTC(mondayUtcDay.year, mondayUtcDay.month - 1, mondayUtcDay.day) + 7 * DAY_MS);
  const end = localMidnight(next.year, next.month, next.day, timeZone);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: periodLabel(start, end, timeZone) };
}

// ISO week (Monday 00:00 to next Monday 00:00 local time) containing `now`, and the week before.
export function weekPeriod(now = new Date(), { timeZone = 'America/Bogota' } = {}) {
  const ms = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(ms)) throw new Error('weekPeriod needs a valid date.');
  const local = zonedParts(ms, timeZone);
  const monday = calendarDay(Date.UTC(local.year, local.month - 1, local.day) - local.weekday * DAY_MS);
  const previousMonday = calendarDay(Date.UTC(monday.year, monday.month - 1, monday.day) - 7 * DAY_MS);
  return { period: weekStarting(monday, timeZone), previousPeriod: weekStarting(previousMonday, timeZone) };
}

// ---------------------------------------------------------------------------
// Privacy helpers (defense in depth: excerpts are already redacted upstream)

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED:key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED:email]'],
  [/\b(?:claude|codex):[A-Za-z0-9._-]{4,}/gi, '[REDACTED:id]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED:id]'],
  [/(?:\b[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, '[REDACTED:path]'],
  [/(?:~|\/(?:home|Users|mnt|tmp|var|etc|opt|root))\/[^\s"'<>|]+/g, '[REDACTED:path]'],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED:secret]'],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[REDACTED:secret]'],
  [/\+\d[\d\s().-]{6,}\d/g, '[REDACTED:number]'],
  [/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[REDACTED:number]'],
  [/\d{7,}/g, '[REDACTED:number]'],
];

export function redactLight(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  return value;
}

const clean = text => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const safeText = (text, max) => clip(redactLight(clean(text)), max);

// Retrospective row values are labels; an absolute path keeps only its last segment.
function safeLabel(value, max) {
  const text = clean(value);
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|~\/)/.test(text)) return safeText(text.split(/[\\/]+/).filter(Boolean).pop() ?? 'unknown', max);
  return safeText(text, max);
}

// ---------------------------------------------------------------------------
// Plain-language catalog

export const CATEGORY_LABELS = {
  'wrong-result': 'It did not work',
  incomplete: 'Something was missing',
  misunderstood: 'Not what I asked',
  scope: 'Did more or less than asked',
  process: 'Skipped a rule or a check',
  'language-style': 'Language or style',
  redo: 'Do it again',
  other: 'Other',
};
const CATEGORIES = Object.keys(CATEGORY_LABELS);

const KPI_DEFS = [
  { id: 'correction-rate', label: 'Corrections', unit: 'per10', goodDirection: 'down',
    meaning: 'How many times you had to correct the agent per 10 messages you sent.',
    better: 'you corrected the agent less often', worse: 'you corrected the agent more often', short: 'corrections' },
  { id: 'false-done-rate', label: 'Broken "done"', unit: 'percent', goodDirection: 'down',
    meaning: 'Share of times the agent said it was finished but you then reported a problem.',
    better: 'fewer "done" claims turned out broken', worse: 'more "done" claims turned out broken', short: 'broken "done" claims' },
  { id: 'verified-commit-rate', label: 'Verified commits', unit: 'percent', goodDirection: 'up',
    meaning: 'Share of commits made after a passing test, build or lint in the same turn.',
    better: 'more commits were verified first', worse: 'fewer commits were verified first', short: 'verified commits' },
  { id: 'fix-revert-rate', label: 'Fixed or reverted within 72 h', unit: 'percent', goodDirection: 'down',
    meaning: 'Share of commits that needed a fix or revert within 72 hours.',
    better: 'fewer commits needed a fix or revert within 72 h', worse: 'more commits needed a fix or revert within 72 h', short: 'fixes or reverts within 72 h' },
];

const OUTCOME = 'chat had a correction, broken done or fix within 72 h';
const PROBLEM_MEASURE = 'Share of chats with a correction, broken done or fix within 72 h.';

const EXPERIMENTS = {
  'no-spec': () => ({ title: 'Spec first for features',
    action: 'Write a short spec with acceptance checks before feature chats (agent-relay-spec).',
    measure: 'Share of feature chats with a correction, broken done or fix within 72 h.' }),
  'low-effort': () => ({ title: 'Higher effort for implementation', action: 'Use high effort for implementation chats.' }),
  'short-prompt': () => ({ title: 'Longer first prompts',
    action: 'Start each chat with a first prompt of 300+ characters that states the goal, the files involved and how to check the result.' }),
  compacted: () => ({ title: 'Hand off before compaction',
    action: 'Hand off before the context fills up: start a fresh chat with a handoff summary instead of letting it compact.' }),
  codex: () => ({ title: 'Compare Claude for implementation', action: 'Run the next implementation chats on Claude instead of Codex and compare.' }),
  'many-tool-errors': () => ({ title: 'Fix tool errors early',
    action: 'When a chat hits repeated tool errors, stop and fix the setup (paths, permissions, dependencies) before continuing.' }),
  model: id => ({ title: 'Try another model', action: `Use a different model than ${id} for implementation chats this week and compare.` }),
  task: type => ({ title: `Spec first for ${type} chats`, action: `Write a short spec with acceptance checks before ${type} chats (agent-relay-spec).` }),
};

const MEASUREMENT_EXPERIMENT = {
  title: 'Check the labels',
  action: 'Mark the label check (node evals/cli.mjs label-check): about 90 yes/no answers on whether the model\'s correction and broken "done" labels are right.',
  why: 'No factor is a validated predictor of problems yet (too little data, an interval that includes zero, or a result that could be chance among the factors tested), so trustworthy measurement comes first.',
  measure: 'Share of model labels confirmed (goal: at least 70%).',
};

// Predictors need enough chats overall and per length group before they can be validated.
export const PREDICTOR_MIN_N = 30, PREDICTOR_MIN_STRATUM = 5;

export const METHODOLOGY = [
  ['Correction', 'A message where you told the agent something was wrong, missing or not what you asked. A model (Codex GPT-6.1 Sol by default) reads each of your follow-up messages with the agent\'s previous reply and labels it; fixed text rules are used only for chats it has not labeled. Questions, new requests, pasted text and messages written by other agents do not count.'],
  ['Broken done', 'The agent said the work was finished or verified, and your next message reported that it was not (the labeling model decides from both messages).'],
  ['Verified commit', 'A commit made after a test, build, lint or typecheck that did not fail earlier in the same turn.'],
  ['Fix or revert within 72 h', 'A commit from another chat within three days that reverted the commit, or whose subject says it fixes something and that changed the same files (generated files, docs and lockfiles excluded). Later commits of the same chat are normal iteration.'],
  ['Predictor', 'A chat trait (for example, no written spec) compared between chats with and without it to see whether problems are more common. Chats are compared only with chats of similar length (messages you sent), because longer chats have more chances for a problem. A predictor needs at least 30 chats on each side and 5 per length group.'],
  ['Validated', 'The interval excludes zero and the result survives the Holm correction for the number of factors tested, so it is unlikely to be chance.'],
  ['Percentage points', 'The plain difference between two percentages: 30% versus 20% is 10 percentage points.'],
  ['Confidence interval', 'The range where the true effect probably lies (95%); when it includes zero the effect may be chance.'],
  ['Bootstrap', 'Resampling the chats thousands of times with a fixed seed to estimate how much a result could vary.'],
  ['n', 'How many items a number is based on; with fewer than 10 the report says there is not enough data.'],
  ['Kappa', 'Agreement between the automatic judge and your labels beyond chance: 0 is chance, 1 is perfect agreement.'],
  ['Holdout', 'Benchmark tasks kept aside and only used for final comparisons, so results are not tuned to them.'],
  ['Effort', 'The reasoning effort setting of the chat (low, medium, high, xhigh or max).'],
  ['Spec', 'A first prompt written as a specification: requirements plus acceptance checks, or an agent-relay-spec reference.'],
  ['Compaction', 'The agent summarized its own context because it filled up, which can lose details.'],
].map(([term, explanation]) => ({ term, explanation }));

export const DEFAULT_JUDGE = Object.freeze({ status: 'not-calibrated', labeled: 0, kappa: null, correlation: null,
  note: 'Needs about 100 labels from the owner before its scores are trusted.' });

// ---------------------------------------------------------------------------
// Aggregation

const LOW_EFFORT = new Set(['minimal', 'low', 'medium']);
const HIGH_EFFORT = new Set(['high', 'xhigh', 'max']);
const int = value => (Number.isInteger(value) && value >= 0 ? value : 0);
const round1 = value => Math.round(value * 10) / 10;

// Keeps only the fields the report needs, so large histories stay small in memory.
function compact(m) {
  const commits = Array.isArray(m.commits) ? m.commits : [];
  return {
    provider: m.provider, model: typeof m.model === 'string' ? m.model : null,
    effort: typeof m.effort === 'string' ? m.effort.toLowerCase() : null,
    startedMs: m.startedAt ? Date.parse(m.startedAt) : NaN, startedAt: m.startedAt ?? null,
    taskType: m.taskType, hasSpec: m.hasSpec === true, promptChars: int(m.promptChars), userTurns: int(m.userTurns),
    corrections: int(m.corrections?.count), byCategory: m.corrections?.byCategory ?? {},
    doneClaims: int(m.doneClaims), falseDone: int(m.falseDone?.count),
    commits: commits.length, verifiedCommits: commits.filter(c => c?.verifiedBefore === true).length,
    checked72h: int(m.commitsChecked72h), fixed72h: int(m.commitsFixedOrReverted72h),
    compactions: int(m.compactions), toolErrors: int(m.toolErrors),
  };
}

const isProblem = c => c.corrections > 0 || c.falseDone > 0 || c.fixed72h > 0;

const KPI_PARTS = {
  'correction-rate': ['corrections', 'userTurns', 10], 'false-done-rate': ['falseDone', 'doneClaims', 100],
  'verified-commit-rate': ['verifiedCommits', 'commits', 100], 'fix-revert-rate': ['fixed72h', 'checked72h', 100],
};

// Each KPI is a ratio of sums over chats; pairs keep the per-chat parts for the trend interval.
function kpiRaw(chats) {
  return Object.fromEntries(Object.entries(KPI_PARTS).map(([id, [num, den, scale]]) => {
    const pairs = chats.map(c => [c[num], c[den]]).filter(([, d]) => d > 0);
    const n = pairs.reduce((total, [, d]) => total + d, 0), hits = pairs.reduce((total, [h]) => total + h, 0);
    return [id, { raw: n ? (hits / n) * scale : null, n, pairs, scale }];
  }));
}

/**
 * Week-over-week call: 'better' or 'worse' only when the bootstrap interval of the
 * difference (resampling chats) excludes zero, else 'same'; 'unknown' under MIN_N.
 */
export function trendOf(current, previous, goodDirection, { seed = 42 } = {}) {
  if (!current || !previous || current.n < MIN_N || previous.n < MIN_N || current.raw === null || previous.raw === null) return 'unknown';
  const result = bootstrapRatioDifference(current.pairs ?? [], previous.pairs ?? [], { seed });
  if (result.status !== 'ok' || !excludesZero(result.ci95)) return 'same';
  return (result.effect < 0) === (goodDirection === 'down') ? 'better' : 'worse';
}

function buildKpis(current, previous, seed) {
  return KPI_DEFS.map(def => {
    const now = current[def.id], before = previous[def.id];
    const insufficient = now.n < MIN_N;
    return {
      id: def.id, label: def.label,
      value: insufficient || now.raw === null ? null : round1(now.raw),
      previous: before.n < MIN_N || before.raw === null ? null : round1(before.raw),
      unit: def.unit, goodDirection: def.goodDirection, trend: trendOf(now, before, def.goodDirection, { seed }),
      meaning: def.meaning, n: now.n, insufficient,
    };
  });
}

// Messages you sent: 1, 2-3, 4-7, 8-15, 16 or more.
export const lengthBucket = turns => (turns <= 1 ? 1 : turns <= 3 ? 2 : turns <= 7 ? 3 : turns <= 15 ? 4 : 5);

function predictorRow(factor, label, withGroup, withoutGroup, seed) {
  // Longer chats have more chances for a problem, so chats are compared only with chats of similar length.
  const item = c => ({ stratum: lengthBucket(c.userTurns), value: isProblem(c) ? 1 : 0 });
  const result = stratifiedDifference(withGroup.map(item), withoutGroup.map(item), { scale: 100, seed, minN: PREDICTOR_MIN_N, minStratum: PREDICTOR_MIN_STRATUM });
  const ok = result.status === 'ok';
  return { factor: clip(factor, 60), label: clip(label, 120), outcome: OUTCOME,
    effect: ok ? result.effect : null, ci95: ok ? result.ci95 : null,
    nWith: withGroup.length, nWithout: withoutGroup.length, status: ok ? 'ok' : 'insufficient',
    validated: ok && excludesZero(result.ci95), p: ok ? result.p : null };
}

const split = (chats, test) => {
  const yes = [], no = [];
  for (const c of chats) { const v = test(c); if (v === true) yes.push(c); else if (v === false) no.push(c); }
  return [yes, no];
};

export function rankPredictors(rows) {
  return [...rows].sort((a, b) => (Number(b.validated) - Number(a.validated))
    || ((b.effect === null ? -1 : Math.abs(b.effect)) - (a.effect === null ? -1 : Math.abs(a.effect)))
    || a.factor.localeCompare(b.factor));
}

function buildPredictors(chats, seed) {
  const rows = [
    predictorRow('no-spec', 'No written spec', ...split(chats, c => !c.hasSpec), seed),
    predictorRow('low-effort', 'Low or medium effort', ...split(chats, c => (LOW_EFFORT.has(c.effort) ? true : HIGH_EFFORT.has(c.effort) ? false : null)), seed),
    predictorRow('short-prompt', 'First prompt under 300 characters', ...split(chats, c => c.promptChars < 300), seed),
    predictorRow('compacted', 'Context was compacted', ...split(chats, c => c.compactions > 0), seed),
    predictorRow('codex', 'Codex instead of Claude', ...split(chats, c => (c.provider === 'codex' ? true : c.provider === 'claude' ? false : null)), seed),
    predictorRow('many-tool-errors', '5 or more tool errors', ...split(chats, c => c.toolErrors >= 5), seed),
  ];
  const counts = (key) => {
    const map = new Map();
    for (const c of chats) if (c[key]) map.set(c[key], (map.get(c[key]) ?? 0) + 1);
    return [...map].filter(([, n]) => n >= MIN_N).map(([value]) => value).sort();
  };
  for (const model of counts('model')) rows.push(predictorRow(`model:${model}`, `Model ${clip(clean(model), 80)}`, ...split(chats, c => c.model === model), seed));
  for (const type of counts('taskType')) rows.push(predictorRow(`task:${type}`, `Task type: ${type}`, ...split(chats, c => c.taskType === type), seed));
  // Holm across every factor tested this week: one chance hit among ~18 is expected at 95%.
  const adjusted = holm(rows.map(row => row.p));
  const all = rows.map(({ p, ...row }, i) => ({ ...row, validated: row.validated && adjusted[i] !== null && adjusted[i] < 0.05 }));
  return { predictors: rankPredictors(all).slice(0, 12), all };
}

// "Spec first" experiments need specs to look helpful: chats without a spec must have had more problems.
const SPEC_FIRST = factor => factor === 'no-spec' || factor.startsWith('task:');

function chooseExperiment(predictors, all = predictors) {
  const spec = all.find(p => p.factor === 'no-spec');
  const top = predictors.find(p => p.validated && p.effect > 0 && (!SPEC_FIRST(p.factor) || (spec?.status === 'ok' && spec.effect > 0)));
  if (!top) return { ...MEASUREMENT_EXPERIMENT };
  const [kind, ...rest] = top.factor.split(':'), arg = rest.join(':');
  const make = EXPERIMENTS[kind];
  if (!make) return { ...MEASUREMENT_EXPERIMENT };
  const plan = make(arg);
  const why = `Chats with "${top.label.toLowerCase()}" had problems ${top.effect} percentage points more often `
    + `(95% CI ${top.ci95[0]} to ${top.ci95[1]}; n = ${top.nWith} vs ${top.nWithout}).`;
  return { title: clip(plan.title, 120), action: clip(plan.action, 300), why: clip(why, 300), measure: clip(plan.measure ?? PROBLEM_MEASURE, 200) };
}

// Corrections and examples. Candidates per category are bounded while streaming.
function newCorrectionAcc() {
  return { total: 0, count: Object.fromEntries(CATEGORIES.map(c => [c, 0])), previous: Object.fromEntries(CATEGORIES.map(c => [c, 0])),
    periodExamples: new Map(), otherExamples: new Map() };
}
function addExamples(map, items, keepNewest) {
  for (const item of items) {
    if (!CATEGORIES.includes(item?.category) || typeof item.excerpt !== 'string') continue;
    const text = safeText(item.excerpt, 160);
    if (text.length < 3) continue;
    const list = map.get(item.category) ?? [];
    if (list.includes(text)) continue;
    list.push(text);
    if (list.length > 2) keepNewest ? list.shift() : list.pop();
    map.set(item.category, list);
  }
}
function buildCorrections(acc) {
  const byCategory = CATEGORIES.filter(c => acc.count[c] > 0 || acc.previous[c] > 0)
    .sort((a, b) => (acc.count[b] - acc.count[a]) || (acc.previous[b] - acc.previous[a]) || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))
    .map(category => ({ category, label: CATEGORY_LABELS[category], count: acc.count[category], previous: acc.previous[category] }));
  const order = [...byCategory.map(row => row.category), ...CATEGORIES.filter(c => !byCategory.some(row => row.category === c))];
  const examples = [];
  for (const category of order) {
    const texts = acc.periodExamples.get(category)?.length ? acc.periodExamples.get(category) : (acc.otherExamples.get(category) ?? []);
    for (const text of texts) if (examples.length < 12) examples.push({ category, text });
  }
  return { total: acc.total, byCategory, examples };
}

function buildBenchmark(tasks, benchmark = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const counts = list.length ? {
    catalogTasks: list.filter(t => !t.excluded).length,
    excludedTasks: list.filter(t => t.excluded).length,
    reproducibleTasks: list.filter(t => !t.excluded && (t.reproducible === true || t.suite)).length,
    holdoutTasks: list.filter(t => !t.excluded && t.suite?.split === 'holdout').length,
  } : { catalogTasks: int(benchmark?.catalogTasks), excludedTasks: int(benchmark?.excludedTasks),
    reproducibleTasks: int(benchmark?.reproducibleTasks), holdoutTasks: int(benchmark?.holdoutTasks) };
  const e = benchmark?.estimate;
  const estimate = e && typeof e === 'object'
    ? { turns: int(e.turns), days: Number.isFinite(e.days) && e.days >= 0 ? e.days : 0, turnsPerDay: Math.max(1, int(e.turnsPerDay)) } : null;
  const num = v => (Number.isFinite(v) ? v : null);
  const runs = (Array.isArray(benchmark?.runs) ? benchmark.runs : []).slice(0, 100).map(r => ({
    variant: safeText(r.variant ?? 'unknown', 120), tasks: int(r.tasks), passedFirstTry: int(r.passedFirstTry),
    medianTurns: num(r.medianTurns), medianMinutes: num(r.medianMinutes), medianTokens: num(r.medianTokens), interventions: int(r.interventions),
  }));
  return { ...counts, estimate, runs };
}

// Retrospective rows come from the benchmark lane; only schema fields pass through.
const RETRO_DIMENSIONS = new Set(['model', 'effort', 'spec', 'taskType', 'project', 'provider']);
const finite = v => (Number.isFinite(v) ? v : null);
function modelRow(row) {
  return { dimension: RETRO_DIMENSIONS.has(row?.dimension) ? row.dimension : 'model', value: safeLabel(row?.value ?? 'unknown', 120),
    chats: int(row?.chats), correctionRate: finite(row?.correctionRate), falseDoneRate: finite(row?.falseDoneRate),
    fixRevertRate: finite(row?.fixRevertRate), medianTurnsToVerifiedCommit: finite(row?.medianTurnsToVerifiedCommit),
    insufficient: row?.insufficient === true || int(row?.chats) < MIN_N };
}

function buildJudge(judge) {
  if (!judge || typeof judge !== 'object') return { ...DEFAULT_JUDGE };
  const c = judge.correlation;
  return {
    status: judge.status === 'calibrated' ? 'calibrated' : 'not-calibrated',
    labeled: int(judge.labeled), kappa: Number.isFinite(judge.kappa) ? judge.kappa : null,
    correlation: c && Number.isFinite(c.r) && Array.isArray(c.ci95) && c.ci95.length === 2
      ? { r: c.r, ci95: [Number(c.ci95[0]), Number(c.ci95[1])], n: int(c.n), outcome: safeText(c.outcome ?? 'problems', 80) } : null,
    note: safeText(judge.note ?? DEFAULT_JUDGE.note, 300),
  };
}

// Only the schema's fields of readLabelCheck() pass through.
function buildLabelCheckSummary(check) {
  if (!check || !Array.isArray(check.kinds)) return null;
  const kinds = check.kinds.filter(k => ['correction', 'broken-done', 'not-correction'].includes(k?.kind)).slice(0, 3).map(k => ({
    kind: k.kind, label: safeText(k.label ?? k.kind, 60), total: int(k.total), answered: int(k.answered), confirmed: int(k.confirmed),
    rate: Number.isFinite(k.rate) ? k.rate : null, ci95: Array.isArray(k.ci95) && k.ci95.length === 2 && k.ci95.every(Number.isFinite) ? [k.ci95[0], k.ci95[1]] : null,
  }));
  const checkedBy = (Array.isArray(check.checkedBy) ? check.checkedBy : []).slice(0, 3).map(name => safeText(name, 60)).filter(Boolean);
  const labeledBy = (Array.isArray(check.labeledBy) ? check.labeledBy : []).slice(0, 3).map(name => safeText(name, 60)).filter(Boolean);
  return { total: int(check.total), answered: int(check.answered), checkedBy, labeledBy, kinds };
}

const NUM_UNIT = { per10: v => `${v} per 10 messages`, percent: v => `${v}%`, count: v => `${v}`, turns: v => `${v} turns` };
const formatKpi = (kpi, value) => NUM_UNIT[kpi.unit](value);

function buildSummary({ chatsInPeriod, period, kpis, experiment }) {
  const sentences = [chatsInPeriod
    ? `This week (${period.label}) you ran ${chatsInPeriod} interactive chat${chatsInPeriod === 1 ? '' : 's'}.`
    : `There were no interactive chats this week (${period.label}).`];
  const defs = Object.fromEntries(KPI_DEFS.map(d => [d.id, d]));
  const pair = kpi => (kpi.unit === 'per10' ? `${kpi.value} vs ${kpi.previous} per 10 messages`
    : `${formatKpi(kpi, kpi.value)} vs ${formatKpi(kpi, kpi.previous)}`);
  const phrase = (kpi, word) => `${defs[kpi.id][word]} (${pair(kpi)})`;
  const better = kpis.filter(k => k.trend === 'better'), worse = kpis.filter(k => k.trend === 'worse');
  const same = kpis.filter(k => k.trend === 'same'), unknown = kpis.filter(k => k.trend === 'unknown');
  const join = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  const comparable = better.length + worse.length + same.length;
  if (comparable) {
    sentences.push(better.length ? clip(`Better than last week: ${join(better.map(k => phrase(k, 'better')))}.`, 300)
      : 'No measure clearly improved compared with last week.');
    sentences.push(worse.length ? clip(`Worse than last week: ${join(worse.map(k => phrase(k, 'worse')))}.`, 300)
      : 'No measure clearly got worse compared with last week.');
  }
  if (unknown.length) {
    sentences.push(comparable
      ? clip(`There is not enough data yet to compare ${join(unknown.map(k => defs[k.id].short))} with last week.`, 300)
      : 'There is not enough data yet to compare any measure with last week.');
  }
  sentences.push(clip(`Next week: ${experiment.action}`, 300));
  return sentences.slice(0, 5);
}

/**
 * Builds the weekly report object (validated against the report schema).
 * metrics: iterable of chat-metrics records, consumed once.
 */
export function buildReport({ metrics, tasks = [], retro = [], judge = DEFAULT_JUDGE, benchmark = {}, coverage = {},
  missing = [], labelCheck = null, run, now = new Date(), seed = 42 } = {}) {
  const { period, previousPeriod } = weekPeriod(now);
  const [ps, pe, qs] = [Date.parse(period.start), Date.parse(period.end), Date.parse(previousPeriod.start)];
  const interactive = [], inPeriod = [], inPrevious = [], acc = newCorrectionAcc();
  const labels = { model: null, claudeChats: 0, ruleChats: 0 };
  let total = 0, first = null, last = null;
  for (const record of metrics ?? []) {
    total++;
    if (!record || record.automated !== false) continue;
    const chat = compact(record);
    interactive.push(chat);
    if (record.modelPass?.status === 'ok') { labels.claudeChats++; labels.model ??= typeof record.modelPass.model === 'string' ? safeText(record.modelPass.model, 80) : null; }
    else labels.ruleChats++;
    if (Number.isFinite(chat.startedMs)) {
      if (first === null || chat.startedMs < first) first = chat.startedMs;
      if (last === null || chat.startedMs > last) last = chat.startedMs;
    }
    const items = Array.isArray(record.corrections?.items) ? record.corrections.items : [];
    if (chat.startedMs >= ps && chat.startedMs < pe) {
      inPeriod.push(chat);
      acc.total += chat.corrections;
      for (const c of CATEGORIES) acc.count[c] += int(chat.byCategory[c]);
      addExamples(acc.periodExamples, items, false);
    } else {
      if (chat.startedMs >= qs && chat.startedMs < ps) {
        inPrevious.push(chat);
        for (const c of CATEGORIES) acc.previous[c] += int(chat.byCategory[c]);
      }
      addExamples(acc.otherExamples, items, true);
    }
  }

  const kpis = buildKpis(kpiRaw(inPeriod), kpiRaw(inPrevious), seed);
  const { predictors, all } = buildPredictors(interactive, seed);
  const experiment = chooseExperiment(predictors, all);

  const notes = (Array.isArray(missing) ? missing : []).map(note => safeText(note, 200)).filter(Boolean);
  if (!inPeriod.length) notes.push('No interactive chats in this period.');
  if (!inPrevious.length) notes.push('No chats in the previous week: trends unavailable.');
  if (!(Array.isArray(retro) && retro.length)) notes.push('No retrospective model table was provided.');
  if (!(Array.isArray(tasks) && tasks.length)) notes.push('No benchmark task catalog was provided.');
  if (!predictors.some(p => p.validated)) notes.push('No validated predictor yet: more chats are needed for confident comparisons.');
  if (labels.ruleChats && labels.claudeChats) notes.push(`${labels.ruleChats} interactive chats are not fully labeled by the model yet; their corrections come from the text rules.`);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    period, previousPeriod,
    coverage: {
      chatsTotal: Number.isInteger(coverage?.chatsTotal) && coverage.chatsTotal >= total ? coverage.chatsTotal : total,
      chatsInteractive: interactive.length, chatsInPeriod: inPeriod.length,
      filesScanned: int(coverage?.filesScanned), filesPartial: int(coverage?.filesPartial),
      firstChatAt: first === null ? null : new Date(first).toISOString(), lastChatAt: last === null ? null : new Date(last).toISOString(),
    },
    summary: buildSummary({ chatsInPeriod: inPeriod.length, period, kpis, experiment }),
    kpis, experiment, predictors,
    corrections: buildCorrections(acc),
    models: { scope: 'All interactive chats to date', rows: (Array.isArray(retro) ? retro : []).slice(0, 200).map(modelRow) },
    benchmark: buildBenchmark(tasks, benchmark),
    judge: buildJudge(judge),
    labels: { ...labels, check: buildLabelCheckSummary(labelCheck) },
    methodology: METHODOLOGY.map(entry => ({ ...entry })),
    missing: [...new Set(notes)].slice(0, 20),
  };
  if (run && typeof run === 'object') {
    report.run = { durationMs: int(Math.round(run.durationMs ?? 0)), peakRssBytes: int(Math.round(run.peakRssBytes ?? 0)) };
    if (run.trigger === 'weekly' || run.trigger === 'manual') report.run.trigger = run.trigger;
  }
  return assertValid('report', report);
}

// ---------------------------------------------------------------------------
// Writing

function localDate(iso, timeZone = 'America/Bogota') {
  const p = zonedParts(Date.parse(iso), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Writes <dir>/<YYYY-MM-DD>/report.json and report.html atomically (temp + rename).
// A different existing report of the same date is kept unless replace is true.
export function writeReport({ report, dir = reportsDir(), date, replace = false } = {}) {
  assertValid('report', report);
  const day = date ?? localDate(report.generatedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Report date must be YYYY-MM-DD.');
  const target = path.join(dir, day), json = path.join(target, 'report.json'), html = path.join(target, 'report.html');
  const jsonText = `${JSON.stringify(report, null, 2)}\n`, htmlText = renderReportHtml(report);
  let existing = null;
  try { existing = fs.readFileSync(json, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== null && existing !== jsonText && !replace) {
    throw new Error(`A different report already exists for ${day}; pass { replace: true } to overwrite it.`);
  }
  fs.mkdirSync(target, { recursive: true });
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const temps = [[`${html}.${suffix}`, html, htmlText], [`${json}.${suffix}`, json, jsonText]];
  try {
    for (const [temp, , text] of temps) fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    // HTML first: report.json is what readers look for, so it lands last.
    for (const [temp, final] of temps) fs.renameSync(temp, final);
  } finally {
    for (const [temp] of temps) fs.rmSync(temp, { force: true });
  }
  return { dir: target, json, html };
}
