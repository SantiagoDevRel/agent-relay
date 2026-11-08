// Linux native discovery and tmux custody. Provider files are read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createTmuxBackend, processStart } from './chat-tab-tmux.mjs';
import { collectClaude, readTranscript } from './claude.mjs';
import { collectCodex, readRollout } from './codex.mjs';
import { classifyCodex } from './classify.mjs';
import { commandsFor, placeOf, topicOf } from './places.mjs';
import { deriveTitle, endsWithQuestion, isRelayOrchestrator, jsonLines, lastWords, readHead } from './util.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BUSY = /esc to (interrupt|cancel)|\[stop\]|[⠁-⣿] +\p{L}|[✻✶✽✢✳*·] [\p{L}' -]+… \(\d/iu;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let clockTicks;

export function linuxProcess(pid, proc = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const dir = path.join(proc, String(pid)), stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    const argv = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0').filter(Boolean);
    const exePath = fs.readlinkSync(path.join(dir, 'exe')), exe = path.basename(exePath);
    clockTicks ||= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }));
    if (!Number.isFinite(clockTicks) || clockTicks <= 0) return null;
    const uptime = Number(fs.readFileSync(path.join(proc, 'uptime'), 'utf8').split(' ')[0]);
    const entry = argv[1] || '';
    let tool = /^(claude|codex)$/.test(exe) ? exe : null;
    // Claude's official native installer symlinks ~/.local/bin/claude to a
    // version-named binary; /proc/exe resolves that symlink.
    if (/\/\.local\/share\/claude\/versions\/\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(exePath)) tool = 'claude';
    if (/^node(?:js)?$/.test(exe)) {
      if (/(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/.test(entry)) tool = 'claude';
      if (/(?:^|\/)@openai\/codex\/bin\/codex\.js$/.test(entry)) tool = 'codex';
    }
    return { pid, ppid: Number(fields[1]), tty: fields[4], started: processStart(stat), tool, argv,
      createdMs: Date.now() - (uptime - Number(processStart(stat)) / clockTicks) * 1000,
      cwd: fs.readlinkSync(path.join(dir, 'cwd')) };
  } catch { return null; }
}

// The cursor must be inside an empty provider composer, with its status drawn.
// Check all continuation rows up to the cursor; never treat a shell prompt as input.
export function emptyLinuxInput(tool, screen, [y, x, height, mode]) {
  if (![y, x, height, mode].every(Number.isInteger) || mode !== 0 || y < 0 || y >= height) return false;
  const rows = screen.replace(/\r/g, '').split('\n');
  if (rows.at(-1) === '') rows.pop();
  const visible = rows.slice(-height), bottom = visible.slice(-14).join('\n');
  if (BUSY.test(bottom) || /trust this folder|allow Codex to work|permission required|select an option|^\s*(?:approve|approval)\s+(?:this (?:command|action)|once|for this session)\b/im.test(bottom)) return false;
  if (!(tool === 'claude' ? /bypass permissions/i : /\? for shortcuts|Ask Codex to do anything/).test(bottom)) return false;
  const before = visible.slice(0, y + 1);
  let at = -1;
  for (let i = 0; i < before.length; i++) if (/^\s*[❯›»]/u.test(before[i])) at = i;
  if (at < Math.max(0, y - 12)) return false;
  const after = visible.slice(at + 1);
  const end = after.findIndex(line => /^\s*(?:[─━╌┄-]{5,}|bypass permissions\b|\? for shortcuts\b)/i.test(line));
  if (end < 0 || y > at + end) return false;
  const draft = [before[at].replace(/^\s*[❯›»]/u, ''), ...after.slice(0, end)].join('\n').trim();
  return draft === '' || (tool === 'codex' && draft === 'Ask Codex to do anything');
}

function filesUnder(dir, depth = 0) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() && depth < 4 ? filesUnder(file, depth + 1) : entry.isFile() && entry.name.endsWith('.jsonl') ? [file] : [];
  });
}

export class LinuxChats {
  constructor({ home = os.homedir(), store = process.env.CHAT_TAB_STORE || path.join(home, '.claude/chat-tabs'),
    backend = createTmuxBackend(), proc = '/proc', readProcess = pid => linuxProcess(pid, proc) } = {}) {
    Object.assign(this, { home, store, backend, proc, readProcess });
  }
  tabs() {
    let names; try { names = fs.readdirSync(this.store); } catch { return []; }
    return names.filter(name => NAME.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).flatMap(name => {
      try {
        const file = path.join(this.store, name), st = fs.lstatSync(file);
        if (!st.isFile() || st.size > 8192 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) return [];
        const tab = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (tab.backend !== 'tmux' || tab.name !== name.slice(0, -5) || !['claude', 'codex'].includes(tab.lane) ||
          !/^[a-zA-Z0-9_-]+$/.test(tab.window || '') || !/^%\d+$/.test(tab.pane || '') || !/^@\d+$/.test(tab.windowId || '') ||
          !Number.isSafeInteger(tab.pid) || !/^\d+$/.test(tab.started || '') ||
          (tab.socket != null && !/^[a-zA-Z0-9_-]+$/.test(tab.socket))) return [];
        return this.backend.alive(tab) ? [tab] : [];
      } catch { return []; }
    });
  }
  processes() {
    let names; try { names = fs.readdirSync(this.proc); } catch { return []; }
    return names.filter(name => /^\d+$/.test(name)).map(name => this.readProcess(Number(name))).filter(Boolean);
  }
  provider(tab, processes = this.processes()) {
    const root = this.readProcess(tab.pid);
    if (!root || root.started !== tab.started) throw Error('Stale tmux pid');
    const byPid = new Map(processes.map(p => [p.pid, p]));
    const under = p => {
      const seen = new Set();
      while (p && !seen.has(p.pid)) {
        if (p.pid === root.pid) return true;
        seen.add(p.pid); p = byPid.get(p.ppid);
      }
      return false;
    };
    // Reject a second provider sharing either the tty or tracked process tree.
    let providers = processes.filter(p => p.tool && (under(p) || (root.tty !== '0' && p.tty === root.tty)));
    // npm's Codex launcher owns one native Codex child. Treat that chain as one
    // provider, but never collapse two sibling TUIs sharing a pane.
    providers = providers.filter(parent => !providers.some(child => {
      if (child.pid === parent.pid || child.tool !== parent.tool) return false;
      const seen = new Set(); let p = byPid.get(child.ppid);
      while (p && !seen.has(p.pid)) { if (p.pid === parent.pid) return true; seen.add(p.pid); p = byPid.get(p.ppid); }
      return false;
    }));
    if (providers.length !== 1 || providers[0].tool !== tab.lane || !under(providers[0])) throw Error('Provider identity unavailable or shared pane');
    return providers[0];
  }
  nativeId(provider) {
    if (provider.tool === 'claude') {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.home, '.claude/sessions', provider.pid + '.json'), 'utf8'));
        if (Number(s.pid) === provider.pid && UUID.test(s.sessionId || '') && String(s.procStart) === provider.started) return s.sessionId;
      } catch {}
    }
    // A transcript FD or resume argv can outlive a native session switch.
    // Neither is evidence of the current session. Require provider-owned records.
    // Codex records the process/thread binding in its native read-only logs DB.
    if (provider.tool === 'codex') {
      let db;
      try {
        const dir = path.join(this.home, '.codex');
        const file = fs.readdirSync(dir).filter(n => /^logs_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
        if (!file) return null;
        db = new DatabaseSync(path.join(dir, file), { readOnly: true });
        const row = db.prepare('select thread_id, ts from logs where process_uuid like ? and thread_id is not null order by ts desc, ts_nanos desc, id desc limit 1').get(`pid:${provider.pid}:%`);
        const ts = Number(row?.ts), ms = ts < 1e11 ? ts * 1000 : ts;
        if (UUID.test(row?.thread_id || '') && Number.isFinite(provider.createdMs) && ms >= provider.createdMs - 1000) return row.thread_id;
      } catch {} finally { db?.close(); }
    }
    return null;
  }
  bindings(processes = this.processes()) {
    const result = new Map();
    for (const tab of this.tabs()) {
      try {
        const provider = this.provider(tab, processes), id = this.nativeId(provider);
        if (!id) continue;
        const key = `${tab.lane}:${id}`, matches = result.get(key) || [];
        matches.push({ tab, provider }); result.set(key, matches);
      } catch {}
    }
    return result;
  }
  binding(chat, bindings = this.bindings()) {
    const matches = bindings.get(`${chat.tool}:${chat.id}`) || [];
    if (matches.length !== 1) throw Error('Chat is not uniquely bound to a live chat-tab pane');
    return matches[0];
  }
  enroll(chat) {
    if (!chat?.alive || chat.automated || chat.state !== 'waiting') throw Error('Chat busy or unavailable');
    const { tab, provider } = this.binding(chat);
    if (chat.pid !== provider.pid) throw Error('Process changed');
    if (chat.tool === 'claude') {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(this.home, '.claude/sessions', provider.pid + '.json'), 'utf8'));
        if (session.status !== 'idle') throw Error('Chat busy');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { id: chat.id, pid: provider.pid, tool: chat.tool, created: provider.started, tab };
  }
  send(chat, enrolled, text) {
    const check = () => {
      const current = this.enroll(chat);
      if (JSON.stringify(current) !== JSON.stringify(enrolled)) throw Error('Process/session changed');
      const p = chat.tool === 'claude' ? readTranscript(chat.file) : readRollout(chat.file);
      if (chat.tool === 'claude' ? !['assistant-text', 'user-interrupt'].includes(p.lastKind) : p.lastTask === 'started') throw Error('Chat busy or transcript state unavailable');
    };
    return this.backend.sendGuarded(enrolled.tab, text, { check, empty: (screen, cursor) => emptyLinuxInput(chat.tool, screen, cursor) });
  }
  collect(opts) {
    const processes = this.processes(), byPid = new Map(processes.filter(p => p.tool).map(p => [p.pid, p.tool + '.exe']));
    const bindings = this.bindings(processes);
    const procs = { get: pid => byPid.get(pid) };
    let claude = { chats: [], hidden: 0 }, codex = { chats: [], hidden: 0 }, hasCodexDb = true;
    claude = collectClaude({ ...opts, procs });
    try { codex = collectCodex({ ...opts, procs }); } catch { hasCodexDb = false; /* Native files also work before Codex creates its state DB. */ }
    const found = new Map(codex.chats.map(chat => [chat.id, chat]));
    for (const file of hasCodexDb ? [] : filesUnder(path.join(this.home, '.codex/sessions'))) {
      try {
        const meta = [...jsonLines(readHead(file, 65536))].find(e => e.type === 'session_meta')?.payload;
        if (!UUID.test(meta?.id || '') || found.has(meta.id)) continue;
        const p = readRollout(file), cwd = meta.cwd || '', { folder, worktree } = placeOf(cwd);
        const automated = meta.source === 'exec' || typeof meta.source === 'object';
        if (automated && !opts.includeAutomated && !opts.includedIds?.has(meta.id)) { codex.hidden++; continue; }
        found.set(meta.id, { id: meta.id, tool: 'codex', title: deriveTitle(p.lastAgent) || 'Codex chat', cwd, folder, worktree,
          topic: topicOf(folder, ''), state: classifyCodex({ alive: false, lastTask: p.lastTask }), alive: false, automated,
          lastActivity: p.lastTs || fs.statSync(file).mtimeMs, stateSince: p.lastTaskTs, lastLine: lastWords(p.lastAgent),
          endsWithQuestion: endsWithQuestion(p.lastAgent), file, ...commandsFor('codex', cwd, meta.id) });
      } catch {}
    }
    const all = [...claude.chats, ...found.values()];
    for (const chat of all) {
      const wasWorking = chat.state === 'working';
      chat.terminalMode = 'tmux'; chat.canOpen = false; chat.alive = false; delete chat.pid;
      try {
        const { tab, provider } = this.binding(chat, bindings);
        chat.alive = true; chat.pid = provider.pid;
        chat.attachCommand = `tmux${tab.socket ? ' -L ' + quote(tab.socket) : ''} attach -t ${quote(tab.window)}`;
        const p = chat.tool === 'claude' ? readTranscript(chat.file) : readRollout(chat.file);
        chat.state = chat.tool === 'codex' ? classifyCodex({ alive: true, lastTask: p.lastTask }) : wasWorking || ['user-real', 'assistant-tool', 'user-tool-result'].includes(p.lastKind) ? 'working' : p.lastKind ? 'waiting' : 'unknown';
        const screen = this.backend.call(tab, 'read', { lines: 20 });
        if (BUSY.test(screen.split('\n').slice(-14).join('\n'))) chat.state = 'working';
      } catch { chat.state = chat.state === 'working' || chat.state === 'waiting' ? 'unknown' : chat.state; }
    }
    return { chats: all.filter(chat => chat.alive || opts.includedIds?.has(chat.id) || chat.lastActivity >= opts.now - opts.windowMs), hidden: claude.hidden + codex.hidden };
  }
}
