// Shared Relay Evals contracts: sample fixtures validate, mutations are rejected,
// and the private store round-trips records in an isolated home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, assertValid } from '../evals/schema.mjs';
import { openStore, evalsHome, reportsDir } from '../evals/store.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/evals/${name}.sample.json`, import.meta.url), 'utf8'));
const SAMPLES = { 'chat-record': 'chat-record', 'chat-metrics': 'chat-metrics', task: 'task', report: 'report' };

for (const [schema, file] of Object.entries(SAMPLES)) {
  test(`${schema} sample is valid`, () => assert.deepEqual(validate(schema, fixture(file)), []));
}

test('schemas reject unknown fields, wrong types and broken patterns', () => {
  const record = fixture('chat-record');
  assert.ok(validate('chat-record', { ...record, rawPath: 'C:/x' }).some(e => e.includes('unexpected property rawPath')));
  assert.ok(validate('chat-record', { ...record, automated: 'no' }).some(e => e.includes('automated')));
  assert.ok(validate('chat-record', { ...record, id: 'gemini:1' }).length);
  const message = { ...record.userMessages[0], text: 'x'.repeat(4001) };
  assert.ok(validate('chat-record', { ...record, userMessages: [message] }).some(e => e.includes('longer than 4000')));
  const metrics = fixture('chat-metrics');
  assert.ok(validate('chat-metrics', { ...metrics, corrections: { ...metrics.corrections, byCategory: { invented: 1 } } }).length);
  const report = fixture('report');
  assert.ok(validate('report', { ...report, summary: ['too short'] }).length);
  assert.ok(validate('report', { ...report, kpis: [...report.kpis, report.kpis[0]] }).some(e => e.includes('more than 4')));
  const predictor = { ...report.predictors[0], ci95: 'wide' };
  assert.ok(validate('report', { ...report, predictors: [predictor] }).length);
  assert.throws(() => assertValid('task', { ...fixture('task'), reproducibleReason: '' }), /Invalid task/);
});

test('store paths honor overrides and default outside Git', () => {
  const home = path.join(os.tmpdir(), 'relay-evals-home');
  assert.equal(evalsHome({ RELAY_EVALS_HOME: home }), path.resolve(home));
  assert.match(evalsHome({ LOCALAPPDATA: 'C:/Users/example/AppData/Local' }).replace(/\\/g, '/'), /AppData\/Local\/chats-dashboard\/evals$/);
  assert.match(reportsDir({}).replace(/\\/g, '/'), /chats-dashboard\/evals\/reports$/);
});

test('store round-trips chats, metrics, tasks, checkpoints and meta', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-store-'));
  const store = openStore({ home });
  try {
    const record = fixture('chat-record');
    store.saveChat(record, { path: 'fake/a.jsonl', provider: 'claude', size: 10, mtimeMs: 5 });
    assert.deepEqual(store.chat(record.id), record);
    assert.equal(store.checkpoint('fake/a.jsonl').status, 'ok');
    assert.deepEqual([...store.chats({ automated: false })].map(r => r.id), [record.id]);
    assert.throws(() => store.saveChat({ ...record, tokens: {} }), /Invalid chat-record/);
    store.saveMetrics(fixture('chat-metrics'));
    assert.equal([...store.metrics()].length, 1);
    store.replaceTasks([fixture('task')]);
    store.replaceTasks([fixture('task')]);
    assert.equal(store.tasks().length, 1);
    store.setMeta('lastRun', { at: 1 });
    assert.deepEqual(store.getMeta('lastRun'), { at: 1 });
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
