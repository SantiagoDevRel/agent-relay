// E4a catalog + E4b retrospective: contract parsing, full coverage of chat
// records, contract linking, reproducibility against a real temporary Git repo
// with controlled dates, and hand-computed retrospective rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validate, assertValid } from '../evals/schema.mjs';
import { openStore } from '../evals/store.mjs';
import { readContracts, parseChecklist, scrub } from '../evals/benchmark/contracts.mjs';
import { buildCatalog, catalogAndSave, createGitExec, promptRequirements, REASONS } from '../evals/benchmark/catalog.mjs';
import { retrospective, topFolder } from '../evals/benchmark/retro.mjs';

// Synthetic contracts, written to a temp dir as <folder>/checklist.md (and requirements.json) at test time.
const CONTRACT_FILES = {
  "bullets-contract-20261003/checklist.md": "# Bullets contract — synthetic cleanup\n\n## State\n\n- [x] A1 — remove the temporary folder\n- [ ] keep the logs for one week\n- DONE — rotate the synthetic cache\n- B2: document the limits\n",
  "json-contract-20261004/checklist.md": "# JSON contract — markdown is ignored when requirements.json parses\n\n1. R9 — \"this markdown item must be ignored\" — completed.\n",
  "json-contract-20261004/requirements.json": "{\n  \"version\": 1,\n  \"items\": [\n    { \"id\": \"R1\", \"literal\": \"literal from json one\", \"status\": \"completed\", \"evidence\": \"synthetic\" },\n    { \"id\": \"R2\", \"literal\": \"literal from json two\", \"status\": \"pending\", \"evidence\": \"synthetic\" }\n  ]\n}\n",
  "numbered-contract-20261002/checklist.md": "# Numbered contract — synthetic report page\n\nLiteral requirements:\n\n1. R1 — \"haz el reporte semanal\" — completed.\n2. \"quita el botón de copiar\" — make the copy button disappear. Status: done (synthetic)\n3. Add a legend to the chart\n",
  "prose-contract-20261005/checklist.md": "# Prose contract\n\nThis synthetic contract only has a paragraph of prose and no list, table or\nrequirements file, so no requirement can be parsed from it.\n",
  "table-contract-20261001/checklist.md": "# Table contract — synthetic greeting widget\n\n| ID | Literal request | Status | Evidence |\n|---|---|---|---|\n| R1 | \"agrega un saludo en español\" | completed | commit abc1234 |\n| R2 | «muéstrame el borrador primero» | pending | none |\n| R3 | \"envía la prueba a test@example.com\" | blocked | needs approval |\n",
};
let CONTRACTS;
test.before(() => {
  CONTRACTS = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-contract-fixtures-'));
  for (const [file, text] of Object.entries(CONTRACT_FILES)) {
    fs.mkdirSync(path.join(CONTRACTS, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(CONTRACTS, file), text);
  }
});
test.after(() => fs.rmSync(CONTRACTS, { recursive: true, force: true }));
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/evals/${name}.sample.json`, import.meta.url), 'utf8'));
const byFolder = list => Object.fromEntries(list.map(c => [c.folder, c]));

test('contracts: tables, numbered lists, bullets, requirements.json precedence and prose', () => {
  const contracts = readContracts({ dir: CONTRACTS });
  assert.deepEqual(contracts.map(c => c.folder), ['bullets-contract-20261003', 'json-contract-20261004', 'numbered-contract-20261002', 'prose-contract-20261005', 'table-contract-20261001']);
  const c = byFolder(contracts);

  assert.equal(c['table-contract-20261001'].title, 'Table contract — synthetic greeting widget');
  assert.deepEqual(c['table-contract-20261001'].requirements, [
    { id: 'R1', literal: 'agrega un saludo en español', status: 'completed' },
    { id: 'R2', literal: 'muéstrame el borrador primero', status: 'pending' },
    { id: 'R3', literal: 'envía la prueba a [REDACTED:email]', status: 'blocked' },
  ]);
  assert.deepEqual(c['numbered-contract-20261002'].requirements, [
    { id: 'R1', literal: 'haz el reporte semanal', status: 'completed' },
    { id: 'R2', literal: 'quita el botón de copiar', status: 'done' },
    { id: 'R3', literal: 'Add a legend to the chart', status: null },
  ]);
  assert.deepEqual(c['bullets-contract-20261003'].requirements, [
    { id: 'A1', literal: 'remove the temporary folder', status: 'completed' },
    { id: 'R2', literal: 'keep the logs for one week', status: 'pending' },
    { id: 'R3', literal: 'rotate the synthetic cache', status: 'done' },
    { id: 'B2', literal: 'document the limits', status: null },
  ]);
  assert.deepEqual(c['json-contract-20261004'].requirements, [
    { id: 'R1', literal: 'literal from json one', status: 'completed' },
    { id: 'R2', literal: 'literal from json two', status: 'pending' },
  ]);
  assert.deepEqual(c['prose-contract-20261005'].requirements, []);
  assert.equal(c['prose-contract-20261005'].title, 'Prose contract');
  assert.ok(c['numbered-contract-20261002'].mentions.includes('agent-work/numbered-contract-20261002/checklist.md'));
  assert.deepEqual(readContracts({ dir: path.join(CONTRACTS, 'does-not-exist') }), []);
});

test('contracts: invalid requirements.json falls back to markdown; literals are capped and duplicate ids stay unique', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-contracts-'));
  try {
    fs.mkdirSync(path.join(dir, 'broken-json-20261006'));
    fs.writeFileSync(path.join(dir, 'broken-json-20261006', 'checklist.md'), '# Broken\n\n1. R1 — "from markdown" — completed.\n');
    fs.writeFileSync(path.join(dir, 'broken-json-20261006', 'requirements.json'), '{ not json');
    const [contract] = readContracts({ dir });
    assert.deepEqual(contract.requirements, [{ id: 'R1', literal: 'from markdown', status: 'completed' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const long = parseChecklist(`1. ${'x'.repeat(5000)}\n1. again`);
  assert.equal(long[0].literal.length, 2000);
  assert.deepEqual(long.map(r => r.id), ['R1', 'R1-2']);
  assert.equal(scrub('call +57 300 123 4567 now'), 'call [REDACTED:phone] now');
});

// ---------- catalog against a real temporary repository ----------

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: repo, env: { ...env, ...extra }, windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
  const commit = (file, date) => {
    fs.writeFileSync(path.join(repo, file), `${file} ${date}\n`);
    git(['add', file]);
    git(['commit', '-q', '-m', `synthetic ${file}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q', '-b', 'main']);
  const c1 = commit('a.txt', '2026-10-01T10:00:00Z');
  const c2 = commit('b.txt', '2026-10-02T10:00:00Z');
  git(['checkout', '-q', '-b', 'feature']);
  const c3 = commit('c.txt', '2026-10-03T10:00:00Z');
  const c4 = commit('d.txt', '2026-10-03T12:00:00Z');
  git(['checkout', '-q', 'main']);
  return { repo, env, c1, c2, c3, c4 };
}

function makeRecord({ id, startedAt, prompts = [], commands = 0, automated = false, gitBranch = null, agentFinal = null, provider = 'claude' }) {
  const base = fixture('chat-record');
  const turn = { ...base.turns[0], i: 0, startedAt, endedAt: startedAt, agentFinal: agentFinal ? { text: agentFinal, chars: agentFinal.length } : null };
  const userMessages = [
    ...prompts.map(p => ({ turn: 0, at: p.at ?? startedAt, kind: 'prompt', text: p.text, chars: p.text.length })),
    ...Array.from({ length: commands }, () => ({ turn: 0, at: startedAt, kind: 'command', text: '/clear', chars: 6 })),
  ];
  const sessionId = id.split(':')[1];
  return assertValid('chat-record', { ...base, id, provider, sessionId, startedAt, endedAt: startedAt, gitBranch, automated, userMessages, turns: [turn], compactions: [] });
}

function makeMetrics({ id, startedAt, repoRoot = null, commits = [], taskType = 'feature', hasSpec = false, automated = false, ...rest }) {
  const base = fixture('chat-metrics');
  return assertValid('chat-metrics', { ...base, id, startedAt, endedAt: startedAt, repoRoot, automated, taskType, hasSpec,
    commits: commits.map(c => ({ turn: 0, repoRoot, verifiedBefore: true, followUp: 'none', ...c })), ...rest });
}

async function withCatalogFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-catalog-'));
  const store = openStore({ home: path.join(root, 'evals') });
  try {
    const repo = makeRepo(root);
    const short = sha => sha.slice(0, 7);
    const add = (record, metrics) => { store.saveChat(makeRecord(record)); if (metrics) store.saveMetrics(makeMetrics({ id: record.id, startedAt: record.startedAt, ...metrics })); };
    const R = repo.repo;
    // A + A2: linked to the numbered contract (prompt mention, then agentFinal checklist path).
    add({ id: 'claude:chat-a', startedAt: '2026-10-02T12:00:00.000Z', gitBranch: 'feature', prompts: [{ text: 'Use numbered-contract-20261002 and build the weekly report.' }] },
      { repoRoot: R, hasSpec: true, commits: [{ sha: short(repo.c3), followUp: 'fixed', followUpSha: short(repo.c4) }], turnsToFirstVerifiedCommit: 3 });
    add({ id: 'claude:chat-a2', startedAt: '2026-10-05T09:00:00.000Z', gitBranch: 'feature', prompts: [{ text: 'continue the report' }], agentFinal: 'Updated C:\\x\\agent-work\\numbered-contract-20261002\\checklist.md.' },
      { repoRoot: R, commits: [{ sha: short(repo.c2), followUp: 'reverted' }], turnsToFirstVerifiedCommit: 2 });
    // B: chat-only, branch missing -> HEAD (main); no commit.
    add({ id: 'claude:chat-b', startedAt: '2026-10-04T08:00:00.000Z', gitBranch: 'gone-branch', prompts: [{ text: 'Refactor the parser.\n1. split tokens\n- keep tests green' }] },
      { repoRoot: R, commits: [] });
    // C: no repository.
    add({ id: 'codex:chat-c', provider: 'codex', startedAt: '2026-10-04T09:00:00.000Z', prompts: [{ text: 'Write a poem about rivers' }] }, { repoRoot: null, provider: 'codex', commits: [] });
    // D: research with a commit; E: device/login task with a commit.
    add({ id: 'claude:chat-d', startedAt: '2026-10-02T12:00:00.000Z', gitBranch: 'feature', prompts: [{ text: 'Investigate caching options' }] },
      { repoRoot: R, taskType: 'research', commits: [{ sha: short(repo.c3) }] });
    add({ id: 'claude:chat-e', startedAt: '2026-10-02T13:00:00.000Z', gitBranch: 'feature', prompts: [{ text: 'Fix the iPhone login screen' }] },
      { repoRoot: R, commits: [{ sha: short(repo.c3) }] });
    // F: started before any commit; J: base equals final.
    add({ id: 'claude:chat-f', startedAt: '2026-09-01T00:00:00.000Z', gitBranch: 'feature', prompts: [{ text: 'Start the project' }] },
      { repoRoot: R, commits: [{ sha: short(repo.c1) }] });
    add({ id: 'claude:chat-j', startedAt: '2026-10-04T10:00:00.000Z', gitBranch: 'feature', prompts: [{ text: 'Polish the feature' }] },
      { repoRoot: R, commits: [{ sha: short(repo.c4) }] });
    // Exclusions: automated (mentions the bullets contract), command-only, duplicate of B.
    add({ id: 'claude:chat-g', startedAt: '2026-10-04T11:00:00.000Z', automated: true, prompts: [{ text: 'worker brief for bullets-contract-20261003' }] }, { repoRoot: R, automated: true });
    add({ id: 'claude:chat-h', startedAt: '2026-10-04T12:00:00.000Z', commands: 2 }, null);
    add({ id: 'claude:chat-i', startedAt: '2026-10-04T08:00:00.000Z', gitBranch: 'gone-branch', prompts: [{ text: 'Refactor the parser.\n1. split tokens\n- keep tests green' }] }, { repoRoot: R });
    return await fn({ store, repo, root });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

const ALL_IDS = ['claude:chat-a', 'claude:chat-a2', 'claude:chat-b', 'codex:chat-c', 'claude:chat-d', 'claude:chat-e', 'claude:chat-f', 'claude:chat-j', 'claude:chat-g', 'claude:chat-h', 'claude:chat-i'];
const sha16 = keys => 'task:' + crypto.createHash('sha256').update([...keys].sort().join('\n')).digest('hex').slice(0, 16);

test('catalog: every record once, contract linking, reproducibility reasons and Git commits', async () => {
  await withCatalogFixture(async ({ store, repo }) => {
    const { tasks, counts } = await catalogAndSave({ store, contractsDir: CONTRACTS, exec: createGitExec({ env: repo.env }) });
    for (const task of tasks) assert.deepEqual(validate('task', task), [], task.id);

    const chatIds = tasks.flatMap(t => t.sources.chatIds);
    assert.deepEqual([...chatIds].sort(), [...ALL_IDS].sort(), 'each chat record appears exactly once');
    const byChat = id => tasks.find(t => t.sources.chatIds.includes(id));
    const byContract = folder => tasks.find(t => t.sources.contract === folder);

    // Linked contract merges A (prompt mention) and A2 (checklist path in agentFinal).
    const a = byContract('numbered-contract-20261002');
    assert.deepEqual(a.sources.chatIds, ['claude:chat-a', 'claude:chat-a2']);
    assert.equal(a.id, sha16(['claude:chat-a', 'claude:chat-a2', 'numbered-contract-20261002']));
    assert.equal(a.title, 'Numbered contract — synthetic report page');
    assert.equal(a.requirements[0].literal, 'haz el reporte semanal');
    assert.equal(a.baseCommit, repo.c2, 'last commit on the chat branch before startedAt');
    assert.equal(a.finalCommit, repo.c4, 'fixed follow-up of the last non-reverted commit');
    assert.equal(a.reproducible, true);
    assert.equal(a.reproducibleReason, REASONS.ok);
    assert.equal(a.hasSpec, true);
    assert.equal(a.outcome.turnsToFirstVerifiedCommit, 2, 'minimum non-null across chats');
    assert.equal(a.outcome.userTurns, 6);
    assert.equal(a.outcome.corrections, 2);

    // Unlinked contracts (including one only mentioned by an excluded automated chat).
    for (const folder of ['table-contract-20261001', 'json-contract-20261004', 'prose-contract-20261005', 'bullets-contract-20261003']) {
      const t = byContract(folder);
      assert.deepEqual(t.sources.chatIds, [], folder);
      assert.equal(t.reproducible, false);
      assert.equal(t.reproducibleReason, REASONS.noChat);
      assert.equal(t.id, sha16([folder]));
    }
    assert.deepEqual(byContract('prose-contract-20261005').requirements, []);

    const b = byChat('claude:chat-b');
    assert.equal(b.sources.contract, null);
    assert.equal(b.baseCommit, repo.c2, 'missing branch falls back to HEAD');
    assert.equal(b.finalCommit, null);
    assert.equal(b.reproducibleReason, REASONS.noFinal);
    assert.deepEqual(b.requirements.map(r => [r.id, r.literal]), [['P1', 'Refactor the parser.\n1. split tokens\n- keep tests green'], ['P1.1', 'split tokens'], ['P1.2', 'keep tests green']]);
    assert.equal(b.title, 'Refactor the parser.');

    assert.equal(byChat('codex:chat-c').reproducibleReason, REASONS.noRepo);
    assert.equal(byChat('claude:chat-d').reproducibleReason, REASONS.research);
    assert.equal(byChat('claude:chat-d').finalCommit, repo.c3);
    assert.equal(byChat('claude:chat-e').reproducibleReason, REASONS.device);
    assert.equal(byChat('claude:chat-f').baseCommit, null);
    assert.equal(byChat('claude:chat-f').reproducibleReason, REASONS.noBase);
    assert.equal(byChat('claude:chat-j').baseCommit, repo.c4);
    assert.equal(byChat('claude:chat-j').reproducibleReason, REASONS.sameCommit);

    const excluded = Object.fromEntries(tasks.filter(t => t.excluded).map(t => [t.sources.chatIds[0], t.excludedReason]));
    assert.deepEqual(excluded, { 'claude:chat-g': REASONS.automated, 'claude:chat-h': REASONS.noPrompt, 'claude:chat-i': REASONS.duplicate });
    for (const t of tasks.filter(t => t.excluded)) assert.equal(t.reproducible, false);

    assert.deepEqual(counts, {
      total: 14, excluded: 3, reproducible: 1,
      byReason: { [REASONS.ok]: 1, [REASONS.noChat]: 4, [REASONS.noFinal]: 1, [REASONS.noRepo]: 1, [REASONS.research]: 1, [REASONS.device]: 1,
        [REASONS.noBase]: 1, [REASONS.sameCommit]: 1, [REASONS.automated]: 1, [REASONS.noPrompt]: 1, [REASONS.duplicate]: 1 },
    });
    assert.deepEqual(store.tasks(), [...tasks].sort((x, y) => x.id.localeCompare(y.id)), 'replaceTasks round-trip');
    assert.deepEqual(store.getMeta('catalog').counts, counts);
  });
});

test('catalog: hung or failing git yields null commits and no crash', async () => {
  await withCatalogFixture(async ({ store }) => {
    const hung = () => new Promise(() => {});
    const started = Date.now();
    const { tasks } = await buildCatalog({ store, contractsDir: CONTRACTS, exec: hung, timeoutMs: 25 });
    assert.ok(Date.now() - started < 10000);
    for (const task of tasks) { assert.equal(task.baseCommit, null); assert.equal(task.finalCommit, null); assert.equal(task.reproducible, false); }
    const failing = async () => { throw Object.assign(new Error('fatal'), { code: 128 }); };
    const second = await buildCatalog({ store, contractsDir: CONTRACTS, exec: failing });
    assert.ok(second.tasks.every(t => t.baseCommit === null && t.finalCommit === null));
    assert.equal(second.counts.reproducible, 0);
  });
});

test('catalog: short folder names link only through their checklist path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-short-'));
  const store = openStore({ home: root });
  try {
    store.saveChat(makeRecord({ id: 'claude:short-1', startedAt: '2026-10-01T00:00:00.000Z', prompts: [{ text: 'read my notes please' }] }));
    store.saveChat(makeRecord({ id: 'claude:short-2', startedAt: '2026-10-02T00:00:00.000Z', prompts: [{ text: 'see agent-work/notes/checklist.md' }] }));
    const contracts = [{ folder: 'notes', title: 'Notes', requirements: [], mentions: ['notes', 'agent-work/notes/checklist.md'] }];
    const { tasks } = await buildCatalog({ store, contracts, exec: async () => { throw new Error('no git'); } });
    assert.deepEqual(tasks.find(t => t.sources.contract === 'notes').sources.chatIds, ['claude:short-2']);
    assert.equal(tasks.find(t => t.sources.chatIds.includes('claude:short-1')).sources.contract, null);
    // A contract without requirements keeps the chat prompt as P1.
    assert.equal(tasks.find(t => t.sources.contract === 'notes').requirements[0].id, 'P1');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('promptRequirements keeps the first prompt as P1 and caps it', () => {
  assert.deepEqual(promptRequirements(null), []);
  const reqs = promptRequirements('y'.repeat(3000));
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].literal.length, 2000);
});

// ---------- retrospective ----------

function retroFixture() {
  const base = fixture('chat-metrics');
  const metric = (over) => ({ ...base, corrections: { count: 0, byCategory: {}, items: [] }, falseDone: { count: 0, items: [] }, ...over });
  const list = [];
  for (let i = 0; i < 10; i++) {
    list.push(metric({ id: `claude:ra-${i}`, provider: 'claude', model: 'm-a', effort: i < 6 ? 'high' : null, hasSpec: i % 2 === 0, project: 'apps/demo', taskType: 'feature',
      automated: false, userTurns: 5, corrections: { count: i < 5 ? 2 : 0, byCategory: {}, items: [] }, doneClaims: i < 8 ? 1 : 0,
      falseDone: { count: i < 2 ? 1 : 0, items: [] }, commitsChecked72h: i < 4 ? 1 : 0, commitsFixedOrReverted72h: i === 0 ? 1 : 0,
      turnsToFirstVerifiedCommit: i < 3 ? [4, 1, 2][i] : null }));
  }
  for (let i = 0; i < 2; i++) {
    list.push(metric({ id: `codex:rb-${i}`, provider: 'codex', model: 'm-b', effort: null, hasSpec: false, project: '', taskType: 'bugfix',
      automated: false, userTurns: 0, doneClaims: 0, commitsChecked72h: 0, commitsFixedOrReverted72h: 0, turnsToFirstVerifiedCommit: null }));
  }
  list.push(metric({ id: 'claude:auto', model: 'm-a', automated: true, userTurns: 50, corrections: { count: 50, byCategory: {}, items: [] } }));
  return list;
}

test('retrospective: hand-computed rows, insufficient flags and null rates', () => {
  const rows = retrospective(retroFixture());
  const row = (dimension, value) => rows.find(r => r.dimension === dimension && r.value === value);
  assert.deepEqual(row('model', 'm-a'), { dimension: 'model', value: 'm-a', chats: 10, correctionRate: 2, falseDoneRate: null, fixRevertRate: null, medianTurnsToVerifiedCommit: 2, insufficient: false });
  // Rates over fewer than minN done claims or checked commits stay null; with a lower minN they are computed.
  const small = retrospective(retroFixture(), { minN: 2 }).find(r => r.dimension === 'model' && r.value === 'm-a');
  assert.deepEqual([small.falseDoneRate, small.fixRevertRate], [0.25, 0.25]);
  assert.deepEqual(row('model', 'm-b'), { dimension: 'model', value: 'm-b', chats: 2, correctionRate: null, falseDoneRate: null, fixRevertRate: null, medianTurnsToVerifiedCommit: null, insufficient: true });
  assert.deepEqual(row('spec', 'with spec'), { dimension: 'spec', value: 'with spec', chats: 5, correctionRate: 2.4, falseDoneRate: null, fixRevertRate: null, medianTurnsToVerifiedCommit: 3, insufficient: true });
  assert.deepEqual(row('spec', 'without spec'), { dimension: 'spec', value: 'without spec', chats: 7, correctionRate: 1.6, falseDoneRate: null, fixRevertRate: null, medianTurnsToVerifiedCommit: 1, insufficient: true });
  assert.equal(row('effort', 'high').chats, 6);
  assert.equal(row('effort', 'unknown').chats, 6);
  assert.equal(row('project', 'apps').chats, 10);
  assert.equal(row('project', '(root)').chats, 2);
  assert.equal(row('provider', 'codex').chats, 2);
  assert.equal(row('taskType', 'bugfix').chats, 2);
  assert.ok(!rows.some(r => r.chats > 12), 'automated chats are excluded');
  assert.deepEqual([...new Set(rows.map(r => r.dimension))], ['model', 'effort', 'spec', 'taskType', 'project', 'provider']);
  assert.deepEqual(rows.filter(r => r.dimension === 'spec').map(r => r.value), ['without spec', 'with spec'], 'chats desc within a dimension');
  assert.equal(retrospective(retroFixture(), { minN: 2 }).find(r => r.value === 'm-b').insufficient, false);
  assert.equal(topFolder(null), 'unknown');
  assert.equal(topFolder('tools\\chats-dashboard'), 'tools');

  const report = fixture('report');
  assert.deepEqual(validate('report', { ...report, models: { scope: 'All interactive chats to date', rows } }), []);
  assert.deepEqual(retrospective([]), []);
});
