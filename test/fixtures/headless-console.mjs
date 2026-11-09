// Window-less consoles for Windows test fixtures.
// `Start-Process conhost.exe -WindowStyle Hidden` still creates a classic console
// window (ConsoleWindowClass). It is invisible but can become the foreground window:
// on 2026-11-08 fake chats recorded the owner's real keystrokes that way. A headless
// conhost keeps the console behind pipes (ConPTY), with no classic window, and
// still supports AttachConsole, ReadConsoleOutput and WriteConsoleInput.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CONHOST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');

// Starts `exe args` in its own headless console. stdout is drained for the whole
// run; the host's terminal queries (DA1, cursor position) get a minimal reply.
export function headlessConsole(exe, args, { width = 120, height = 30 } = {}) {
  const host = spawn(CONHOST, ['--headless', '--width', String(width), '--height', String(height), '--', exe, ...args],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  host.on('error', () => {});
  host.stdin.on('error', () => {});
  host.stdout.on('data', (chunk) => {
    const text = chunk.toString('latin1');
    if (text.includes('\x1b[6n')) host.stdin.write('\x1b[1;1R');
    if (text.includes('\x1b[c')) host.stdin.write('\x1b[?1;0c');
  });
  host.stderr.resume();
  return {
    pid: host.pid,
    close() {
      try { host.stdin.end(); } catch { /* already closed */ }
      host.stdout.destroy();
      host.stderr.destroy();
      if (host.exitCode === null && host.signalCode === null) { try { host.kill(); } catch { /* gone */ } }
    },
  };
}

const ENUM_WINDOWS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Fixture -Name Windows -MemberDefinition @'
public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
public static string List(uint[] pids) {
  var rows = new System.Collections.Generic.List<string>();
  IntPtr foreground = GetForegroundWindow();
  EnumWindows((hwnd, l) => {
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    if (Array.IndexOf(pids, pid) < 0) return true;
    var name = new System.Text.StringBuilder(256); GetClassName(hwnd, name, 256);
    // One tab-separated row per window; the class name comes last, unescaped.
    rows.Add(pid + "\\t" + (IsWindowVisible(hwnd) ? 1 : 0) + "\\t" + (hwnd == foreground ? 1 : 0) + "\\t" + name.ToString());
    return true;
  }, IntPtr.Zero);
  return string.Join("\\n", rows);
}
'@
[Fixture.Windows]::List([uint32[]]($env:FIXTURE_PIDS -split ','))
`;

// Top-level windows owned by these processes (EnumWindows + GetWindowThreadProcessId).
export async function windowsOwnedBy(pids) {
  const encoded = Buffer.from(ENUM_WINDOWS, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 30_000, env: { ...process.env, FIXTURE_PIDS: pids.join(',') } });
  return stdout.split(/\r?\n/).filter(Boolean).map((row) => {
    const [pid, visible, foreground, ...cls] = row.split('\t');
    return { pid: Number(pid), cls: cls.join('\t'), visible: visible === '1', foreground: foreground === '1' };
  });
}

// No fixture process may own a classic console window; a ConPTY pseudo window is
// acceptable only while it is hidden and not the foreground window.
export async function assertNoConsoleWindow(pids) {
  const windows = await windowsOwnedBy(pids);
  assert.deepEqual(windows.filter((w) => w.cls === 'ConsoleWindowClass'), [], 'no classic console window');
  assert.deepEqual(windows.filter((w) => w.visible || w.foreground), [], 'no visible or foreground fixture window');
  return windows;
}
