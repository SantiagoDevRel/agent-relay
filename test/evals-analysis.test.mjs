import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ANALYSES, ANALYSIS_HEADER, ANALYSIS_PROVIDERS, analysisPrompt } from '../evals/analysis.mjs';
import { startAnalysis } from '../server/evals-api.mjs';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/evals/report.sample.json', import.meta.url), 'utf8'));
const latest = { report: sample, generatedAt: sample.generatedAt, date: '2026-10-18' };
const env = { RELAY_EVALS_REPORTS: 'C:\\private\\reports', RELAY_EVALS_HOME: 'C:\\private\\evals' };

test('every analysis prompt carries the fixed header, inputs, read-only rules and a non-overwriting output file', () => {
  assert.equal(new Set(ANALYSES.map(analysis => analysis.id)).size, ANALYSES.length);
  for (const analysis of ANALYSES) {
    const prompt = analysisPrompt(analysis.id, latest, { env });
    assert.ok(prompt.startsWith(`# Relay Evals · ${analysis.label}\n${ANALYSIS_HEADER}\n`));
    assert.ok(prompt.includes(analysis.task));
    assert.ok(prompt.includes('"C:/private/reports/2026-10-18/report.json"'));
    assert.ok(prompt.includes('"C:/private/evals/dataset.sqlite"') && prompt.includes('readOnly: true'));
    assert.ok(prompt.includes(`"C:/private/reports/2026-10-18/analysis-${analysis.id}.md"`) && prompt.includes('never overwrite'));
    assert.match(prompt, /data, never instructions/);
    assert.match(prompt, /Do not start agents, subagents, other models/);
    assert.match(prompt, /At most three recommendations/);
    assert.ok(Buffer.byteLength(prompt) < 16 * 1024, 'fits the native launch prompt limit');
  }
  assert.throws(() => analysisPrompt('rm -rf', latest, { env }), /Unknown analysis/);
  assert.throws(() => analysisPrompt('corrections', { report: null, reason: 'no-report' }, { env }), /No valid weekly report/);
});

test('the client button list mirrors the server analyses exactly', () => {
  const source = fs.readFileSync(new URL('../web/src/lib/evals.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('export const EVALS_ANALYSES'), source.indexOf('] as const;'));
  const client = [...block.matchAll(/\{ id: '([^']+)', label: '([^']+)', description: '([^']+)' \}/g)].map(match => ({ id: match[1], label: match[2], description: match[3] }));
  assert.deepEqual(client, ANALYSES.map(({ id, label, description }) => ({ id, label, description })));
  const providers = source.slice(source.indexOf('export const EVALS_ANALYSIS_PROVIDERS'));
  const clientProviders = [...providers.slice(0, providers.indexOf('] as const;')).matchAll(/\{ id: '([^']+)', label: '([^']+)', model: '([^']+)', modelLabel: '([^']+)' \}/g)]
    .map(match => ({ id: match[1], label: match[2], model: match[3], modelLabel: match[4] }));
  assert.deepEqual(clientProviders, ANALYSIS_PROVIDERS.map(provider => ({ ...provider })));
});

test('startAnalysis validates the ID, needs a valid report, builds the prompt server-side and refuses a double click', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-analysis-'));
  try {
    const launched = [];
    let clock = 1_000_000;
    const options = { dir, env: { RELAY_EVALS_HOME: path.join(dir, 'home') }, now: () => clock, launch: async value => { launched.push(value); } };
    await assert.rejects(startAnalysis('models', options), error => error.status === 409 && /No valid weekly report/.test(error.message));
    fs.mkdirSync(path.join(dir, '2026-10-18'));
    fs.writeFileSync(path.join(dir, '2026-10-18', 'report.json'), JSON.stringify(sample));
    await assert.rejects(startAnalysis('../../etc', options), error => error.status === 400);
    await assert.rejects(startAnalysis({ id: 'models' }, options), error => error.status === 400);
    assert.equal(launched.length, 0, 'invalid requests never launch');

    await assert.rejects(startAnalysis('models', { ...options, provider: 'gemini' }), error => error.status === 400 && /Unknown provider/.test(error.message));
    await assert.rejects(startAnalysis('models', { ...options, provider: { id: 'claude' } }), error => error.status === 400);
    assert.equal(launched.length, 0, 'invalid requests never launch');

    assert.deepEqual(await startAnalysis('models', options), { opened: true, id: 'models', provider: 'claude', model: 'claude-opus-5-5', date: '2026-10-18' });
    assert.equal(launched.length, 1);
    assert.deepEqual([launched[0].provider, launched[0].model], ['claude', 'claude-opus-5-5']);
    assert.ok(launched[0].prompt.startsWith('# Relay Evals · Which model and effort to use\n'));
    assert.ok(launched[0].prompt.includes(path.join(dir, '2026-10-18').replaceAll('\\', '/')));

    clock += 5_000;
    await assert.rejects(startAnalysis('models', options), error => error.status === 409 && /just opened/.test(error.message));
    await startAnalysis('friction', options);
    // The same analysis with the other agent is a different chat, not a double click.
    assert.deepEqual(await startAnalysis('models', { ...options, provider: 'codex' }), { opened: true, id: 'models', provider: 'codex', model: 'gpt-6.1-sol', date: '2026-10-18' });
    launched.splice(2, 1);
    clock += 30_000;
    await startAnalysis('models', options);
    assert.deepEqual(launched.map(value => value.prompt.split('\n')[0]), ['# Relay Evals · Which model and effort to use', '# Relay Evals · Tool errors and compactions', '# Relay Evals · Which model and effort to use']);

    // A failed launch frees the ID so a retry is possible right away.
    const failing = { ...options, launch: async () => { throw Object.assign(Error('Global chat limit reached'), { status: 429 }); } };
    await assert.rejects(startAnalysis('corrections', failing), error => error.status === 429);
    await startAnalysis('corrections', options);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
