// tmux transport only. Lane commands, prompt files and readiness policy live in chat-tab.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tail = s => String(s).trimEnd().split('\n').slice(-30).join('\n');

export function processStart(stat) {
  // comm may contain spaces and parentheses. Field 22 is starttime (clock ticks).
  const value = String(stat).slice(String(stat).lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(value || '')) throw Error('Invalid /proc process identity');
  return value;
}

export function tmuxScript({ command, cwd, closing, title, sessionVars, extra = [] }) {
  return 'unset ' + sessionVars.join(' ') + '\n' +
    'cd -- ' + quote(cwd) + ' && ' + command + extra.map(a => ' ' + quote(a)).join('') + '\n' +
    'rc=$?\nif [ "$rc" -ne 0 ] && [ ! -f ' + quote(closing) + ' ]; then\n' +
    // OSC k renames this window; repeat after the initial window options are set.
    '  while [ ! -f ' + quote(closing) + ' ]; do\n' +
    String.raw`    printf '\033k%s\033\\' ` + quote('🔴 ' + title) + '\n    sleep 1\n  done\nfi\nexit "$rc"';
}

export function createTmuxBackend({ env = process.env,
  runner = (file, argv) => execFileSync(file, argv, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }),
  readStart = pid => processStart(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')),
  now = Date.now, sleep = pause,
} = {}) {
  const socket = env.CHAT_TAB_TMUX_SOCKET || null;
  const run = (args, selectedSocket = socket) => String(runner('tmux', [...(selectedSocket ? ['-L', selectedSocket] : []), ...args]) || '');
  const forTab = (tab, args) => run(args, tab.socket ?? null);
  function identity(tab) {
    if (!/^%\d+$/.test(tab.pane || '') || !/^\d+$/.test(String(tab.pid))) return null;
    let parts;
    try {
      parts = forTab(tab, ['display-message', '-p', '-t', tab.pane, '#{pane_id}\t#{pane_pid}\t#{window_id}\t#{session_name}']).trim().split('\t');
      return { pane: parts[0], pid: Number(parts[1]), windowId: parts[2], session: parts[3], started: readStart(Number(parts[1])) };
    } catch { return null; }
  }
  const matches = (tab, current) => current && current.pane === tab.pane && current.pid === tab.pid && current.started === tab.started && current.windowId === tab.windowId && (!tab.window || current.session === tab.window);
  const alive = tab => Boolean(matches(tab, identity(tab)));
  function assertIdentity(tab) {
    const current = identity(tab);
    if (!matches(tab, current)) throw Error('Identity mismatch: the tab was closed or its process was replaced');
    return current;
  }
  function read(tab, lines = 60) {
    assertIdentity(tab);
    return forTab(tab, ['capture-pane', '-p', '-J', '-t', tab.pane, '-S', '-' + lines]);
  }
  function keys(tab, names) {
    const map = { enter: 'Enter', up: 'Up', down: 'Down', esc: 'Escape', tab: 'Tab', y: 'y' };
    if (names.some(n => !map[n] && !/^[!-~]$/.test(n))) throw Error('Unknown key');
    for (const n of names) {
      assertIdentity(tab);
      forTab(tab, ['send-keys', '-t', tab.pane, ...(map[n] ? [map[n]] : ['-l', '--', n])]);
      sleep(250);
    }
    return JSON.stringify({ keys: names.length });
  }
  function send(tab, text) {
    if (!text || text.length > 4000 || /[\x00-\x1f\x7f]/.test(text)) throw Error('Single-line text required (1–4000 characters)');
    assertIdentity(tab);
    forTab(tab, ['send-keys', '-t', tab.pane, '-l', '--', text]);
    // Match the console bridge: let TUIs finish processing their paste burst.
    sleep(1600);
    assertIdentity(tab);
    forTab(tab, ['send-keys', '-t', tab.pane, 'Enter']);
    return JSON.stringify({ submitted: true, characters: text.length });
  }
  // Relay supplies an identity/session guard. Unlike chat-tab's interactive send,
  // this path never retries Enter and never accepts a draft already in the TUI.
  function sendGuarded(tab, text, { check, empty }) {
    if (typeof check !== 'function' || typeof empty !== 'function') throw Error('Missing input guard');
    if (!text || text.length > 4000 || /[\x00-\x1f\x7f]/.test(text) || /^\s*\//.test(text)) throw Error('Ordinary single-line text required');
    check(); assertIdentity(tab);
    // Keep physical rows: joined wraps cannot be compared with tmux cursor_y.
    const screen = forTab(tab, ['capture-pane', '-p', '-t', tab.pane]);
    const styled = forTab(tab, ['capture-pane', '-e', '-p', '-t', tab.pane]);
    const cursor = forTab(tab, ['display-message', '-p', '-t', tab.pane, '#{cursor_y}\t#{cursor_x}\t#{pane_height}\t#{pane_in_mode}']).trim().split('\t').map(Number);
    if (!empty(screen, cursor, styled)) throw Error('Input draft or prompt unavailable; no text sent');
    check(); assertIdentity(tab);
    forTab(tab, ['send-keys', '-t', tab.pane, '-l', '--', text]);
    sleep(1600);
    check(); assertIdentity(tab);
    forTab(tab, ['send-keys', '-t', tab.pane, 'Enter']);
    return { submitted: true, characters: text.length };
  }
  function wait(tab, { quiet = 5, min = 8, timeout = 900, lines = 60, busy, ready } = {}) {
    const t0 = now(), deadline = t0 + timeout * 1000;
    let last = null, since = t0, state = 'timeout';
    const working = busy ? new RegExp(busy, 'u') : null, drawn = ready ? new RegExp(ready) : null;
    while (now() < deadline) {
      if (!alive(tab)) { state = 'exited'; break; }
      let current;
      try { current = read(tab, lines); } catch (e) { if (!alive(tab)) { state = 'exited'; break; } throw e; }
      if (current !== last) { last = current; since = now(); }
      const bottom = tail(current);
      if (!working?.test(bottom) && (!drawn || drawn.test(bottom)) && now() - since >= quiet * 1000 && now() - t0 >= min * 1000) {
        state = 'done'; break;
      }
      sleep(700);
    }
    return `[chat-tab: ${state}]\n${last ?? ''}`;
  }
  function open({ session, title, cwd, command, extra = [], sessionVars, pidFile, closing, adopt = false, waitS = 180 }) {
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw Error('Invalid tmux session name');
    if (adopt) {
      const tab = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if ((tab.socket ?? null) !== socket) throw Error('Cannot adopt a different tmux socket');
      if (!tab.started) tab.started = readStart(tab.pid);
      assertIdentity(tab);
      return tab;
    }
    let exists = false;
    try { run(['has-session', '-t', '=' + session]); exists = true; } catch {}
    const script = tmuxScript({ command, cwd, closing, title, sessionVars, extra });
    const args = exists ? ['new-window', '-d', '-t', '=' + session + ':'] : ['new-session', '-d', '-s', session];
    const parts = run([...args, '-n', title, '-P', '-F', '#{pane_id}\t#{pane_pid}\t#{window_id}', '--', 'bash', '--login', '-i', '-c', script]).trim().split('\t');
    const tab = { backend: 'tmux', socket, pane: parts[0], pid: Number(parts[1]), windowId: parts[2] };
    if (!/^%\d+$/.test(tab.pane) || !Number.isInteger(tab.pid) || tab.pid < 1) throw Error('tmux did not report its process');
    // Save the pending handle before /proc lookup, so a late registration can be adopted.
    fs.writeFileSync(pidFile, JSON.stringify(tab), { mode: 0o600 });
    const deadline = now() + waitS * 1000;
    while (now() < deadline) {
      try { tab.started = readStart(tab.pid); break; } catch { sleep(500); }
    }
    if (!tab.started) throw Error('The tab did not report its process within ' + waitS + ' s. If it appears later, use open ... --adopt.');
    fs.writeFileSync(pidFile, JSON.stringify(tab), { mode: 0o600 });
    forTab(tab, ['set-window-option', '-t', tab.windowId, 'automatic-rename', 'off']);
    forTab(tab, ['set-window-option', '-t', tab.windowId, 'allow-rename', 'on']);
    return tab;
  }
  function close(tab, closing) {
    // A recycled pane is never closed or typed into, even if its old record is stale.
    const current = identity(tab);
    if (current && !matches(tab, current)) throw Error('Identity mismatch: the tab was closed or its process was replaced');
    fs.writeFileSync(closing, '', { mode: 0o600 });
    for (let attempt = 0; attempt < 2 && alive(tab); attempt++) {
      try { send(tab, tab.lane === 'codex' ? '/quit' : '/exit'); } catch (e) { if (alive(tab)) throw e; }
      for (const deadline = now() + 5000; now() < deadline && alive(tab);) sleep(500);
    }
    if (alive(tab)) {
      const exact = assertIdentity(tab);
      forTab(tab, ['kill-window', '-t', exact.windowId]);
    }
    if (alive(tab)) throw Error('The tab "' + tab.name + '" did not close; close it manually.');
  }
  return { open, alive, close, sendGuarded, call(tab, action, spec = {}) {
    if (action === 'read') return read(tab, spec.lines);
    if (action === 'send') return send(tab, spec.text);
    if (action === 'keys') return keys(tab, spec.keys);
    if (action === 'wait') return wait(tab, spec);
    throw Error('Unknown action: ' + action);
  } };
}
