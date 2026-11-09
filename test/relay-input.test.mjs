// Windows input guard (server/relay-input.ps1 through server/relay-transport.mjs).
// Fake chats are node.exe linked as claude.exe / codex.exe, each in its own
// window-less (headless) conhost with a fake home; nothing here touches a real chat
// or window, and no fixture can take keyboard focus. The fake draws a composer and
// records every key it receives.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { assertNoConsoleWindow, headlessConsole } from './fixtures/headless-console.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const windows = process.platform === 'win32';
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRIPT = path.resolve(new URL('../server/relay-input.ps1', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const ESC = '\x1b';

// argv: marker, input log, screen file, mode. `sibling` starts a second copy of
// this executable in the same console (another agent sharing it).
const FAKE_CHAT = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [marker, inputLog, screen, mode] = process.argv.slice(2);
if (mode === 'idle') { setInterval(() => {}, 1 << 30); }
else {
  fs.writeFileSync(inputLog, '');
  process.stdout.write(fs.readFileSync(screen, 'utf8'));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => fs.appendFileSync(inputLog, buf));
  let sibling = '';
  if (mode === 'sibling') sibling = ' sibling=' + spawn(process.execPath, [process.argv[1], '', '', '', 'idle'], { stdio: 'inherit' }).pid;
  setTimeout(() => fs.writeFileSync(marker, 'pid=' + process.pid + sibling + '\\n'), 300);
  setInterval(() => {}, 1 << 30);
}
`;

async function until(check, ms, what) {
  for (let waited = 0; waited < ms; waited += 150) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Windows input guard: delivers only to an empty composer and reports certain refusals as not sent',
  { skip: !windows && 'Windows only', timeout: 300_000 }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-input-'));
    const sessions = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    // claude.mjs resolves ~/.claude when it is first imported.
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    const { enrollChat, messageInput } = await import('../server/relay-transport.mjs');
    const { processIdentity } = await import('../server/system.mjs');
    const script = path.join(home, 'fake-chat.mjs');
    fs.writeFileSync(script, FAKE_CHAT);
    const exe = {};
    for (const tool of ['claude', 'codex']) {
      exe[tool] = path.join(home, `${tool}.exe`);
      try { fs.linkSync(process.execPath, exe[tool]); } catch { fs.copyFileSync(process.execPath, exe[tool]); }
    }
    const started = [], hosts = [];

    async function fake(tool, screen, mode = 'chat') {
      const name = crypto.randomUUID();
      const marker = path.join(home, `${name}.pid`), inputLog = path.join(home, `${name}.keys`), screenFile = path.join(home, `${name}.screen`);
      fs.writeFileSync(screenFile, screen);
      const host = headlessConsole(exe[tool], [script, marker, inputLog, screenFile, mode]);
      hosts.push(host);
      const text = await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8'), 20_000, `${tool} fake chat`);
      const pid = Number(text.match(/pid=(\d+)/)[1]);
      started.push(pid);
      const sibling = text.match(/sibling=(\d+)/)?.[1];
      if (sibling) started.push(Number(sibling));
      await assertNoConsoleWindow([host.pid, pid, ...(sibling ? [Number(sibling)] : [])]);
      const identity = await processIdentity(pid);
      assert.equal(identity.image, `${tool}.exe`);
      const chat = { id: crypto.randomUUID(), pid, tool, alive: true, automated: false, state: 'waiting', file: path.join(home, `${name}.jsonl`), pidSeenAt: Date.now() };
      if (tool === 'claude') writeSession(chat, identity.created, 'idle');
      return { chat, identity, inputLog, keys: () => fs.readFileSync(inputLog, 'utf8') };
    }
    const writeSession = (chat, procStart, status) => fs.writeFileSync(path.join(sessions, `${chat.pid}.json`),
      JSON.stringify({ pid: chat.pid, sessionId: chat.id, procStart, status, kind: 'interactive' }));

    async function deliver(f) {
      const folder = fs.mkdtempSync(path.join(home, 'handoff-'));
      const file = path.join(folder, 'user-message.md');
      const id = crypto.randomUUID();
      const enrolled = await enrollChat(f.chat);
      return { id, folder, file, promise: messageInput(f.chat, enrolled, file, id) };
    }
    const expectedText = (d) => `AGENT-RELAY MESSAGE ${d.id}: Read the user's message in ${d.file} and respond in this same chat.`;

    async function delivered(f) {
      const d = await deliver(f);
      const result = await d.promise;
      assert.deepEqual(result, { submitted: true, characters: expectedText(d).length });
      await until(() => f.keys().endsWith('\r'), 10_000, 'Enter in the fake chat');
      assert.equal(f.keys(), `${expectedText(d)}\r`, 'the exact text and one Enter were typed');
    }

    async function refused(f, reason) {
      const d = await deliver(f);
      await assert.rejects(d.promise, (error) => error.code === 'RELAY_NOT_SENT' && error.reason === reason && /nothing was typed/.test(error.message));
      const receipt = path.join(d.folder, `${d.id}-transport.json`);
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { submitted: false, notSent: true, reason });
      await sleep(2500); // longer than the guard's pause before Enter
      assert.equal(f.keys(), '', 'nothing was typed');
    }

    // Runs the guard script directly with a hand-made spec (identity mismatches).
    async function direct(f, spec) {
      const folder = fs.mkdtempSync(path.join(home, 'direct-'));
      const receipt = path.join(folder, 'receipt.json'), request = path.join(folder, 'input.json');
      fs.writeFileSync(request, JSON.stringify({ pid: f.chat.pid, image: f.chat.tool, startedTicks: f.identity.created, text: 'hello', receipt, ...spec }));
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { windowsHide: true, timeout: 20_000, env: { ...process.env, AGENT_RELAY_INPUT_FILE: request } });
      await sleep(2500);
      assert.equal(f.keys(), '', 'nothing was typed');
      assert.equal(stdout.trim(), fs.readFileSync(receipt, 'utf8'));
      return JSON.parse(fs.readFileSync(receipt, 'utf8'));
    }

    try {
      await t.test('empty Claude composer: delivered', async () => {
        await delivered(await fake('claude', 'Claude Code\r\n❯ '));
      });
      await t.test('literal Codex placeholder: delivered', async () => {
        await delivered(await fake('codex', `OpenAI Codex\r\n› ${ESC}[2mAsk Codex to do anything${ESC}[22m`));
      });
      await t.test('a normal draft: refused before input', async () => {
        await refused(await fake('claude', 'Claude Code\r\n❯ fix the login page'), 'draft');
      });
      await t.test('a Codex draft: refused before input', async () => {
        await refused(await fake('codex', 'OpenAI Codex\r\n› Ask Codex to do anything else'), 'draft');
      });
      // The console API cannot see SGR 2 (measured on conhost and OpenConsole), so
      // a dim Claude placeholder is indistinguishable from a draft and stays refused.
      await t.test('a dim Claude placeholder: refused, the console cannot see dim', async () => {
        await refused(await fake('claude', `Claude Code\r\n❯ ${ESC}[2mTry "fix lint errors"${ESC}[22m`), 'draft');
      });
      await t.test('mixed dim and normal text: refused', async () => {
        await refused(await fake('claude', `Claude Code\r\n❯ ${ESC}[2mTry${ESC}[22m fix it`), 'draft');
      });
      await t.test('no prompt marker: refused as no-composer', async () => {
        await refused(await fake('claude', 'Loading Claude Code...'), 'no-composer');
      });
      await t.test('a second agent in the same console: refused as identity', async () => {
        await refused(await fake('claude', 'Claude Code\r\n❯ ', 'sibling'), 'identity');
      });
      await t.test('a busy Claude session: refused before the guard runs', async () => {
        const f = await fake('claude', 'Claude Code\r\n❯ ');
        const enrolled = await enrollChat(f.chat);
        writeSession(f.chat, f.identity.created, 'busy');
        await assert.rejects(messageInput(f.chat, enrolled, path.join(home, 'x.md'), crypto.randomUUID()),
          (error) => error.code === 'RELAY_NOT_SENT' && error.reason === 'busy');
        await sleep(2500);
        assert.equal(f.keys(), '', 'nothing was typed');
      });
      await t.test('a changed Claude session identity: refused as identity', async () => {
        const f = await fake('claude', 'Claude Code\r\n❯ ');
        const enrolled = await enrollChat(f.chat);
        writeSession(f.chat, String(BigInt(f.identity.created) + 1n), 'idle');
        await assert.rejects(messageInput(f.chat, enrolled, path.join(home, 'x.md'), crypto.randomUUID()),
          (error) => error.code === 'RELAY_NOT_SENT' && error.reason === 'identity');
        await sleep(2500);
        assert.equal(f.keys(), '', 'nothing was typed');
      });
      await t.test('identity mismatch at the guard: not-sent receipt, exit 0, nothing typed', async () => {
        const f = await fake('claude', 'Claude Code\r\n❯ ');
        assert.deepEqual(await direct(f, { startedTicks: String(BigInt(f.identity.created) + 1n) }), { submitted: false, notSent: true, reason: 'identity' });
        assert.deepEqual(await direct(f, { image: 'codex' }), { submitted: false, notSent: true, reason: 'identity' });
        assert.deepEqual(await direct(f, { pid: 99_999_999 }), { submitted: false, notSent: true, reason: 'identity' });
      });
    } finally {
      for (const pid of started) if (alive(pid)) { try { process.kill(pid); } catch {} }
      for (const host of hosts) host.close();
      await sleep(800);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
