// collectCodex against throwaway Codex databases in a temp home folder.
// node --test runs each file in its own process, so the home override stays here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-codex-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const codexDir = path.join(home, '.codex');
fs.mkdirSync(codexDir);

const DAY = 86400_000;
const now = Date.now();
const OPEN_PID = 4242;
const OTHER_PID = 4343;
const AUTOMATED_PID = 4444;

function rollout(name, events) {
  const file = path.join(codexDir, `${name}.jsonl`);
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

const state = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
state.exec(`create table threads (id text primary key, updated_at integer, updated_at_ms integer,
  source text, name text, title text, first_user_message text, cwd text, git_branch text,
  rollout_path text, archived integer default 0)`);
const logs = new DatabaseSync(path.join(codexDir, 'logs_2.sqlite'));
logs.exec(`create table logs (id integer primary key autoincrement, ts integer, ts_nanos integer,
  thread_id text, process_uuid text)`);

function thread(id, { ageMs, pid, events, name, source = 'cli' }) {
  const at = now - ageMs;
  const file = events ? rollout(id, events) : path.join(codexDir, `${id}-missing.jsonl`);
  state.prepare(`insert into threads (id, updated_at, updated_at_ms, source, name, cwd, rollout_path)
    values (?, ?, ?, ?, ?, ?, ?)`).run(id, Math.floor(at / 1000), at, source, name, path.join(home, 'repo'), file);
  if (pid) {
    logs.prepare(`insert into logs (ts, ts_nanos, thread_id, process_uuid) values (?, 0, ?, ?)`)
      .run(Math.floor(at / 1000), id, `pid:${pid}:uuid-${id}`);
  }
}

const finished = (ageMs) => [
  { timestamp: new Date(now - ageMs).toISOString(), type: 'event_msg', payload: { type: 'task_started' } },
  {
    timestamp: new Date(now - ageMs + 1000).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: '¿Seguimos?' },
  },
];

// Terminal left open for a month: outside every window, still open.
thread('old-open', { ageMs: 30 * DAY, pid: OPEN_PID, events: finished(30 * DAY), name: 'Old but open' });
// Same age, process gone: belongs to no window.
thread('old-closed', { ageMs: 30 * DAY, pid: 9999, events: finished(30 * DAY), name: 'Old and closed' });
// Open terminal whose rollout file is missing: no evidence about the turn.
thread('no-rollout', { ageMs: 60_000, pid: OTHER_PID, name: 'Missing rollout' });
thread('automated-open', { ageMs: 30_000, pid: AUTOMATED_PID, name: 'Automated work', source: 'exec',
  events: [{ timestamp: new Date(now - 30_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }] });
state.prepare('update threads set first_user_message = ? where id = ?').run('# Agent Relay · Orquestador\n<!-- agent-relay-native-orchestrator:v1 -->\nWait for the requested mission.', 'old-open');
state.close();
logs.close();

const { closeCodexDbs, collectCodex } = await import('../server/codex.mjs');
const procs = { get: (pid) => ([OPEN_PID, OTHER_PID, AUTOMATED_PID].includes(pid) ? 'codex.exe' : undefined) };

after(() => {
  closeCodexDbs();
  fs.rmSync(home, { recursive: true, force: true });
});

test('Codex: an open chat shows up however old it is; a closed old one does not', () => {
  const { chats, liveCount } = collectCodex({ procs, windowMs: DAY, now });
  const ids = chats.map((c) => c.id).sort();
  assert.deepEqual(ids, ['no-rollout', 'old-open']);
  assert.equal(liveCount, 2);
  const old = chats.find((c) => c.id === 'old-open');
  assert.equal(old.alive, true);
  assert.equal(old.state, 'waiting');
  assert.equal(old.endsWithQuestion, true);
  assert.equal(old.runCommand, 'codex resume old-open');
  assert.equal(old.role, 'orchestrator', 'native orchestrator role survives a custom chat title');
});

test('Codex: an open chat with an unreadable rollout is unknown, not waiting', () => {
  const { chats } = collectCodex({ procs, windowMs: DAY, now });
  const c = chats.find((x) => x.id === 'no-rollout');
  assert.equal(c.alive, true);
  assert.equal(c.state, 'unknown');
  assert.equal(c.role, undefined, 'ordinary chats keep their existing presentation');
});

test('Codex: showing automated chats preserves their real process and working state', () => {
  const hidden = collectCodex({ procs, windowMs: DAY, now });
  assert.equal(hidden.hidden, 1);
  assert.ok(!hidden.chats.some((c) => c.id === 'automated-open'));
  const shown = collectCodex({ procs, windowMs: DAY, now, includeAutomated: true });
  const chat = shown.chats.find((c) => c.id === 'automated-open');
  assert.equal(chat.automated, true);
  assert.equal(chat.alive, true, 'a live automated process must not look cut');
  assert.equal(chat.state, 'working');
  assert.equal(chat.pid, AUTOMATED_PID);
  assert.equal(chat.canOpen, false, 'never offer to reopen a live session');
});
