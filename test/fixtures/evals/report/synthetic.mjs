// Synthetic chat-metrics records for the E6 report tests. No real transcript text.
// Every record is schema-valid; repoRoot uses a fake path so tests can prove it never
// reaches the report.
export const FAKE_ROOT = 'C:/Users/example/Desktop/synthetic-repo';

let serial = 0;

export function chatMetrics(overrides = {}) {
  const n = ++serial;
  const { corrections = [], falseDone = 0, commits = [], ...rest } = overrides;
  const byCategory = {};
  for (const item of corrections) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  return {
    schemaVersion: 1,
    id: `claude:synthetic-${String(n).padStart(4, '0')}`,
    provider: 'claude',
    project: 'apps/synthetic',
    repoRoot: FAKE_ROOT,
    model: 'claude-opus-5-5',
    effort: 'high',
    startedAt: '2026-10-20T15:00:00.000Z',
    endedAt: '2026-10-20T16:00:00.000Z',
    week: '2026-W43',
    automated: false,
    taskType: 'feature',
    hasSpec: true,
    specSignals: [],
    promptChars: 400,
    userTurns: 1,
    corrections: {
      count: corrections.length, byCategory,
      items: corrections.map((item, turn) => ({ turn, category: item.category, rule: 'synthetic-rule', source: 'rule', excerpt: item.excerpt ?? 'synthetic correction' })),
    },
    interruptions: 0,
    doneClaims: 0,
    falseDone: { count: falseDone, items: [] },
    commits: commits.map((verifiedBefore, turn) => ({ sha: 'abcdef1', turn, repoRoot: FAKE_ROOT, verifiedBefore, followUp: 'none' })),
    turnsToFirstVerifiedCommit: null,
    commitsChecked72h: 0,
    commitsFixedOrReverted72h: 0,
    tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
    compactions: 0,
    toolCalls: 0,
    toolErrors: 0,
    modelPass: { status: 'skipped' },
    coverage: { transcriptComplete: true, gitChecked: true },
    ...rest,
  };
}

export const many = (count, overrides = {}) => Array.from({ length: count }, (_, i) =>
  chatMetrics(typeof overrides === 'function' ? overrides(i) : overrides));

// Instants inside the week of Oct 19-25, 2026 (Bogota) and the week before.
export const NOW = new Date('2026-10-25T20:00:00.000Z');
export const THIS_WEEK = '2026-10-20T15:00:00.000Z';
export const LAST_WEEK = '2026-10-13T15:00:00.000Z';
export const OLDER = '2026-09-01T15:00:00.000Z';
