// E4c frozen suite: check derivation from real temporary git repos, deterministic
// freezing with a stratified holdout, turn estimates and the capped stratified sample.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertValid } from '../evals/schema.mjs';
import { openStore } from '../evals/store.mjs';
import { normalizeMissionSpec } from '../server/missions.mjs';
import { deriveChecks, isRelayCheckArgv, isTestFile, FIX_SUBJECT } from '../evals/benchmark/hidden-checks.mjs';
import { freezeSuite, readSuite, estimateSuite, sampleTasks, assignSplits, liveBlocker } from '../evals/benchmark/suite.mjs';
import { git, commit, greetingRepo } from './fixtures/evals/suite/git-repo.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/evals/${name}.sample.json`, import.meta.url), 'utf8'));
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const hex = n => crypto.createHash('sha256').update(String(n)).digest('hex').slice(0, 16);
const SHELLS = /^(?:bash|sh|cmd|powershell|pwsh|zsh)(?:\.exe)?$/i;

function task(overrides = {}) {
  const { suite: _suite, ...base } = fixture('task');
  return { ...base, ...overrides };
}
function assertRelayAccepts(checks) {
  // Cross-check with Relay's own contract validator, not only our mirror of it.
  const argv = checks.map(c => c.argv);
  normalizeMissionSpec({ title: 'probe', goal: 'Probe derived checks', project: path.resolve('/probe'), provider: 'claude',
    tasks: [{ id: 'probe', title: 'probe', prompt: 'probe task', files: ['src/'], checks: argv }], checks: argv });
}

test('deriveChecks: visible entry points, final-state and fix-commit tests, contract requirements', async () => {
  const dir = tmp('relay-evals-derive-');
  try {
    const { root, base, final } = greetingRepo(path.join(dir, 'repo'));
    const t = task({ repoRoot: root, baseCommit: base, finalCommit: final, requirements: [{ id: 'R1', literal: 'Spanish', status: null }, { id: 'R2', literal: 'English default', status: null }] });
    const { visible, hidden, reason } = await deriveChecks({ task: t });
    assert.equal(reason, null);
    assert.deepEqual(visible.map(c => [c.origin, c.argv]), [['existing-test', ['npm', 'test']]]);
    assert.deepEqual(hidden.map(c => [c.origin, c.argv]), [
      ['final-state-test', ['node', '--test', 'test/greet-es.test.mjs']],
      ['fix-commit', ['node', '--test', 'test/greet.test.mjs']],
      ['contract-requirement', ['node', 'evals/benchmark/judge-requirement.mjs', '--task', t.id, '--requirement', 'R1']],
      ['contract-requirement', ['node', 'evals/benchmark/judge-requirement.mjs', '--task', t.id, '--requirement', 'R2']],
    ]);
    for (const c of [...visible, ...hidden]) {
      assert.ok(isRelayCheckArgv(c.argv));
      assert.ok(!SHELLS.test(path.basename(c.argv[0])));
      assert.ok(!c.argv.some(a => /^(?:install|i|ci|add)$/.test(a)));
      assert.ok(c.timeoutMs >= 1000);
    }
    assertRelayAccepts([...visible, ...hidden]);
    // The source repository is only read.
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(git(root, 'rev-parse', 'HEAD'), final);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deriveChecks: node:test files without a script, pytest config, and unsupported stacks', async () => {
  const dir = tmp('relay-evals-derive2-');
  try {
    const root = path.join(dir, 'repo'); fs.mkdirSync(root); git(root, 'init', '-q', '-b', 'main');
    const base = commit(root, { 'lib/a.mjs': 'export const a = 1;\n', 'test/a.test.mjs': '// a\n', 'pytest.ini': '[pytest]\n', 'tests/test_b.py': 'def test_b(): pass\n' }, 'base');
    const final = commit(root, { 'tests/test_c.py': 'def test_c(): pass\n', 'test/new.test.ts': '// ts\n' }, 'add c');
    const { visible, hidden, reason } = await deriveChecks({ task: task({ repoRoot: root, baseCommit: base, finalCommit: final, requirements: [] }) });
    assert.deepEqual(visible.map(c => c.argv), [['python', '-m', 'pytest', '-q'], ['node', '--test', 'test/a.test.mjs']]);
    assert.deepEqual(hidden.map(c => c.argv), [['python', '-m', 'pytest', '-q', 'tests/test_c.py']]);
    assert.match(reason, /unsupported runner/);
    const none = await deriveChecks({ task: task({ repoRoot: null, baseCommit: null, finalCommit: null }) });
    assert.deepEqual([none.visible, none.hidden, none.reason], [[], [], 'no git repository']);
    const missing = await deriveChecks({ task: task({ repoRoot: root, baseCommit: 'f'.repeat(40) }) });
    assert.equal(missing.reason, 'base commit unreadable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('check rules reject shells, installs, npx without --no-install and mutating git', () => {
  for (const bad of [['bash', '-c', 'x'], ['cmd.exe', '/c', 'x'], ['npm', 'install'], ['npm', 'ci'], ['npx', 'vitest'], ['git', 'commit'], ['relay', 'start'], ['claude'], ['run.ps1']]) assert.equal(isRelayCheckArgv(bad), false, bad[0]);
  for (const good of [['npm', 'test'], ['npx', '--no-install', 'vitest', 'run'], ['git', 'diff'], ['node', '--test', 'a.test.mjs']]) assert.equal(isRelayCheckArgv(good), true);
  assert.ok(isTestFile('test/a.test.mjs') && isTestFile('src/x.spec.ts') && isTestFile('tests/test_a.py'));
  assert.ok(!isTestFile('test/fixtures/a.test.mjs') && !isTestFile('node_modules/x/a.test.js') && !isTestFile('src/a.mjs'));
  assert.ok(FIX_SUBJECT.test('fix: x') && FIX_SUBJECT.test('Revert "y"') && FIX_SUBJECT.test('arreglo del saludo') && !FIX_SUBJECT.test('Add feature prefix'));
});

// 10 tasks in stratum A, 5 in B, 1 in C (all reproducible) + 2 not reproducible + 1 excluded.
function seedStore(store, repo) {
  const record = fixture('chat-record'), tasks = [];
  const add = (n, overrides) => {
    const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const { provider = 'claude', ...rest } = overrides;
    const chat = { ...record, id: `${provider}:${sessionId}`, provider, sessionId,
      userMessages: [{ ...record.userMessages[0], text: `Synthetic task ${n}: add a greeting.` }, ...record.userMessages.slice(1)] };
    store.saveChat(chat);
    tasks.push(task({ id: `task:${hex(n)}`, sources: { chatIds: [chat.id], contract: null }, repoRoot: repo.root, baseCommit: repo.base, finalCommit: repo.final,
      outcome: { ...fixture('task').outcome, userTurns: 2 + (n % 3) }, ...rest }));
  };
  for (let n = 0; n < 10; n++) add(n, { taskType: 'feature', hasSpec: true });
  for (let n = 10; n < 15; n++) add(n, { taskType: 'bugfix', hasSpec: false, provider: 'codex' });
  add(15, { taskType: 'docs', hasSpec: false });
  add(16, { reproducible: false, reproducibleReason: 'no git repo', repoRoot: null, baseCommit: null, finalCommit: null });
  add(17, { reproducible: false, reproducibleReason: 'needs device/credentials' });
  add(18, { excluded: true, excludedReason: 'duplicate fork' });
  store.replaceTasks(tasks);
  return tasks;
}

test('freezeSuite: deterministic file, sha sidecar, stratified holdout, valid entries only for reproducible tasks', async () => {
  const dir = tmp('relay-evals-freeze-'), store = openStore({ home: path.join(dir, 'home') });
  try {
    const repo = greetingRepo(path.join(dir, 'repo'));
    seedStore(store, repo);
    const now = () => Date.parse('2026-10-22T20:00:00.000Z');
    const first = await freezeSuite({ store, now, outDir: path.join(dir, 'a') });
    const second = await freezeSuite({ store, now, outDir: path.join(dir, 'b') });
    assert.equal(path.basename(first.file), 'suite-2026-10-22.json');
    assert.ok(fs.readFileSync(first.file).equals(fs.readFileSync(second.file)), 'same seed and inputs must give identical bytes');
    assert.equal(fs.readFileSync(`${first.file}.sha256`, 'utf8'), fs.readFileSync(`${second.file}.sha256`, 'utf8'));
    assert.equal(fs.readFileSync(`${first.file}.sha256`, 'utf8').split(' ')[0], crypto.createHash('sha256').update(fs.readFileSync(first.file)).digest('hex'));
    assert.equal(readSuite(first.file).entries.length, 16);
    fs.appendFileSync(second.file, ' ');
    assert.throws(() => readSuite(second.file), /sha256/);

    assert.equal(first.entries.length, 16);
    assert.ok(first.entries.every(e => e.reproducible && !e.excluded));
    for (const e of first.entries) assertValid('task', e);
    const by = stratum => first.entries.filter(e => e.suite.stratum === stratum);
    assert.equal(by('feature|claude|spec').filter(e => e.suite.split === 'holdout').length, 2);
    assert.equal(by('bugfix|codex|nospec').filter(e => e.suite.split === 'holdout').length, 1);
    assert.deepEqual(by('docs|claude|nospec').map(e => e.suite.split), ['dev']);
    assert.deepEqual([first.counts.reproducible, first.counts.frozen, first.counts.holdout, first.counts.dev], [16, 16, 3, 13]);
    const e0 = first.entries.find(e => e.id === `task:${hex(0)}`);
    assert.equal(e0.suite.prompt, 'Synthetic task 0: add a greeting.');
    assert.equal(e0.suite.frozenAt, '2026-10-22T20:00:00.000Z');
    assert.deepEqual(e0.suite.visibleChecks.map(c => c.origin), ['existing-test']);
    assert.ok(e0.suite.hiddenChecks.some(c => c.origin === 'final-state-test') && e0.suite.hiddenChecks.some(c => c.origin === 'fix-commit'));
    // Catalog persisted: only frozen tasks carry suite; others are untouched.
    const stored = store.tasks();
    assert.equal(stored.length, 19);
    assert.equal(stored.filter(t => t.suite).length, 16);
    // A different seed changes which tasks are held out but not how many.
    const splits = [1, 2, 3, 4, 5].map(seed => JSON.stringify([...assignSplits(first.entries, { seed })].filter(([, s]) => s === 'holdout').map(([id]) => id).sort()));
    assert.ok(new Set(splits).size > 1);
    assert.ok(splits.every(s => JSON.parse(s).length === 3));
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const entry = (n, stratum, split, userTurns = 3) => ({ id: `task:${hex(n)}`, outcome: { userTurns }, suite: { stratum, split } });

test('estimateSuite: median dev turns, refine turn for spec variants, days at 128 turns/day', () => {
  const entries = [entry(1, 'a', 'dev', 2), entry(2, 'a', 'dev', 4), entry(3, 'b', 'dev', 6), entry(4, 'b', 'holdout', 100)];
  assert.deepEqual(estimateSuite(entries), { turns: 4 * (4 * 2 + 1), days: 0.3, turnsPerDay: 128 });
  assert.deepEqual(estimateSuite(entries, { turnsPerTask: 10, turnsPerDay: 20 }), { turns: 4 * 21, days: 4.2, turnsPerDay: 20 });
  assert.equal(estimateSuite(entries, { variants: [{ spec: true }, { spec: true }, { spec: false }] }).turns, 4 * (4 * 3 + 2));
  assert.equal(estimateSuite([entry(5, 'a', 'dev', 0)]).turns, 1 * 2 + 1, 'minimum one turn per task');
  assert.equal(estimateSuite(Array.from({ length: 200 }, (_, n) => entry(n, 'a', 'dev', 3))).days, 11, '1400 / 128 rounds up to 11.0');
});

test('sampleTasks: at most 10 dev tasks covering every stratum, deterministic, capped without allowFull', () => {
  const entries = [];
  for (let n = 0; n < 40; n++) entries.push(entry(n, ['a', 'b', 'c', 'd'][n % 4], n % 5 === 0 ? 'holdout' : 'dev'));
  entries.push(entry(99, 'rare', 'dev'), entry(98, 'only-holdout', 'holdout'));
  const sample = sampleTasks(entries, { seed: 7 });
  assert.equal(sample.length, 10);
  assert.ok(sample.every(e => e.suite.split === 'dev'));
  assert.deepEqual(new Set(sample.map(e => e.suite.stratum)), new Set(['a', 'b', 'c', 'd', 'rare']));
  assert.equal(new Set(sample.map(e => e.id)).size, 10);
  assert.deepEqual(sampleTasks(entries, { seed: 7 }).map(e => e.id), sample.map(e => e.id));
  assert.throws(() => sampleTasks(entries, { limit: 11 }), /capped at 10/);
  assert.equal(sampleTasks(entries, { limit: 30, allowFull: true }).length, 30);
  assert.equal(sampleTasks(entries.slice(0, 3), { limit: 10 }).length, 2);
});

test('liveBlocker keeps side effects, outside files, questions and the workspace root out of a live sample', () => {
  const task = (prompt, extra = {}) => ({ id: `task:${prompt.length}`, repoRoot: 'C:/work/app', suite: { split: 'dev', stratum: 'feature|claude|nospec', prompt, visibleChecks: [{ argv: ['npm', 'test'] }] }, ...extra });
  const cases = [
    ['add light mode to docs.example.com but keep dark as default', null],
    ['arreglame un script para enviar hoy el SMS', 'side-effect'],
    ['deploy it to demo.vercel.app', 'side-effect'],
    ['mira downloads/barra hinge y copia esa UI', 'outside-repo'],
    ['mira el ultimo screenshot y mejora el layout', 'outside-repo'],
    ['quiero q uses cllaude design para el dashboard', 'outside-repo'],
    ['hay mas maneras de agregar valor? investiga', 'no-code-change'],
  ];
  for (const [prompt, expected] of cases) assert.equal(liveBlocker(task(prompt)), expected, prompt);
  assert.equal(liveBlocker(task('add a footer', { repoRoot: 'C:\\Users\\example\\Projects\\' }), { CHATS_WORKSPACE_ROOT: 'c:/users/example/projects' }), 'workspace-root');
  assert.equal(liveBlocker(task('add a footer', { repoRoot: 'C:\\Users\\example\\Projects\\app' }), { CHATS_WORKSPACE_ROOT: 'C:/Users/example/Projects' }), null);
  assert.equal(liveBlocker(task('add a footer', { suite: { split: 'dev', stratum: 'review|codex|nospec', prompt: 'add a footer', visibleChecks: [{ argv: ['npm', 'test'] }] } })), 'no-code-change');
  assert.equal(liveBlocker(task('add a footer', { suite: { split: 'dev', stratum: 'feature|claude|nospec', prompt: 'add a footer', visibleChecks: [] } })), 'no-visible-checks');
  const safe = sampleTasks(cases.map(([prompt]) => task(prompt)), { safe: true });
  assert.deepEqual(safe.map(e => e.suite.prompt), ['add light mode to docs.example.com but keep dark as default']);
});
