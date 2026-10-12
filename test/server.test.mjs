// Starts the real server on a spare port and checks its guards. Needs `npm run build`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';

const PORT = 4861;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = new URL('../server/server.mjs', import.meta.url);
const built = fs.existsSync(new URL('../dist/index.html', import.meta.url));

// fetch() cannot override Host, so this uses http.request directly.
function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await request('/api/ping');
      if (r.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

test('server guards: host, token, origin, content type, open and quit', { skip: !built && 'run npm run build first', timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-server-guards-'));
  fs.mkdirSync(path.join(home, '.claude/projects'), { recursive: true });
  fs.mkdirSync(path.join(home, 'chats-dashboard'), { recursive: true });
  const workspace = path.join(home, 'workspace'), mcp = path.join(workspace, 'projects', 'example-team', 'MCP');
  fs.mkdirSync(path.join(mcp, 'main'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.secrets'));
  const refinementId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const refinementDir = path.join(home, 'Downloads', 'agent-work', 'agent-relay-missions', 'prompt-specs', refinementId);
  fs.mkdirSync(refinementDir, { recursive: true });
  fs.writeFileSync(path.join(refinementDir, 'spec-output.txt'), 'Fixture provider output: <script>never execute this</script>\n');
  fs.writeFileSync(path.join(home, 'chats-dashboard', 'prompt-specs.json'), JSON.stringify([{ id: refinementId, kind: 'mission', status: 'attention', provider: 'claude', model: 'fixture-model', effort: 'max', createdAt: 123, detail: 'Fixture preparation failed.', original: { goal: 'Private fixture request', acceptance: '' } }]));
  fs.writeFileSync(path.join(home, 'chats-dashboard/mobile.json'), JSON.stringify({ version: 1, enabled: true, backendPort: PORT, origin: 'https://relay.example.ts.net', ownerLogin: 'owner@example.test', createdAt: Date.now() }));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER.pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, CHATS_PORT: String(PORT), CHATS_WORKSPACE_ROOT: workspace, USERPROFILE: home, HOME: home, LOCALAPPDATA: home },
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    await waitForServer();
    assert.equal((await request('/', { headers: { Host: 'evil.example' } })).status, 421, 'foreign Host is rejected (DNS rebinding)');
    const page = await request('/');
    assert.equal(page.status, 200);
    const token = page.body.match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1];
    assert.ok(token, 'index.html carries the run token');
    const remoteHeaders = { Host: 'relay.example.ts.net', 'X-Forwarded-Host': 'relay.example.ts.net', 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': 'owner@example.test' };
    for (const target of ['/', '/shell.html', '/manifest.webmanifest', '/api/ping', `/api/snapshot?t=${token}`]) {
      assert.equal((await request(target, { headers: { ...remoteHeaders, 'Tailscale-User-Login': 'other@example.test' } })).status, 403, 'other tailnet member receives neither shell, assets, token, nor data');
      assert.equal((await request(target, { headers: { ...remoteHeaders, 'Tailscale-User-Login': '' } })).status, 403, 'missing identity is rejected before every route');
    }
    assert.equal((await request('/', { headers: { ...remoteHeaders, Host: `127.0.0.1:${PORT}` } })).status, 403, 'rewritten local Host cannot bypass proxy authorization');
    const remotePage = await request('/', { headers: remoteHeaders }); assert.equal(remotePage.status, 200); assert.ok(remotePage.body.includes(token));
    assert.equal((await request('/api/snapshot', { headers: remoteHeaders })).status, 403, 'owner still needs run token for API');
    assert.equal((await request(`/api/projects?t=${token}`, { headers: remoteHeaders })).status, 200);
    assert.equal((await request('/api/projects/folders')).status, 403, 'folder discovery requires the run token');
    assert.equal((await request(`/api/projects/folders?t=${token}`, { headers: { ...remoteHeaders, 'Tailscale-User-Login': 'other@example.test' } })).status, 403, 'folder discovery requires the owner identity');
    const folders = JSON.parse((await request(`/api/projects/folders?t=${token}`, { headers: remoteHeaders })).body);
    assert.equal(folders.root.path, workspace); assert.equal(folders.current.path, workspace);
    assert.deepEqual(folders.folders.map(value => value.label), ['projects']);
    const target = JSON.parse((await request(`/api/projects/folders?t=${token}&path=${encodeURIComponent(mcp)}`, { headers: remoteHeaders })).body);
    assert.deepEqual(target.breadcrumbs.map(value => value.label), ['workspace', 'projects', 'example-team', 'MCP']);
    assert.deepEqual(target.folders.map(value => value.label), ['main']);
    assert.equal((await request(`/api/projects/folders?t=${token}&path=${encodeURIComponent(home)}`)).status, 403, 'outside paths are rejected');
    assert.equal((await request(`/api/projects/folders?t=${token}&path=${encodeURIComponent(path.join(workspace, '.secrets'))}`)).status, 403, 'hidden paths are rejected');
    for (const target of ['/api/prompts/history?kind=mission', `/api/prompts/log?id=${refinementId}`]) {
      assert.equal((await request(target)).status, 403, 'saved preparations require the run token');
      assert.equal((await request(`${target}&t=${token}`, { headers: { ...remoteHeaders, 'Tailscale-User-Login': 'other@example.test' } })).status, 403, 'saved preparations require the owner identity');
    }
    const attempts = JSON.parse((await request(`/api/prompts/history?kind=mission&t=${token}`, { headers: remoteHeaders })).body);
    assert.equal(attempts.total, 1); assert.equal(attempts.attempts[0].id, refinementId);
    assert.equal(JSON.stringify(attempts).includes('Private fixture request'), false, 'history does not expose original requests');
    const savedLog = await request(`/api/prompts/log?id=${refinementId}&t=${token}`, { headers: remoteHeaders });
    assert.equal(savedLog.status, 200); assert.match(JSON.parse(savedLog.body).text, /Fixture provider output/);
    assert.equal(JSON.parse(savedLog.body).original.goal, 'Private fixture request', 'authorized log viewing also recovers the saved original request');
    assert.match(JSON.parse(savedLog.body).text, /<script>never execute this<\/script>/, 'output stays plain text data');
    assert.equal((await request(`/api/prompts/history?kind=other&t=${token}`)).status, 400);
    assert.equal((await request(`/api/prompts/log?id=../settings.json&t=${token}`)).status, 404);
    assert.equal((await request(`/api/prompts/log?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&t=${token}`)).status, 404);
    // The offline copy the installed app caches must never hold a token.
    const shell = await request('/shell.html');
    assert.equal(shell.status, 200);
    assert.match(shell.body, /name="chats-token" content=""/);
    assert.ok(!shell.body.includes(token), 'shell.html has no token');
    const manifest = await new Promise((resolve, reject) => {
      http.get(`${BASE}/manifest.webmanifest`, (res) => { res.resume(); resolve(res.headers['content-type']); }).on('error', reject);
    });
    assert.equal(manifest, 'application/manifest+json');

    assert.equal((await request('/api/snapshot')).status, 403, 'no token');
    assert.equal((await request('/api/snapshot?t=wrong')).status, 403, 'wrong token');
    // The first cycle can take a moment on a cold cache.
    let snap;
    for (let i = 0; i < 50 && !snap?.chats; i += 1) {
      snap = JSON.parse((await request(`/api/snapshot?t=${token}`)).body);
      if (!snap.chats) await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(Array.isArray(snap.chats));
    assert.ok(snap.chats.every((c) => !('cwd' in c)), 'absolute cwd stays server-side');

    const json = { 'Content-Type': 'application/json', Origin: BASE, 'X-Chats-Token': token };
    const post = (path, payload, headers = json) => request(path, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal((await post('/api/window', { days: 5 }, { ...json, ...remoteHeaders, Origin: BASE })).status, 403, 'local origin cannot submit to remote owner session');
    assert.equal((await post('/api/window', { days: 5 }, { ...json, ...remoteHeaders, Origin: 'https://relay.example.ts.net' })).status, 400, 'authorized remote write reaches application validation');
    assert.equal((await post('/api/prompts/refine', { kind: 'mission', goal: 'tiny', provider: 'codex' })).status, 400, 'invalid refinements launch no model');
    const refused = await post('/api/prompts/refine', { kind: 'mission', goal: 'Prepare a fixture specification.', provider: 'claude', effort: 'ultra' });
    assert.equal(refused.status, 422, 'unsupported Claude effort is rejected before launching any provider');
    const refusal = JSON.parse(refused.body); assert.match(refusal.refinementId, /^[a-f0-9-]{36}$/);
    const refusalLog = await request(`/api/prompts/log?id=${refusal.refinementId}&t=${token}`);
    assert.equal(refusalLog.status, 200); assert.match(JSON.parse(refusalLog.body).text, /Unsupported reasoning effort/);
    assert.equal((await post('/api/chat/message', { id: 'not-a-uuid', text: 'My message' })).status, 404);
    assert.equal((await post('/api/missions/extend', { id: 'not-a-mission', minutes: 60 })).status, 404);
    assert.equal((await post('/api/control', { action: 'pause' }, { ...json, Origin: 'http://evil.example' })).status, 403, 'foreign Origin');
    assert.equal((await post('/api/control', { action: 'pause' }, { ...json, 'X-Chats-Token': 'nope' })).status, 403, 'POST without token');
    assert.equal((await post('/api/control', { action: 'pause' }, { ...json, 'Content-Type': 'text/plain' })).status, 415, 'JSON only');
    assert.equal((await post('/api/window', { days: 5 })).status, 400);
    assert.equal((await post('/api/open', { id: 'not-a-uuid' })).status, 404);
    assert.equal((await post('/api/control', { action: 'pause' })).status, 200);
    assert.equal(JSON.parse((await request(`/api/snapshot?t=${token}`)).body).paused, true);
    assert.equal((await post('/api/control', { action: 'quit' })).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    await assert.rejects(request('/api/ping'), 'port is closed after quit');
  } finally {
    if (child.exitCode === null) { const stopped = new Promise(r => child.once('exit', r)); child.kill(); await stopped; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
