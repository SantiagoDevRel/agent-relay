// One bounded Relay Evals run: extract → secret check → model labels → metrics →
// catalog → retrospective → judge status → report → notification. Started by the
// weekly scheduled task or by hand; it never runs the benchmark and leaves nothing
// running when it returns. The labeler (Codex by default) sees only messages it has not labeled before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, evalsHome, reportsDir } from './store.mjs';
import { extractAll } from './extract.mjs';
import { computeAll } from './metrics.mjs';
import { DEFAULT_LABELER, LABELERS, labelAll } from './claude-labels.mjs';
import { readLabelCheck, checkDir } from './label-check.mjs';
import { catalogAndSave } from './benchmark/catalog.mjs';
import { retrospective } from './benchmark/retro.mjs';
import { estimateSuite, readSuite } from './benchmark/suite.mjs';
import { judgeStatus, readLabels, scoreSpec, firstPrompt } from './judge.mjs';
import { buildReport, writeReport, weekPeriod } from './report.mjs';

// Optional external secret checker: a Node script run as `<script> check <file>` that exits
// 1 and prints `file:<line>: <kind>` per finding. Without it the check reports 'missing'.
const SECRETS_TOOL = process.env.RELAY_EVALS_SECRET_CHECK || '';
const LABELING = path.join(path.dirname(reportsDir()), 'labeling');

// A second run while one is active exits instead of competing for the dataset.
function lock(home) {
  const file = path.join(home, 'weekly.lock');
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { process.kill(held.pid, 0); throw Object.assign(new Error('Another Relay Evals run is active.'), { code: 'locked' }); }
    catch (error) { if (error.code === 'locked') throw error; }
  } catch (error) { if (error.code === 'locked') throw error; }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

const execText = (file, args, timeoutMs) => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout ?? '') }));
});

// Defense in depth after redaction: every stored text goes through the configured
// secret checker (it prints only line numbers and kinds). Flagged texts are scrubbed.
export async function secretCheck(store, { tool = SECRETS_TOOL, timeoutMs = 10 * 60000 } = {}) {
  if (!tool || !fs.existsSync(tool)) return { status: 'missing', flagged: 0 };
  const file = path.join(store.home, `secret-check-${process.pid}.txt`), index = [];
  const out = fs.openSync(file, 'w');
  try {
    for (const record of store.chats()) {
      record.userMessages.forEach((m, i) => { if (m.text) { index.push([record.id, 'user', i]); fs.writeSync(out, m.text.replace(/\r?\n/g, ' ⏎ ') + '\n'); } });
      record.turns.forEach((t, i) => { if (t.agentFinal?.text) { index.push([record.id, 'final', i]); fs.writeSync(out, t.agentFinal.text.replace(/\r?\n/g, ' ⏎ ') + '\n'); } });
    }
    fs.closeSync(out);
    const result = await execText(process.execPath, [tool, 'check', file], timeoutMs);
    if (result.code === 0) return { status: 'ok', flagged: 0, texts: index.length };
    // One line can be reported once per finding kind.
    const lines = [...new Set([...result.stdout.matchAll(/:(\d+): /g)].map(m => Number(m[1])))];
    if (result.code !== 1 || !lines.length) return { status: 'error', flagged: 0, texts: index.length };
    const byChat = new Map();
    for (const line of lines) { const hit = index[line - 1]; if (hit) byChat.set(hit[0], [...(byChat.get(hit[0]) ?? []), hit]); }
    for (const [id, hits] of byChat) {
      const record = store.chat(id);
      for (const [, kind, i] of hits) {
        if (kind === 'user') record.userMessages[i].text = '[REDACTED:secret-check]';
        else record.turns[i].agentFinal.text = '[REDACTED:secret-check]';
        record.redactions += 1;
      }
      store.saveChat(record);
    }
    return { status: 'scrubbed', flagged: lines.length, texts: index.length };
  } finally { try { fs.closeSync(out); } catch { /* closed */ } fs.rmSync(file, { force: true }); }
}

// Newest frozen suite under <home>/benchmark, verified against its sha256 sidecar.
export function latestSuite(home) {
  const dir = path.join(home, 'benchmark');
  let files = [];
  try { files = fs.readdirSync(dir).filter(name => /^suite-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort(); } catch { return { status: 'none' }; }
  if (!files.length) return { status: 'none' };
  try { return { status: 'ok', entries: readSuite(path.join(dir, files.at(-1))).entries }; } catch { return { status: 'invalid' }; }
}

// The owner's labels, if a kit has been filled in: the newest labels.csv with any row.
function latestLabels(dir = LABELING) {
  let folders = [];
  try { folders = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse(); } catch { return { labels: new Map(), items: [] }; }
  for (const folder of folders) {
    const csv = path.join(dir, folder, 'labels.csv'), items = path.join(dir, folder, 'items.jsonl');
    if (!fs.existsSync(csv)) continue;
    const labels = readLabels(csv);
    const entries = fs.existsSync(items) ? fs.readFileSync(items, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    if (labels.size) return { labels, items: entries };
  }
  return { labels: new Map(), items: [] };
}

// Judge scores: every interactive chat's first prompt (for the outcome correlation)
// plus the labeled kit items (for kappa against the owner's labels).
function judgeSection(store, labeling = LABELING) {
  const { labels, items } = latestLabels(labeling);
  const judgeScores = [], outcomes = new Map();
  for (const metrics of store.metrics()) if (!metrics.automated) outcomes.set(metrics.id, metrics);
  for (const record of store.chats({ automated: false })) {
    const prompt = firstPrompt(record);
    if (prompt) judgeScores.push({ id: record.id, chatId: record.id, total: scoreSpec(prompt).total });
  }
  for (const item of items) judgeScores.push({ id: item.id, chatId: item.chatId, total: scoreSpec(item.prompt).total });
  return judgeStatus({ labels, judgeScores, outcomes });
}

async function notify(htmlFile, report) {
  const script = fileURLToPath(new URL('../server/notify-windows.ps1', import.meta.url));
  if (process.platform !== 'win32' || !fs.existsSync(script)) return 'unavailable';
  const payload = Buffer.from(JSON.stringify({ title: 'Relay Evals: weekly report ready', text: report.summary[0], url: pathToFileURL(htmlFile).href })).toString('base64');
  const result = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Payload', payload], 20000);
  return result.code === 0 && /"accepted":true/.test(result.stdout) ? 'shown' : 'failed';
}

// sources, secretsTool, contractsDir, labeling and labelCheckDir exist so tests never read real transcripts,
// contracts or labels; label replaces labelAll so tests never call a model.
export async function runWeekly({ trigger = 'manual', home = evalsHome(), reports = reportsDir(), modelLabels = false, labeler = DEFAULT_LABELER, label = labelAll, notifyUser = true, now = new Date(), log = () => {},
  sources = os.homedir(), secretsTool = SECRETS_TOOL, contractsDir, labeling = LABELING, labelCheckDir = checkDir(), git = true } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const unlock = lock(home), started = Date.now(), steps = [], missing = [];
  const store = openStore({ home });
  const step = async (name, fn) => {
    const at = Date.now(); log(`${name}…`);
    try { const value = await fn(); steps.push({ name, ms: Date.now() - at, status: 'ok' }); return value; }
    catch (error) { steps.push({ name, ms: Date.now() - at, status: 'error', error: String(error?.message ?? error).slice(0, 200) }); throw error; }
  };
  let outcome = { status: 'failed' };
  try {
    const extraction = await step('extract', () => extractAll({ store, home: sources, onProgress: p => { if (p.done % 500 === 0 || p.done === p.total) log(`extract ${p.done}/${p.total}`); } }));
    const secrets = await step('secret-check', () => secretCheck(store, { tool: secretsTool }));
    if (secrets.status === 'missing') missing.push('No secret checker is configured (RELAY_EVALS_SECRET_CHECK); only built-in redaction ran.');
    if (secrets.status === 'error') missing.push('The secret checker failed; only built-in redaction ran.');
    if (modelLabels) {
      const labels = await step('labels', () => label({ store, labeler, onProgress: p => { if (p.done % 400 === 0 || p.done === p.total) log(`labels ${p.done}/${p.total}`); } }));
      if (labels.status !== 'ok') missing.push(`${LABELERS[labeler].model} labeled ${labels.labeled} of ${labels.pending} new messages (${labels.stopped ?? 'stopped'}); unlabeled chats use the text rules.`);
    } else missing.push('Model labels not requested: corrections come from the text rules.');
    await step('metrics', () => computeAll({ store, git, labels: modelLabels, labelModel: LABELERS[labeler].model }));
    const catalog = await step('catalog', () => catalogAndSave({ store, ...(contractsDir ? { contractsDir } : {}) }));
    // The frozen suite (if any) stays the benchmark: its split and estimate win over the rebuilt catalog.
    const suite = latestSuite(home);
    if (suite.status === 'invalid') missing.push('The frozen benchmark suite failed its integrity check; the estimate uses the catalog.');
    const frozen = new Map((suite.entries ?? []).map(entry => [entry.id, entry]));
    const tasks = store.tasks().map(task => frozen.get(task.id) ? { ...task, suite: frozen.get(task.id).suite } : task);
    const retro = await step('retrospective', () => retrospective(store.metrics()));
    // Holdout tasks are reserved for final validation, so a full run covers the dev split (as `benchmark estimate`).
    const estimate = estimateSuite((suite.entries ?? tasks.filter(task => task.reproducible && !task.excluded)).filter(entry => entry.suite?.split !== 'holdout'));
    const judge = await step('judge', () => judgeSection(store, labeling));
    const partial = store.checkpoints().filter(c => c.status === 'partial' || c.status === 'error').length;
    const { period } = weekPeriod(now);
    const coverage = { ...store.chatStats({ from: period.start, to: period.end }), filesScanned: extraction.files, filesPartial: partial };
    const run = { durationMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024, trigger };
    let labelCheck = null;
    try { labelCheck = readLabelCheck({ dir: labelCheckDir }); } catch { missing.push('The label check file could not be read.'); }
    const report = await step('report', () => buildReport({ metrics: store.metrics(), tasks, retro, judge,
      benchmark: { estimate, runs: store.getMeta('benchmarkRuns') ?? [] }, coverage, missing, labelCheck, run, now }));
    report.run = { ...run, durationMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
    const written = await step('write', () => writeReport({ report, dir: reports, replace: true }));
    const notified = notifyUser ? await notify(written.html, report) : 'skipped';
    outcome = { status: 'ok', report: written, notified, extraction, secrets, catalog: catalog?.counts ?? null };
    return outcome;
  } catch (error) {
    outcome = { status: 'failed', error: String(error?.message ?? error).slice(0, 300) };
    throw error;
  } finally {
    const record = { startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024, trigger, steps, ...outcome };
    fs.appendFileSync(path.join(home, 'runs.jsonl'), JSON.stringify(record) + '\n');
    store.close(); unlock();
  }
}
