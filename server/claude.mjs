// Claude Code collector. Sources (read-only):
//   ~/.claude/sessions/<pid>.json   one file per running session, with its status
//   ~/.claude/projects/<proj>/<id>.jsonl   the transcript
//   ~/.claude/projects/<proj>/<id>/subagents/**   background agents' transcripts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyClaude, claudeMessageKind } from './classify.mjs';
import { applyUsage, publicUsage } from './usage.mjs';
import { commandsFor, placeOf, topicOf } from './places.mjs';
import { deriveTitle, endsWithQuestion, isRelayOrchestrator, jsonLines, lastWords, readHead, readRange, readTail, toMs } from './util.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(ROOT, 'projects');
const SESSIONS = path.join(ROOT, 'sessions');
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1536 * 1024;
const BG_ACTIVE_MS = 90_000;
const RECAP_SUFFIX = /\s*\(disable recaps in \/config\)\s*$/;

const cache = new Map(); // file -> { size, mtimeMs, parsed }

export function clearClaudeCache() {
  cache.clear();
  index.lastFull = 0;
}

export function stopClaudeWatcher() {
  index.watcher?.close();
  index.watcher = null;
}

function readLiveSessions(procs) {
  const live = new Map();
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS).filter((n) => n.endsWith('.json'));
  } catch {
    return live;
  }
  for (const file of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS, file), 'utf8'));
      const image = procs.get(Number(s.pid), Number(s.startedAt) || 0);
      if (!s.sessionId || (image !== 'claude.exe' && image !== 'unverified')) continue;
      live.set(s.sessionId, s);
    } catch {
      // A session file being rewritten right now: next cycle picks it up.
    }
  }
  return live;
}

// One session file, re-read right before acting on its process ("Cerrar").
export function sessionOf(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS, `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function firstUserText(entries) {
  for (const e of entries) {
    if (claudeMessageKind(e) !== 'user-real') continue;
    const c = e.message.content;
    return typeof c === 'string' ? c : c.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
  }
  return '';
}

// State from the first lines: first message, start folder, automation markers.
function startTranscript(headText) {
  const head = [...jsonLines(headText)];
  const p = {
    automated: false,
    firstUser: firstUserText(head).replace(/<\/?pasted_content[^>]*>/g, ' ').trim(),
    cwd: head.find((e) => e.cwd)?.cwd || '',
    cwds: [...new Set(head.filter((e) => e.cwd).map((e) => e.cwd))],
    branch: '',
    customTitle: '',
    aiTitle: '',
    away: null,
    lastAssistant: null,
    lastUserTs: 0,
    lastKind: null,
    lastKindTs: 0,
    lastTs: 0,
    cleanExit: false,
  };
  if (head.some((e) => e.entrypoint === 'sdk-cli') || p.firstUser.startsWith('<!-- ai-pack')) p.automated = true;
  return p;
}

// Every field is "latest wins", so appended lines can be applied on top of an
// earlier state: that is what makes the incremental read below correct.
function applyEntries(p, text) {
  for (const e of jsonLines(text)) {
    p.usage ||= {};
    applyUsage(p.usage, e, 'claude');
    const ts = toMs(e.timestamp);
    if (ts > p.lastTs) p.lastTs = ts;
    if (e.entrypoint === 'sdk-cli') p.automated = true;
    if (e.cwd) {
      p.cwd = e.cwd;
      if (!p.cwds.includes(e.cwd)) p.cwds.push(e.cwd);
    }
    if (e.gitBranch) p.branch = e.gitBranch;
    if (e.type === 'custom-title' && e.customTitle) p.customTitle = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) p.aiTitle = e.aiTitle;
    if (e.type === 'system' && e.subtype === 'away_summary' && e.content) {
      p.away = { text: String(e.content).replace(RECAP_SUFFIX, ''), ts };
    }
    // Written on a normal quit; a resumed chat's next message clears it.
    if (e.type === 'cost-state') p.cleanExit = true;
    const kind = claudeMessageKind(e);
    if (kind) p.cleanExit = false;
    if (!kind || kind === 'user-meta' || kind === 'user-notification') continue;
    p.lastKind = kind;
    p.lastKindTs = ts;
    if (kind === 'user-real') p.lastUserTs = ts;
    if (e.type === 'assistant') {
      const c = e.message?.content;
      const text = Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (text.trim()) p.lastAssistant = { text, ts };
    }
  }
}

export function parseClaudeTranscript(headText, tailText) {
  const p = startTranscript(headText);
  applyEntries(p, tailText);
  return p;
}

// Busy chats grow every few seconds; only the new complete lines are parsed.
function parseCached(file, st, full) {
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && (hit.parsed.tailRead || !full)) return hit;
  if (hit?.parsed.tailRead && st.size > hit.offset && st.size - hit.offset <= TAIL_BYTES) {
    const buf = readRange(file, hit.offset, st.size);
    const end = buf.lastIndexOf(10) + 1;
    if (end > 0) {
      applyEntries(hit.parsed, buf.subarray(0, end).toString('utf8'));
      hit.offset += end;
    }
    hit.size = st.size;
    hit.mtimeMs = st.mtimeMs;
    return hit;
  }
  const parsed = startTranscript(readHead(file, HEAD_BYTES));
  let offset = st.size;
  // Automated lanes are known from the head alone: skip their tail unless shown.
  if (!parsed.automated || full) {
    const { text, size } = readTail(file, TAIL_BYTES);
    const end = text.lastIndexOf('\n') + 1;
    applyEntries(parsed, text.slice(0, end));
    offset = size - Buffer.byteLength(text.slice(end));
    parsed.tailRead = true;
  }
  const entry = { size: st.size, mtimeMs: st.mtimeMs, offset, parsed };
  cache.set(file, entry);
  return entry;
}

// Same cached read the collector uses, for tests.
export const readTranscript = (file) => parseCached(file, fs.statSync(file), false).parsed;

// Newest write inside the session's subagents/ (and workflows) folders.
function backgroundMtime(sessionDir) {
  let newest = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (ent.name.endsWith('.jsonl')) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          // File rotated away mid-scan.
        }
      }
    }
  };
  walk(path.join(sessionDir, 'subagents'), 0);
  return newest;
}

// Transcript index kept fresh by a recursive watcher (ReadDirectoryChangesW on
// Windows), so a cycle only stats files that changed. Stat-ing all ~450
// transcripts costs ~50 ms of CPU, so the full rescan only runs every 60 s, as a
// safety net for anything the watcher misses.
const FULL_SCAN_MS = 60_000;
const index = { files: new Map(), dirty: new Set(), bgEvents: new Map(), bgSizes: new Map(), lastFull: 0, watcher: null };

// Only a write counts as background work. Windows also reports a file being read
// (its last-access time), and Claude Code touches its subagent transcripts when
// it quits, which made a chat closed after a finished turn look cut. The mtime of
// a file being written can lag, so growth is what is compared.
export function noteSubagentEvent(key, file, now = Date.now()) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return; // Deleted or renamed.
  }
  const before = index.bgSizes.get(file);
  index.bgSizes.set(file, st.size);
  const wrote = before === undefined ? now - st.mtimeMs < 10_000 : st.size !== before;
  if (wrote) index.bgEvents.set(key, now);
}

export const backgroundEventAt = (key) => index.bgEvents.get(key) || 0;

function startWatcher() {
  if (index.watcher) return;
  try {
    index.watcher = fs.watch(PROJECTS, { recursive: true }, (_event, name) => {
      if (!name) {
        index.lastFull = 0; // Event overflow: rescan everything.
        return;
      }
      const parts = String(name).split(/[\\/]/);
      if (parts.length === 2 && parts[1].endsWith('.jsonl')) index.dirty.add(path.join(PROJECTS, parts[0], parts[1]));
      else if (parts[2] === 'subagents' && name.endsWith('.jsonl')) noteSubagentEvent(`${parts[0]}/${parts[1]}`, path.join(PROJECTS, String(name)));
    });
    index.watcher.on('error', () => {
      index.watcher?.close();
      index.watcher = null;
      index.lastFull = 0;
    });
  } catch {
    index.watcher = null;
  }
}

function statInto(file, project) {
  const name = path.basename(file);
  if (!name.endsWith('.jsonl') || name.startsWith('agent-')) return;
  try {
    index.files.set(file, { id: name.slice(0, -6), project, st: fs.statSync(file) });
  } catch {
    index.files.delete(file); // Moved or deleted.
  }
}

function refreshIndex(now) {
  startWatcher();
  if (index.watcher && now - index.lastFull < FULL_SCAN_MS) {
    for (const file of index.dirty) statInto(file, path.basename(path.dirname(file)));
    index.dirty.clear();
    return;
  }
  index.files.clear();
  index.dirty.clear();
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    return;
  }
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(PROJECTS, dir.name));
    } catch {
      continue;
    }
    for (const n of names) statInto(path.join(PROJECTS, dir.name, n), dir.name);
  }
  index.lastFull = now;
}

export function collectClaude({ procs, windowMs, now, includeAutomated = false, includedIds = new Set() }) {
  const live = readLiveSessions(procs);
  const chats = [];
  let hidden = 0;
  refreshIndex(now);
  // A resumed session can be moved or copied to another project folder; the
  // newest transcript is the one `claude --resume` will use.
  const newest = new Map(); // id -> { file, st, project }
  for (const [file, { id, project, st }] of index.files) {
    if (!live.has(id) && !includedIds.has(id) && now - st.mtimeMs > windowMs) continue;
    const prev = newest.get(id);
    if (!prev || st.mtimeMs > prev.st.mtimeMs) newest.set(id, { file, st, project });
  }
  for (const [id, { file, st, project }] of newest) {
    const session = live.get(id);
    let entry;
    try {
      entry = parseCached(file, st, includeAutomated || includedIds.has(id));
    } catch {
      continue;
    }
    const p = entry.parsed;
    const automated = Boolean(p.automated || (session && (session.kind !== 'interactive' || session.entrypoint === 'sdk-cli')));
    if (automated) {
      if (!includedIds.has(id)) hidden += 1;
      if (!includeAutomated && !includedIds.has(id)) continue;
    }
    // A closed session where nobody ever wrote anything is noise.
    if (!session && !p.lastKind && !p.firstUser) continue;
    // Walk the subagents folder once; after that the watcher reports new writes.
    // Without a watcher, open chats are walked every cycle.
    if (entry.bgWalk === undefined || (session && !index.watcher)) {
      entry.bgWalk = backgroundMtime(path.join(PROJECTS, project, id));
    }
    const bg = Math.max(entry.bgWalk, index.bgEvents.get(`${project}/${id}`) || 0);
    const chat = buildChat(id, p, session, project, bg, now);
    chat.file = file;
    if (automated) chat.automated = true;
    chats.push(chat);
  }
  return { chats, hidden, liveCount: live.size };
}

// Claude names a project folder after its working directory with every
// non-alphanumeric character turned into '-'.
export const projectKey = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');

// The folder whose name matches the transcript's project is where
// `claude --resume <id>` finds the chat; the session's live cwd may have moved
// into a subfolder through `cd`.
export function resumeCwd(project, candidates) {
  const list = candidates.filter(Boolean);
  return list.find((c) => projectKey(c) === project) || list[0] || '';
}

function buildChat(id, p, session, project, bg, now) {
  const alive = Boolean(session);
  const state = classifyClaude({
    alive,
    status: session?.status,
    lastKind: p.lastKind,
    bgAfterReply: bg > p.lastKindTs + 5000,
    bgActive: now - bg < BG_ACTIVE_MS,
    cleanExit: p.cleanExit,
  });
  const cwd = resumeCwd(project, [session?.cwd, p.cwd, ...p.cwds]);
  const { folder, worktree } = placeOf(cwd);
  const title = p.customTitle || p.aiTitle || deriveTitle(p.firstUser) || (alive ? 'New chat' : 'Untitled');
  const lastActivity = Math.max(p.lastTs, bg, alive ? Number(session.updatedAt) || 0 : 0);
  const useAway = p.away && (!p.lastAssistant || p.away.ts >= p.lastAssistant.ts);
  let stateSince = lastActivity;
  if (alive && session.statusUpdatedAt) stateSince = Number(session.statusUpdatedAt);
  else if (state === 'closed' || state === 'waiting') stateSince = p.lastAssistant?.ts || lastActivity;
  return {
    id,
    tool: 'claude',
    ...(isRelayOrchestrator(p.firstUser) ? { role: 'orchestrator' } : {}),
    title,
    state,
    alive,
    folder,
    worktree,
    topic: topicOf(folder, title),
    lastActivity,
    stateSince,
    lastLine: useAway ? p.away.text : lastWords(p.lastAssistant?.text || ''),
    endsWithQuestion: endsWithQuestion(p.lastAssistant?.text || ''),
    ...commandsFor('claude', cwd, id),
    canOpen: !alive,
    pid: alive ? Number(session.pid) || undefined : undefined,
    procStart: alive ? session.procStart : undefined,
    cwd,
    branch: p.branch || undefined,
    usage: publicUsage(p.usage),
  };
}
