// E4c runner: dry runs never touch Relay, live runs with a fake Relay clone real temporary
// repos, run real hidden node:test checks, checkpoint every pair and resume without re-spending.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validate } from '../evals/schema.mjs';
import { deriveChecks } from '../evals/benchmark/hidden-checks.mjs';
import { runBenchmark, summarizeRuns, readCheckpoint, pairKey, DEFAULT_VARIANTS } from '../evals/benchmark/runner.mjs';
import { git, commit, greetingRepo, BILINGUAL } from './fixtures/evals/suite/git-repo.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/evals/${name}.sample.json`, import.meta.url), 'utf8'));
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const hex = n => crypto.createHash('sha256').update(`runner-${n}`).digest('hex').slice(0, 16);

async function suiteEntry(n, repo) {
  const { suite: _s, ...base } = fixture('task');
  const task = { ...base, id: `task:${hex(n)}`, repoRoot: repo.root, baseCommit: repo.base, finalCommit: repo.final, requirements: [{ id: 'R1', literal: 'Spanish', status: null }] };
  const { visible, hidden } = await deriveChecks({ task });
  return { ...task, suite: { frozenAt: '2026-10-22T20:00:00.000Z', prompt: `Synthetic prompt ${n}: add a Spanish greeting.`, visibleChecks: visible, hiddenChecks: hidden, split: 'dev', stratum: 'feature|claude|spec' } };
}
const fakeEntry = n => ({ id: `task:${hex(n)}`, repoRoot: 'C:/nowhere', baseCommit: 'a'.repeat(40), outcome: { userTurns: 2 }, suite: { visibleChecks: [{ argv: ['npm', 'test'], origin: 'existing-test' }], hiddenChecks: [], split: 'dev', stratum: 's' } });
const snapshot = root => ({ refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)'), head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'symbolic-ref', 'HEAD'), status: git(root, 'status', '--porcelain', '--untracked-files=all') });

// Fake Relay: simulates the worker by committing in the clone handed over as the project.
function fakeRelay(plan) {
  const calls = [], missions = new Map();
  const relay = {
    async refine(input) { calls.push(['refine', input.goal]); return { status: 'ready', goal: `Refined: ${input.goal}`, acceptance: 'Spanish works.' }; },
    async create(contract) {
      calls.push(['create', contract.title]);
      const [, taskId, variant] = /^Benchmark (task:[a-f0-9]+) \((.+)\)$/.exec(contract.title);
      const behavior = plan[`${taskId}|${variant}`];
      assert.equal(contract.tasks.length, 1);
      assert.deepEqual(contract.checks, [['npm', 'test']], 'only visible checks reach the worker');
      assert.ok(!JSON.stringify(contract).includes('greet-es.test.mjs'), 'hidden test names never reach the worker');
      if (behavior.throws) throw new Error('fake relay failure');
      if (behavior.solve) commit(contract.project, { 'src/greet.mjs': BILINGUAL }, 'Worker change');
      else commit(contract.project, { 'README.md': 'no real change\n' }, 'Worker change');
      const id = crypto.randomUUID();
      missions.set(id, { status: 'ready', finalChecksPassed: true, verifiedHead: git(contract.project, 'rev-parse', 'HEAD'), turnsUsed: 2,
        events: behavior.retry ? [{ at: 1, text: 'Explicit retry of task. Previous state is preserved.' }] : [], tasks: [{ id: 'task', status: 'completed' }],
        project: contract.project, refinedPrompt: contract.tasks[0].prompt });
      return { id };
    },
    async status(id) { calls.push(['status', id]); return missions.get(id); },
    async waitForTerminal(id, { deadline }) { calls.push(['wait', id]); assert.ok(Number.isFinite(deadline)); return missions.get(id); },
  };
  return { relay, calls, missions };
}
const throwingRelay = () => {
  const calls = [];
  const fail = name => async () => { calls.push(name); throw new Error(`relay.${name} must not be called`); };
  return { calls, relay: { refine: fail('refine'), create: fail('create'), status: fail('status'), waitForTerminal: fail('waitForTerminal') } };
};

test('dryRun returns the plan and estimate without calling relay or writing a checkpoint', async () => {
  const dir = tmp('relay-evals-dry-');
  try {
    const { relay, calls } = throwingRelay();
    const checkpointFile = path.join(dir, 'cp.jsonl');
    const out = await runBenchmark({ entries: [fakeEntry(1), fakeEntry(2)], relay, workDir: path.join(dir, 'work'), checkpointFile });
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.plan.map(p => [p.variant, p.state]), [['claude-high', 'planned'], ['claude-high-spec', 'planned'], ['claude-high', 'planned'], ['claude-high-spec', 'planned']]);
    assert.deepEqual(out.estimate, { turns: 2 * (2 * 2 + 1), days: 0.1, turnsPerDay: 128 });
    assert.deepEqual(calls, []);
    assert.ok(!fs.existsSync(checkpointFile) && !fs.existsSync(path.join(dir, 'work')));
    assert.deepEqual(DEFAULT_VARIANTS.map(v => [v.id, v.provider, v.model, v.effort, v.spec]), [['claude-high', 'claude', 'claude-opus-5-5', 'high', false], ['claude-high-spec', 'claude', 'claude-opus-5-5', 'high', true]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses more than 10 tasks x 2 variants without allowFull; Fable is blocked', async () => {
  const dir = tmp('relay-evals-cap-');
  try {
    const base = { relay: throwingRelay().relay, workDir: dir, checkpointFile: path.join(dir, 'cp.jsonl') };
    const eleven = Array.from({ length: 11 }, (_, n) => fakeEntry(n));
    await assert.rejects(runBenchmark({ ...base, entries: eleven }), /Refusing more than 10 tasks x 2 variants/);
    await assert.rejects(runBenchmark({ ...base, entries: eleven, dryRun: false }), /Refusing/);
    const three = [...DEFAULT_VARIANTS, { id: 'codex-high', provider: 'codex', model: '', effort: 'high' }];
    await assert.rejects(runBenchmark({ ...base, entries: [fakeEntry(1)], variants: three }), /Refusing/);
    const full = await runBenchmark({ ...base, entries: eleven, variants: three, allowFull: true });
    assert.equal(full.plan.length, 33);
    await assert.rejects(runBenchmark({ ...base, entries: [fakeEntry(1)], variants: [{ id: 'fable', provider: 'claude', model: 'claude-fable-5-1' }] }), /Fable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live run: clones read-only, runs hidden checks, records every pair, continues after a failure and resumes', async () => {
  const dir = tmp('relay-evals-live-');
  try {
    const repo = greetingRepo(path.join(dir, 'source'));
    const before = snapshot(repo.root);
    const entries = [await suiteEntry(1, repo), await suiteEntry(2, repo)];
    const [t1, t2] = entries.map(e => e.id);
    const { relay, calls, missions } = fakeRelay({
      [`${t1}|claude-high`]: { solve: true },
      [`${t1}|claude-high-spec`]: { solve: false },
      [`${t2}|claude-high`]: { throws: true },
      [`${t2}|claude-high-spec`]: { solve: true, retry: true },
    });
    const workDir = path.join(dir, 'work'), checkpointFile = path.join(dir, 'state', 'cp.jsonl');
    let clock = Date.parse('2026-10-22T20:00:00.000Z');
    const now = () => (clock += 30_000);
    const out = await runBenchmark({ entries, relay, workDir, checkpointFile, now, dryRun: false });
    const byKey = Object.fromEntries(out.results.map(r => [pairKey(r.task, r.variant), r]));
    const good = byKey[`${t1}|claude-high`], wrong = byKey[`${t1}|claude-high-spec`], failed = byKey[`${t2}|claude-high`], retried = byKey[`${t2}|claude-high-spec`];
    assert.equal(good.status, 'passed');
    assert.equal(good.passedFirstTry, true);
    assert.deepEqual(good.hiddenChecks.map(c => [c.origin, c.status]), [['final-state-test', 'passed'], ['fix-commit', 'passed']]);
    assert.equal(good.pendingJudgeChecks, 1);
    assert.deepEqual([good.turns, good.tokens, good.interventions], [2, null, 0]);
    assert.ok(good.minutes > 0);
    assert.equal(wrong.status, 'failed', 'visible checks passed but the hidden Spanish test fails');
    assert.equal(wrong.passedFirstTry, false);
    assert.equal(wrong.turns, 3, 'refine turn counts for the spec variant');
    assert.equal(failed.status, 'error');
    assert.match(failed.detail, /fake relay failure/);
    assert.equal(retried.status, 'passed');
    assert.equal(retried.passedFirstTry, false, 'a retry is a human intervention');
    assert.equal(retried.interventions, 1);
    assert.equal(calls.filter(c => c[0] === 'refine').length, 2);
    assert.ok([...missions.values()].every(m => m.refinedPrompt.startsWith('Refined: ') === m.project.endsWith('-spec')));

    // Checkpoint: one start and one result per pair, written as JSONL.
    const checkpoint = readCheckpoint(checkpointFile);
    assert.equal(checkpoint.results.size, 4);
    assert.equal(checkpoint.started.size, 4);

    // The clone sits at the base commit and the accepted final state is not reachable from it.
    const clone = path.join(workDir, `${hex(1)}-claude-high`);
    assert.equal(git(clone, 'rev-parse', 'HEAD~1'), repo.base);
    assert.throws(() => git(clone, 'cat-file', '-e', `${repo.final}^{commit}`));
    assert.equal(git(clone, 'for-each-ref', '--format=%(refname)'), 'refs/heads/relay-evals/bench');
    // The source repository is untouched.
    assert.deepEqual(snapshot(repo.root), before);

    // Resume: finished pairs are never re-spent.
    const again = throwingRelay();
    const resumed = await runBenchmark({ entries, relay: again.relay, workDir, checkpointFile, now, dryRun: false });
    assert.deepEqual(again.calls, []);
    assert.deepEqual(resumed.results.map(r => r.status).sort(), ['error', 'failed', 'passed', 'passed']);
    const dry = await runBenchmark({ entries, workDir, checkpointFile });
    assert.ok(dry.plan.every(p => p.state === 'done'));

    // report.benchmark.runs[] and estimate validate against the report schema.
    const runs = summarizeRuns(out.results);
    assert.deepEqual(runs.map(r => [r.variant, r.tasks, r.passedFirstTry, r.medianTurns, r.medianTokens, r.interventions]),
      [['claude-high', 1, 1, 2, null, 0], ['claude-high-spec', 2, 0, 3, null, 1]]);
    const report = fixture('report');
    assert.deepEqual(validate('report', { ...report, benchmark: { ...report.benchmark, runs, estimate: out.estimate } }), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted pair is not re-spent automatically', async () => {
  const dir = tmp('relay-evals-interrupted-');
  try {
    const entries = [fakeEntry(1)];
    const checkpointFile = path.join(dir, 'cp.jsonl');
    fs.writeFileSync(checkpointFile, `${JSON.stringify({ type: 'start', key: pairKey(entries[0].id, 'claude-high') })}\n${JSON.stringify({ type: 'result', key: pairKey(entries[0].id, 'claude-high-spec'), result: { task: entries[0].id, variant: 'claude-high-spec', status: 'failed', passedFirstTry: false, turns: 1, minutes: 1, tokens: null, interventions: 0 } })}\n{"type":"res`);
    const { relay, calls } = throwingRelay();
    const out = await runBenchmark({ entries, relay, workDir: path.join(dir, 'work'), checkpointFile, dryRun: false });
    assert.deepEqual(calls, []);
    assert.deepEqual(out.results.map(r => r.status), ['interrupted', 'failed']);
    assert.ok(!fs.existsSync(path.join(dir, 'work')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
