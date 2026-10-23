// E2 Layer 1 metrics: golden sample, crafted records for each definition, and
// computeAll over an isolated store with fake exec and cached labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeMetrics, computeAll, isoWeek, chatCommits } from '../evals/metrics.mjs';
import { assertValid } from '../evals/schema.mjs';
import { openStore } from '../evals/store.mjs';
import { DEFAULT_LABEL_MODEL, labelItems, labelKey } from '../evals/claude-labels.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/evals/${name}.sample.json`, import.meta.url), 'utf8'));
const ROOT = 'C:/Users/example/Projects/workspace';
const ZERO = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
const full = sha => sha.padEnd(40, '0');

function turn(i, { events = [], final = null, interrupted = false, model = 'm1', effort = 'high', at = `2026-10-01T1${i % 10}:00:00.000Z` } = {}) {
  return { i, startedAt: at, endedAt: at, userChars: 1, model, effort, interrupted, toolCalls: 2, toolErrors: 1, toolCounts: {}, events,
    tokens: { ...ZERO }, agentFinal: final === null ? null : { text: final, chars: final.length } };
}
function record({ id = 'claude:crafted', messages, turns, startedAt = '2026-10-01T10:00:00.000Z', automated = false, cwd = null } = {}) {
  const base = fixture('chat-record');
  return { ...base, id, sessionId: id.split(':')[1], cwd, startedAt, automated, compactions: [], turns,
    userMessages: messages.map(([t, kind, text]) => ({ turn: t, at: null, kind, text, chars: text.length })) };
}

test('golden: the shared sample record yields the shared sample metrics', () => {
  const git = new Map([['a1b2c3d', { repoRoot: ROOT, fullSha: full('a1b2c3d'), followUp: 'none' }]]);
  const metrics = computeMetrics(fixture('chat-record'), { git });
  assertValid('chat-metrics', metrics);
  assert.deepEqual(metrics, fixture('chat-metrics'));
});

test('falseDone: a claim followed by a core correction within the next two prompts', () => {
  const r = record({
    messages: [[0, 'prompt', 'Build the page'], [1, 'prompt', 'gracias'], [2, 'prompt', 'falta el footer'],
      [3, 'prompt', 'ok'], [4, 'prompt', 'great'], [5, 'prompt', 'no funciona el menú'], [6, 'prompt', 'en español por favor']],
    turns: [turn(0, { final: 'Listo, quedó.' }), turn(1), turn(2, { final: 'Done.' }), turn(3), turn(4), turn(5, { final: 'Fixed and verified.' }), turn(6)],
  });
  const m = assertValid('chat-metrics', computeMetrics(r));
  assert.equal(m.doneClaims, 3);
  assert.equal(m.corrections.count, 3);
  assert.deepEqual(m.corrections.byCategory, { incomplete: 1, 'wrong-result': 1, 'language-style': 1 });
  // Claim at 2 is followed by "ok" and "great" before the report at 5; claim at 5 by a style correction.
  assert.deepEqual(m.falseDone, { count: 1, items: [{ claimTurn: 0, reportTurn: 2, claimExcerpt: 'Listo, quedó.', reportExcerpt: 'falta el footer' }] });
});

test('verifiedBefore, dedupe and turnsToFirstVerifiedCommit', () => {
  const commit = sha => ({ category: 'git-commit', failed: false, commits: [sha], cwd: null });
  const r = record({
    messages: [[0, 'prompt', 'go'], [1, 'prompt', 'more'], [2, 'prompt', 'more']],
    turns: [
      turn(0, { events: [commit('aaaaaaa'), { category: 'test', failed: true, cwd: null }, commit('bbbbbbb'), { category: 'lint', failed: null, cwd: null }, commit('ccccccc')] }),
      turn(1, { events: [{ category: 'deploy', failed: false, cwd: null }, commit('ddddddd'), { category: 'build', failed: false, cwd: null }, commit('aaaaaaa')] }),
      turn(2, { events: [{ category: 'typecheck', failed: false, cwd: null }, commit('eeeeeee')] }),
    ],
  });
  const m = assertValid('chat-metrics', computeMetrics(r));
  assert.deepEqual(m.commits.map(c => [c.sha, c.turn, c.verifiedBefore, c.followUp]),
    [['aaaaaaa', 0, false, 'unknown'], ['bbbbbbb', 0, false, 'unknown'], ['ccccccc', 0, false, 'unknown'], ['ddddddd', 1, false, 'unknown'], ['eeeeeee', 2, true, 'unknown']]);
  assert.equal(m.turnsToFirstVerifiedCommit, 3);
  assert.equal(m.commitsChecked72h, 0);
  assert.equal(m.coverage.gitChecked, false);
  assert.match(m.coverage.notes[0], /5 of 5 commits/);
  assert.equal(computeMetrics({ ...r, turns: r.turns.slice(0, 2) }).turnsToFirstVerifiedCommit, null);
  const first = computeMetrics({ ...r, turns: [turn(0, { events: [{ category: 'test', failed: false, cwd: null }, commit('fffffff')] })] });
  assert.equal(first.turnsToFirstVerifiedCommit, 1);
  assert.deepEqual(chatCommits({ ...r, cwd: 'X' }).map(c => c.cwd), ['X', 'X', 'X', 'X', 'X']);
});

test('interruptions count distinct turns from interrupt messages and interrupted turns', () => {
  const r = record({
    messages: [[0, 'prompt', 'go'], [1, 'prompt', 'and'], [1, 'interrupt', ''], [3, 'prompt', 'x'], [4, 'interrupt', '']],
    turns: [turn(0), turn(1, { interrupted: true }), turn(2), turn(3, { interrupted: true }), turn(4)],
  });
  assert.equal(computeMetrics(r).interruptions, 3);
  assert.equal(computeMetrics({ ...r, userMessages: r.userMessages.filter(m => m.kind !== 'interrupt') }).interruptions, 2);
});

test('git follow-ups: counts and open windows; a later commit of the same chat is not a fix', () => {
  const commit = sha => ({ category: 'git-commit', failed: false, commits: [sha], cwd: null });
  const r = record({
    messages: [[0, 'prompt', 'go'], [1, 'prompt', 'no funciona el login'], [2, 'prompt', 'ok']],
    turns: [turn(0, { events: [commit('1111111'), commit('2222222')] }), turn(1, { events: [commit('3333333')] }), turn(2, { events: [commit('4444444')] })],
  });
  const at = Date.parse('2026-10-01T10:00:00Z') / 1000;
  const git = new Map([
    ['1111111', { repoRoot: ROOT, fullSha: full('1111111'), followUp: 'none', committedAt: at }],
    ['2222222', { repoRoot: ROOT, fullSha: full('2222222'), followUp: 'reverted', followUpSha: full('9999999'), hoursToFollowUp: 2.5, committedAt: at }],
    ['3333333', { repoRoot: ROOT, fullSha: full('3333333'), followUp: 'fixed', followUpSha: full('8888888'), hoursToFollowUp: 5, committedAt: at + 3600 }],
    ['4444444', { repoRoot: ROOT, fullSha: full('4444444'), followUp: 'unknown', reason: 'window-open', committedAt: at + 7200 }],
  ]);
  const m = assertValid('chat-metrics', computeMetrics(r, { git }));
  // 1111111 stays 'none' although the chat committed 3333333 after a correction: same-chat iteration.
  assert.deepEqual(m.commits.map(c => [c.sha, c.followUp, c.followUpSha ?? null, c.hoursToFollowUp ?? null]), [
    ['1111111', 'none', null, null], ['2222222', 'reverted', full('9999999'), 2.5], ['3333333', 'fixed', full('8888888'), 5], ['4444444', 'unknown', null, null]]);
  assert.equal(m.commitsChecked72h, 3);
  assert.equal(m.commitsFixedOrReverted72h, 2);
  assert.equal(m.repoRoot, ROOT);
  assert.match(m.coverage.notes[0], /1 of 4 commits .*1 younger than 72 h/);
  assert.equal(computeMetrics(record({ messages: [[0, 'prompt', 'x']], turns: [turn(0)] }), { repoRoot: '/r' }).repoRoot, '/r');
  assert.deepEqual(chatCommits(r).map(c => c.chat), ['claude:crafted', 'claude:crafted', 'claude:crafted', 'claude:crafted']);
});

test('model/effort majority, Bogota ISO week, sums and spec', () => {
  const r = record({
    startedAt: '2026-10-19T03:00:00.000Z', // Sunday 22:00 in Bogota: week 42, not 43
    messages: [[0, 'prompt', 'Review this PR. Requirements: R1 x. Acceptance: tests pass.'], [1, 'prompt', 'the spacing feels off'], [1, 'command', '/compact']],
    turns: [turn(0, { model: 'a', effort: null }), turn(1, { model: 'b', effort: 'low' }), turn(2, { model: 'b', effort: null })],
  });
  const m = assertValid('chat-metrics', computeMetrics(r));
  assert.deepEqual([m.model, m.effort, m.week, m.taskType, m.hasSpec, m.userTurns, m.promptChars, m.toolCalls, m.toolErrors],
    ['b', 'low', '2026-W42', 'review', true, 2, 59, 6, 3]);
  assert.deepEqual(m.modelPass, { status: 'skipped' });
  assert.equal(isoWeek('2026-10-19T14:00:00.000Z'), '2026-W43');
  assert.equal(isoWeek('2027-01-01T12:00:00.000Z'), '2026-W53');
  assert.equal(isoWeek(null), null);
});

test('Claude labels replace the rules for corrections and broken done; incomplete labels fall back to the rules', () => {
  const r = record({
    messages: [[0, 'prompt', 'Build the page'], [1, 'prompt', 'qué falta para cerrar?'], [2, 'prompt', 'the spacing feels off, it is not what I wanted'], [3, 'prompt', 'gracias']],
    turns: [turn(0, { final: 'Here is a plan.' }), turn(1, { final: 'The page is ready.' }), turn(2, { final: 'Spacing fixed.' }), turn(3)],
  });
  const label = (correction, category = null, brokenDone = false, excerpt = 'x') => ({ correction, category, brokenDone, excerpt });
  const byTurn = new Map([[1, label(false)], [2, label(true, 'misunderstood', true, 'the spacing feels off, it is not what I wanted')], [3, label(false)]]);
  const m = assertValid('chat-metrics', computeMetrics(r, { labels: { complete: true, model: 'claude-sonnet-5-5', byTurn } }));
  assert.deepEqual(m.corrections.items, [{ turn: 2, category: 'misunderstood', rule: 'claude', source: 'model', excerpt: 'the spacing feels off, it is not what I wanted' }]);
  assert.deepEqual(m.modelPass, { status: 'ok', model: 'claude-sonnet-5-5', added: 1 });
  // "The page is ready." is not a rule claim; the broken done report makes it one.
  assert.equal(m.doneClaims, 2);
  assert.deepEqual(m.falseDone.items.map(i => [i.claimTurn, i.reportTurn]), [[1, 2]]);

  const partial = assertValid('chat-metrics', computeMetrics(r, { labels: { complete: false, model: 'claude-sonnet-5-5', byTurn } }));
  assert.deepEqual(partial.modelPass, { status: 'missing', model: 'claude-sonnet-5-5' });
  assert.equal(partial.corrections.items[0]?.source ?? 'rule', 'rule');
  assert.ok(partial.coverage.notes.some(n => /Model labels incomplete/.test(n)));
});

function seedStore(home) {
  const store = openStore({ home });
  const messages = [[0, 'prompt', 'Build it'], [1, 'prompt', 'hmm, the spacing feels off']];
  store.saveChat(record({ id: 'claude:a', startedAt: '2026-10-01T10:00:00.000Z', messages, turns: [turn(0), turn(1)] }));
  store.saveChat(record({ id: 'claude:b', startedAt: '2026-10-02T10:00:00.000Z', automated: true, messages, turns: [turn(0), turn(1)] }));
  store.saveChat(record({ id: 'codex:c', startedAt: '2026-10-03T10:00:00.000Z', messages, turns: [turn(0), turn(1)] }));
  return store;
}

test('computeAll uses cached model labels for interactive chats only and falls back without them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-metrics-'));
  const store = seedStore(home);
  try {
    const progress = [];
    const none = await computeAll({ store, git: false, labels: true, onProgress: p => progress.push(p) });
    assert.deepEqual(none, { chats: 3, metrics: 3, gitChecked: 0, labels: { status: 'missing', claude: 0, rules: 2, model: DEFAULT_LABEL_MODEL } });
    assert.deepEqual(['claude:a', 'claude:b', 'codex:c'].map(id => store.metricsFor(id).modelPass.status), ['missing', 'skipped', 'missing']);
    assert.deepEqual(progress.at(-1), { phase: 'metrics', done: 3 });

    const item = labelItems(store.chat('codex:c'))[0];
    store.saveLabels([{ key: labelKey(item, DEFAULT_LABEL_MODEL), model: DEFAULT_LABEL_MODEL, label: { correction: true, category: 'other', brokenDone: false } }]);
    const ok = await computeAll({ store, git: false, labels: true });
    // claude:a has the same message and previous reply, so the same cached label covers it.
    assert.deepEqual(ok.labels, { status: 'ok', claude: 2, rules: 0, model: DEFAULT_LABEL_MODEL });
    assert.deepEqual(store.metricsFor('codex:c').corrections.items.map(i => [i.source, i.rule, i.category]), [['model', 'claude', 'other']]);
    // Labels of another model are a different cache: the Claude labeler has none here.
    const other = await computeAll({ store, git: false, labels: true, labelModel: 'claude-sonnet-5-5' });
    assert.deepEqual([other.labels.status, other.labels.claude], ['missing', 0]);
    const skipped = await computeAll({ store, git: false });
    assert.equal(skipped.labels.status, 'skipped');
    assert.equal(store.metricsFor('claude:a').modelPass.status, 'skipped');
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('computeAll batches git outcomes through the injected exec and resolves the chat cwd', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-metrics-git-'));
  const store = openStore({ home });
  try {
    const commitEvent = { category: 'git-commit', failed: false, commits: ['abc1234'], cwd: null };
    store.saveChat(record({ id: 'claude:g1', cwd: home, messages: [[0, 'prompt', 'go']], turns: [turn(0, { events: [commitEvent] })] }));
    store.saveChat(record({ id: 'claude:g2', cwd: home, startedAt: '2026-10-02T10:00:00.000Z', messages: [[0, 'prompt', 'go']], turns: [turn(0)] }));
    const calls = [];
    const exec = async args => {
      calls.push(args[0]);
      if (args[0] === 'rev-parse') return '/fake/repo\n';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'show') return `${full('abc1234')}\x1f${Date.parse('2026-10-01T10:00:00Z') / 1000}\n`;
      if (args[0] === 'log') return '';
      throw new Error(`unexpected ${args[0]}`);
    };
    const result = await computeAll({ store, exec, now: Date.parse('2026-10-20T00:00:00Z') });
    assert.equal(result.gitChecked, 1);
    assert.deepEqual(store.metricsFor('claude:g1').commits.map(c => [c.repoRoot, c.followUp]), [['/fake/repo', 'none']]);
    assert.equal(store.metricsFor('claude:g2').repoRoot, '/fake/repo');
    assert.equal(calls.filter(c => c === 'rev-parse').length, 1, 'cwd roots are cached');
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
