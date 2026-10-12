import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('real mission HTTP API guards authority, persists eleven tasks, and rejects dirty source without inference', { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-api-')), project = path.join(dir, 'project'); fs.mkdirSync(project);
  const git = args => execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' });
  git(['init']); git(['config', 'user.name', 'Relay Tests']); git(['config', 'user.email', 'relay-tests@localhost']);
  fs.writeFileSync(path.join(project, 'README.md'), 'Fixture\n'); git(['add', '--', 'README.md']); git(['commit', '-m', 'Initialize fixture']);
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../server/server.mjs', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHATS_PORT: String(port), HOME: dir, USERPROFILE: dir, LOCALAPPDATA: dir } });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  try {
    let token;
    for (let n = 0; n < 150; n++) {
      if (child.exitCode !== null) throw Error(`Server exited: ${output}`);
      try { token = (await (await fetch(base)).text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1]; if (token) break; } catch { /* still starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(token, output);
    const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Chats-Token': token, ...headers }, body: JSON.stringify(body) });
    const get = async route => (await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}t=${token}`)).json();
    for (const route of ['/api/missions', '/api/missions/catalog', '/api/missions/status', '/api/missions/log']) assert.equal((await fetch(base + route)).status, 403);
    for (const action of ['plan', 'create', 'start', 'pause', 'resume', 'stop', 'retry', 'message', 'apply', 'terminal']) assert.equal((await post(`/api/missions/${action}`, {}, { 'X-Chats-Token': 'invalid' })).status, 403);
    assert.equal((await post('/api/missions/create', {}, { Origin: 'https://evil.example' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => { http.get(base + '/', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
    assert.equal(wrongHost, 421);
    assert.equal((await post('/api/missions/create', [])).status, 400);
    const spec = { title: 'Eleven requested features', goal: 'Implement every requested feature with executable acceptance checks.', project, provider: 'codex', effort: 'high',
      tasks: Array.from({ length: 11 }, (_, index) => ({ id: `feature-${index + 1}`, title: `Feature ${index + 1}`, prompt: `Implement literal feature ${index + 1} with checks.`, files: [`feature-${index + 1}.mjs`], dependsOn: index === 10 ? ['feature-1'] : [], checks: [[process.execPath, '--check', `feature-${index + 1}.mjs`]] })), checks: [[process.execPath, '--check', 'feature-1.mjs']] };
    let response = await post('/api/missions/create', spec); assert.equal(response.status, 200, await response.clone().text()); const job = await response.json();
    assert.equal(job.tasks.length, 11); assert.equal(job.status, 'draft'); assert.equal(job.sessionsUsed, 0);
    let saved = (await get('/api/missions')).jobs.find(value => value.id === job.id); assert.equal(saved.tasks[10].dependsOn[0], 'feature-1'); assert.equal(saved.progress.total, 11); assert.ok(!('prompt' in saved.tasks[0]));
    fs.appendFileSync(path.join(project, 'README.md'), 'user edit');
    response = await post('/api/missions/start', { id: job.id }); assert.equal(response.status, 409); assert.equal((await get(`/api/missions/status?id=${job.id}`)).sessionsUsed, 0);
    assert.equal((await post('/api/missions/create', { ...spec, limits: { maxSessions: 1000 } })).status, 400);
    assert.equal((await post('/api/missions/retry', { id: job.id, taskId: '../escape' })).status, 404);
    assert.equal((await post('/api/missions/terminal', { id: job.id, taskId: 'unknown' })).status, 404);
    assert.equal((await post('/api/missions/apply', { id: job.id })).status, 409);
    await post('/api/control', { action: 'pause' }); assert.equal((await post('/api/missions/create', spec)).status, 409);
    assert.equal((await post('/api/missions/stop', { id: job.id })).status, 200);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000).unref(); }); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
