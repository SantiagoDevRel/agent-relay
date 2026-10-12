// End-to-end test of "Cerrar chat" and "Resumen" against the real server, with a
// fake home: two fake Claude chats (node.exe linked as claude.exe, each in its own
// hidden console) and a fake ollama. Nothing here touches real chats or consoles.
// Needs `npm run build`. Windows only.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { projectKey } from '../server/claude.mjs';
import { processIdentity } from '../server/system.mjs';

const PORT = 4862;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.resolve(new URL('../server/server.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const built = fs.existsSync(new URL('../dist/index.html', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

// Quits on the second Ctrl+C like Claude Code: writes `cost-state` and removes its
// session file. With `stubborn` it ignores Ctrl+C, so only a forced close ends it.
const FAKE_CHAT = `
import fs from 'node:fs';
import path from 'node:path';
const [marker, sessions, transcript, mode] = process.argv.slice(2);
const sessionFile = path.join(sessions, process.pid + '.json');
fs.writeFileSync(marker, 'pid=' + process.pid + '\\n');
process.stdin.setRawMode(true);
process.stdin.resume();
let armed = 0;
process.stdin.on('data', (buf) => {
  if (!buf.includes(3) || mode === 'stubborn') return;
  if (Date.now() - armed < 2000) {
    fs.appendFileSync(transcript, JSON.stringify({ type: 'cost-state', sessionId: 'x' }) + '\\n');
    fs.rmSync(sessionFile, { force: true });
    process.exit(0);
  }
  armed = Date.now();
});
setInterval(() => {}, 1 << 30);
`;

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${pathname}`, { method, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function until(check, ms, what) {
  for (let waited = 0; waited < ms; waited += 200) {
    const value = await check();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('close sends Ctrl+C (clean exit = closed), forces a stubborn chat, and summaries use the model once',
  { skip: (!built && 'run npm run build first') || (process.platform !== 'win32' && 'Windows only'), timeout: 120_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-actions-'));
    const work = path.join(home, 'work');
    const sessions = path.join(home, '.claude', 'sessions');
    const project = path.join(home, '.claude', 'projects', projectKey(work));
    for (const dir of [work, sessions, project, path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
    const fakeExe = path.join(home, 'claude.exe');
    try { fs.linkSync(process.execPath, fakeExe); } catch { fs.copyFileSync(process.execPath, fakeExe); }
    const script = path.join(home, 'fake-chat.mjs');
    fs.writeFileSync(script, FAKE_CHAT);

    const model = { requests: [] };
    const ollama = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        model.requests.push(JSON.parse(data));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: JSON.stringify({ tema: 'Arreglo del login', hecho: ['Cambió auth.ts y agregó un test.'], estado: 'Esperando tu OK para desplegar.', pendiente: ['Confirmar el despliegue.'] }) } }));
      });
    });
    await new Promise((r) => ollama.listen(0, '127.0.0.1', r));

    const fakes = [];
    let server;
    try {
      // Two chats, each in its own hidden console (conhost, never Windows Terminal).
      for (const mode of ['clean', 'stubborn']) {
        const id = crypto.randomUUID();
        const marker = path.join(home, `${mode}.pid`);
        const transcript = path.join(project, `${id}.jsonl`);
        fs.writeFileSync(transcript, `${[
          { type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), cwd: work, message: { content: `Arregla el login (${mode})` } },
          { type: 'assistant', timestamp: new Date(Date.now() - 50_000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(work, 'auth.ts') } }] } },
          { type: 'user', timestamp: new Date(Date.now() - 45_000).toISOString(), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
          { type: 'assistant', timestamp: new Date(Date.now() - 40_000).toISOString(), message: { content: [{ type: 'text', text: '¿Lo despliego?' }] } },
          { type: 'ai-title', aiTitle: `Login ${mode}` },
        ].map((e) => JSON.stringify(e)).join('\n')}\n`);
        await run('powershell.exe', ['-NoProfile', '-Command',
          `Start-Process conhost.exe -WindowStyle Hidden -ArgumentList '"${fakeExe}" "${script}" "${marker}" "${sessions}" "${transcript}" "${mode}"'`]);
        const pid = Number(await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').match(/pid=(\d+)/)?.[1], 15_000, `${mode} fake chat`));
        fakes.push({ id, pid, mode, transcript });
        const identity = await processIdentity(pid);
        assert.equal(identity.image, 'claude.exe');
        // What Claude Code writes for a running chat, with the real creation time.
        fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: work, startedAt: identity.createdMs, procStart: identity.created, kind: 'interactive', entrypoint: 'cli', status: 'idle', updatedAt: Date.now() }));
      }

      server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
        env: { ...process.env, CHATS_PORT: String(PORT), USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
          CHATS_SUMMARY_URL: `http://127.0.0.1:${ollama.address().port}`, CHATS_SUMMARY_MODEL: 'fake-model' },
        stdio: 'ignore',
      });
      const token = await until(async () => {
        try {
          return (await request('/')).body.match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1];
        } catch {
          return null;
        }
      }, 20_000, 'server');
      const snapshot = async () => JSON.parse((await request(`/api/snapshot?t=${token}`)).body);
      const chatOf = async (id) => (await snapshot()).chats?.find((c) => c.id === id);
      const json = { 'Content-Type': 'application/json', Origin: BASE, 'X-Chats-Token': token };
      const post = async (pathname, payload) => {
        const r = await request(pathname, { method: 'POST', headers: json, body: JSON.stringify(payload) });
        return { status: r.status, body: JSON.parse(r.body || '{}') };
      };
      const [clean, stubborn] = fakes;
      for (const f of fakes) await until(async () => (await chatOf(f.id))?.alive, 20_000, `${f.mode} chat listed as open`);
      const listed = await chatOf(clean.id);
      assert.equal(listed.pid, clean.pid, 'open chats carry their pid');
      assert.ok(!('file' in listed) && !('procStart' in listed), 'transcript path and process identity stay server-side');

      // Facts come from the transcript, no model involved.
      const facts = await post('/api/facts', { id: clean.id });
      assert.equal(facts.status, 200);
      assert.equal(facts.body.facts.userTurns, 1);
      assert.deepEqual(facts.body.facts.files, ['auth.ts']);
      assert.match(facts.body.facts.firstAsk, /Arregla el login/);
      assert.equal(model.requests.length, 0);

      // One model call, then the cached summary until the transcript changes or a refresh.
      const first = await post('/api/summary', { id: clean.id });
      assert.equal(first.status, 200);
      assert.equal(first.body.summary.tema, 'Arreglo del login');
      assert.equal(model.requests.length, 1);
      const sent = model.requests[0];
      assert.equal(sent.model, 'fake-model');
      assert.equal(sent.stream, false);
      assert.ok(sent.format?.required.includes('pendiente'), 'structured output schema');
      assert.match(sent.messages.at(-1).content, /Arregla el login \(clean\)/);
      assert.match(sent.messages.at(-1).content, /auth\.ts/);
      assert.equal((await post('/api/summary', { id: clean.id })).body.cached, true);
      assert.equal(model.requests.length, 1, 'served from cache');
      await post('/api/summary', { id: clean.id, refresh: true });
      assert.equal(model.requests.length, 2, 'refresh asks again');

      // Guards before any key press.
      assert.equal((await post('/api/close', { id: crypto.randomUUID(), pid: clean.pid })).status, 404);
      assert.equal((await post('/api/close', { id: clean.id, pid: stubborn.pid })).status, 409, 'pid the UI did not show');
      assert.equal((await post('/api/focus', { id: crypto.randomUUID() })).status, 404);
      assert.ok(alive(clean.pid) && alive(stubborn.pid), 'nothing was closed by a refused request');

      // Clean: Ctrl+C in its console, the fake quits normally and the chat shows closed.
      const closed = await post('/api/close', { id: clean.id, pid: clean.pid });
      assert.equal(closed.status, 200);
      assert.equal(closed.body.how, 'clean');
      assert.equal(alive(clean.pid), false);
      assert.match(fs.readFileSync(clean.transcript, 'utf8'), /cost-state/);
      const after = await until(async () => { const c = await chatOf(clean.id); return c && !c.alive && c; }, 15_000, 'clean chat closed');
      assert.equal(after.state, 'closed', 'a normal quit right after a reply is closed, not cut');
      assert.equal((await post('/api/focus', { id: clean.id })).status, 409, 'cannot go to a closed chat');

      // Stubborn: ignores Ctrl+C, so it is ended by force.
      const forced = await post('/api/close', { id: stubborn.id, pid: stubborn.pid });
      assert.equal(forced.status, 200);
      assert.equal(forced.body.how, 'forced');
      assert.equal(alive(stubborn.pid), false);
    } finally {
      server?.kill();
      for (const f of fakes) if (alive(f.pid)) process.kill(f.pid);
      ollama.close();
      await sleep(800);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
