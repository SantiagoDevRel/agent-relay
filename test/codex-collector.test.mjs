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

// 2026-11-16: with twenty Codex chats writing, the oldest row of logs_2.sqlite was two hours
// old. Five chats that had waited longer were shown closed with their terminals open, and
// nothing was delivered to them (one message waited 5 h 36 min).
test('Codex: a chat whose log rows Codex pruned stays open while its own process runs', async () => {
  const { clearCodexCache } = await import('../server/codex.mjs');
  const QUIET_PID = 4545;
  const loggedAt = Math.floor((now - 60_000) / 1000) * 1000;
  const write = (file, sql, ...args) => { const db = new DatabaseSync(path.join(codexDir, file)); db.prepare(sql).run(...args); db.close(); };
  write('state_5.sqlite', `insert into threads (id, updated_at, updated_at_ms, source, name, cwd, rollout_path) values (?, ?, ?, 'cli', 'Quiet chat', ?, ?)`,
    'quiet', loggedAt / 1000, loggedAt, path.join(home, 'repo'), rollout('quiet', finished(60_000)));
  write('logs_2.sqlite', `insert into logs (ts, ts_nanos, thread_id, process_uuid) values (?, 0, 'quiet', ?)`, loggedAt / 1000, `pid:${QUIET_PID}:uuid-quiet`);
  let running = true;
  let created = loggedAt - 3600_000;
  const watch = { get: (pid) => (pid === QUIET_PID && running ? 'codex.exe' : procs.get(pid)), created: (pid) => (pid === QUIET_PID ? created : undefined) };
  let at = now;
  const quiet = () => { at += 31_000; return collectCodex({ procs: watch, windowMs: DAY, now: at }).chats.find((c) => c.id === 'quiet'); };

  assert.equal(quiet().alive, true, 'open while its log row exists');
  write('logs_2.sqlite', `delete from logs where thread_id = 'quiet'`);
  const kept = quiet();
  assert.equal(kept.alive, true, 'the trimmed row does not close the chat');
  assert.equal(kept.state, 'waiting');
  assert.equal(kept.pid, QUIET_PID);
  assert.equal(kept.pidSeenAt, loggedAt, 'the send path still checks the process against the last real log');
  assert.equal(kept.canOpen, false, 'never offer to reopen a live session');

  clearCodexCache();
  assert.equal(quiet().alive, true, 'a resync keeps what was observed');

  created = loggedAt + 60_000;
  assert.equal(quiet().alive, false, 'a process created after the last log is another program with the same pid');
  created = undefined;
  assert.equal(quiet().alive, false, 'without a creation time nothing vouches for the pid');
  created = loggedAt - 3600_000;
  running = false;
  const gone = quiet();
  assert.equal(gone.alive, false, 'the process ended');
  assert.equal(gone.state, 'closed');
  running = true;
  assert.equal(quiet().alive, true, 'the same process seen again is still the chat');

  const blind = collectCodex({ procs: { get: watch.get }, windowMs: DAY, now: at + 31_000 });
  assert.equal(blind.chats.find((c) => c.id === 'quiet').alive, false, 'a watcher that cannot tell creation times keeps the old rule');
});
