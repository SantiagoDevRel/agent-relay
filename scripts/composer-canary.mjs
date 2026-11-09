#!/usr/bin/env node
/**
 * Linux/tmux canary, run after upgrading the installed provider CLIs:
 *   node scripts/composer-canary.mjs [--cwd /path/to/project]
 * Defaults to the repository root. Opens isolated Claude/Codex probe chats,
 * types a draft, clears it with C-u, and prints one JSON result. No Enter or
 * model message is sent. Finally kills only its own verified probe windows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTmuxBackend } from '../server/chat-tab-tmux.mjs';
import { inspectLinuxInput } from '../server/linux-chats.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sessionVars = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'AI_AGENT', 'CODEX_THREAD_ID'];
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const acceptable = (step, inspected) => step === 'draft' ? !inspected.empty && inspected.reason === 'draft' :
  inspected.empty && ['empty', 'placeholder'].includes(inspected.reason);

export function runComposerCanary({ cwd = root, env = process.env,
  runner = (file, argv, options) => execFileSync(file, argv, { encoding: 'utf8', timeout: 90000, ...options }),
  now = Date.now, sleep = pause, timeoutMs = 60000 } = {}) {
  if (process.platform !== 'linux') throw Error('The composer canary requires Linux and tmux');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-composer-canary-'));
  fs.chmodSync(store, 0o700);
  const probeEnv = { ...env, CHAT_TAB_STORE: store, CHAT_TAB_TMUX_SOCKET: `relay-canary-${process.pid}-${now()}` };
  const backend = createTmuxBackend({ env: probeEnv, runner: (file, argv) => runner(file, argv, { env: probeEnv }), now, sleep });
  const tmux = args => runner('tmux', ['-L', probeEnv.CHAT_TAB_TMUX_SOCKET, ...args], { env: probeEnv });
  const report = { ok: true, versions: {}, probes: {} }, pending = new Set();
  function handle(name) {
    for (const suffix of ['.json', '.pid']) {
      try { return JSON.parse(fs.readFileSync(path.join(store, name + suffix), 'utf8')); } catch {}
    }
    return null;
  }
  function close(name) {
    const tab = handle(name);
    if (tab && backend.alive(tab)) {
      // No /exit or /quit: even cleanup must never press Enter.
      fs.writeFileSync(path.join(store, name + '.closing'), '', { mode: 0o600 });
      backend.capture(tab); // Recheck the exact pane/process identity before killing our window.
      tmux(['kill-window', '-t', tab.windowId]);
      if (backend.alive(tab)) throw Error('Probe window did not close');
    } else if (tab) {
      // A gone process is fine; an existing recycled window is not ours to close.
      try { tmux(['display-message', '-p', '-t', tab.pane, '#{pane_id}']); }
      catch { pending.delete(name); return; }
      throw Error('Probe identity changed; refused to close a different window');
    }
    pending.delete(name);
  }
  function inspect(tab) {
    const frame = backend.capture(tab);
    return { ...inspectLinuxInput(tab.lane, frame.screen, frame.cursor, frame.styled), frame };
  }
  function step(tab, name) {
    const deadline = now() + timeoutMs;
    let inspected, stable = null, since = now();
    do {
      inspected = inspect(tab);
      if (inspected.frame.screen !== stable) { stable = inspected.frame.screen; since = now(); }
      if (acceptable(name, inspected) && now() - since >= 750) break;
      sleep(250);
    } while (now() < deadline);
    return { step: name, reason: inspected.reason, ok: acceptable(name, inspected) && now() - since >= 750 };
  }
  try {
    for (const lane of ['claude', 'codex']) {
      const name = `relay-canary-${lane}`, result = report.probes[lane] = { ok: false, steps: [] };
      try {
        report.versions[lane] = String(runner(lane, ['--version'], { env: probeEnv })).trim().slice(0, 256);
        pending.add(name);
        const command = probeEnv.NODE_ENV === 'test' && probeEnv.CHAT_TAB_TEST_LANE_CMD || (lane === 'claude' ?
          'CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false exec claude --dangerously-skip-permissions' :
          'exec codex --no-daemon --dangerously-bypass-approvals-and-sandbox');
        const opened = backend.open({ session: name, title: name, cwd, command, sessionVars,
          pidFile: path.join(store, name + '.pid'), closing: path.join(store, name + '.closing') });
        fs.writeFileSync(path.join(store, name + '.json'), JSON.stringify({ ...opened, name, lane, window: name }), { mode: 0o600 });
        const tab = handle(name);
        if (!tab || !backend.alive(tab)) throw Error('Probe did not register a live tmux pane');
        const fresh = step(tab, 'fresh'); result.steps.push(fresh);
        if (!fresh.ok) throw Error(`Fresh composer refused: ${fresh.reason}`);
        const checked = inspect(tab);
        if (!acceptable('fresh', checked)) throw Error(`Composer changed before draft: ${checked.reason}`);
        tmux(['send-keys', '-t', tab.pane, '-l', '--', 'relay canary draft']);
        result.steps.push(step(tab, 'draft'));
        // Identity is verified even if the draft assertion failed.
        backend.capture(tab);
        tmux(['send-keys', '-t', tab.pane, 'C-u']);
        result.steps.push(step(tab, 'cleared'));
        result.ok = result.steps.every(value => value.ok);
      } catch (error) { result.error = error.message; }
      finally {
        if (pending.has(name)) {
          try { close(name); } catch (error) { result.cleanupError = error.message; result.ok = false; }
        }
      }
      if (!result.ok) report.ok = false;
    }
  } finally {
    for (const name of pending) {
      try { close(name); } catch (error) { report.ok = false; report.cleanupError = error.message; }
    }
    // Retain the handles if custody was lost, so the owner can diagnose safely.
    if (pending.size === 0) {
      fs.rmSync(store, { recursive: true });
      // The probe server exits with its last window but can leave its socket file behind.
      try { tmux(['kill-server']); } catch {}
      const socket = path.join(env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, probeEnv.CHAT_TAB_TMUX_SOCKET);
      try { if (fs.lstatSync(socket).isSocket()) fs.rmSync(socket); } catch {}
    } else report.retainedStore = store;
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--cwd')) throw Error('Usage: composer-canary.mjs [--cwd DIR]');
    const report = runComposerCanary(args.length ? { cwd: path.resolve(args[1]) } : {});
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1;
  }
}
