// E1 extractor: synthetic Claude/Codex transcripts in a fake home, isolated
// evals store, incremental checkpoints, redaction and read-only provider files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../evals/store.mjs';
import { validate } from '../evals/schema.mjs';
import { discoverSources, extractAll, extractFile } from '../evals/extract.mjs';
import { readLines } from '../evals/sources/lines.mjs';

const FIXTURES = new URL('./fixtures/evals/transcripts/', import.meta.url);
const fixture = name => fs.readFileSync(new URL(name, FIXTURES), 'utf8');
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '44444444-5555-4666-8777-888888888888';
const SECRET_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const C1 = '22222222-3333-4444-8555-666666666666';
const C2 = '33333333-4444-4555-8666-777777777777';
const C3 = '55555555-6666-4777-8888-999999999999';
// Assembled at runtime so no token-shaped literal lives in the repository.
const SECRET = 'sk-' + 'proj-' + 'Qw7Er9Ty2Ui4Op6As8Df1Gh3';

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }

function fakeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-evals-extract-'));
  const home = path.join(root, 'home');
  const projects = path.join(home, '.claude', 'projects', 'C--work-demo');
  const files = {
    main: write(path.join(projects, `${S1}.jsonl`), fixture('claude-main.ndjson')),
    aipack: write(path.join(projects, `${S2}.jsonl`), fixture('claude-aipack.ndjson')),
    subagent: write(path.join(projects, S1, 'subagents', 'agent-a1b2c3.jsonl'), fixture('claude-subagent.ndjson')),
    secret: write(path.join(projects, `${SECRET_ID}.jsonl`), `${JSON.stringify({
      type: 'user', message: { role: 'user', content: `Deploy with key ${SECRET} and mail ana.perez@example.com` },
      cwd: 'C:\\work\\demo', entrypoint: 'cli', sessionId: SECRET_ID, timestamp: '2026-10-21T08:00:00.000Z' })}\n`),
    classic: write(path.join(home, '.codex', 'sessions', '2026', '10', '20', `rollout-2026-10-20T11-00-00-${C1}.jsonl`), fixture('codex-classic.ndjson')),
    current: write(path.join(home, '.codex', 'archived_sessions', `rollout-2026-10-21T12-00-00-${C2}.jsonl`), fixture('codex-current.ndjson')),
    legacy: write(path.join(home, '.codex', 'sessions', '2025', '04', '01', `rollout-2025-04-01T08-00-00-${C3}.jsonl`), fixture('codex-legacy.ndjson')),
    ignored: write(path.join(home, '.codex', 'sessions', 'notes.txt'), 'not a transcript'),
  };
  const store = openStore({ home: path.join(root, 'evals') });
  return { root, home, files, store, cleanup: () => { try { store.close(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); } };
}

const hashes = home => {
  const out = {};
  const visit = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) visit(f); else out[f] = createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } };
  visit(home);
  return out;
};

test('Claude transcript: prompts, command, reminder, interrupt, tools, events, deduplicated usage, compaction, effort', async () => {
  const env = fakeHome();
  try {
    const { record, status } = await extractFile({ provider: 'claude', file: env.files.main });
    assert.equal(status, 'partial'); // One malformed line.
    assert.deepEqual(validate('chat-record', record), []);
    assert.equal(record.id, `claude:${S1}`);
    assert.equal(record.cwd, 'C:\\work\\demo');
    assert.equal(record.gitBranch, 'feature/greeting');
    assert.equal(record.entrypoint, 'cli');
    assert.equal(record.automated, false);
    assert.deepEqual(record.userMessages.map(m => [m.turn, m.kind, m.text]), [
      [0, 'prompt', 'Add a Spanish greeting and run the tests.'],
      [1, 'command', '/review'],
      [2, 'prompt', 'Ahora traduce también el mensaje de error, por favor.'],
      [2, 'interrupt', ''],
    ]);
    assert.ok(!JSON.stringify(record).includes('Injected context'), 'system reminder must be stripped');
    assert.ok(!JSON.stringify(record).includes('please check the diff'), 'command args are not stored');
    assert.equal(record.turns.length, 3);
    const [first, , third] = record.turns;
    assert.equal(first.toolCalls, 4);
    assert.equal(first.toolErrors, 1);
    assert.deepEqual(first.toolCounts, { read: 1, shell: 2, edit: 1 });
    assert.deepEqual(first.events, [
      { category: 'test', failed: false, cwd: null },
      { category: 'git-commit', failed: false, cwd: null, commits: ['a1b2c3d'] },
    ]);
    // msg_1 appears on two lines with the same usage: counted once.
    assert.deepEqual(first.tokens, { input: 5070, cached: 4900, cacheWrite: 50, output: 105, reasoning: 0, total: 5175 });
    assert.equal(first.agentFinal.text, 'Done: greeting added, tests pass and committed a1b2c3d.');
    assert.equal(first.endedAt, '2026-10-20T10:00:10.000Z');
    assert.equal(first.effort, 'high');
    assert.equal(third.interrupted, true);
    assert.deepEqual(third.events, [{ category: 'build', failed: null, cwd: 'C:/work/demo' }]);
    assert.deepEqual(record.compactions, [{ at: '2026-10-20T10:10:00.000Z', trigger: 'manual', turn: 0 }]);
    assert.deepEqual(record.efforts, [{ value: 'high', turns: 3 }]);
    assert.deepEqual(record.models, [{ value: 'claude-opus-5-5', turns: 3 }]);
    assert.equal(record.tokens.input, 5070 + 1505);
    assert.deepEqual({ ...record.coverage, bytes: 0 }, { complete: false, bytes: 0, lines: 24, skippedLines: 1, oversizedLines: 0, unknownEvents: 1 });
  } finally { env.cleanup(); }
});

test('Codex classic rollout: meta, effort, deduplicated prompt, exit codes, token deltas, abort, completion', async () => {
  const env = fakeHome();
  try {
    const { record, status } = await extractFile({ provider: 'codex', file: env.files.classic });
    assert.equal(status, 'ok');
    assert.deepEqual(validate('chat-record', record), []);
    assert.equal(record.id, `codex:${C1}`);
    assert.equal(record.gitBranch, 'main');
    assert.equal(record.entrypoint, 'codex-tui');
    assert.equal(record.automated, false);
    assert.deepEqual(record.userMessages.map(m => [m.turn, m.kind, m.text]), [
      [0, 'prompt', 'Fix the failing API test'], [0, 'interrupt', ''], [1, 'prompt', 'sigue, y haz commit cuando pase'],
    ]);
    const [first, second] = record.turns;
    assert.equal(first.interrupted, true);
    assert.equal(first.toolCalls, 3);
    assert.equal(first.toolErrors, 1);
    assert.deepEqual(first.events, [{ category: 'test', failed: true, cwd: 'C:\\work\\api' }, { category: 'typecheck', failed: false, cwd: 'C:\\work\\api' }]);
    assert.deepEqual(first.tokens, { input: 1000, cached: 600, cacheWrite: 0, output: 100, reasoning: 40, total: 1100 });
    assert.deepEqual(second.tokens, { input: 800, cached: 600, cacheWrite: 0, output: 60, reasoning: 20, total: 860 });
    assert.deepEqual(second.events[1], { category: 'git-commit', failed: false, cwd: null, commits: ['9f8e7d6'] });
    assert.equal(second.agentFinal.text, 'Committed 9f8e7d6; tests pass.');
    assert.equal(first.agentFinal.text, 'Partial fix applied.');
    assert.deepEqual(record.efforts, [{ value: 'high', turns: 2 }]);
    assert.equal(record.compactions.length, 1, 'compacted line and event are one compaction');
    assert.deepEqual(record.tokens, { input: 1800, cached: 1200, cacheWrite: 0, output: 160, reasoning: 60, total: 1960 });
  } finally { env.cleanup(); }
});

test('Codex current items and oldest legacy shapes; exec sessions are automated', async () => {
  const env = fakeHome();
  try {
    const current = (await extractFile({ provider: 'codex', file: env.files.current })).record;
    assert.equal(current.automated, true);
    assert.equal(current.turns[0].toolCalls, 2, 'item-mode counts replace the code-mode wrapper call');
    assert.equal(current.turns[0].toolErrors, 1);
    assert.deepEqual(current.turns[0].events, [{ category: 'lint', failed: true, cwd: 'C:\\work\\lib' }]);
    assert.equal(current.turns[0].effort, 'xhigh');
    assert.equal(current.turns[0].agentFinal.text, 'Lint still reports 2 problems.');
    const legacy = (await extractFile({ provider: 'codex', file: env.files.legacy })).record;
    assert.equal(legacy.id, `codex:${C3}`);
    assert.deepEqual(legacy.userMessages.map(m => m.text), ['List the files and run pytest']);
    assert.deepEqual(legacy.turns[0].events, [{ category: 'test', failed: false, cwd: '/home/user/app' }]);
  } finally { env.cleanup(); }
});

test('ai-pack chats and subagent files are automated; the subagent knows its parent', async () => {
  const env = fakeHome();
  try {
    const aipack = (await extractFile({ provider: 'claude', file: env.files.aipack })).record;
    assert.equal(aipack.automated, true);
    assert.equal(aipack.parentId, null);
    const sub = (await extractFile({ provider: 'claude', file: env.files.subagent })).record;
    assert.equal(sub.id, 'claude:agent-a1b2c3');
    assert.equal(sub.automated, true);
    assert.equal(sub.parentId, `claude:${S1}`);
    assert.deepEqual(sub.models, [{ value: 'claude-haiku-5-5', turns: 1 }], '<synthetic> is skipped');
    assert.deepEqual(sub.turns[0].toolCounts, { search: 1 });
  } finally { env.cleanup(); }
});

test('oversized and malformed lines are counted without breaking later lines', async () => {
  const env = fakeHome();
  try {
    const line = (text, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, sessionId: S1, timestamp: ts });
    const file = write(path.join(env.root, 'big', `${S1}.jsonl`), [
      line('first prompt', '2026-10-20T10:00:00.000Z'),
      line('x'.repeat(5000), '2026-10-20T10:00:01.000Z'),
      '{not json',
      line('third prompt after the big line', '2026-10-20T10:00:02.000Z'),
    ].join('\n'));
    const { record, status } = await extractFile({ provider: 'claude', file, maxLineBytes: 1024 });
    assert.equal(status, 'partial');
    assert.deepEqual(record.userMessages.map(m => m.text), ['first prompt', 'third prompt after the big line']);
    assert.equal(record.coverage.oversizedLines, 1);
    assert.equal(record.coverage.skippedLines, 1);
    assert.equal(record.coverage.complete, false);
    // The reader keeps multi-byte characters intact across tiny chunks.
    const seen = [];
    for await (const item of readLines(file, { maxLineBytes: 1024, chunkBytes: 7 })) seen.push(item.oversized ? 'BIG' : item.text.slice(0, 5));
    assert.deepEqual(seen, ['{"typ', 'BIG', '{not ', '{"typ']);
    const utf = write(path.join(env.root, 'big', 'utf.jsonl'), 'ñandú→😀\nok');
    const lines = [];
    for await (const item of readLines(utf, { chunkBytes: 3 })) lines.push(item.text);
    assert.deepEqual(lines, ['ñandú→😀', 'ok']);
  } finally { env.cleanup(); }
});

test('extractAll is incremental, redacts secrets, keeps the richer duplicate and never changes provider files', async () => {
  const env = fakeHome();
  try {
    const sources = discoverSources({ home: env.home });
    assert.equal(sources.length, 7);
    assert.ok(sources.every(s => s.file.endsWith('.jsonl') && s.size > 0 && Number.isInteger(s.mtimeMs)));
    const before = hashes(env.home);
    const progress = [];
    const first = await extractAll({ store: env.store, home: env.home, onProgress: p => progress.push(p.done) });
    assert.deepEqual(first, { files: 7, processed: 7, unchanged: 0, partial: 1, empty: 0, errors: 0, chats: 7 });
    assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7]);
    const second = await extractAll({ store: env.store, home: env.home });
    assert.equal(second.processed, 0);
    assert.equal(second.unchanged, 7);
    assert.deepEqual(hashes(env.home), before, 'provider files must be byte-identical');

    // Secret redacted in the stored record and absent from every database file.
    const stored = env.store.chat(`claude:${SECRET_ID}`);
    assert.match(stored.userMessages[0].text, /\[REDACTED:openai-key\].*\[REDACTED:email\]/);
    assert.equal(stored.redactions, 2);
    for (const record of env.store.chats()) assert.ok(!JSON.stringify(record).includes(env.home), 'records never hold provider paths');
    env.store.db.exec('pragma wal_checkpoint(TRUNCATE)');
    for (const name of fs.readdirSync(env.store.home)) {
      const bytes = fs.readFileSync(path.join(env.store.home, name));
      assert.ok(!bytes.includes(Buffer.from(SECRET)), `secret value found in ${name}`);
      assert.ok(!bytes.includes(Buffer.from('ana.perez@example.com')), `email found in ${name}`);
    }

    // Appending to one file re-processes only that file.
    fs.appendFileSync(env.files.classic, `${JSON.stringify({ timestamp: '2026-10-20T11:05:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'one more thing' } })}\n`);
    const third = await extractAll({ store: env.store, home: env.home });
    assert.equal(third.processed, 1);
    assert.equal(third.unchanged, 6);
    assert.equal(env.store.chat(`codex:${C1}`).turns.length, 3);

    // A copy of the main chat with fewer turns in another project folder: the richer record stays.
    const poorer = fixture('claude-main.ndjson').split('\n').slice(0, 6).join('\n') + '\n';
    const moved = write(path.join(env.home, '.claude', 'projects', 'C--work-other', `${S1}.jsonl`), poorer);
    const fourth = await extractAll({ store: env.store, home: env.home });
    assert.equal(fourth.processed, 1);
    assert.equal(env.store.chat(`claude:${S1}`).turns.length, 3);
    assert.equal(env.store.checkpoint(moved).chatId, `claude:${S1}`);
    assert.equal(env.store.checkpoint(env.files.main).chatId, `claude:${S1}`);
    // When the moved copy becomes richer, it replaces the record.
    fs.appendFileSync(moved, fixture('claude-main.ndjson').split('\n').slice(6).join('\n') + '\n'
      + `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a fourth prompt' }, sessionId: S1, timestamp: '2026-10-22T09:00:00.000Z' })}\n`);
    await extractAll({ store: env.store, home: env.home });
    assert.equal(env.store.chat(`claude:${S1}`).turns.length, 4);
  } finally { env.cleanup(); }
});

test('empty files, unreadable files and symlinks are handled without records', async () => {
  const env = fakeHome();
  try {
    const empty = write(path.join(env.home, '.claude', 'projects', 'C--work-demo', '77777777-8888-4999-8aaa-bbbbbbbbbbbb.jsonl'),
      `${JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} })}\n`);
    const outside = write(path.join(env.root, 'outside', 'secret.jsonl'), fixture('claude-aipack.ndjson'));
    let linked = false;
    try { fs.symlinkSync(path.dirname(outside), path.join(env.home, '.codex', 'sessions', 'linked'), 'junction'); linked = true; } catch { /* Symlinks unavailable. */ }
    const sources = discoverSources({ home: env.home });
    assert.ok(!sources.some(s => s.file.startsWith(path.dirname(outside))), 'never follows links outside the roots');
    if (linked) assert.ok(!sources.some(s => s.file.includes(`${path.sep}linked${path.sep}`)));
    const summary = await extractAll({ store: env.store, home: env.home });
    assert.equal(summary.empty, 1);
    assert.equal(env.store.checkpoint(empty).status, 'empty');
    const missing = await extractFile({ provider: 'codex', file: path.join(env.root, 'missing.jsonl') });
    assert.deepEqual(missing, { record: null, status: 'error', detail: 'read failed: ENOENT' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(extractAll({ store: env.store, home: env.home, signal: controller.signal }), /abort/i);
  } finally { env.cleanup(); }
});
