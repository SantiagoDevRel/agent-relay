#!/usr/bin/env node
// Relay Evals command line. Every step is explicit; only `weekly` is scheduled.
//   node evals/cli.mjs weekly [--trigger weekly|manual] [--no-labels] [--labeler codex|claude] [--no-notify]
//   node evals/cli.mjs extract | labels | metrics [--no-labels] | catalog | report [--no-labels]
//   node evals/cli.mjs label-check | judge kit [--n 100]
// Model labels (weekly, report, labels) use the labeler's subscription for new messages only.
// The labeler is Codex unless --labeler or RELAY_EVALS_LABELER says claude; --no-labels
// (or the older --no-claude / RELAY_EVALS_CLAUDE=0) keeps the text rules.
//   node evals/cli.mjs benchmark freeze | estimate | sample [--live] [--variants file.json]
// The benchmark runner spends Relay turns: it runs only through `benchmark sample --live`,
// never from `weekly`, and refuses more than 10 tasks x 2 variants without --allow-full.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore, evalsHome, reportsDir } from './store.mjs';

const args = process.argv.slice(2), flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota' }).format(new Date());
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const log = line => process.stderr.write(`[evals] ${line}\n`);
const modelLabels = !flag('no-labels') && !flag('no-claude') && process.env.RELAY_EVALS_CLAUDE !== '0';

// --labeler wins over RELAY_EVALS_LABELER; an unknown name is an error, never a silent default.
async function chosenLabeler() {
  const { LABELERS, labelerFromEnv } = await import('./claude-labels.mjs');
  const name = option('labeler', null);
  if (name === null) return labelerFromEnv();
  if (!Object.hasOwn(LABELERS, name)) throw new Error(`Unknown labeler ${name}: use ${Object.keys(LABELERS).join(' or ')}.`);
  return name;
}

async function main() {
  const [command, sub] = args;
  if (command === 'weekly') {
    const { runWeekly } = await import('./weekly.mjs');
    const result = await runWeekly({ trigger: option('trigger', 'manual'), modelLabels, labeler: await chosenLabeler(), notifyUser: !flag('no-notify'), log });
    return print({ status: result.status, report: result.report, notified: result.notified });
  }
  const store = openStore({ home: evalsHome() });
  try {
    if (command === 'extract') { const { extractAll } = await import('./extract.mjs'); return print(await extractAll({ store, home: os.homedir() })); }
    if (command === 'labels') { const { labelAll } = await import('./claude-labels.mjs'); return print(await labelAll({ store, labeler: await chosenLabeler(), onProgress: p => log(`labels ${p.done}/${p.total}`) })); }
    if (command === 'metrics') { const { computeAll } = await import('./metrics.mjs'); const { LABELERS } = await import('./claude-labels.mjs'); const r = await computeAll({ store, git: true, labels: modelLabels, labelModel: LABELERS[await chosenLabeler()].model }); return print({ ...r }); }
    if (command === 'label-check') { const { buildLabelCheck } = await import('./label-check.mjs'); const { LABELERS } = await import('./claude-labels.mjs'); return print(buildLabelCheck({ store, model: LABELERS[await chosenLabeler()].model })); }
    if (command === 'catalog') { const { catalogAndSave } = await import('./benchmark/catalog.mjs'); return print((await catalogAndSave({ store }))?.counts); }
    if (command === 'judge' && sub === 'kit') {
      const { buildLabelingKit } = await import('./judge.mjs');
      const outDir = path.join(path.dirname(reportsDir()), 'labeling', today());
      const kit = await buildLabelingKit({ store, outDir, n: Number(option('n', 100)) });
      return print({ dir: kit.dir, items: kit.items.length ?? kit.items });
    }
    if (command === 'benchmark') {
      const suite = await import('./benchmark/suite.mjs');
      if (sub === 'freeze') { const r = await suite.freezeSuite({ store }); return print({ file: r.file, counts: r.counts }); }
      const entries = await latestSuite();
      if (sub === 'estimate') return print({ reproducible: entries.length, holdout: entries.filter(e => e.suite.split === 'holdout').length, ...suite.estimateSuite(entries.filter(e => e.suite.split === 'dev')) });
      if (sub === 'sample') {
        const { runBenchmark, summarizeRuns, cliRelay } = await import('./benchmark/runner.mjs');
        // Only tasks a scratch clone can run unattended (suite.liveBlocker); the rest are counted, never run.
        const sample = suite.sampleTasks(entries, { limit: Math.min(10, Number(option('limit', 10))), seed: 20261022, allowFull: flag('allow-full'), safe: true });
        const blocked = {};
        for (const entry of entries.filter(e => e.suite.split === 'dev')) { const why = suite.liveBlocker(entry); if (why) blocked[why] = (blocked[why] ?? 0) + 1; }
        const variants = option('variants') ? JSON.parse(fs.readFileSync(option('variants'), 'utf8')) : undefined;
        const workDir = path.join(os.homedir(), 'Downloads', 'agent-work', 'relay-evals-benchmark');
        const result = await runBenchmark({ entries: sample, variants, workDir, checkpointFile: path.join(evalsHome(), 'benchmark', 'runs.jsonl'), dryRun: !flag('live'), allowFull: flag('allow-full'),
          // The live path drives the installed relay CLI; mission request files stay in the work folder.
          relay: flag('live') ? cliRelay({ scratch: path.join(workDir, 'requests') }) : undefined });
        if (flag('live')) store.setMeta('benchmarkRuns', summarizeRuns(result.results));
        return print(flag('live') ? { runs: summarizeRuns(result.results), results: result.results, blocked } : { ...result, blocked });
      }
    }
    if (command === 'report') { store.close(); const { runWeekly } = await import('./weekly.mjs'); return print(await runWeekly({ trigger: 'manual', modelLabels, labeler: await chosenLabeler(), notifyUser: false, log })); }
    process.stderr.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    process.exitCode = 2;
  } finally { try { store.close(); } catch { /* closed */ } }

  async function latestSuite() {
    const found = (await import('./weekly.mjs')).latestSuite(evalsHome());
    if (found.status === 'invalid') throw new Error('The newest frozen suite does not match its sha256 sidecar.');
    if (found.status !== 'ok') throw new Error('No frozen suite yet: run `node evals/cli.mjs benchmark freeze` first.');
    return found.entries;
  }
}

main().catch(error => { process.stderr.write(`[evals] ${error?.message ?? error}\n`); process.exitCode = 1; });
