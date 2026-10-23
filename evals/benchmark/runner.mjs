// E4c benchmark runner. Explicit command only: never call it from the weekly path.
// For each (task, variant) pair not yet in the JSONL checkpoint it clones the source repo
// into a scratch directory at the base commit, optionally refines the prompt with
// agent-relay-spec, runs a one-task Relay mission whose checks are the visible checks,
// then runs the executable hidden checks against the verified candidate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median } from '../stats.mjs';
import { estimateSuite, SAMPLE_LIMIT } from './suite.mjs';
import { execArgv, isRelayCheckArgv, checkTestFiles, isRunnableHidden, CHECK_TIMEOUT_MS } from './hidden-checks.mjs';

export const DEFAULT_VARIANTS = Object.freeze([
  Object.freeze({ id: 'claude-high', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', spec: false }),
  Object.freeze({ id: 'claude-high-spec', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', spec: true }),
]);
export const MAX_SAMPLE_VARIANTS = 2;
const VARIANT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 600_000;
const TERMINAL = new Set(['ready', 'applied', 'stopped', 'attention', 'expired', 'failed']);
const PASSED = new Set(['ready', 'applied']);
const RELAY_CLI = fileURLToPath(new URL('../../relay-cli.mjs', import.meta.url));

export const pairKey = (taskId, variantId) => `${taskId}|${variantId}`;
const dirName = (taskId, variantId) => `${taskId.replace(/^task:/, '')}-${variantId}`;
const short = value => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300);

export function validateVariants(variants) {
  if (!Array.isArray(variants) || !variants.length) throw new Error('At least one variant is required.');
  const ids = new Set();
  for (const v of variants) {
    if (!v || !VARIANT_ID.test(v.id || '') || ids.has(v.id)) throw new Error('Variant ids must be unique lowercase slugs.');
    if (!['claude', 'codex'].includes(v.provider)) throw new Error('Variant provider must be claude or codex.');
    if (v.model !== undefined && (typeof v.model !== 'string' || /fable/i.test(v.model))) throw new Error('Managed Fable inference is blocked; choose another model.');
    if (v.effort !== undefined && typeof v.effort !== 'string') throw new Error('Variant effort must be a string.');
    ids.add(v.id);
  }
  return variants.map(v => ({ id: v.id, provider: v.provider, model: v.model ?? '', effort: v.effort ?? 'high', spec: v.spec === true }));
}

// JSONL checkpoint: {type:'start'} before spending, {type:'result'} when a pair finishes.
// A torn last line from a crash is ignored.
export function readCheckpoint(file) {
  const started = new Set(), results = new Map();
  if (!file || !fs.existsSync(file)) return { started, results };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row?.type === 'start' && row.key) started.add(row.key);
    if (row?.type === 'result' && row.key && row.result) results.set(row.key, row.result);
  }
  return { started, results };
}
function appendCheckpoint(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Default Relay adapter: the installed relay CLI (node relay-cli.mjs) without a shell.
export function cliRelay({ exec = execArgv, cli = RELAY_CLI, scratch, pollMs = 30_000 } = {}) {
  const call = async (args, timeoutMs) => {
    const result = await exec(process.execPath, ['--no-warnings', cli, ...args], { timeoutMs });
    if (result.code !== 0) throw new Error(result.timedOut ? 'relay command timed out' : short(result.stderr.replace(/^relay:\s*/, '')) || 'relay command failed');
    return JSON.parse(result.stdout);
  };
  const request = (name, body) => {
    fs.mkdirSync(scratch, { recursive: true });
    const file = path.join(scratch, `${name}-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    return `@${file}`;
  };
  const sleep = (ms, signal) => new Promise(resolve => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
  const relay = {
    refine: input => call(['refine', request('refine', input)], 960_000),
    create: contract => call(['create', request('contract', contract), '--start'], 400_000),
    status: id => call(['status', id, '--json'], 60_000),
    stop: id => call(['stop', id], 60_000),
    // Bounded wait inside an explicit command; stops the mission when the deadline passes.
    async waitForTerminal(id, { deadline, signal } = {}) {
      while (true) {
        const view = await relay.status(id);
        if (TERMINAL.has(view.status)) return view;
        if (signal?.aborted || Date.now() >= deadline) { try { return await relay.stop(id); } catch { return { ...view, waitTimedOut: true }; } }
        await sleep(Math.min(pollMs, Math.max(1000, deadline - Date.now())), signal);
      }
    },
  };
  return relay;
}

const git = async (exec, cwd, args, timeoutMs = GIT_TIMEOUT_MS) => {
  const result = await exec('git', ['-C', cwd, ...args], { timeoutMs });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed${result.timedOut ? ' (timeout)' : ''}`);
  return result.stdout;
};

// Read-only clone of the source at the base commit. Every other ref and the reflog are
// removed from the scratch clone so the worker cannot browse the accepted final state.
export async function prepareClone({ exec = execArgv, repoRoot, baseCommit, dir, branch = 'relay-evals/bench' }) {
  if (fs.existsSync(dir)) throw new Error('The pair work directory already exists; inspect it before reusing.');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const clone = await exec('git', ['clone', '--no-hardlinks', '--quiet', repoRoot, dir], { timeoutMs: CLONE_TIMEOUT_MS });
  if (clone.code !== 0) throw new Error('git clone failed');
  await git(exec, dir, ['checkout', '--quiet', '--detach', baseCommit]);
  await git(exec, dir, ['checkout', '--quiet', '-b', branch]);
  const refs = (await git(exec, dir, ['for-each-ref', '--format=%(refname)'])).split('\n').map(r => r.trim()).filter(Boolean);
  for (const ref of refs) if (ref !== `refs/heads/${branch}`) await git(exec, dir, ['update-ref', '-d', ref]);
  await git(exec, dir, ['remote', 'remove', 'origin']).catch(() => {});
  await git(exec, dir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  await git(exec, dir, ['gc', '--quiet', '--prune=now'], CLONE_TIMEOUT_MS);
  return dir;
}

// Top-level scopes of the base tree: the benchmark worker may edit anything in the clone.
async function scopesOf(exec, dir) {
  const entries = (await git(exec, dir, ['ls-tree', '-z', 'HEAD'])).split('\0').filter(Boolean).map(line => {
    const [meta, name] = line.split('\t');
    return { name, tree: meta.split(' ')[1] === 'tree' };
  });
  const scopes = entries.filter(e => e.name && !/^\.git$/i.test(e.name) && !/(?:^\.env|secret|wallet|\.pem$|\.key$|^keys\.json$)/i.test(e.name))
    .map(e => e.tree ? `${e.name}/` : e.name);
  const taken = new Set(entries.map(e => e.name.toLowerCase()));
  for (const extra of ['src', 'test', 'tests']) if (!taken.has(extra)) scopes.push(`${extra}/`);
  return scopes.slice(0, 100);
}

function contractFor(entry, variant, dir, prompt, scopes, limits) {
  const visible = entry.suite.visibleChecks.map(c => c.argv);
  const timeouts = entry.suite.visibleChecks.map(c => c.timeoutMs ?? null);
  const title = `Benchmark ${entry.id} (${variant.id})`.slice(0, 160);
  return {
    title, goal: prompt.length >= 10 ? prompt : `${prompt} (benchmark task)`, project: dir,
    provider: variant.provider, model: variant.model, effort: variant.effort,
    limits: { concurrency: 1, maxSessions: 4, maxTurns: 8, taskMinutes: limits.taskMinutes, missionMinutes: limits.missionMinutes },
    tasks: [{ id: 'task', title, prompt, dependsOn: [], files: scopes, checks: visible, checkTimeoutsMs: timeouts }],
    checks: visible, checkTimeoutsMs: timeouts,
  };
}

const countEvents = (view, pattern) => (view.events ?? []).filter(e => pattern.test(e.text || '')).length;

// Runs executable hidden checks in a detached worktree of the verified candidate. Hidden
// test files are read from the source repo at the final commit (read-only) and written
// into that scratch worktree only. Output is never stored, only pass/fail.
async function runHidden({ exec, entry, clone, candidate, hiddenDir, signal }) {
  const runnable = entry.suite.hiddenChecks.filter(isRunnableHidden);
  const pending = entry.suite.hiddenChecks.length - runnable.length;
  if (!runnable.length) return { status: 'none', passed: null, checks: [], pendingJudge: pending };
  if (!candidate) return { status: 'unavailable', passed: false, checks: [], pendingJudge: pending };
  await git(exec, clone, ['worktree', 'add', '--quiet', '--detach', hiddenDir, candidate]);
  // Same restoration Relay uses: only the versioned lockfile, no lifecycle scripts.
  let dependencies = 'not-needed';
  if (runnable.some(c => /^(?:npm|npx)(?:\.cmd)?$/i.test(path.basename(c.argv[0]))) && fs.existsSync(path.join(hiddenDir, 'package-lock.json'))) {
    const restore = await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: hiddenDir, timeoutMs: CLONE_TIMEOUT_MS, signal });
    dependencies = restore.code === 0 ? 'restored' : 'failed';
  }
  const checks = [];
  for (const check of runnable) {
    if (signal?.aborted) break;
    let available = true;
    for (const file of checkTestFiles(check)) {
      const content = await exec('git', ['-C', entry.repoRoot, 'show', `${entry.finalCommit}:${file}`], { timeoutMs: GIT_TIMEOUT_MS });
      if (content.code !== 0) { available = false; break; }
      const target = path.join(hiddenDir, ...file.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content.stdout);
    }
    if (!available || !isRelayCheckArgv(check.argv)) { checks.push({ origin: check.origin, passed: false, status: 'unavailable' }); continue; }
    const result = await exec(check.argv[0], check.argv.slice(1), { cwd: hiddenDir, timeoutMs: check.timeoutMs ?? CHECK_TIMEOUT_MS, signal });
    checks.push({ origin: check.origin, passed: result.code === 0, status: result.timedOut ? 'timeout' : result.code === 0 ? 'passed' : 'failed' });
  }
  const passed = checks.length === runnable.length && checks.every(c => c.passed);
  return { status: passed ? 'passed' : 'failed', passed, checks, pendingJudge: pending, dependencies };
}

async function runPair({ entry, variant, relay, exec, workDir, now, signal, limits }) {
  const started = now();
  const first = path.join(workDir, dirName(entry.id, variant.id));
  // A retried interrupted pair keeps the earlier directory as evidence and uses a new one.
  const dir = [first, ...Array.from({ length: 19 }, (_, i) => `${first}-r${i + 2}`)].find(d => !fs.existsSync(d) && !fs.existsSync(`${d}-hidden`));
  if (!dir) throw new Error('Too many work directories for this pair; inspect them first.');
  const base = { task: entry.id, variant: variant.id, stratum: entry.suite.stratum ?? null, startedAt: new Date(started).toISOString() };
  let turns = 0, refineStatus = null;
  await prepareClone({ exec, repoRoot: entry.repoRoot, baseCommit: entry.baseCommit, dir });
  let prompt = entry.suite.prompt;
  if (variant.spec) {
    const refined = await relay.refine({ kind: 'mission', goal: prompt, project: dir, provider: variant.provider, model: variant.model, effort: variant.effort });
    turns += 1; refineStatus = refined?.status ?? null;
    if (typeof refined?.goal === 'string' && refined.goal.trim()) prompt = `${refined.goal}${refined.acceptance ? `\n\nAcceptance:\n${refined.acceptance}` : ''}`.slice(0, 20000);
  }
  const contract = contractFor(entry, variant, dir, prompt, await scopesOf(exec, dir), limits);
  const created = await relay.create(contract);
  const missionId = created?.id;
  if (!missionId) throw new Error('Relay did not return a mission id.');
  const view = await relay.waitForTerminal(missionId, { deadline: started + limits.missionMinutes * 60_000, signal });
  const followUps = countEvents(view, /^Instruction saved for the next turn/);
  const retries = countEvents(view, /^Explicit retry of /);
  const attention = view.status === 'attention' || view.status === 'expired' || view.deadlineReached === true || (view.tasks ?? []).some(t => t.status === 'attention') ? 1 : 0;
  turns += Number.isInteger(view.turnsUsed) ? view.turnsUsed : 0;
  const candidate = PASSED.has(view.status) ? view.verifiedHead || null : null;
  const hidden = await runHidden({ exec, entry, clone: dir, candidate, hiddenDir: `${dir}-hidden`, signal });
  const missionPassed = PASSED.has(view.status) && view.finalChecksPassed !== false;
  const finished = now();
  const tokens = Number.isFinite(view.tokens?.total) ? view.tokens.total : Number.isFinite(view.tokens) ? view.tokens : null;
  return {
    ...base, status: missionPassed && hidden.passed !== false ? 'passed' : 'failed', missionId: String(missionId).slice(0, 80), missionStatus: view.status ?? null,
    refineStatus, hiddenStatus: hidden.status, hiddenDependencies: hidden.dependencies ?? null, hiddenChecks: hidden.checks, pendingJudgeChecks: hidden.pendingJudge,
    // Unknown when no executable hidden check exists: never counted as a pass.
    passedFirstTry: hidden.passed === null ? null : missionPassed && followUps === 0 && retries === 0 && hidden.passed === true,
    turns, minutes: Math.round(((finished - started) / 60_000) * 10) / 10, tokens, interventions: followUps + retries + attention,
    followUps, retries, finishedAt: new Date(finished).toISOString(),
  };
}

export async function runBenchmark({ entries, variants = DEFAULT_VARIANTS, relay, exec = execArgv, workDir, checkpointFile, signal, now = Date.now,
  dryRun = true, allowFull = false, retryInterrupted = false, taskMinutes = 60, missionMinutes = 90 } = {}) {
  if (!Array.isArray(entries)) throw new Error('entries must be a list of frozen suite tasks.');
  const list = validateVariants(variants);
  if ((entries.length > SAMPLE_LIMIT || list.length > MAX_SAMPLE_VARIANTS) && allowFull !== true) {
    throw new Error(`Refusing more than ${SAMPLE_LIMIT} tasks x ${MAX_SAMPLE_VARIANTS} variants without allowFull (the owner's explicit OK).`);
  }
  for (const entry of entries) if (!entry?.suite || !entry.repoRoot || !/^[a-f0-9]{40}$/.test(entry.baseCommit || '')) throw new Error('Every entry must be a frozen reproducible suite task.');
  if (!workDir || !checkpointFile) throw new Error('workDir and checkpointFile are required.');
  const checkpoint = readCheckpoint(checkpointFile);
  const pairs = entries.flatMap(entry => list.map(variant => ({ entry, variant, key: pairKey(entry.id, variant.id) })));
  const plan = pairs.map(({ entry, variant, key }) => ({ task: entry.id, variant: variant.id,
    state: checkpoint.results.has(key) ? 'done' : checkpoint.started.has(key) ? 'interrupted' : entry.suite.visibleChecks.length ? 'planned' : 'no-visible-checks' }));
  const estimate = estimateSuite(entries, { variants: list });
  if (dryRun) return { dryRun: true, plan, estimate, results: [...checkpoint.results.values()], runs: summarizeRuns([...checkpoint.results.values()]) };
  if (!relay) throw new Error('A live run needs a relay adapter (see cliRelay).');
  const limits = { taskMinutes, missionMinutes };
  const results = [];
  for (const { entry, variant, key } of pairs) {
    if (checkpoint.results.has(key)) { results.push(checkpoint.results.get(key)); continue; }
    if (signal?.aborted) break;
    if (checkpoint.started.has(key) && !retryInterrupted) {
      // An earlier run stopped mid-pair: never re-spend automatically.
      results.push({ task: entry.id, variant: variant.id, status: 'interrupted', detail: 'A previous run stopped during this pair. Inspect its work directory, then pass retryInterrupted explicitly.' });
      continue;
    }
    if (!entry.suite.visibleChecks.length) {
      const result = { task: entry.id, variant: variant.id, status: 'skipped', detail: 'No visible checks: Relay needs at least one check to launch the mission.' };
      appendCheckpoint(checkpointFile, { type: 'result', key, result }); results.push(result); continue;
    }
    appendCheckpoint(checkpointFile, { type: 'start', key, at: new Date(now()).toISOString() });
    let result;
    try { result = await runPair({ entry, variant, relay, exec, workDir, now, signal, limits }); }
    catch (error) { result = { task: entry.id, variant: variant.id, status: 'error', detail: short(error.message), passedFirstTry: false, finishedAt: new Date(now()).toISOString() }; }
    appendCheckpoint(checkpointFile, { type: 'result', key, result });
    results.push(result);
  }
  return { dryRun: false, plan, estimate, results, runs: summarizeRuns(results) };
}

// report.benchmark.runs[]: one row per variant over measured pairs (passed or failed).
// Infrastructure errors, skipped and interrupted pairs are not model attempts.
export function summarizeRuns(results) {
  const byVariant = new Map();
  for (const r of results ?? []) {
    if (!['passed', 'failed'].includes(r?.status)) continue;
    if (!byVariant.has(r.variant)) byVariant.set(r.variant, []);
    byVariant.get(r.variant).push(r);
  }
  const numbers = (rows, key) => rows.map(r => r[key]).filter(Number.isFinite);
  return [...byVariant].sort(([a], [b]) => a < b ? -1 : 1).map(([variant, rows]) => ({
    variant: String(variant).slice(0, 120), tasks: rows.length,
    passedFirstTry: rows.filter(r => r.passedFirstTry === true).length,
    medianTurns: median(numbers(rows, 'turns')), medianMinutes: median(numbers(rows, 'minutes')), medianTokens: median(numbers(rows, 'tokens')),
    interventions: rows.reduce((sum, r) => sum + (Number.isInteger(r.interventions) ? r.interventions : 0), 0),
  }));
}
