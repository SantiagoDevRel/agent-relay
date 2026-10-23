// Weekly pipeline guards: the secret check scrubs exactly the flagged texts, a
// missing checker is reported, and the run lock refuses a concurrent run.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../evals/store.mjs';
import { secretCheck, runWeekly, latestSuite } from '../evals/weekly.mjs';
import { validate } from '../evals/schema.mjs';
import { labelAll } from '../evals/claude-labels.mjs';

const sample = () => JSON.parse(fs.readFileSync(new URL('./fixtures/evals/chat-record.sample.json', import.meta.url), 'utf8'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-weekly-'));

test('secret check scrubs only the flagged lines and removes its temporary file', async () => {
  const home = temp(), store = openStore({ home });
  try {
    store.saveChat(sample());
    // Fake checker: flags the second exported line (the first user correction) like the configured secret checker does.
    const tool = path.join(home, 'fake-secrets.mjs');
    fs.writeFileSync(tool, "const f=process.argv[3];console.log(f+':2: GitHub token');process.exitCode=1;\n");
    const result = await secretCheck(store, { tool });
    assert.equal(result.status, 'scrubbed'); assert.equal(result.flagged, 1);
    const record = store.chat(sample().id);
    assert.equal(record.userMessages[1].text, '[REDACTED:secret-check]');
    assert.equal(record.userMessages[0].text, sample().userMessages[0].text);
    assert.equal(record.redactions, 1);
    assert.deepEqual(fs.readdirSync(home).filter(f => f.startsWith('secret-check-')), []);
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('secret check reports ok, missing and checker errors honestly', async () => {
  const home = temp(), store = openStore({ home });
  try {
    store.saveChat(sample());
    const ok = path.join(home, 'ok.mjs'); fs.writeFileSync(ok, "console.log('No secrets found');\n");
    assert.equal((await secretCheck(store, { tool: ok })).status, 'ok');
    assert.equal((await secretCheck(store, { tool: path.join(home, 'absent.mjs') })).status, 'missing');
    const broken = path.join(home, 'broken.mjs'); fs.writeFileSync(broken, 'process.exitCode=3;\n');
    assert.equal((await secretCheck(store, { tool: broken })).status, 'error');
    assert.equal(store.chat(sample().id).userMessages[1].text, sample().userMessages[1].text);
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a live run lock refuses a second weekly run', async () => {
  const home = temp();
  try {
    fs.writeFileSync(path.join(home, 'weekly.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await assert.rejects(runWeekly({ home, reports: path.join(home, 'reports'), notifyUser: false }), /Another Relay Evals run is active/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a line flagged for two finding kinds is scrubbed and counted once', async () => {
  const home = temp(), store = openStore({ home });
  try {
    store.saveChat(sample());
    const tool = path.join(home, 'twice.mjs');
    fs.writeFileSync(tool, "const f=process.argv[3];console.log(f+':2: GitHub token');console.log(f+':2: credential (DGX rule)');process.exitCode=1;\n");
    const result = await secretCheck(store, { tool });
    assert.equal(result.flagged, 1);
    assert.equal(store.chat(sample().id).redactions, 1);
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('latestSuite verifies the sha256 sidecar of the newest frozen suite', () => {
  const home = temp();
  try {
    assert.equal(latestSuite(home).status, 'none');
    const dir = path.join(home, 'benchmark'); fs.mkdirSync(dir);
    const text = JSON.stringify({ schemaVersion: 1, entries: [] });
    fs.writeFileSync(path.join(dir, 'suite-2026-10-22.json'), text);
    fs.writeFileSync(path.join(dir, 'suite-2026-10-22.json.sha256'), `${crypto.createHash('sha256').update(text).digest('hex')}  suite-2026-10-22.json\n`);
    assert.deepEqual(latestSuite(home), { status: 'ok', entries: [] });
    fs.writeFileSync(path.join(dir, 'suite-2026-10-22.json'), text + ' ');
    assert.equal(latestSuite(home).status, 'invalid');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a full weekly run over fixture transcripts writes a valid report and a run record', async () => {
  const root = temp(), home = path.join(root, 'evals'), reports = path.join(root, 'reports'), sources = path.join(root, 'user');
  const fixture = name => fs.readFileSync(new URL(`./fixtures/evals/transcripts/${name}`, import.meta.url), 'utf8');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try {
    put(path.join(sources, '.claude', 'projects', 'C--work-demo', '11111111-2222-4333-8444-555555555555.jsonl'), fixture('claude-main.ndjson'));
    put(path.join(sources, '.codex', 'sessions', '2026', '10', '20', 'rollout-2026-10-20T11-00-00-66666666-7777-4888-8999-aaaaaaaaaaaa.jsonl'), fixture('codex-classic.ndjson'));
    const ok = path.join(root, 'ok.mjs'); fs.writeFileSync(ok, "console.log('No secrets found');\n");
    const result = await runWeekly({ home, reports, sources, secretsTool: ok, contractsDir: path.join(root, 'contracts'), labeling: path.join(root, 'labeling'),
      labelCheckDir: path.join(root, 'label-check'), git: false, notifyUser: false, now: new Date('2026-10-25T20:00:00-05:00'), trigger: 'manual' });
    assert.equal(result.status, 'ok');
    assert.equal(result.extraction.chats, 2);
    const report = JSON.parse(fs.readFileSync(result.report.json, 'utf8'));
    assert.deepEqual(validate('report', report), []);
    assert.equal(report.coverage.filesScanned, 2);
    assert.equal(report.run.trigger, 'manual');
    assert.ok(fs.readFileSync(result.report.html, 'utf8').includes('<html'));
    const runs = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(runs.at(-1).status, 'ok');
    assert.ok(runs.at(-1).peakRssBytes > 0 && runs.at(-1).durationMs >= 0);
    assert.ok(!fs.existsSync(path.join(home, 'weekly.lock')), 'the lock is released');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a weekly run with model labels labels every interactive chat once and reports who labeled', async () => {
  const root = temp(), home = path.join(root, 'evals'), reports = path.join(root, 'reports'), sources = path.join(root, 'user');
  const fixture = name => fs.readFileSync(new URL(`./fixtures/evals/transcripts/${name}`, import.meta.url), 'utf8');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try {
    put(path.join(sources, '.claude', 'projects', 'C--work-demo', '11111111-2222-4333-8444-555555555555.jsonl'), fixture('claude-main.ndjson'));
    put(path.join(sources, '.codex', 'sessions', '2026', '10', '20', 'rollout-2026-10-20T11-00-00-66666666-7777-4888-8999-aaaaaaaaaaaa.jsonl'), fixture('codex-classic.ndjson'));
    const ok = path.join(root, 'ok.mjs'); fs.writeFileSync(ok, "console.log('No secrets found');\n");
    let prompts = 0;
    // A fake labeler: every message is labeled "not a correction".
    const run = async prompt => {
      prompts++;
      const n = (prompt.match(/^\[\d+\] previous reply:/gm) ?? []).length;
      return { labels: Array.from({ length: n }, (_, k) => ({ i: k + 1, correction: false, category: 'none', brokenDone: false })) };
    };
    const options = { home, reports, sources, secretsTool: ok, contractsDir: path.join(root, 'contracts'), labeling: path.join(root, 'labeling'),
      labelCheckDir: path.join(root, 'label-check'), git: false, notifyUser: false, now: new Date('2026-10-25T20:00:00-05:00'), modelLabels: true,
      label: ({ store, labeler, onProgress }) => labelAll({ store, labeler, run, onProgress }) };
    const result = await runWeekly(options);
    assert.equal(result.status, 'ok');
    const report = JSON.parse(fs.readFileSync(result.report.json, 'utf8'));
    assert.deepEqual(validate('report', report), []);
    assert.equal(report.labels.model, 'gpt-6.1-sol', 'Codex labels by default');
    assert.equal(report.labels.ruleChats, 0);
    assert.ok(report.labels.claudeChats >= 1);
    assert.equal(report.labels.check, null);
    assert.ok(!report.missing.some(note => /label/i.test(note)), report.missing.join(' | '));
    assert.ok(prompts >= 1);
    // The next week sends only new messages: nothing here.
    const before = prompts;
    await runWeekly({ ...options, now: new Date('2026-10-26T20:00:00-05:00') });
    assert.equal(prompts, before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
