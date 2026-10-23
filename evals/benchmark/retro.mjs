// E4b retrospective benchmark: real Layer 1 outcomes over 100% of interactive
// history, grouped by model, effort, spec use, task type, project and provider.
// No re-runs, no inference, no cost. Rows follow report.schema.json#/$defs/modelRow.
import { median, MIN_N } from '../stats.mjs';

export const DIMENSIONS = ['model', 'effort', 'spec', 'taskType', 'project', 'provider'];

// Top-level folder of a display project: '' is the workspace root, null is unknown.
export function topFolder(project) {
  if (project === null || project === undefined) return 'unknown';
  const first = String(project).split(/[\\/]/).find(Boolean);
  return first ?? '(root)';
}

const VALUE_OF = {
  model: m => m.model ?? 'unknown',
  effort: m => m.effort ?? 'unknown',
  spec: m => m.hasSpec ? 'with spec' : 'without spec',
  taskType: m => m.taskType,
  project: m => topFolder(m.project),
  provider: m => m.provider,
};

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (num, den, scale = 1) => den > 0 ? round(num / den * scale) : null;

export function retrospective(metricsIterable, { minN = MIN_N } = {}) {
  const groups = new Map();
  for (const m of metricsIterable) {
    if (m.automated) continue;
    for (const dimension of DIMENSIONS) {
      const value = String(VALUE_OF[dimension](m)).slice(0, 120);
      const key = `${dimension}\n${value}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { dimension, value, chats: 0, corrections: 0, userTurns: 0, falseDone: 0, doneClaims: 0, fixed: 0, checked: 0, turns: [] });
      g.chats++;
      g.corrections += m.corrections.count;
      g.userTurns += m.userTurns;
      g.falseDone += m.falseDone.count;
      g.doneClaims += m.doneClaims;
      g.fixed += m.commitsFixedOrReverted72h;
      g.checked += m.commitsChecked72h;
      if (m.turnsToFirstVerifiedCommit !== null) g.turns.push(m.turnsToFirstVerifiedCommit);
    }
  }
  return [...groups.values()].map(g => ({
    dimension: g.dimension,
    value: g.value,
    chats: g.chats,
    correctionRate: ratio(g.corrections, g.userTurns, 10),
    // A rate over fewer than minN claims or checked commits is shown as missing, not as 0% or 100%.
    falseDoneRate: g.doneClaims >= minN ? ratio(g.falseDone, g.doneClaims) : null,
    fixRevertRate: g.checked >= minN ? ratio(g.fixed, g.checked) : null,
    medianTurnsToVerifiedCommit: median(g.turns),
    insufficient: g.chats < minN,
  })).sort((a, b) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension) || b.chats - a.chats || a.value.localeCompare(b.value));
}
