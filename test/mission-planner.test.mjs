import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MissionPlanner } from '../server/mission-planner.mjs';
import { MissionManager } from '../server/missions.mjs';

function fixture(runner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-planner-')), project = path.join(dir, 'project'); fs.mkdirSync(project);
  const git = args => execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  git(['init']); git(['config', 'user.name', 'Relay Tests']); git(['config', 'user.email', 'relay-tests@localhost']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(project, 'README.md'), 'Planner fixture\n'); git(['add', '--', 'README.md']); git(['commit', '-m', 'Initialize fixture']);
  const file = path.join(dir, 'plans.json'), artifacts = path.join(dir, 'artifacts');
  const planner = new MissionPlanner({ file, artifacts, runner, gate: async () => {} });
  const request = { project, title: 'Fixture plan', goal: 'Implement a feature with meaningful acceptance checks.', provider: 'codex', effort: 'high', model: '', limits: { concurrency: 2 } };
  const spec = { ...request, tasks: [{ id: 'feature', title: 'Implement feature', prompt: request.goal, files: ['feature.mjs'], dependsOn: [], checks: [['node', '--check', 'feature.mjs']] }], checks: [['node', '--check', 'feature.mjs']] };
  return { dir, project, git, planner, request, spec, file, artifacts };
}
test('planning preserves user controls and source, persists chat identity, and never starts workers', async () => {
  let f, calls = 0;
  f = fixture(async input => {
    calls++; assert.equal(input.role, 'planner'); assert.notEqual(path.resolve(input.cwd), f.project); assert.ok(path.resolve(input.cwd).startsWith(f.artifacts + path.sep)); assert.equal(fs.readFileSync(path.join(input.cwd, 'README.md'), 'utf8'), 'Planner fixture\n'); assert.ok(fs.readFileSync(input.promptFile, 'utf8').includes('read-only tools'));
    fs.writeFileSync(input.outputFile, 'Planner actual transcript');
    return { exitCode: 0, sessionHandle: 'codex-abcdef', nativeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', answer: JSON.stringify({ ...f.spec, provider: 'claude', project: 'C:/wrong-project', effort: 'max' }) };
  });
  try {
    const before = f.git(['rev-parse', 'HEAD']); const result = await f.planner.plan(f.request);
    assert.equal(result.spec.provider, 'codex'); assert.equal(result.spec.project, path.resolve(f.project)); assert.equal(result.spec.effort, 'high');
    assert.equal(result.spec.limits.concurrency, 2); assert.equal(calls, 1); assert.equal(f.git(['status', '--porcelain']), ''); assert.equal(f.git(['rev-parse', 'HEAD']), before);
    const restarted = new MissionPlanner({ file: f.file, artifacts: f.artifacts, runner: async () => { throw Error('No inference on restart'); } });
    assert.equal(restarted.details(result.spec.planId).sessionHandle, 'codex-abcdef'); assert.equal(restarted.log(result.spec.planId), 'Planner actual transcript');
  } finally { fs.rmSync(f.dir, { force: true, recursive: true }); }
});
test('dirty source is copied without changing the index; invalid budgets spend no turn and malformed plans retain evidence', async () => {
  let calls = 0; const f = fixture(async input => { calls++; assert.equal(fs.readFileSync(path.join(input.cwd, 'README.md'), 'utf8'), 'Planner fixture\nuser edit'); return { exitCode: 0, answer: 'not a plan', sessionHandle: 'codex-abcdef' }; });
  try {
    await assert.rejects(f.planner.plan({ ...f.request, limits: { concurrency: 1000 } }), /Limit/); assert.equal(calls, 0);
    await assert.rejects(f.planner.plan({ ...f.request, terminalViews: 'yes' }), /boolean/); assert.equal(calls, 0);
    fs.appendFileSync(path.join(f.project, 'README.md'), 'user edit');
    const index = fs.readFileSync(path.resolve(f.project, f.git(['rev-parse', '--git-path', 'index']))), head = f.git(['rev-parse', 'HEAD']);
    await assert.rejects(f.planner.plan(f.request), /JSON/); assert.equal(calls, 1); assert.equal(f.planner.busy, false);
    assert.deepEqual(fs.readFileSync(path.resolve(f.project, f.git(['rev-parse', '--git-path', 'index']))), index); assert.equal(f.git(['rev-parse', 'HEAD']), head); assert.equal(fs.readFileSync(path.join(f.project, 'README.md'), 'utf8'), 'Planner fixture\nuser edit');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8'))[0].status, 'attention');
  } finally { fs.rmSync(f.dir, { force: true, recursive: true }); }
});

test('a mission consumes the exact planner baseline and preserves explicit provider default effort', async () => {
  let f, plannedSource;
  f = fixture(async input => { plannedSource = input.cwd; assert.equal(input.effort, ''); assert.equal(fs.readFileSync(path.join(input.cwd, 'README.md'), 'utf8'), 'staged user\nunstaged user\n'); assert.equal(fs.readFileSync(path.join(input.cwd, 'user.mjs'), 'utf8'), 'export const user = true;\n'); return { exitCode: 0, answer: JSON.stringify(f.spec), sessionHandle: 'codex-abcdef' }; });
  let manager;
  try {
    fs.writeFileSync(path.join(f.project, 'README.md'), 'staged user\n'); f.git(['add', '--', 'README.md']); fs.appendFileSync(path.join(f.project, 'README.md'), 'unstaged user\n'); fs.writeFileSync(path.join(f.project, 'user.mjs'), 'export const user = true;\n');
    const index = fs.readFileSync(path.resolve(f.project, f.git(['rev-parse', '--git-path', 'index']))), head = f.git(['rev-parse', 'HEAD']);
    const { spec } = await f.planner.plan({ ...f.request, effort: '' }); assert.equal(spec.effort, '');
    manager = new MissionManager({ file: path.join(f.dir, 'missions.json'), artifacts: path.join(f.dir, 'missions'), gate: async () => {}, resolveBaseline: id => f.planner.baseline(id), runner: async input => { assert.equal(fs.readFileSync(path.join(input.cwd, 'README.md'), 'utf8'), 'staged user\nunstaged user\n'); fs.writeFileSync(path.join(input.cwd, 'feature.mjs'), 'export const feature = true;\n'); return { exitCode: 0, answer: 'STATUS: OK', sessionHandle: 'codex-123456' }; } });
    const mission = await manager.create(spec); assert.equal(manager.jobs[0].baseline.path, plannedSource); assert.equal(mission.baselineDirty, true); assert.equal(mission.deliveryMode, 'worktree'); await manager.start(mission.id);
    const end = Date.now() + Math.min(120000, Math.max(20000, Number(process.env.CHATS_TEST_WAIT_MS) || 20000)); while (manager.publicState()[0].status !== 'ready') { if (Date.now() > end || manager.publicState()[0].status === 'attention') throw Error(JSON.stringify(manager.publicState()[0])); await new Promise(resolve => setTimeout(resolve, 20)); }
    await manager.apply(mission.id); assert.equal(f.git(['rev-parse', 'HEAD']), head); assert.deepEqual(fs.readFileSync(path.resolve(f.project, f.git(['rev-parse', '--git-path', 'index']))), index); assert.equal(fs.readFileSync(path.join(f.project, 'README.md'), 'utf8'), 'staged user\nunstaged user\n'); assert.equal(fs.readFileSync(path.join(f.project, 'feature.mjs'), 'utf8'), 'export const feature = true;\n');
  } finally { await manager?.shutdown(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('interrupted planning becomes attention on restart without consuming another turn', () => {
  const f = fixture(async () => { throw Error('Restart must not launch a model'); });
  try {
    fs.writeFileSync(f.file, JSON.stringify([{ id: 'interrupted', status: 'planning', provider: 'codex' }]));
    const restarted = new MissionPlanner({ file: f.file, artifacts: f.artifacts, runner: async () => { throw Error('No inference'); } });
    assert.equal(restarted.busy, false);
    assert.equal(restarted.details('interrupted').status, 'attention');
    assert.match(restarted.plans[0].detail, /restarted/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a selected nested folder stays the planning context and plans cannot claim another project in the parent repository', async () => {
  let f, context, outside = false, calls = 0;
  f = fixture(async input => {
    calls++;
    const prompt = fs.readFileSync(input.promptFile, 'utf8');
    assert.ok(prompt.includes(`Selected project folder: ${JSON.stringify(context)}`));
    assert.ok(prompt.includes('MCP/'));
    assert.equal(fs.readFileSync(path.join(input.cwd, 'MCP', 'README.md'), 'utf8'), 'Selected MCP source\n');
    return { exitCode: 0, answer: JSON.stringify({ ...f.spec, tasks: f.spec.tasks.map(task => ({ ...task, files: [outside ? 'another-project/feature.mjs' : 'MCP/feature.mjs'], checks: [['node', '--check', 'MCP/feature.mjs']] })), checks: [['node', '--check', 'MCP/feature.mjs']] }) };
  });
  try {
    context = path.join(f.project, 'MCP'); fs.mkdirSync(context); fs.writeFileSync(path.join(context, 'README.md'), 'Selected MCP source\n');
    f.git(['add', '--', 'MCP/README.md']); f.git(['commit', '-m', 'Add nested project fixture']);
    const result = await f.planner.plan({ ...f.request, project: context });
    assert.equal(result.spec.project, f.project); assert.deepEqual(result.spec.tasks[0].files, ['MCP/feature.mjs']);
    assert.equal(f.planner.plans[0].context, context);
    outside = true;
    await assert.rejects(f.planner.plan({ ...f.request, project: context }), /outside the selected project folder/);
    assert.equal(calls, 2); assert.equal(f.planner.plans[1].status, 'attention'); assert.equal(f.git(['status', '--porcelain']), '');
  } finally { fs.rmSync(f.dir, { force: true, recursive: true }); }
});
