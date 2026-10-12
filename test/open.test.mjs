// Intercept Windows Terminal spawning inside this test's child only. No real
// window or chat is opened; the collectors read a throwaway home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { projectKey } from '../server/claude.mjs';

const BASE = 'http://127.0.0.1:4864';
const built = fs.existsSync(new URL('../dist/index.html', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('open reserves a chat across simultaneous clicks and reports Windows Terminal launch failures',
  { skip: !built && 'run npm run build first', timeout: 30_000 }, async () => {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-open-'));
    const work = path.join(fixtureHome, 'repo');
    const project = path.join(fixtureHome, '.claude', 'projects', projectKey(work));
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(work);
    const ids = ['bbbbbbbb-bbbb-bbbb-bbbb-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002'];
    for (const id of ids) fs.writeFileSync(path.join(project, id + '.jsonl'),
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: work, message: { content: 'Revisa el login.' } }) + '\n' +
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Terminado.' }] } }) + '\n');
    const bootstrap = path.join(fixtureHome, 'spawn-stub.cjs');
    const marker = path.join(fixtureHome, 'launches.jsonl');
    const fail = path.join(fixtureHome, 'fail');
    fs.writeFileSync(bootstrap, `
const cp = require('node:child_process');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const original = cp.spawn;
cp.spawn = function(cmd, args, opts) {
  if (cmd !== 'wt.exe') return original.apply(this, arguments);
  const child = new EventEmitter(); child.unref = () => {};
  fs.appendFileSync(process.env.CHATS_TEST_MARKER, JSON.stringify(args) + '\\n');
  process.nextTick(() => fs.existsSync(process.env.CHATS_TEST_FAIL)
    ? child.emit('error', new Error('fixture launch failure')) : child.emit('spawn'));
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
    const child = spawn(process.execPath, ['--no-warnings', '--require', bootstrap,
      fileURLToPath(new URL('../server/server.mjs', import.meta.url))], {
      env: { ...process.env, CHATS_PORT: '4864', USERPROFILE: fixtureHome, HOME: fixtureHome, LOCALAPPDATA: fixtureHome,
        CHATS_TEST_MARKER: marker, CHATS_TEST_FAIL: fail }, windowsHide: true, stdio: 'ignore',
    });
    try {
      let token;
      for (let i = 0; i < 60 && !token; i++) {
        try { token = (await (await fetch(BASE)).text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1]; } catch { /* Starting. */ }
        if (!token) await sleep(100);
      }
      assert.ok(token);
      for (let i = 0; i < 100; i++) {
        const s = await (await fetch(`${BASE}/api/snapshot?t=${token}`)).json();
        if (s.chats?.length === 2) break;
        await sleep(100);
      }
      const post = (id) => fetch(`${BASE}/api/open`, { method: 'POST',
        headers: { Origin: BASE, 'Content-Type': 'application/json', 'X-Chats-Token': token }, body: JSON.stringify({ id }) });
      const responses = await Promise.all([post(ids[0]), post(ids[0])]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409], 'only one launch is accepted before collection catches up');
      assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
      fs.writeFileSync(fail, 'fail the next launch');
      assert.equal((await post(ids[1])).status, 500, 'a failed spawn must not claim success');
      fs.unlinkSync(fail);
      assert.equal((await post(ids[1])).status, 200, 'a failed launch releases the reservation for retry');
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
