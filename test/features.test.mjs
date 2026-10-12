import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Preferences, NotificationTransitions } from '../server/preferences.mjs';
import { HistoryIndex } from '../server/history.mjs';
import { parseDgx } from '../server/services.mjs';

test('preferences persist independent patches and propagate write errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-prefs-'));
  try {
    const file = path.join(dir, 'preferences.json'), p = new Preferences(file);
    p.chat('a', { favorite: true }); p.chat('a', { note: 'Recordatorio á' }); p.notifications(true);
    const read = new Preferences(file);
    assert.deepEqual(read.get('a'), { favorite: true, note: 'Recordatorio á' });
    assert.deepEqual([...read.favorites()], ['a']); assert.equal(read.data.notifications, true);
    read.file = dir; assert.throws(() => read.chat('a', { favorite: false }));
    assert.equal(read.get('a').favorite, true);
  } finally { fs.rmSync(dir, { force: true, recursive: true }); }
});

test('notification transitions seed silently, deduplicate, skip automation and normal exits', () => {
  const t = new NotificationTransitions();
  const chat = { id: 'a', state: 'working', alive: true };
  assert.deepEqual(t.update([chat]), []);
  assert.equal(t.update([{ ...chat, state: 'waiting' }]).length, 1);
  assert.deepEqual(t.update([{ ...chat, state: 'waiting' }]), []);
  assert.equal(t.update([{ ...chat, state: 'cut', alive: false }]).length, 1);
  assert.deepEqual(t.update([{ ...chat, state: 'closed', alive: false }]), []);
  t.reset(); t.update([{ ...chat, automated: true }]);
  assert.deepEqual(t.update([{ ...chat, state: 'waiting', automated: true }]), []);
  assert.deepEqual(t.update([{ id: 'new', state: 'cut' }]), []);
});

test('local history indexes old messages, excludes tools, persists and incrementally appends', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-history-'));
  const project = path.join(dir, '.claude', 'projects', 'fixture'); fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, '11111111-1111-4111-8111-111111111111.jsonl');
  const line = text => JSON.stringify({ type: 'user', cwd: dir, timestamp: '2024-01-01T00:00:00Z', message: { content: text } }) + '\n';
  fs.writeFileSync(file, line('Mi café fantástico sobre planetas') + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'secreto herramienta' }] } }) + '\n');
  const original = fs.readFileSync(file);
  const index = new HistoryIndex(dir, path.join(dir, 'derived', 'history.sqlite'));
  try {
    const first = await index.request('search', { query: 'café' });
    assert.equal(first.state.phase, 'indexing', 'first search responds while cataloging continues');
    await index.request('refresh');
    const result = await index.request('search', { query: 'cafe fantas' });
    assert.equal(result.total, 1); assert.equal(result.results[0].tool, 'claude');
    assert.equal(result.results[0].cwd, undefined, 'private source paths stay server-side');
    assert.equal((await index.request('search', { query: 'secreto' })).total, 0);
    assert.equal((await index.request('search', { query: '" OR * --' })).total, 0, 'FTS syntax is treated as literal words');
    assert.deepEqual(fs.readFileSync(file), original, 'index never changes source');
    fs.appendFileSync(file, line('Otra galaxia memorable'));
    await index.request('refresh');
    assert.equal((await index.request('search', { query: 'galaxia' })).total, 1);
    assert.equal((await index.request('search', { query: 'café' })).total, 1, 'unchanged messages are not duplicated');
    assert.equal(index.state.phase, 'ready');
    await index.worker.terminate(); index.worker = null;
    assert.equal((await index.request('search', { query: 'galaxia' })).total, 1, 'index survives worker restart');
  } finally { await index.worker?.terminate(); fs.rmSync(dir, { force: true, recursive: true }); }
});

test('DGX status preserves real verdict and never guesses missing load', () => {
  assert.equal(parseDgx('GPU 92%\nVERDICT: BUSY whisper lock').verdict, 'BUSY');
  assert.equal(parseDgx('Ollama online').verdict, 'UNKNOWN');
});

test('DGX highlights parse measured utilization and only live service evidence', () => {
  const data = parseDgx(`GPU: 92% util · 73°C
RAM unificada: 46/121 GB usada · 75 GB disponible
ComfyUI service: active
pid 3030203 10.8 GB /home/test/asr/whisper-venv/bin/python transcribe.py
VERDICT: BUSY
CPU_STAT_BEGIN
cpu 100 0 50 800 50 0 0 0 20 0
cpu 110 0 60 875 55 0 0 0 25 0
`);
  assert.equal(data.percent, 92); assert.equal(data.temperature, 73);
  assert.deepEqual(data.ram, { used: 46, total: 121 });
  assert.equal(data.cpuPercent, 20, 'guest counters must not count twice');
  assert.deepEqual(data.services, ['ComfyUI', 'Whisper']);
  const missing = parseDgx('Lock pesado: whisper (pid 12)\nComfyUI service: inactive');
  assert.deepEqual(missing.services, [], 'stale locks do not mean ON');
  assert.equal(missing.percent, null); assert.equal(missing.cpuPercent, null);
  assert.equal(missing.ram, null);
  assert.equal(parseDgx('GPU: 0% util · 35°C').percent, 0, 'zero is a measured value');
  assert.equal(parseDgx('CPU_STAT_BEGIN\ncpu 1 0 0 1 0 0 0 0\ncpu 1 0 0 1 0 0 0 0').cpuPercent, null);
});
