// Controls run against an isolated home: never persist settings in User's app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PORT = 4863;
const BASE = `http://127.0.0.1:${PORT}`;
const built = fs.existsSync(new URL('../dist/index.html', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('paused controls reject stale settings; resume applies new settings and malformed bodies return 400',
  { skip: !built && 'run npm run build first', timeout: 30_000 }, async () => {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-controls-'));
    const settings = path.join(fixtureHome, 'chats-dashboard', 'settings.json');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning',
      fileURLToPath(new URL('../server/server.mjs', import.meta.url))], {
      env: { ...process.env, CHATS_PORT: String(PORT), USERPROFILE: fixtureHome, HOME: fixtureHome, LOCALAPPDATA: fixtureHome },
      windowsHide: true, stdio: 'ignore',
    });
    try {
      let token;
      for (let i = 0; i < 60 && !token; i++) {
        try {
          token = (await (await fetch(BASE)).text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1];
        } catch { /* Starting. */ }
        if (!token) await sleep(100);
      }
      assert.ok(token);
      const snapshot = async () => (await fetch(`${BASE}/api/snapshot?t=${token}`)).json();
      for (let i = 0; i < 100 && !(await snapshot()).chats; i++) await sleep(100);
      assert.ok((await snapshot()).chats);
      const post = (route, body) => fetch(BASE + route, { method: 'POST',
        headers: { Origin: BASE, 'Content-Type': 'application/json', 'X-Chats-Token': token }, body: JSON.stringify(body) });
      assert.equal((await post('/api/control', { action: 'pause' })).status, 200);
      const frozen = await snapshot();
      for (const [route, body] of [['/api/window', { days: 7 }], ['/api/automated', { show: true }], ['/api/control', { action: 'resync' }]]) {
        const response = await post(route, body);
        assert.equal(response.status, 409, `${route} cannot report success without updating the paused view`);
        assert.equal((await response.json()).error, 'paused');
      }
      assert.equal(fs.existsSync(settings), false, 'rejected controls must not persist hidden changes');
      assert.deepEqual(await snapshot(), frozen, 'pause keeps the snapshot frozen');
      assert.equal((await post('/api/control', { action: 'resume' })).status, 200);
      assert.equal((await snapshot()).paused, false);
      assert.equal((await post('/api/window', { days: 7 })).status, 200);
      assert.equal((await snapshot()).windowDays, 7);
      assert.equal((await post('/api/automated', { show: true })).status, 200);
      assert.equal((await snapshot()).showAutomated, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { windowDays: 7, showAutomated: true });
      for (const body of [null, [], 'bad', 42, true]) {
        assert.equal((await post('/api/control', body)).status, 400, 'JSON must be an object');
      }
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
