// 72 h Git follow-up against a real temporary repository with controlled dates,
// plus the unknown cases and the timeout path with a fake exec.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitOutcomes, repoRootOf, createGitCache, defaultExec } from '../evals/git-outcomes.mjs';
import { classifyCommand, commitShas, localDir } from '../evals/sources/shell.mjs';

const HOUR = 3600;
const NOW_S = Math.floor(Date.now() / 1000);
const T0 = NOW_S - 10 * 24 * HOUR;

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-git-'));
  const git = (args, at) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      ...(at ? { GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` } : {}) },
  }).trim();
  git(['init', '-q']);
  const commit = (file, content, message, at) => {
    fs.writeFileSync(path.join(dir, file), content);
    git(['add', file]);
    git(['commit', '-q', '-m', message], at);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit };
}

test('gitOutcomes finds reverts, same-file fixes, none and open windows in a real repo', async () => {
  const { dir, git, commit } = makeRepo();
  try {
    const a = commit('a.txt', 'one\n', 'add greeting', T0);
    git(['revert', '--no-edit', a], T0 + 1 * HOUR);
    const c = commit('c.txt', 'parser v1\n', 'add parser', T0 + 5 * HOUR);
    const f = commit('c.txt', 'parser v2\n', 'fix broken parser', T0 + 6 * HOUR);
    const d = commit('d.txt', 'docs\n', 'add docs page', T0 + 7 * HOUR);
    commit('e.txt', 'typo\n', 'fix typo elsewhere', T0 + 8 * HOUR); // fix, but no shared file with d
    commit('d.txt', 'docs v2\n', 'fix docs', T0 + 100 * HOUR); // same file, after 72 h
    const young = commit('y.txt', 'new\n', 'add y', NOW_S - HOUR);

    const calls = [];
    const exec = (args, options) => { calls.push(args[0]); return defaultExec(args, options); };
    const cache = createGitCache();
    const input = [a, c, d, young].map(sha => ({ sha: sha.slice(0, 7), cwd: dir }));
    const out = await gitOutcomes(input, { exec, cache, now: NOW_S * 1000 });
    const root = (await repoRootOf(dir, { cache })).toLowerCase();
    for (const value of out.values()) assert.equal(value.repoRoot.toLowerCase(), root);

    const revert = out.get(a.slice(0, 7));
    assert.equal(revert.followUp, 'reverted');
    assert.equal(revert.fullSha, a);
    assert.equal(revert.hoursToFollowUp, 1);
    assert.match(revert.followUpSha, /^[a-f0-9]{40}$/);
    assert.deepEqual([out.get(c.slice(0, 7)).followUp, out.get(c.slice(0, 7)).followUpSha, out.get(c.slice(0, 7)).hoursToFollowUp], ['fixed', f, 1]);
    assert.equal(out.get(d.slice(0, 7)).followUp, 'none');
    assert.deepEqual([out.get(young.slice(0, 7)).followUp, out.get(young.slice(0, 7)).reason], ['unknown', 'window-open']);

    // Only read-only verbs; the overlapping windows of a, c and d share one log call.
    assert.deepEqual([...new Set(calls)].sort(), ['cat-file', 'diff-tree', 'log', 'rev-parse', 'show']);
    assert.equal(calls.filter(v => v === 'log').length, 1);
    calls.length = 0;
    const again = await gitOutcomes(input, { exec, cache, now: NOW_S * 1000 });
    assert.equal(calls.length, 0, 'second run is served from the cache');
    assert.equal(again.get(c.slice(0, 7)).followUp, 'fixed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitOutcomes: missing cwd, missing directory, non-repo and unknown SHA are unknown', async () => {
  const { dir, commit } = makeRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-plain-'));
  try {
    commit('a.txt', 'x\n', 'init', T0);
    const out = await gitOutcomes([
      { sha: '1111111', cwd: null },
      { sha: '2222222', cwd: path.join(plain, 'does-not-exist') },
      { sha: '3333333', cwd: plain },
      { sha: 'deadbee', cwd: dir },
      { sha: 'NOT-A-SHA', cwd: dir },
    ], { now: NOW_S * 1000 });
    assert.deepEqual(['1111111', '2222222', '3333333', 'deadbee'].map(sha => [out.get(sha).followUp, out.get(sha).reason]),
      [['unknown', 'no-repo'], ['unknown', 'no-repo'], ['unknown', 'no-repo'], ['unknown', 'unknown-sha']]);
    assert.ok(out.get('deadbee').repoRoot, 'the repository itself still resolves');
    assert.equal(out.has('NOT-A-SHA'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('gitOutcomes: an exec that never resolves yields unknown within the timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-hang-'));
  try {
    const started = Date.now();
    const out = await gitOutcomes([{ sha: 'abcdef1', cwd: dir }, { sha: 'abcdef2', cwd: dir }], { exec: () => new Promise(() => {}), timeoutMs: 50 });
    assert.deepEqual([out.get('abcdef1').followUp, out.get('abcdef2').followUp], ['unknown', 'unknown']);
    assert.ok(Date.now() - started < 3000, 'bounded by the per-call timeout and the cached failed root');
    // A failing log after a resolved commit is also unknown, never 'none'.
    const exec = async args => {
      if (args[0] === 'rev-parse') return '/repo\n';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'show') return `${'a'.repeat(40)}\x1f${T0}\n`;
      throw new Error('log failed');
    };
    const failed = await gitOutcomes([{ sha: 'aaaaaaa', cwd: dir }], { exec, now: NOW_S * 1000 });
    assert.deepEqual([failed.get('aaaaaaa').followUp, failed.get('aaaaaaa').reason], ['unknown', 'git-error']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a later fix that shares only Markdown or a lockfile is not a follow-up fix', async () => {
  const { dir, commit } = makeRepo();
  try {
    const a = commit('AGENTS.md', 'rules\n', 'add rules', T0);
    commit('AGENTS.md', 'rules v2\n', 'fix unrelated bug notes', T0 + HOUR);
    const b = commit('package-lock.json', '{}\n', 'add lockfile', T0 + 2 * HOUR);
    commit('package-lock.json', '{"a":1}\n', 'fix install', T0 + 3 * HOUR);
    const out = await gitOutcomes([a, b].map(sha => ({ sha: sha.slice(0, 7), cwd: dir })), { now: NOW_S * 1000 });
    assert.deepEqual([out.get(a.slice(0, 7)).followUp, out.get(b.slice(0, 7)).followUp], ['none', 'none']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generated files, fix words outside the subject and later commits of the same chat are not fixes', async () => {
  const { dir, commit } = makeRepo();
  try {
    const a = commit('contrato.generated.json', '{}\n', 'add contract', T0);
    commit('contrato.generated.json', '{"a":1}\n', 'fix contract', T0 + HOUR);
    const b = commit('b.js', 'one\n', 'add b', T0 + 2 * HOUR);
    commit('b.js', 'two\n', 'Record the guide entry\n\nMentions the replay fix in guides.', T0 + 3 * HOUR);
    const c = commit('c.js', 'one\n', 'add c', T0 + 4 * HOUR);
    const own = commit('c.js', 'two\n', 'fix c edge case', T0 + 5 * HOUR);
    const d = commit('d.js', 'one\n', 'add d', T0 + 6 * HOUR);
    const other = commit('d.js', 'two\n', 'fix d crash', T0 + 7 * HOUR);
    const input = [
      { sha: a.slice(0, 7), cwd: dir, chat: 'claude:one' }, { sha: b.slice(0, 7), cwd: dir, chat: 'claude:one' },
      { sha: c.slice(0, 7), cwd: dir, chat: 'claude:one' }, { sha: own.slice(0, 7), cwd: dir, chat: 'claude:one' },
      { sha: d.slice(0, 7), cwd: dir, chat: 'claude:one' }, { sha: other.slice(0, 7), cwd: dir, chat: 'codex:two' },
    ];
    const out = await gitOutcomes(input, { now: NOW_S * 1000 });
    assert.deepEqual([a, b, c, d].map(sha => out.get(sha.slice(0, 7)).followUp), ['none', 'none', 'none', 'fixed']);
    assert.equal(out.get(d.slice(0, 7)).followUpSha, other);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file: URLs and Git Bash /c/ paths become native directories for Git lookups', async () => {
  assert.equal(localDir('file:///C:/Users/example/My%20repo'), String.raw`C:\Users\example\My repo`);
  assert.equal(localDir('/c/Users/example/repo'), String.raw`C:\Users\example\repo`);
  assert.equal(localDir('/d'), 'D:\\');
  assert.equal(localDir('C:/Users/example'), 'C:/Users/example', 'native paths keep their form');
  assert.equal(localDir('/home/user/repo'), '/home/user/repo');
  assert.equal(localDir(null), null);
  assert.deepEqual(classifyCommand('git commit -m x', 'file:///C:/r/s'), [{ category: 'git-commit', cwd: String.raw`C:\r\s` }]);
  assert.deepEqual(classifyCommand('cd sub && npm test', 'file:///C:/r'), [{ category: 'test', cwd: String.raw`C:\r\sub` }]);
  const { dir } = makeRepo();
  try {
    const root = await repoRootOf(pathToFileURL(dir).href, { cache: createGitCache() });
    assert.equal(fs.realpathSync(root), fs.realpathSync(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quiet commits followed by a one-line log or rev-parse still yield the new SHA', () => {
  assert.deepEqual(commitShas('[main 1a2b3c4] add parser\n 1 file changed'), ['1a2b3c4']);
  assert.deepEqual(commitShas('58846f0 chore: scaffold app\n=== branch ===\nmaster'), ['58846f0']);
  assert.deepEqual(commitShas('warning: LF will be replaced\r\n9f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c\r\n'), ['9f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c']);
  assert.deepEqual(commitShas('12345678\tsrc\n'), [], 'digits only are sizes, not SHAs');
  assert.deepEqual(commitShas('nothing to commit, working tree clean'), []);
});
