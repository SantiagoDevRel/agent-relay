// Process liveness, Windows Update reboot state and the installed-app shortcut
// (read-only queries), plus the two actions User asked for on an open chat:
// bring its terminal tab to the front and end its process.
//
// A full `tasklist` takes ~5 s on a machine with 1000+ processes, so liveness is
// two-speed: process.kill(pid, 0) every cycle (instant, catches deaths), plus a
// background Get-Process every 60 s that confirms the pid still belongs to
// claude.exe / codex.exe (guards against pid reuse).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_MENU = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');

// The Start-menu shortcut Chrome creates when the dashboard is installed as an
// app: "Chats.lnk" pointing at chrome_proxy --app-id=... Opening it gives the
// window the app's own taskbar identity, so a pinned icon finds it. Chrome names
// its Start-menu folder in the browser's language, so the menu is searched.
export function appShortcut(dir = START_MENU, depth = 0) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 2) {
      const found = appShortcut(full, depth + 1);
      if (found) return found;
    } else if (entry.name === 'Agent Relay.lnk' || entry.name === 'Chats.lnk') {
      // .lnk strings are UTF-16LE, at an even or odd byte offset.
      const buf = fs.readFileSync(full);
      if (`${buf.toString('utf16le')}${buf.subarray(1).toString('utf16le')}`.includes('--app-id=')) return full;
    }
  }
  return null;
}

const VERIFY_EVERY_MS = 60_000;
const FOCUS_SCRIPT = fileURLToPath(new URL('./focus-tab.ps1', import.meta.url));
const CTRL_C_SCRIPT = fileURLToPath(new URL('./send-ctrl-c.ps1', import.meta.url));
const FILETIME_EPOCH_MS = 11_644_473_600_000;

const run = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout || '') }),
    );
  });

// Image name and creation time of one process, read right before acting on it.
// `created` is a Windows FILETIME string: the same value Claude Code stores as
// `procStart` in its session file, so a reused pid cannot pass for the chat.
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { ok, stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.ProcessName)|$($p.StartTime.ToFileTimeUtc())"`,
  ]);
  const m = ok && stdout.trim().match(/^(.+)\|(\d+)$/);
  if (!m) return null;
  return { image: `${m[1].toLowerCase()}.exe`, created: m[2], createdMs: Number(BigInt(m[2]) / 10_000n) - FILETIME_EPOCH_MS };
}

// Presses Ctrl+C in the process's console (send-ctrl-c.ps1), exactly like typing
// it in its tab: Claude Code and Codex quit normally on the second press.
export async function pressCtrlC(pid, presses) {
  if (!Number.isInteger(pid) || pid <= 0) return { attached: false, sent: 0 };
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CTRL_C_SCRIPT], {
    ...process.env,
    CHATS_CLOSE_PID: String(pid),
    CHATS_CLOSE_PRESSES: String(presses),
  });
  try {
    const out = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    return { attached: out.attached === true, sent: Number(out.sent) || 0 };
  } catch {
    return { attached: false, sent: 0 };
  }
}

export function isRunning(pid) {
  return exists(pid);
}

// Last resort when a chat ignores Ctrl+C: ends the process and its children
// (shells and MCP servers it started). The transcript stays; the chat can be reopened.
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return (await run('taskkill', ['/PID', String(pid), '/T', '/F'])).ok;
}

// Selects the Windows Terminal tab titled like the chat and brings its window to
// the front (focus-tab.ps1). The title travels in an environment variable.
export async function focusTab(title) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SCRIPT], {
    ...process.env,
    CHATS_FOCUS_TITLE: title,
  });
  try {
    const out = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    return { found: out.found === true, matches: Number(out.matches) || 0, focused: out.focused === true };
  } catch {
    return null;
  }
}

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class ProcessWatch {
  constructor() {
    this.known = new Map(); // pid -> 'claude.exe' | 'codex.exe'
    this.verifiedAt = 0;
    this.pending = null;
  }

  async verify() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const { ok, stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process -Name claude,codex -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id),$($_.ProcessName)" }',
      ]);
      if (ok) {
        const next = new Map();
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.trim().match(/^(\d+),(.+)$/);
          if (m) next.set(Number(m[1]), `${m[2].toLowerCase()}.exe`);
        }
        this.known = next;
        this.verifiedAt = Date.now();
      }
      this.pending = null;
    })();
    return this.pending;
  }

  // Map-like view used by the collectors. get(pid, seenAt) -> image name when the
  // process is alive. `seenAt` is when the chat last showed that pid; a pid that
  // the last verification did not list only counts if it appeared after it.
  snapshot(now = Date.now()) {
    if (now - this.verifiedAt > VERIFY_EVERY_MS) this.verify();
    const known = this.known;
    const verifiedAt = this.verifiedAt;
    const self = this;
    return {
      get(pid, seenAt = Infinity) {
        if (!pid || !exists(pid)) return undefined;
        const name = known.get(pid);
        if (name) return name;
        if (verifiedAt >= seenAt) return undefined;
        self.verify();
        return 'unverified';
      },
    };
  }
}

const REBOOT_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
];

export async function rebootPending() {
  const results = await Promise.all(REBOOT_KEYS.map((key) => run('reg', ['query', key])));
  return results.some((r) => r.ok);
}
