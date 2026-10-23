// E4c check derivation. Visible checks are the project's existing test entry points at
// the task's base commit; hidden checks come from the accepted final state (tests added
// or modified between base and final, tests touched by fix commits) and one judge check
// per contract requirement. Read-only git only; every argv satisfies Relay's check rules.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const CHECK_TIMEOUT_MS = 600_000;
export const MAX_VISIBLE = 12;
export const MAX_HIDDEN = 24;
// Relay accepts at most 24 argv items per check; keep room for the runner prefix.
const FILES_PER_CHECK = 16;
const SHA = /^[a-f0-9]{40}$/;
const OUTPUT_LIMIT = 32 * 1024 * 1024;

// Mirrors server/missions.mjs checks(): no shells, providers, destructive commands,
// installs/publication, npx without --no-install, or mutating git.
const BLOCKED = /^(?:bash|sh|zsh|fish|cmd|powershell|pwsh|wscript|cscript|rm|rmdir|del|erase|mv|remove-item|move-item|codex|claude|ai-chat|ai-loop|relay)(?:\.exe|\.cmd|\.bat)?$/i;
export function isRelayCheckArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 24) return false;
  if (argv.some(a => typeof a !== 'string' || !a || a.length > 2000 || /[\u0000-\u001f]/.test(a))) return false;
  const exe = path.basename(argv[0]);
  if (BLOCKED.test(exe) || /\.(?:bat|ps1)$/i.test(exe) || argv[0].startsWith('-')) return false;
  if (/^(?:npm|pnpm|yarn|npx)(?:\.cmd)?$/i.test(exe) && argv.slice(1).some(a => /^(?:install|i|ci|add|remove|uninstall|publish|exec|dlx)$/i.test(a))) return false;
  if (/^npx(?:\.cmd)?$/i.test(exe) && !argv.includes('--no-install')) return false;
  if (/^git(?:\.exe)?$/i.test(exe) && !['diff', 'status', 'ls-files', 'show', 'rev-parse', 'log'].includes(argv[1])) return false;
  return true;
}

// Test files the runners below can execute. Fixtures and dependencies are never tests.
const JS_TEST = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)|(?:test|tests|__tests__)\/(?:[^/]+\/)*[^/]+\.(?:mjs|cjs|js|ts|mts|cts))$/i;
const PY_TEST = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i;
const IGNORED = /(?:^|\/)(?:node_modules|fixtures|__fixtures__|__snapshots__|dist|build|coverage|\.git|vendor)\//i;
const TS = /\.(?:ts|tsx|mts|cts)$/i;
export const isTestFile = file => !IGNORED.test(file) && (JS_TEST.test(file) || PY_TEST.test(file));

// Commit subjects that mark a later correction of the task (English and Spanish).
export const FIX_SUBJECT = /\b(?:fix(?:es|ed)?|hotfix|bugfix|revert(?:s|ed)?|regression|arregl\w*|corrig\w*|correcci[oó]n)\b/i;

// npm/npx are .cmd shims on Windows; run their JS entry with node instead of a shell.
function resolveNpm(file, args) {
  if (process.platform !== 'win32' || !/^(?:npm|npx)(?:\.cmd)?$/i.test(path.basename(file))) return [file, args];
  const cli = /^npx/i.test(path.basename(file)) ? 'npx-cli.js' : 'npm-cli.js';
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter).map(p => p.replace(/^"|"$/g, ''))];
  for (const dir of dirs) { const script = path.join(dir, 'node_modules', 'npm', 'bin', cli); if (fs.existsSync(script)) return [process.execPath, [script, ...args]]; }
  return [file, args];
}

// A parent node:test run exports NODE_TEST_CONTEXT; a nested `node --test` check would then
// report to that parent and exit 0 even when it fails, so checks never inherit it.
function childEnv(extra) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Default argv runner: no shell, bounded output, timeout kills the process tree.
export function execArgv(file, args, { cwd, timeoutMs = 60_000, signal, env } = {}) {
  [file, args] = resolveNpm(file, args);
  return new Promise(resolve => {
    let child, stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false, settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      child = spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(env) });
    } catch (error) { done({ code: null, stdout: '', stderr: '', timedOut: false, error: error.code || 'spawn-failed' }); return; }
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch { /* already exited */ } }
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, timeoutMs));
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > OUTPUT_LIMIT) { overflow = true; kill(); return; }
        if (name === 'stdout') stdout += chunk; else stderr += chunk;
      });
    }
    child.on('error', error => { clearTimeout(timer); done({ code: null, stdout, stderr, timedOut, error: error.code || 'spawn-failed' }); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      done({ code: overflow ? null : code, stdout, stderr, timedOut, ...(overflow ? { error: 'output-limit' } : {}), ...(signal?.aborted ? { error: 'aborted' } : {}) });
    });
  });
}

const gitReader = (exec, repo, timeoutMs) => async args => {
  const result = await exec('git', ['-C', repo, ...args], { timeoutMs });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
};

// readFile(commit, relativePath) → string | null, through `git show` (never the work tree).
const defaultReadFile = (exec, repo, timeoutMs) => async (commit, file) => {
  const result = await exec('git', ['-C', repo, 'show', `${commit}:${file}`], { timeoutMs });
  return result.code === 0 ? result.stdout : null;
};

function parseJson(text) { try { const value = JSON.parse(text.replace(/^﻿/, '')); return value && typeof value === 'object' ? value : null; } catch { return null; } }
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const realScript = script => typeof script === 'string' && script.trim() && !/no test specified/i.test(script);
const check = (argv, origin, description) => ({ argv, origin, description: description.slice(0, 300), timeoutMs: CHECK_TIMEOUT_MS });

async function pytestDeclared(readFile, commit, tree) {
  if (tree.has('pytest.ini') || tree.has('conftest.py')) return true;
  for (const [file, marker] of [['pyproject.toml', /\[tool\.pytest|\bpytest\b/], ['setup.cfg', /\[tool:pytest\]/], ['tox.ini', /\[pytest\]/]]) {
    if (!tree.has(file)) continue;
    const text = await readFile(commit, file);
    if (text && marker.test(text)) return true;
  }
  return false;
}

// Builds the argv that runs exactly these test files with the stack's runner.
function runnerFor(files, testScript) {
  const python = files.filter(f => PY_TEST.test(f));
  const js = files.filter(f => !PY_TEST.test(f));
  const groups = [], skipped = [];
  if (python.length) for (const part of chunks(python, FILES_PER_CHECK)) groups.push(['python', '-m', 'pytest', '-q', ...part]);
  if (js.length) {
    const script = String(testScript || '');
    if (/\bvitest\b/.test(script)) for (const part of chunks(js, FILES_PER_CHECK)) groups.push(['npx', '--no-install', 'vitest', 'run', ...part]);
    else if (/\bjest\b/.test(script)) for (const part of chunks(js, FILES_PER_CHECK)) groups.push(['npx', '--no-install', 'jest', ...part]);
    else {
      const runnable = js.filter(f => !TS.test(f));
      skipped.push(...js.filter(f => TS.test(f)));
      for (const part of chunks(runnable, FILES_PER_CHECK)) groups.push(['node', '--test', ...part]);
    }
  }
  return { groups, skipped };
}

// Returns { visible, hidden, reason }. reason is null when both lists were derived normally.
export async function deriveChecks({ task, exec = execArgv, readFile, timeoutMs = 60_000 } = {}) {
  const reasons = [];
  const empty = reason => ({ visible: [], hidden: [], reason });
  if (!task?.repoRoot) return empty('no git repository');
  if (!SHA.test(task.baseCommit || '')) return empty('base commit missing');
  const repo = task.repoRoot, git = gitReader(exec, repo, timeoutMs);
  readFile ??= defaultReadFile(exec, repo, timeoutMs);
  let tree;
  try { tree = new Set((await git(['ls-tree', '-r', '--name-only', '-z', task.baseCommit])).split('\0').filter(Boolean)); }
  catch { return empty('base commit unreadable'); }

  // Visible: existing entry points at the base commit.
  const visible = [];
  const basePackage = tree.has('package.json') ? parseJson(await readFile(task.baseCommit, 'package.json') || '') : null;
  const scripts = basePackage?.scripts && typeof basePackage.scripts === 'object' ? basePackage.scripts : {};
  if (realScript(scripts.test)) visible.push(check(['npm', 'test'], 'existing-test', 'Existing npm test script at the base commit'));
  for (const name of ['typecheck', 'lint', 'build']) if (realScript(scripts[name])) visible.push(check(['npm', 'run', name], 'existing-test', `Existing npm ${name} script at the base commit`));
  if (await pytestDeclared(readFile, task.baseCommit, tree)) visible.push(check(['python', '-m', 'pytest', '-q'], 'existing-test', 'Existing pytest configuration at the base commit'));
  if (!realScript(scripts.test)) {
    const nodeTests = [...tree].filter(f => isTestFile(f) && !PY_TEST.test(f) && !TS.test(f)).sort();
    for (const part of chunks(nodeTests, FILES_PER_CHECK)) visible.push(check(['node', '--test', ...part], 'existing-test', 'Existing node:test files at the base commit'));
  }
  if (!visible.length) reasons.push('no recognized test entry point at the base commit');
  if (visible.length > MAX_VISIBLE) { reasons.push(`visible checks truncated to ${MAX_VISIBLE}`); visible.length = MAX_VISIBLE; }

  // Hidden: accepted final state and later fix commits.
  const hidden = [];
  if (SHA.test(task.finalCommit || '') && task.finalCommit !== task.baseCommit) {
    try {
      const changed = (await git(['diff', '--name-status', '--no-renames', '-z', task.baseCommit, task.finalCommit])).split('\0');
      const tests = new Set();
      for (let i = 0; i + 1 < changed.length; i += 2) if (/^[AM]$/.test(changed[i]) && isTestFile(changed[i + 1])) tests.add(changed[i + 1]);
      const fixTests = new Set();
      const log = await git(['log', '--no-merges', '--format=%x01%s', '--name-only', `${task.baseCommit}..${task.finalCommit}`]);
      for (const block of log.split('\x01').slice(1)) {
        const [subject, ...files] = block.split('\n');
        if (FIX_SUBJECT.test(subject)) for (const file of files.map(f => f.trim())) if (tests.has(file)) fixTests.add(file);
      }
      const finalPackage = parseJson(await readFile(task.finalCommit, 'package.json') || '');
      const testScript = finalPackage?.scripts?.test ?? scripts.test;
      const skipped = [];
      for (const [origin, files, label] of [
        ['final-state-test', [...tests].filter(f => !fixTests.has(f)).sort(), 'Tests added or changed in the accepted final state'],
        ['fix-commit', [...fixTests].sort(), 'Tests touched by later fix commits'],
      ]) {
        const { groups, skipped: unsupported } = runnerFor(files, testScript);
        skipped.push(...unsupported);
        for (const argv of groups) hidden.push(check(argv, origin, label));
      }
      if (skipped.length) reasons.push(`${skipped.length} hidden test file(s) need an unsupported runner`);
    } catch { reasons.push('final commit unreadable'); }
  } else reasons.push('final commit missing');
  for (const requirement of task.requirements ?? []) {
    hidden.push(check(['node', 'evals/benchmark/judge-requirement.mjs', '--task', task.id, '--requirement', String(requirement.id)],
      'contract-requirement', `Contract requirement ${requirement.id}, applied by the result judge`));
  }
  if (hidden.length > MAX_HIDDEN) { reasons.push(`hidden checks truncated to ${MAX_HIDDEN}`); hidden.length = MAX_HIDDEN; }
  const invalid = [...visible, ...hidden].filter(c => !isRelayCheckArgv(c.argv));
  if (invalid.length) throw new Error('Derived a check that violates Relay check rules.');
  return { visible, hidden, reason: reasons.length ? reasons.join('; ') : null };
}

// Test files referenced by a hidden check's argv (used by the runner to materialize them).
export const checkTestFiles = check => check.argv.filter(arg => !arg.startsWith('-') && isTestFile(arg) && !path.isAbsolute(arg) && !arg.split('/').includes('..'));
export const isRunnableHidden = check => check.origin !== 'contract-requirement';
