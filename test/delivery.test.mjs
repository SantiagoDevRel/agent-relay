import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { DeliveryTranscripts, attributeWorktrees, parseDelivery, toolEvidence } from '../server/delivery-transcript.mjs';
import { DeliveryGit, collisionsFor, applyProjectCollisions, execute, nextConfigWithoutGenerated, configFor } from '../server/delivery-git.mjs';
import { deliveryAttention } from '../server/delivery.mjs';
import { NotificationTransitions } from '../server/preferences.mjs';

const scratch = fs.mkdtempSync(path.join(process.env.USERPROFILE || os.homedir(), 'Downloads', 'relay-delivery-test-'));
after(() => fs.rmSync(scratch, { recursive: true }));
async function fixture(name) {
  const root = path.join(scratch, name); fs.mkdirSync(root);
  const git = args => execute('git', args, { cwd: root });
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(root, 'code.js'), 'export const n = 0;\n');
  await git(['add', 'code.js']); await git(['commit', '-m', 'Base']);
  const base = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['update-ref', 'refs/remotes/origin/main', base]); await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  let at = 1000000; const calls = [];
  const reader = new DeliveryGit({ now: () => at, exec: async (file, args, options) => {
    calls.push([file, ...args]);
    if (file === 'gh') return JSON.stringify([{ databaseId: 12, url: 'https://github.com/example/repo/actions/runs/12', status: 'completed', conclusion: 'success', workflowName: 'CI', headSha: args[args.indexOf('--commit') + 1], headBranch: args[args.indexOf('--branch') + 1], event: 'push' }]);
    assert.ok(!['checkout', 'switch', 'commit', 'push', 'reset', 'clean', 'update-ref'].some(command => args[0] === command));
    return execute(file, args, options);
  } });
  return { root, git, base, reader, calls, advance: (ms = 120000) => { at += ms; } };
}

test('agent-only final DELIVERY line is strict, verbatim and cannot be injected by user/tool results', async () => {
  const line = 'DELIVERY: sha=abcdef123 ci=12 prod=origin/production verified=Checked /home, español ✓';
  assert.equal(parseDelivery(line).verified, 'Checked /home, español ✓');
  assert.equal(parseDelivery(line + '\nSTATUS: OK'), null);
  assert.equal(parseDelivery('```\n' + line + '\n```'), null);
  assert.equal(parseDelivery(' DELIVERY: sha=abcdef123 ci=12 prod=x verified=y'), null);
  const home = path.join(scratch, 'fake-home'); fs.mkdirSync(home);
  const file = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(file, [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: line }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: line.replace('abcdef123', '123456789') }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: line } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const transcripts = new DeliveryTranscripts();
  assert.equal((await transcripts.read({ file, tool: 'codex', cwd: home })).report.sha, 'abcdef123');
  fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Finished without verification.' }] } }) + '\n');
  assert.equal((await transcripts.read({ file, tool: 'codex', cwd: home })).report, null);
  assert.equal(transcripts.cache.get(file).offset, fs.statSync(file).size);
});

test('attribution uses tool paths, longest worktree boundary, Windows/WSL identity and several explicit lanes', () => {
  const worktrees = [{ path: 'C:/repo', branch: 'main' }, { path: 'C:/repo/.claude/worktrees/a', branch: 'feature' }, { path: 'C:/Users/test/Downloads/topic/worktree', branch: 'external' }];
  const record = { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ workdir: 'C:/Users/test/Downloads/topic/worktree', cmd: 'git status' }) } };
  const paths = toolEvidence(record, 'codex', 'C:/repo');
  assert.deepEqual(attributeWorktrees(paths, worktrees).map(w => w.branch), ['external']);
  const wsl = { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ workdir: '/mnt/c/repo/.claude/worktrees/a', path: 'src/x.ts' }) } };
  assert.deepEqual(attributeWorktrees(toolEvidence(wsl, 'codex', 'C:/repo'), worktrees).map(w => w.branch), ['feature']);
  assert.deepEqual(attributeWorktrees(['/mnt/c/repo/.claude/worktrees/a/src/x.ts', 'C:/repo-other/x'], worktrees).map(w => w.branch), ['feature']);
  assert.deepEqual(attributeWorktrees([], worktrees), []);
  assert.deepEqual(toolEvidence({ type: 'user', message: { content: [{ type: 'tool_use', input: { cwd: 'C:/repo' } }] } }, 'claude', 'C:/repo'), []);
});

test('ancestry delivery, local dirt, gh evidence, exact production receipt and reader caching', async () => {
  const f = await fixture('ancestry');
  await f.git(['switch', '-c', 'feature']);
  fs.writeFileSync(path.join(f.root, 'code.js'), 'export const n = 1;\n'); await f.git(['add', 'code.js']); await f.git(['commit', '-m', 'Feature']);
  const head = (await f.git(['rev-parse', 'HEAD'])).trim();
  await f.git(['update-ref', 'refs/remotes/origin/main', head]); await f.git(['update-ref', 'refs/remotes/origin/production', head]);
  fs.writeFileSync(path.join(f.root, '.agent-relay-delivery.json'), JSON.stringify({ productionRef: 'origin/production', ignored: ['.agent-relay-delivery.json'] }));
  fs.writeFileSync(path.join(f.root, 'dirty.js'), 'const dirty = true;');
  const repo = await f.reader.repository(f.root), lane = await f.reader.lane(repo, repo.worktrees[0]);
  assert.equal(lane.local, 1); assert.equal(lane.committed, 0); assert.equal(lane.onMain, true); assert.equal(lane.production, true); assert.equal(lane.mainCommit, head); assert.equal(lane.ci.state, 'success');
  assert.ok(!lane.files.includes('code.js'), 'integrated history is outside the pending collision diff');
  assert.ok(lane.files.includes('dirty.js'));
  const count = f.calls.length; await f.reader.lane(repo, repo.worktrees[0]); assert.equal(f.calls.length, count);
  const chat = { id: 'agent', alive: true };
  const report = { sha: head, ci: '12', prod: 'origin/production', verified: 'Checked the real home' };
  const value = await f.reader.chat(repo, chat, { paths: [f.root], complete: true, report });
  assert.equal(value.lanes[0].verification.state, 'verified');
  const incomplete = await f.reader.chat(repo, chat, { paths: [f.root], complete: false, report });
  assert.equal(incomplete.state, 'unknown'); assert.equal(incomplete.lanes[0].verification.state, 'not reported', 'an unread tail cannot prove the last assistant receipt');
  assert.equal((await f.reader.chat(repo, chat, { paths: [f.root], complete: true, report: { ...report, sha: 'abcdef123' } })).lanes[0].verification.state, 'not reported');
  f.advance(30000); await f.reader.lane(repo, repo.worktrees[0]);
  const refreshedCalls = f.calls.length; await f.reader.lane(repo, repo.worktrees[0]);
  assert.equal(f.calls.length, refreshedCalls, 'an unchanged refresh renews the shared worktree 30 second cache');
  f.advance(90000); await f.reader.lane(repo, repo.worktrees[0]);
  assert.equal(f.calls.filter(c => c[0] === 'gh').length, 2);
});

test('stable patch IDs detect rebased/cherry-picked commits and map their main CI SHA', async () => {
  const f = await fixture('rebase');
  await f.git(['switch', '-c', 'feature']);
  fs.writeFileSync(path.join(f.root, 'code.js'), 'export const n = 1;\n'); await f.git(['add', 'code.js']); await f.git(['commit', '-m', 'Feature']);
  const laneSha = (await f.git(['rev-parse', 'HEAD'])).trim();
  await f.git(['switch', 'main']); fs.writeFileSync(path.join(f.root, 'other.js'), 'const another = true;\n'); await f.git(['add', 'other.js']); await f.git(['commit', '-m', 'Other']); await f.git(['cherry-pick', laneSha]);
  const main = (await f.git(['rev-parse', 'HEAD'])).trim(); await f.git(['update-ref', 'refs/remotes/origin/main', main]); await f.git(['switch', 'feature']);
  const repo = await f.reader.repository(f.root), lane = await f.reader.lane(repo, repo.worktrees[0]);
  assert.notEqual(laneSha, main); assert.equal(lane.onMain, true); assert.equal(lane.method, 'patch-id (rebase)'); assert.equal(lane.mainCommit, main); assert.equal(lane.ci.runs[0].headSha, main);
  assert.equal(lane.production, undefined, 'absent production refs hide that stage');
});

test('aggregate patch detects squash; different content stays outside main', async () => {
  const f = await fixture('squash'); await f.git(['switch', '-c', 'feature']);
  for (const n of [1, 2]) { fs.writeFileSync(path.join(f.root, 'code.js'), `export const n = ${n};\n`); await f.git(['add', 'code.js']); await f.git(['commit', '-m', 'Step ' + n]); }
  await f.git(['switch', 'main']); await f.git(['merge', '--squash', 'feature']); await f.git(['commit', '-m', 'Squash']);
  const main = (await f.git(['rev-parse', 'HEAD'])).trim(); await f.git(['update-ref', 'refs/remotes/origin/main', main]); await f.git(['switch', 'feature']);
  const repo = await f.reader.repository(f.root), lane = await f.reader.lane(repo, repo.worktrees[0]);
  assert.equal(lane.onMain, true); assert.equal(lane.method, 'patch-id (squash)'); assert.equal(lane.mainCommit, main);
  fs.writeFileSync(path.join(f.root, 'code.js'), 'export const n = 3;\n'); await f.git(['add', 'code.js']); await f.git(['commit', '-m', 'Unshipped']); f.advance();
  const unshipped = await f.reader.lane(await f.reader.repository(f.root), repo.worktrees[0]); assert.equal(unshipped.onMain, false); assert.equal(unshipped.committed, 3); assert.ok(unshipped.files.includes('code.js'));
});

test('collisions deduplicate each chat, exclude inactive/doc/generated lanes and allow repo patterns', () => {
  const rows = [{ chatId: 'a', active: true, files: ['src/x.ts', 'src/x.ts', 'docs/a.md', 'src/generated.ts', 'src/z.ts'] }, { chatId: 'b', active: true, files: ['src/x.ts', 'docs/a.md', 'src/generated.ts'] }, { chatId: 'c', active: false, files: ['src/z.ts'] }];
  assert.deepEqual(collisionsFor(rows, { ignored: [], collisionIgnored: ['docs/**', '**/*generated*'] }), [{ file: 'src/x.ts', chats: ['a', 'b'] }]);
  assert.equal(collisionsFor(rows, { ignored: ['src/x.ts'], collisionIgnored: ['docs/**', '**/*generated*'] }).length, 0);
});

test('Next generated dist entries alone are noise; source compiler changes remain visible', () => {
  const before = { compilerOptions: { strict: true }, include: ['src/**/*.ts', '.next/types/**/*.ts'] };
  assert.equal(nextConfigWithoutGenerated(JSON.stringify(before)), nextConfigWithoutGenerated(JSON.stringify({ ...before, include: ['src/**/*.ts', '.next-test/types/**/*.ts'] })));
  assert.notEqual(nextConfigWithoutGenerated(JSON.stringify(before)), nextConfigWithoutGenerated(JSON.stringify({ ...before, compilerOptions: { strict: false } })));
});

test('attention covers CI failure, finished unmerged commits, new collisions and the exact 30 minute threshold', () => {
  const lane = { ci: { state: 'failure' }, committed: 2, onMain: false, production: true, verification: { state: 'not reported' }, collisions: ['src/x.ts'] };
  const delivery = { state: 'attributed', lanes: [lane] };
  assert.equal(deliveryAttention({ state: 'waiting' }, delivery, 30 * 60000 - 1, 0).length, 3);
  assert.equal(deliveryAttention({ state: 'waiting' }, delivery, 30 * 60000, 0).length, 4);
  assert.equal(deliveryAttention({ state: 'working' }, { ...delivery, lanes: [{ ...lane, ci: { state: 'success' }, collisions: [], verification: { state: 'verified' } }] }, 30 * 60000, 0).length, 0);
});

test('Delivery changes stay in dashboard attention and never become Windows notifications', () => {
  const transitions = new NotificationTransitions();
  const chat = { id: 'a', alive: true, state: 'working', delivery: { state: 'unknown', attention: [] } };
  assert.deepEqual(transitions.update([chat]), []);
  const ready = { ...chat, delivery: { state: 'attributed', attention: ['CI failed'] } };
  assert.deepEqual(transitions.update([ready]), []);
  const collision = { ...ready, delivery: { state: 'attributed', attention: ['CI failed', 'Code collision: src/x.ts'] } };
  assert.deepEqual(transitions.update([collision]), []);
  assert.deepEqual(transitions.update([collision]), []);
  transitions.reset(); assert.deepEqual(transitions.update([collision]), []);
});

test('Delivery indexing, new incidents and recovery stay silent while a finished turn still notifies', () => {
  const t = new NotificationTransitions();
  const chat = { id: 'a', alive: true, state: 'working', delivery: { state: 'attributed', attention: [], lanes: [] } };
  const incident = { ...chat, delivery: { ...chat.delivery, attention: ['CI failed', 'Code collision: src/a.ts, src/b.ts'] } };
  assert.deepEqual(t.update([chat], { deliveryReady: false }), []);
  for (let i = 0; i < 12; i++) assert.deepEqual(t.update([incident], { deliveryReady: false }), []);
  assert.deepEqual(t.update([incident]), [], 'first complete pass seeds all existing incidents silently');
  const reordered = { ...incident, delivery: { ...incident.delivery, attention: ['Code collision: src/b.ts, src/a.ts', 'CI failed'] } };
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(t.update([{ ...chat, delivery: { ...chat.delivery, stale: true } }]), []);
    assert.deepEqual(t.update([{ ...chat, delivery: { state: 'unknown', attention: [] } }]), []);
    assert.deepEqual(t.update([{ ...chat, delivery: { ...chat.delivery, error: 'unavailable' } }]), []);
    assert.deepEqual(t.update([reordered]), [], 'unchanged incidents remain deduplicated across 4 s cycles');
  }
  const newFile = { ...incident, delivery: { ...incident.delivery, attention: [...incident.delivery.attention, 'Code collision: src/c.ts'] } };
  assert.deepEqual(t.update([newFile]), [], 'a new collision changes dashboard attention only');
  assert.deepEqual(t.update([newFile]), []);
  assert.deepEqual(t.update([chat]), [], 'a complete healthy pass resolves the incident');
  assert.deepEqual(t.update([incident]), [], 'a recurring incident stays silent in Windows');
  assert.equal(t.update([{ ...incident, state: 'waiting' }])[0].notificationKind, 'turn', 'a finished turn must not be mislabeled as another Delivery incident');
});

test('cold large histories use bounded head/tail and incremental reads without interpreting omitted user prose', async () => {
  const file = path.join(scratch, 'bounded.jsonl'), cwd = path.join(scratch, 'repo');
  const tool = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ workdir: cwd, cmd: 'git status' }) } }) + '\n';
  const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'x'.repeat(64 * 1024) }] } }) + '\n';
  fs.writeFileSync(file, tool + user.repeat(100) + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'DELIVERY: sha=abcdef123 ci=12 prod=origin/production verified=Real check' } }) + '\n');
  const reader = new DeliveryTranscripts(); let result;
  do { result = await reader.read({ file, cwd, tool: 'codex' }); } while (!result.atEnd);
  assert.equal(result.complete, true); assert.equal(result.entire, false); assert.ok(result.paths.includes(cwd)); assert.equal(result.report.sha, 'abcdef123');
  const before = reader.cache.get(file).offset; fs.appendFileSync(file, tool);
  result = await reader.read({ file, cwd, tool: 'codex' }); assert.ok(reader.cache.get(file).offset > before); assert.equal(result.report.sha, 'abcdef123');
});

test('missing transcripts and unavailable Git stay unknown without an endless indexing queue', async () => {
  const reader = new DeliveryTranscripts();
  const missing = await reader.read({ tool: 'codex', cwd: scratch });
  assert.equal(missing.atEnd, true); assert.equal(missing.complete, false);
  const git = new DeliveryGit({ exec: async () => { throw Error('git timed out'); } });
  await assert.rejects(git.root(scratch), /timed out/);
  const notGit = new DeliveryGit({ exec: async () => { throw Object.assign(Error('git exited 128'), { detail: 'fatal: not a git repository' }); } });
  assert.equal(await notGit.root(scratch), null);
});

test('an empty last Claude assistant message clears an older receipt; oversized lines never verify', async () => {
  const file = path.join(scratch, 'claude-last-message.jsonl');
  const line = 'DELIVERY: sha=abcdef123 ci=12 prod=origin/production verified=Checked';
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: line }] } }) + '\n');
  const reader = new DeliveryTranscripts(), chat = { file, cwd: scratch, tool: 'claude' };
  assert.equal((await reader.read(chat)).report.sha, 'abcdef123');
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n');
  assert.equal((await reader.read(chat)).report, null);
  assert.equal(parseDelivery(line + 'x'.repeat(2048)), null);
});

test('fetch and Actions reads honor the 120 second boundary with fixed remote-only fetch argv', async () => {
  const f = await fixture('cadence'); let at = 0;
  const calls = [];
  const reader = new DeliveryGit({ now: () => at, exec: async (file, args, options) => {
    calls.push([file, ...args]);
    if (file === 'gh') return JSON.stringify([{ databaseId: 1, headSha: f.base, headBranch: 'main', workflowName: 'CI', event: 'push', status: 'in_progress', conclusion: '' }]);
    if (args[0] === 'remote') return 'https://github.com/example/repo.git';
    if (args[0] === 'fetch') return '';
    return execute(file, args, options);
  } });
  await reader.repository(f.root); assert.equal((await reader.ciFor(f.root, f.base, 'origin/main')).state, 'pending');
  at = 119999; await reader.repository(f.root); await reader.ciFor(f.root, f.base, 'origin/main');
  assert.equal(calls.filter(c => c[1] === 'fetch').length, 1); assert.equal(calls.filter(c => c[0] === 'gh').length, 1);
  at = 120000; await reader.repository(f.root); await reader.ciFor(f.root, f.base, 'origin/main');
  assert.equal(calls.filter(c => c[1] === 'fetch').length, 2); assert.equal(calls.filter(c => c[0] === 'gh').length, 2);
  assert.deepEqual(calls.find(c => c[1] === 'fetch'), ['git', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
});

test('nested Next generated config is excluded while new code files and compiler edits stay visible', async () => {
  const f = await fixture('nested-next'), nested = path.join(f.root, 'apps', 'pwa'); fs.mkdirSync(nested, { recursive: true });
  const config = { compilerOptions: { strict: true }, include: ['src/**/*.ts', '.next/types/**/*.ts'] };
  fs.writeFileSync(path.join(nested, 'tsconfig.json'), JSON.stringify(config)); await f.git(['add', 'apps/pwa/tsconfig.json']); await f.git(['commit', '-m', 'Nested Next config']);
  await f.git(['update-ref', 'refs/remotes/origin/main', (await f.git(['rev-parse', 'HEAD'])).trim()]);
  fs.writeFileSync(path.join(nested, 'tsconfig.json'), JSON.stringify({ ...config, include: ['src/**/*.ts', '.next-dev/types/**/*.ts'] }));
  fs.mkdirSync(path.join(nested, 'src')); fs.writeFileSync(path.join(nested, 'src', 'new.ts'), 'export const added = 1;');
  fs.mkdirSync(path.join(nested, '.next-dev'), { recursive: true }); fs.writeFileSync(path.join(nested, '.next-dev', 'index.json'), '{}');
  fs.mkdirSync(path.join(f.root, 'supabase', '.temp'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'supabase', '.temp', 'cli-latest'), 'generated metadata');
  const repo = await f.reader.repository(f.root), lane = await f.reader.lane(repo, repo.worktrees[0]);
  assert.deepEqual(lane.localFiles, ['apps/pwa/src/new.ts']); assert.ok(lane.files.includes('apps/pwa/src/new.ts'));
  fs.writeFileSync(path.join(nested, 'tsconfig.json'), JSON.stringify({ ...config, compilerOptions: { strict: false } })); f.advance();
  assert.ok((await f.reader.lane(repo, repo.worktrees[0])).localFiles.includes('apps/pwa/tsconfig.json'));
});

test('an incomplete appended JSON record does not assert complete transcript coverage', async () => {
  const file = path.join(scratch, 'incomplete-tail.jsonl'); fs.writeFileSync(file, '{"type":"assistant"');
  const reader = new DeliveryTranscripts(), chat = { file, cwd: scratch, tool: 'claude' };
  const partial = await reader.read(chat); assert.equal(partial.atEnd, true); assert.equal(partial.complete, false);
  fs.appendFileSync(file, ',"message":{"content":[]}}\n'); assert.equal((await reader.read(chat)).complete, true);
});

test('incremental publications preserve collisions until files or actual liveness change', () => {
  const repo = { root: 'C:/repo', config: { ignored: [], collisionIgnored: [] } };
  const state = id => ({ state: 'attributed', project: repo.root, lanes: [{ chatId: id, files: ['src/shared.ts'], collisions: [] }] });
  const values = new Map([['a', state('a')], ['b', state('b')]]), active = new Set(['a', 'b']);
  applyProjectCollisions(values, repo, active); assert.deepEqual(values.get('a').lanes[0].collisions, ['src/shared.ts']);
  values.set('a', state('a')); applyProjectCollisions(values, repo, active);
  assert.deepEqual(values.get('a').lanes[0].collisions, ['src/shared.ts'], 'fresh lane never publishes an artificial empty collision baseline');
  applyProjectCollisions(values, repo, new Set(['a'])); assert.deepEqual(values.get('a').lanes[0].collisions, []);
});

test('non-code artifacts do not collide and oversized worktrees fail explicitly with cached errors', async () => {
  const artifacts = ['src/shared.ts', 'shot.png', 'console.log', 'session.jsonl', 'cache.pyc', '.ai-chat-home/.claude.json', '.playwright-mcp/probe.js'];
  assert.deepEqual(collisionsFor(['a','b'].map(chatId => ({ chatId, active: true, files: artifacts })), configFor(scratch)), [{ file: 'src/shared.ts', chats: ['a','b'] }]);
  let calls = 0, now = 100000;
  const reader = new DeliveryGit({ network: false, now: () => now, exec: async (_file, args) => {
    calls++;
    if (args[0] === 'status') return Array.from({ length: 4097 }, (_, i) => '?? src/file'+i+'.ts\0').join('');
    if (args.includes('HEAD')) return 'a'.repeat(40);
    return '.git/index';
  } });
  const worktree = { path: scratch, branch: 'main' };
  await assert.rejects(reader.lane({}, worktree), /4096-file bound/);
  const firstCalls = calls; await assert.rejects(reader.lane({}, worktree), /4096-file bound/); assert.equal(calls, firstCalls);
  now += 30000; await assert.rejects(reader.lane({}, worktree), /4096-file bound/); assert.ok(calls > firstCalls);
});

test('shared incidents and changing commit SHAs cannot queue Windows toasts across chats', () => {
  const t = new NotificationTransitions(), chats = ['a','b','c'].map(id => ({ id, alive: true, state: 'working', delivery: { state: 'attributed', project: 'C:/repo', lanes: [], attention: [] } }));
  assert.deepEqual(t.update(chats), []);
  const incident = chats.map(chat => ({ ...chat, delivery: { ...chat.delivery, attention: ['Code collision: src/x.ts'] } }));
  assert.deepEqual(t.update(incident), []); assert.deepEqual(t.update(incident), []);
  const other = { ...chats[2], delivery: { ...chats[2].delivery, project: 'C:/other', attention: ['Code collision: src/x.ts'] } };
  assert.deepEqual(t.update([incident[0], incident[1], other]), []);
  assert.deepEqual(t.update(chats), []); assert.deepEqual(t.update(incident), []);
  const newcomerFirst = new NotificationTransitions(); newcomerFirst.update(chats);
  assert.deepEqual(newcomerFirst.update([{ ...incident[0], id: 'new' }, ...incident]), []);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(t.update(incident.map(chat => ({ ...chat, delivery: { ...chat.delivery,
      attention: ['CI failed', 'Production check not reported within 30 minutes', 'Code collision: src/'+i+'.ts'],
      lanes: [{ head: String(i).padStart(40, '0'), mainCommit: String(i+1).padStart(40, '0') }] } }))), []);
  }
  const finished = incident.map(chat => ({ ...chat, state: 'waiting' }));
  assert.deepEqual(t.update(finished).map(chat => chat.notificationKind), ['turn', 'turn', 'turn']);
  assert.deepEqual(t.update(finished), []);
  assert.deepEqual(t.update(finished.map(chat => ({ ...chat, alive: false, state: 'cut' }))).map(chat => chat.notificationKind), ['cut', 'cut', 'cut']);
});

test('No code evidence is published immediately before the worker completes its pass', async () => {
  const worker = new Worker(new URL('../server/delivery-worker.mjs', import.meta.url), { env: { ...process.env, HOME: scratch, USERPROFILE: scratch, LOCALAPPDATA: scratch } });
  const frames = []; let deadline;
  try {
    const done = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(Error('Isolated No code worker timed out')), 10000);
      worker.on('error', reject); worker.on('message', frame => { frames.push(frame); if (frame.done) resolve(); });
    });
    worker.postMessage({ chats: [{ id: 'isolated', cwd: scratch, tool: 'claude', alive: true }] });
    await done;
    const first = frames.find(frame => frame.values);
    assert.equal(first.done, undefined, 'a completed fast row does not wait for a pass-wide barrier');
    assert.equal(first.values[0][1].state, 'no-code');
  } finally { clearTimeout(deadline); await worker.terminate(); }
});

test('a non-fast-forward integration uses real main CI and rejects side-branch runs', async () => {
  const f = await fixture('non-ff'); await f.git(['switch', '-c', 'feature']);
  fs.writeFileSync(path.join(f.root, 'code.js'), 'export const n = 1;\n'); await f.git(['add', 'code.js']); await f.git(['commit', '-m', 'Feature']);
  const feature = (await f.git(['rev-parse', 'HEAD'])).trim();
  await f.git(['switch', 'main']); fs.writeFileSync(path.join(f.root, 'other.js'), 'export const other = 1;'); await f.git(['add', 'other.js']); await f.git(['commit', '-m', 'Other']);
  await f.git(['merge', '--no-ff', 'feature', '-m', 'Integrate']); const main = (await f.git(['rev-parse', 'HEAD'])).trim();
  await f.git(['update-ref', 'refs/remotes/origin/main', main]); await f.git(['switch', 'feature']);
  const exec = f.reader.exec; f.reader.exec = async (file, args, options) => {
    const result = await exec(file, args, options);
    return file === 'gh' && args.includes(feature) ? JSON.stringify(JSON.parse(result).map(run => ({ ...run, headBranch: 'feature' }))) : result;
  };
  const repo = await f.reader.repository(f.root), lane = await f.reader.lane(repo, repo.worktrees[0]);
  assert.equal(lane.onMain, true); assert.equal(lane.ci.state, 'success'); assert.equal(lane.ci.runs[0].headSha, main); assert.equal(lane.ci.runs[0].headBranch, 'main');
  for (const call of f.calls.filter(call => call[0] === 'gh')) assert.equal(call[call.indexOf('--branch') + 1], 'main');
});
