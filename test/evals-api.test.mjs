import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { latestReport, MAX_REPORT_BYTES } from '../server/evals-api.mjs';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/evals/report.sample.json', import.meta.url), 'utf8'));
const report = (label, generatedAt) => ({ ...structuredClone(sample), generatedAt, period: { ...sample.period, label } });
function writeReport(dir, date, value) {
  fs.mkdirSync(path.join(dir, date), { recursive: true });
  fs.writeFileSync(path.join(dir, date, 'report.json'), typeof value === 'string' ? value : JSON.stringify(value));
}
// Directory junctions need no elevation on Windows; elsewhere a plain dir symlink.
const linkDir = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
// The real server serves its token through dist/index.html. Without a build (for
// example before `npm run build` in a fresh worktree), run an isolated copy of the
// server code with a minimal token page instead; the repository is never written.
function serverEntry(home) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (fs.existsSync(path.join(root, 'dist', 'index.html'))) return path.join(root, 'server', 'server.mjs');
  const copy = path.join(home, 'app');
  for (const item of ['server', 'evals', 'skills', 'topics.json', 'package.json', 'relay-cli.mjs']) {
    if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(copy, item), { recursive: true });
  }
  fs.mkdirSync(path.join(copy, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'dist', 'index.html'), '<!doctype html><meta name="chats-token" content="__CHATS_TOKEN__">');
  return path.join(copy, 'server', 'server.mjs');
}

test('latestReport picks the newest valid date folder and ignores links, odd names and oversized files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-latest-'));
  try {
    assert.deepEqual(await latestReport({ dir: path.join(dir, 'absent') }), { report: null, reason: 'no-report' });
    assert.deepEqual(await latestReport({ dir }), { report: null, reason: 'no-report' });
    fs.mkdirSync(path.join(dir, '2026-10-30'));
    assert.deepEqual(await latestReport({ dir }), { report: null, reason: 'no-report' }, 'a folder without report.json is a run in progress, not an invalid report');
    writeReport(dir, '2026-10-29', '{ not json');
    assert.deepEqual(await latestReport({ dir }), { report: null, reason: 'invalid-report' });

    writeReport(dir, '2026-10-11', report('Older week', '2026-10-11T20:00:00.000Z'));
    writeReport(dir, '2026-10-18', report('Newer week', '2026-10-18T20:00:00.000Z'));
    let latest = await latestReport({ dir });
    assert.equal(latest.date, '2026-10-18');
    assert.equal(latest.report.period.label, 'Newer week');
    assert.equal(latest.generatedAt, '2026-10-18T20:00:00.000Z');

    const broken = report('Schema-breaking week', '2026-10-25T20:00:00.000Z'); broken.kpis = [];
    writeReport(dir, '2026-10-25', broken);
    writeReport(dir, '2026-10-26', { ...report('Unknown field', '2026-10-26T20:00:00.000Z'), extra: true });
    writeReport(dir, '2026-10-27', report('Too large', '2026-10-27T20:00:00.000Z'));
    fs.appendFileSync(path.join(dir, '2026-10-27', 'report.json'), ' '.repeat(MAX_REPORT_BYTES));
    writeReport(dir, '9999-99-99', report('Not a calendar date', '2026-12-01T20:00:00.000Z'));
    writeReport(dir, 'latest', report('Not a date folder', '2026-12-01T20:00:00.000Z'));
    writeReport(dir, '2026-12-01-copy', report('Suffixed folder', '2026-12-01T20:00:00.000Z'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-outside-'));
    try {
      writeReport(outside, 'week', report('Linked folder', '2026-12-02T20:00:00.000Z'));
      linkDir(path.join(outside, 'week'), path.join(dir, '2026-12-02'));
      assert.ok(fs.lstatSync(path.join(dir, '2026-12-02')).isSymbolicLink(), 'fixture created a linked folder');
      latest = await latestReport({ dir });
      assert.equal(latest.report.period.label, 'Newer week', 'invalid newer reports, non-date folders and linked folders fall back to the newest valid report');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/evals/latest is token-gated, reads on request only and stays out of the live snapshot', { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-evals-api-'));
  const reports = path.join(home, 'evals-reports-private');
  fs.mkdirSync(reports);
  const port = 4871, base = `http://127.0.0.1:${port}`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const child = spawn(process.execPath, ['--no-warnings', serverEntry(home)], {
    env: { ...process.env, CHATS_PORT: String(port), USERPROFILE: home, HOME: home, LOCALAPPDATA: home, CHATS_DELIVERY_DISABLED: '1',
      RELAY_EVALS_REPORTS: reports, RELAY_EVALS_HOME: path.join(home, 'evals-home'), CHATS_SUMMARY_URL: 'http://127.0.0.1:9' },
    windowsHide: true, stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let token = '';
    for (let i = 0; i < 200 && !token; i++) {
      try { token = (await (await fetch(base)).text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1] ?? ''; } catch { /* starting */ }
      if (!token) await sleep(50);
    }
    assert.ok(token, 'server started');
    const raw = async route => (await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}t=${token}`)).text();
    const latest = async () => { const text = await raw('/api/evals/latest'); return { text, body: JSON.parse(text) }; };

    assert.equal((await fetch(`${base}/api/evals/latest`)).status, 403);
    assert.equal((await fetch(`${base}/api/evals/latest?t=${'0'.repeat(48)}`)).status, 403);
    assert.deepEqual((await latest()).body, { report: null, reason: 'no-report' });

    // Analysis chats: token-gated, fixed IDs only, and nothing opens without a valid report.
    const analyze = (body, headers = { 'X-Chats-Token': token }) => fetch(`${base}/api/evals/analyze`,
      { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await analyze({ id: 'corrections' }, {})).status, 403);
    assert.equal((await analyze({ id: 'anything else' })).status, 400);
    assert.equal((await analyze({ prompt: 'Run this instead' })).status, 400);
    const noReport = await analyze({ id: 'corrections' });
    assert.equal(noReport.status, 409); assert.match((await noReport.json()).error, /No valid weekly report/);

    writeReport(reports, '2026-10-11', report('Older week', '2026-10-11T20:00:00.000Z'));
    let result = await latest();
    assert.equal(result.body.report.period.label, 'Older week', 'a report written after startup is read on the next request');

    writeReport(reports, '2026-10-18', report('Newer week', '2026-10-18T20:00:00.000Z'));
    result = await latest();
    assert.equal(result.body.date, '2026-10-18');
    assert.equal(result.body.report.period.label, 'Newer week');

    const broken = report('Broken week', '2026-10-25T20:00:00.000Z'); delete broken.summary;
    writeReport(reports, '2026-10-25', broken);
    writeReport(reports, 'drafts', report('Draft folder', '2026-11-01T20:00:00.000Z'));
    const outside = path.join(home, 'outside'); writeReport(outside, 'week', report('Linked week', '2026-11-02T20:00:00.000Z'));
    linkDir(path.join(outside, 'week'), path.join(reports, '2026-11-02'));
    result = await latest();
    assert.equal(result.body.report.period.label, 'Newer week', 'invalid newer, non-date and linked folders are ignored');

    for (const text of [result.text, JSON.stringify({ report: null })]) {
      for (const secret of [reports, reports.replaceAll('\\', '\\\\'), 'evals-reports-private', home.replaceAll('\\', '\\\\')]) {
        assert.equal(text.includes(secret), false, 'the response never reveals the reports location');
      }
    }

    fs.rmSync(path.join(reports, '2026-10-11'), { recursive: true });
    fs.rmSync(path.join(reports, '2026-10-18'), { recursive: true });
    result = await latest();
    assert.deepEqual(result.body, { report: null, reason: 'invalid-report' });
    assert.equal(result.text.includes('evals-reports-private'), false);

    let snapshot;
    for (let i = 0; i < 100; i++) { snapshot = await raw('/api/snapshot'); if (JSON.parse(snapshot).chats) break; await sleep(50); }
    const controller = new AbortController();
    const events = await fetch(`${base}/api/events?t=${token}`, { signal: controller.signal });
    const reader = events.body.getReader(); let frame = '';
    while (!frame.includes('data: ')) frame += new TextDecoder().decode((await reader.read()).value);
    while (!frame.slice(frame.indexOf('data: ')).includes('\n\n')) frame += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    for (const payload of [snapshot, frame]) {
      assert.match(payload, /"chats":/, 'payload is a real snapshot');
      for (const marker of ['evals', 'Evals', 'Linked week', 'Older week', 'Newer week', 'Broken week', 'schemaVersion', 'kpis']) {
        assert.equal(payload.includes(marker), false, `live payloads carry no evals data (${marker})`);
      }
    }
  } finally {
    child.kill(); await exited;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
