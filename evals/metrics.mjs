// E2 Layer 1 metrics: one chat-metrics object per chat record. computeMetrics is
// pure; computeAll adds the read-only Git follow-up and the cached model labels.
//
// Metric definitions (all per chat):
// - corrections: one item per follow-up human prompt that corrects the agent. Model labels
//   (claude-labels.mjs) when every message of the chat is labeled, else the deterministic rules.
// - interruptions: distinct turns with an interrupt message or an interrupted turn
//   (an interrupt message and its interrupted turn count once).
// - doneClaims: turns whose agentFinal is a closure claim (isDoneClaim).
// - falseDone: with model labels, a message the labeler marks brokenDone (the previous reply claimed
//   the work was done and the message reports it is not; that reply counts as a done claim).
//   With rules, a done claim at turn t followed, within the next two human prompts after t, by a
//   correction of category wrong-result, incomplete or misunderstood.
// - commits: SHAs from git-commit events (deduplicated, first occurrence wins).
//   verifiedBefore = a test/build/lint/typecheck event with failed === false earlier in
//   the same turn. followUp comes from gitOutcomes, which ignores later commits of the
//   same chat: iterating inside one chat is not a fix of finished work.
// - turnsToFirstVerifiedCommit: turn index of the first verified commit + 1, else null.
// - commitsChecked72h: commits whose closed 72 h window was inspected (followUp ≠ unknown);
//   commitsFixedOrReverted72h: those with followUp fixed or reverted.
// - repoRoot: from the first commit Git resolved, else rev-parse of record.cwd, else null.
// - model/effort: values used by the most turns (ties: first seen), else the record's
//   most counted models/efforts entry, else null.
// - week: ISO week of startedAt in America/Bogota.
// - taskType, hasSpec, specSignals, promptChars: from the first human prompt.
//   userTurns: number of human prompt messages.
// - tokens: record totals; compactions: record compactions; toolCalls/toolErrors: sums over turns.
// - coverage.gitChecked: every commit has a known follow-up (true when there are no commits).
import { detectCorrections, isDoneClaim, excerpt } from './corrections.mjs';
import { chatLabels, DEFAULT_LABEL_MODEL } from './claude-labels.mjs';
import { classifyTaskType, detectSpec } from './task-type.mjs';
import { gitOutcomes, repoRootOf, createGitCache, defaultExec } from './git-outcomes.mjs';

const VERIFY = new Set(['test', 'build', 'lint', 'typecheck']);
const FALSE_DONE_CATEGORIES = new Set(['wrong-result', 'incomplete', 'misunderstood']);
const WINDOW_MS = 72 * 3600 * 1000;
const LIMITS = { corrections: 200, falseDone: 100, commits: 500, notes: 20 };

export function isoWeek(iso, timeZone = 'America/Bogota') {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function mostFrequent(values, fallback) {
  const counts = new Map();
  for (const value of values) if (typeof value === 'string' && value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null, top = 0;
  for (const [value, count] of counts) if (count > top) { best = value; top = count; }
  if (best) return best;
  const sorted = [...(fallback ?? [])].filter(item => item?.value).sort((a, b) => b.turns - a.turns);
  return sorted[0]?.value ?? null;
}

// Git-commit SHAs of a record with the directory they ran in (event cwd, else chat cwd).
export function chatCommits(record) {
  const seen = new Set(), out = [];
  for (const turn of record.turns ?? []) for (const event of turn.events ?? []) {
    if (event.category !== 'git-commit') continue;
    for (const sha of event.commits ?? []) if (!seen.has(sha)) { seen.add(sha); out.push({ sha, cwd: event.cwd ?? record.cwd ?? null, chat: record.id }); }
  }
  return out;
}

const key = item => `${item.turn}\u0000${item.excerpt}`;

/**
 * Pure Layer 1 metrics for one chat record.
 * @param {object} record chat-record
 * @param {{git?: Map, labels?: {complete:boolean, model:string, byTurn:Map}|null, timeZone?: string, repoRoot?: string|null}} options
 *   git: gitOutcomes() map by SHA; labels: chatLabels() result, or null when model labels were not
 *   requested; repoRoot: rev-parse of record.cwd when no commit resolves.
 */
export function computeMetrics(record, { git = new Map(), labels = null, timeZone = 'America/Bogota', repoRoot = null } = {}) {
  const messages = record.userMessages ?? [];
  const turns = record.turns ?? [];
  const prompts = messages.filter(m => m.kind === 'prompt');
  const first = prompts[0];
  const spec = detectSpec(first?.text ?? '');
  const notes = [];

  // Corrections: model labels when the whole chat is labeled, else the rules.
  const claude = labels?.complete === true;
  const items = claude
    ? [...labels.byTurn].filter(([, label]) => label.correction).map(([turn, label]) => ({ turn, category: label.category, rule: 'claude', source: 'model', excerpt: excerpt(label.excerpt) }))
    : detectCorrections(record);
  items.sort((a, b) => a.turn - b.turn);
  const byCategory = {};
  for (const item of items) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;

  // Interruptions: one per distinct turn.
  const interrupted = new Set(messages.filter(m => m.kind === 'interrupt').map(m => m.turn));
  for (const turn of turns) if (turn.interrupted) interrupted.add(turn.i);

  // Closure claims and false "done".
  const corrections = new Map(items.map(item => [key(item), item]));
  const claims = turns.filter(turn => turn.agentFinal && isDoneClaim(turn.agentFinal.text));
  const falseItems = [];
  if (claude) {
    const claimed = new Set(claims.map(turn => turn.i));
    for (const [turn, label] of [...labels.byTurn].sort((a, b) => a[0] - b[0])) {
      const claim = turns.find(t => t.i === turn - 1 && t.agentFinal);
      if (!label.brokenDone || !claim) continue;
      if (!claimed.has(claim.i)) { claimed.add(claim.i); claims.push(claim); }
      falseItems.push({ claimTurn: claim.i, reportTurn: turn, claimExcerpt: excerpt(claim.agentFinal.text, 200), reportExcerpt: excerpt(label.excerpt, 200) });
    }
  }
  for (const claim of claude ? [] : claims) {
    const next = prompts.filter(m => m.turn > claim.i).slice(0, 2);
    for (const message of next) {
      const found = corrections.get(`${message.turn}\u0000${excerpt(message.text)}`);
      if (found && FALSE_DONE_CATEGORIES.has(found.category)) {
        falseItems.push({ claimTurn: claim.i, reportTurn: message.turn, claimExcerpt: excerpt(claim.agentFinal.text, 200), reportExcerpt: excerpt(message.text, 200) });
        break;
      }
    }
  }

  // Commits, verification and Git follow-up.
  const commits = [];
  const commitTimes = new Map();
  for (const turn of turns) {
    let verified = false;
    for (const event of turn.events ?? []) {
      if (VERIFY.has(event.category) && event.failed === false) verified = true;
      if (event.category !== 'git-commit') continue;
      for (const sha of event.commits ?? []) {
        if (commits.some(c => c.sha === sha)) continue;
        const outcome = git.get(sha);
        /** @type {Record<string, any>} */
        const commit = { sha, turn: turn.i, repoRoot: outcome?.repoRoot ?? null, verifiedBefore: verified, followUp: outcome?.followUp ?? 'unknown' };
        if (!['fixed', 'reverted', 'none', 'unknown'].includes(commit.followUp)) commit.followUp = 'unknown';
        if (outcome?.followUpSha) commit.followUpSha = outcome.followUpSha;
        if (Number.isFinite(outcome?.hoursToFollowUp)) commit.hoursToFollowUp = outcome.hoursToFollowUp;
        commits.push(commit);
        const at = Number.isFinite(outcome?.committedAt) ? outcome.committedAt * 1000 : Date.parse(turn.endedAt ?? turn.startedAt ?? '');
        if (Number.isFinite(at)) commitTimes.set(sha, at);
      }
    }
  }
  const firstVerified = commits.find(c => c.verifiedBefore);
  const checked = commits.filter(c => c.followUp !== 'unknown');
  const unknownCommits = commits.length - checked.length;
  if (unknownCommits) {
    const young = commits.filter(c => c.followUp === 'unknown' && git.get(c.sha)?.reason === 'window-open').length;
    notes.push(`${unknownCommits} of ${commits.length} commits have no Git follow-up${young ? ` (${young} younger than 72 h)` : ''}.`);
  }

  if (labels && !claude) notes.push('Model labels incomplete for this chat: corrections come from the deterministic rules.');
  if (!record.coverage?.complete) notes.push('Transcript coverage is partial.');
  if (items.length > LIMITS.corrections) notes.push(`Correction items capped at ${LIMITS.corrections} of ${items.length}.`);
  if (falseItems.length > LIMITS.falseDone) notes.push(`False done items capped at ${LIMITS.falseDone} of ${falseItems.length}.`);
  if (commits.length > LIMITS.commits) notes.push(`Commits capped at ${LIMITS.commits} of ${commits.length}.`);

  const pass = { status: !labels ? 'skipped' : claude ? 'ok' : 'missing' };
  if (labels && typeof labels.model === 'string' && labels.model) pass.model = labels.model.slice(0, 80);
  if (claude) pass.added = items.length;

  const coverage = { transcriptComplete: Boolean(record.coverage?.complete), gitChecked: unknownCommits === 0 };
  if (notes.length) coverage.notes = notes.slice(0, LIMITS.notes).map(note => note.slice(0, 200));

  return {
    schemaVersion: 1,
    id: record.id,
    provider: record.provider,
    project: record.project ?? null,
    repoRoot: commits.find(c => c.repoRoot)?.repoRoot ?? repoRoot ?? null,
    model: mostFrequent(turns.map(t => t.model), record.models),
    effort: mostFrequent(turns.map(t => t.effort), record.efforts),
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    week: isoWeek(record.startedAt, timeZone),
    automated: Boolean(record.automated),
    taskType: classifyTaskType(first?.text ?? ''),
    hasSpec: spec.hasSpec,
    specSignals: spec.signals,
    promptChars: first?.chars ?? 0,
    userTurns: prompts.length,
    corrections: { count: items.length, byCategory, items: items.slice(0, LIMITS.corrections) },
    interruptions: interrupted.size,
    doneClaims: claims.length,
    falseDone: { count: falseItems.length, items: falseItems.slice(0, LIMITS.falseDone) },
    commits: commits.slice(0, LIMITS.commits),
    turnsToFirstVerifiedCommit: firstVerified ? firstVerified.turn + 1 : null,
    commitsChecked72h: checked.length,
    commitsFixedOrReverted72h: checked.filter(c => c.followUp === 'fixed' || c.followUp === 'reverted').length,
    tokens: { ...record.tokens },
    compactions: (record.compactions ?? []).length,
    toolCalls: turns.reduce((sum, t) => sum + (t.toolCalls ?? 0), 0),
    toolErrors: turns.reduce((sum, t) => sum + (t.toolErrors ?? 0), 0),
    modelPass: pass,
    coverage,
  };
}

/**
 * Computes and saves metrics for every stored chat, in batches.
 * - git: one gitOutcomes call per batch (shared cache, per-call timeouts and one overall
 *   deadline of gitBudgetMs), plus rev-parse of each chat cwd when no commit resolves.
 * - labels: use the cached model labels (labelAll fills them) for interactive chats;
 *   a chat with any unlabeled message falls back to the rules.
 * @returns {Promise<{chats:number, metrics:number, gitChecked:number, labels:{status:string, claude:number, rules:number, model?:string}}>}
 */
export async function computeAll({
  store, git = true, labels = false, labelModel = DEFAULT_LABEL_MODEL, exec = defaultExec, signal, onProgress,
  now = Date.now(), timeoutMs = 10000, gitBudgetMs = 600000, batchSize = 200,
} = {}) {
  const cache = createGitCache();
  const gitDeadline = Date.now() + gitBudgetMs;
  const summary = { chats: 0, metrics: 0, gitChecked: 0, labels: { status: labels ? 'ok' : 'skipped', claude: 0, rules: 0 } };
  if (labels) summary.labels.model = labelModel;
  let batch = [];

  const flush = async () => {
    const outcomes = git ? await gitOutcomes(batch.flatMap(chatCommits), { exec, timeoutMs, now, cache, deadline: gitDeadline }) : new Map();
    for (const record of batch) {
      signal?.throwIfAborted();
      const chat = labels && !record.automated ? chatLabels(record, store, labelModel) : null;
      if (chat) summary.labels[chat.complete ? 'claude' : 'rules'] += 1;
      const hasRoot = chatCommits(record).some(c => outcomes.get(c.sha)?.repoRoot);
      const repoRoot = git && !hasRoot ? await repoRootOf(record.cwd, { exec, timeoutMs, cache, deadline: gitDeadline }) : null;
      const metrics = computeMetrics(record, { git: outcomes, labels: chat, repoRoot });
      store.saveMetrics(metrics);
      summary.metrics += 1;
      summary.gitChecked += metrics.commitsChecked72h;
    }
    summary.chats += batch.length;
    batch = [];
    onProgress?.({ phase: 'metrics', done: summary.chats });
  };

  for (const record of store.chats()) {
    signal?.throwIfAborted();
    batch.push(record);
    if (batch.length >= batchSize) await flush();
  }
  if (batch.length) await flush();
  if (labels) {
    const { claude, rules } = summary.labels;
    summary.labels.status = rules === 0 ? 'ok' : claude === 0 ? 'missing' : 'partial';
  }
  return summary;
}
