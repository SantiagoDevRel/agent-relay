// Codex CLI collector. Sources (read-only):
//   ~/.codex/state_*.sqlite   threads: name, cwd, source, rollout path
//   ~/.codex/logs_*.sqlite    which codex.exe process last touched each thread
//   rollout .jsonl            turn events (task_started / task_complete / turn_aborted)
// Windows can leave a rollout's mtime stale while Codex holds it open, so change
// detection uses the file size and the database, never the mtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyCodex } from './classify.mjs';
import { applyUsage, publicUsage } from './usage.mjs';
import { commandsFor, normalizeCwd, placeOf, topicOf } from './places.mjs';
import { deriveTitle, endsWithQuestion, isRelayOrchestrator, jsonLines, lastWords, readTail, toMs } from './util.mjs';

const CODEX = path.join(os.homedir(), '.codex');
const CHUNK = 4 * 1024 * 1024;

const cache = new Map(); // rollout -> { size, parsed }
const rolloutMemo = new Map(); // thread id -> { updated, parsed }
const procMemo = new Map(); // thread id -> { updated, checkedAt, pid, ts }
const PROC_RECHECK_MS = 30_000;
let candidateMemo = { at: 0, rows: [] };
let dbs = null;

export function clearCodexCache() {
  cache.clear();
  rolloutMemo.clear();
  procMemo.clear();
  candidateMemo = { at: 0, rows: [] };
  closeCodexDbs();
}

export function closeCodexDbs() {
  if (!dbs) return;
  for (const db of [dbs.state, dbs.logs]) {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
  dbs = null;
}

// Newest versioned file, e.g. state_5.sqlite over state_4.sqlite.
function newestDb(prefix) {
  const files = fs.readdirSync(CODEX).filter((n) => new RegExp(`^${prefix}_\\d+\\.sqlite$`).test(n));
  files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  return files[0] ? path.join(CODEX, files[0]) : null;
}

function openDbs() {
  if (dbs) return dbs;
  const statePath = newestDb('state');
  if (!statePath) throw new Error('Codex state database not found');
  const logsPath = newestDb('logs');
  const state = new DatabaseSync(statePath, { readOnly: true });
  const logs = logsPath ? new DatabaseSync(logsPath, { readOnly: true }) : null;
  const columns = `id, coalesce(updated_at_ms, updated_at * 1000) as updated, source,
             name, title, first_user_message, cwd, git_branch, rollout_path`;
  const interactive = `archived = 0 and source != 'exec' and source not like '%subagent%'`;
  const automated = `archived = 0 and (source = 'exec' or source like '%subagent%')`;
  dbs = {
    state,
    logs,
    // Every interactive thread, however old: a terminal can stay open for weeks.
    // Ids only; a few hundred rows plus indexed log lookups cost a few ms.
    candidates: state.prepare(`
      select id, coalesce(updated_at_ms, updated_at * 1000) as updated
      from threads where ${interactive}`),
    // updated_at (seconds) is indexed; updated_at_ms only adds precision.
    threads: state.prepare(`
      select ${columns} from threads
      where updated_at >= ? and ${interactive}
      order by updated_at desc`),
    threadById: state.prepare(`select ${columns} from threads where id = ?`),
    automatedThreads: state.prepare(`
      select ${columns} from threads
      where updated_at >= ? and ${automated}
      order by updated_at desc`),
    automatedCount: state.prepare(`
      select count(*) as n from threads where updated_at >= ? and ${automated}`),
    lastProcess: logs?.prepare(`
      select process_uuid, ts from logs
      where thread_id = ? order by ts desc, ts_nanos desc, id desc limit 1`),
  };
  return dbs;
}

const TASK_EVENTS = { task_started: 'started', task_complete: 'complete', turn_aborted: 'aborted' };
// Raw-text prefilters. Inside JSON strings quotes are escaped, so these only match
// real top-level fields; each hit is still parsed and checked.
const TASK_RE = /"type":"(?:task_started|task_complete|turn_aborted)"/;
const AGENT_RE = /"type":"(?:task_complete|agent_message)"|"role":"assistant"/;
const USAGE_RE = /"type"\s*:\s*"(?:token_count|turn_context)"/;

export function taskOf(e) {
  const t = e?.type === 'event_msg' ? TASK_EVENTS[e.payload?.type] : undefined;
  return t ? { lastTask: t, lastTaskTs: toMs(e.timestamp) } : null;
}

export function agentTextOf(e) {
  const pl = e?.payload || {};
  let text = '';
  if (e?.type === 'event_msg' && pl.type === 'task_complete') text = pl.last_agent_message || '';
  else if (e?.type === 'event_msg' && pl.type === 'agent_message') text = pl.message || '';
  else if (e?.type === 'response_item' && pl.type === 'message' && pl.role === 'assistant') {
    text = (pl.content || []).map((c) => c?.text || '').join('\n');
  }
  return text.trim() ? { lastAgent: text, lastAgentTs: toMs(e.timestamp) } : null;
}

// Last line in [start, end) that matches `re` and that `pick` accepts, scanning
// backwards in chunks so a 1 GB rollout costs only the bytes after the event.
function scanBack(fd, start, end, re, pick) {
  let hi = end;
  while (hi > start) {
    const lo = Math.max(start, hi - CHUNK);
    const buf = Buffer.alloc(hi - lo);
    fs.readSync(fd, buf, 0, hi - lo, lo);
    let cut = 0;
    if (lo > start) {
      cut = buf.indexOf(10) + 1;
      if (cut === 0 || cut >= buf.length) {
        hi = lo; // No whole line in this chunk: part of one huge line, never a turn event.
        continue;
      }
    }
    const lines = buf.subarray(cut).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!re.test(lines[i])) continue;
      try {
        const got = pick(JSON.parse(lines[i]));
        if (got) return got;
      } catch {
        // Partial line at a chunk edge.
      }
    }
    hi = lo + cut;
  }
  return null;
}

const EMPTY = { lastTask: null, lastTaskTs: 0, lastAgent: '', lastAgentTs: 0, lastTs: 0 };

// Incremental: when the rollout grows, only the new bytes (plus a margin) are scanned.
export function readRollout(rollout) {
  const fd = fs.openSync(rollout, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const hit = cache.get(rollout);
    if (hit && hit.size === size) return hit.parsed;
    const grew = hit && size > hit.size;
    const from = grew ? Math.max(0, hit.size - 65536) : 0;
    const base = grew ? hit.parsed : EMPTY;
    const task = scanBack(fd, from, size, TASK_RE, taskOf);
    const agent = scanBack(fd, from, size, AGENT_RE, agentTextOf);
    const usageFrom = Math.max(from, size - 8 * 1024 * 1024);
    const latest = scanBack(fd, usageFrom, size, USAGE_RE, e => {
      const usage = {}; applyUsage(usage, e, 'codex');
      return usage.at ? usage : null;
    });
    const context = scanBack(fd, usageFrom, size, /"type"\s*:\s*"turn_context"/, e => e.type === 'turn_context' && e.payload?.model ? { model: e.payload.model } : null);
    const compact = scanBack(fd, usageFrom, size, /"type"\s*:\s*"compacted"/, e => e.type === 'compacted' ? { at: toMs(e.timestamp) } : null);
    const usage = latest ? { ...latest, model: context?.model || base.usage?.model || null } : { ...base.usage };
    usage.interruptions = base.usage?.interruptions || 0;
    usage.compactions = base.usage?.compactions || 0;
    if (compact && compact.at >= (usage.at || 0)) { usage.contextTokens = null; usage.contextPercent = null; }
    let lastTs = base.lastTs;
    const seen = base.usage?.signalAt || 0;
    for (const e of jsonLines(readTail(rollout, 65536).text)) {
      const at = toMs(e.timestamp); lastTs = Math.max(lastTs, at);
      if (at > seen && (e.type === 'compacted' || e.payload?.type === 'turn_aborted')) {
        if (e.type === 'compacted') usage.compactions++;
        else usage.interruptions++;
        usage.signalAt = Math.max(usage.signalAt || 0, at);
      }
    }
    const parsed = { ...base, ...(task || {}), ...(agent || {}), lastTs,
      usage };
    cache.set(rollout, { size, parsed });
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

// All interactive threads (re-listed every 30 s) plus this cycle's fresh window rows.
// A thread that changes is always in the window, so the 30 s list only has to
// catch old threads reopened without a new turn.
function candidateThreads(db, rows, now) {
  if (now - candidateMemo.at > PROC_RECHECK_MS) candidateMemo = { at: now, rows: db.candidates.all() };
  const byId = new Map(candidateMemo.rows.map((r) => [r.id, r]));
  for (const r of rows) byId.set(r.id, r);
  return byId.values();
}

// thread id -> { pid, ts } of the codex.exe process that last logged for it, if still running.
function aliveThreads(db, threads, procs, now) {
  const byPid = new Map();
  if (!db.lastProcess) return new Map();
  for (const t of threads) {
    // The thread -> process lookup is re-queried when the thread changes or
    // every 30 s; whether that process still runs is checked every cycle.
    let m = procMemo.get(t.id);
    if (!m || m.updated !== t.updated || now - m.checkedAt > PROC_RECHECK_MS) {
      const row = db.lastProcess.get(t.id);
      m = {
        updated: t.updated,
        checkedAt: now,
        pid: Number(String(row?.process_uuid || '').match(/^pid:(\d+):/)?.[1]),
        ts: toMs(row?.ts),
      };
      procMemo.set(t.id, m);
    }
    const { pid, ts } = m;
    const name = pid ? procs.get(pid, ts) : undefined;
    if (name !== 'codex.exe' && name !== 'unverified') continue;
    const current = byPid.get(pid);
    // A terminal shows one thread at a time: keep the one it touched last.
    if (!current || ts > current.ts) byPid.set(pid, { id: t.id, ts });
  }
  return new Map([...byPid].map(([pid, v]) => [v.id, { pid, ts: v.ts }]));
}

// Subagent threads have no name; their source JSON carries a nickname and path.
function automatedTitle(r) {
  try {
    const spawn = JSON.parse(r.source)?.subagent?.thread_spawn;
    if (spawn) return `Subagent ${spawn.agent_nickname || ''} · ${spawn.agent_path || ''}`.trim();
  } catch {
    // 'exec' is a plain string, not JSON.
  }
  return '';
}

export function collectCodex({ procs, windowMs, now, includeAutomated = false, includedIds = new Set() }) {
  const db = openDbs();
  const since = Math.floor((now - windowMs) / 1000);
  const rows = db.threads.all(since);
  const automatedRows = includeAutomated ? db.automatedThreads.all(since) : [];
  const alive = aliveThreads(db, [...candidateThreads(db, rows, now), ...automatedRows], procs, now);
  // Open chats older than the window are shown too.
  const shown = new Set([...rows, ...automatedRows].map((r) => r.id));
  for (const id of new Set([...alive.keys(), ...includedIds])) {
    if (shown.has(id)) continue;
    const row = db.threadById.get(id);
    if (row && (includedIds.has(id) || includeAutomated || (row.source !== 'exec' && !String(row.source).includes('subagent')))) rows.push({ ...row, automated: row.source === 'exec' || String(row.source).includes('subagent') });
  }
  const hidden = Number(db.automatedCount.get(since).n);
  const chats = [];
  for (const r of [...rows, ...automatedRows.map((a) => ({ ...a, automated: true }))]) {
    const live = alive.get(r.id);
    // A closed thread's rollout only changes when its database row does.
    let p = EMPTY;
    let unreadable = false;
    const memo = rolloutMemo.get(r.id);
    if (!live && memo && memo.updated === r.updated) p = memo.parsed;
    else {
      try {
        p = readRollout(normalizeCwd(r.rollout_path));
        rolloutMemo.set(r.id, { updated: r.updated, parsed: p });
      } catch {
        // Missing rollout: the state stays unknown instead of guessed.
        unreadable = true;
      }
    }
    const state = classifyCodex({ alive: Boolean(live), lastTask: p.lastTask, unreadable });
    const cwd = normalizeCwd(r.cwd);
    const { folder, worktree } = placeOf(cwd);
    const title = r.name || (r.automated && automatedTitle(r)) || deriveTitle(r.title || r.first_user_message || '') || 'Untitled';
    const lastActivity = Math.max(p.lastTs, Number(r.updated) || 0, live?.ts || 0);
    chats.push({
      id: r.id,
      tool: 'codex',
      ...(isRelayOrchestrator(r.first_user_message) ? { role: 'orchestrator' } : {}),
      title,
      state,
      alive: Boolean(live),
      folder,
      worktree,
      topic: topicOf(folder, title),
      lastActivity,
      stateSince: state === 'cut' || !p.lastTaskTs ? lastActivity : p.lastTaskTs,
      lastLine: lastWords(p.lastAgent),
      endsWithQuestion: endsWithQuestion(p.lastAgent),
      ...commandsFor('codex', cwd, r.id),
      canOpen: !live,
      pid: live?.pid,
      pidSeenAt: live?.ts,
      file: normalizeCwd(r.rollout_path),
      cwd,
      branch: r.git_branch || undefined,
      automated: r.automated || undefined,
      usage: publicUsage(p.usage),
    });
  }
  return { chats, hidden, liveCount: alive.size };
}
