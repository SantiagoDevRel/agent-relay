import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {RemoteAccess, readMobileConfig, validateMobileConfig, writeMobileConfig} from '../server/remote-access.mjs';
import {deriveMobileConfig, enableMobile, ownsServe} from '../scripts/enable-mobile.mjs';

const owner = 'owner@example.invalid', origin = 'https://relay.tailtest.ts.net', host = 'relay.tailtest.ts.net';
const config = port => ({version: 1, enabled: true, origin, ownerLogin: owner, backendPort: port, createdAt: 1});
function fixture(t, port = 4848) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mobile-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'mobile.json');
  return {file, access: new RemoteAccess({file, port}), port};
}
const req = (headers, address = '127.0.0.1', method = 'GET') => ({headers, socket: {remoteAddress: address}, method});
const proxy = (extra = {}) => ({host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'tailscale-user-login': owner, ...extra});
const serveConfig = port => ({TCP: {'443': {HTTPS: true}}, Web: {[`${host}:443`]: {Handlers: {'/': {Proxy: `http://127.0.0.1:${port}`}}}}});
const status = {BackendState: 'Running', Self: {DNSName: `${host}.`, UserID: 12}, User: {'12': {LoginName: owner}}};

test('loopback Host rules continue locally and never promote forwarding headers', t => {
  const {access} = fixture(t);
  assert.equal(access.authorize(req({host: '127.0.0.1:4848'})).allowed, true);
  assert.equal(access.authorize(req({host: 'localhost:4848'}, '::1')).allowed, true);
  for (const headers of [{host: 'evil.example:4848'}, {host: '127.0.0.1:4848.evil'}, {host}, {host: '127.0.0.1:4848', 'x-forwarded-host': host}, {host: 'localhost:4848', 'tailscale-user-login': owner}, {host: '127.0.0.1:4848', forwarded: 'proto=https'}]) {
    assert.equal(access.authorize(req(headers)).allowed, false);
  }
  assert.equal(access.authorize(req({host: '127.0.0.1:4848'}, '100.64.0.10')).allowed, false);
  const duplicate = req({host: '127.0.0.1:4848'}); duplicate.rawHeaders = ['Host', '127.0.0.1:4848', 'Host', host];
  assert.equal(access.authorize(duplicate).status, 421);
});

test('mobile requires the exact configured owner, HTTPS proxy and domain', t => {
  const {access, file, port} = fixture(t); writeMobileConfig(file, config(port));
  assert.deepEqual(access.authorize(req(proxy())), {allowed: true, status: 200, remote: true, origin});
  for (const headers of [proxy({'tailscale-user-login': undefined}), proxy({'tailscale-user-login': 'other@example.invalid'}), proxy({'tailscale-user-login': `${owner},other@example.invalid`}), proxy({'tailscale-user-login': [owner]}), proxy({'x-forwarded-proto': 'http'}), proxy({'x-forwarded-host': '127.0.0.1:4848'}), proxy({host: `${host}.evil`}), proxy({host: `${host}:443`}), proxy({'tailscale-funnel-request': '?1'})]) {
    assert.equal(access.authorize(req(headers)).allowed, false);
  }
  assert.equal(access.authorize(req(proxy(), '100.64.0.10')).allowed, false);
  const duplicate = req(proxy()); duplicate.rawHeaders = ['Tailscale-User-Login', owner, 'Tailscale-User-Login', owner];
  assert.equal(access.authorize(duplicate).allowed, false);
  assert.equal(JSON.stringify(access.publicState()).includes(owner), false);
});

test('configuration loads live, malformed/unknown owner/disabled/port mismatch fail closed', t => {
  const {access, file, port} = fixture(t);
  assert.equal(access.publicState().enabled, false);
  writeMobileConfig(file, config(port)); assert.equal(access.publicState().enabled, true);
  writeMobileConfig(file, {...config(port), enabled: false}); assert.equal(access.authorize(req(proxy())).allowed, false);
  for (const value of [{...config(port), ownerLogin: ''}, {...config(port), ownerLogin: '\r\n'}, {...config(port), origin: 'https://relay.tailtest.ts.net.evil'}, {...config(port), origin: `${origin}/admin`}, {...config(port), origin: origin + ':443'}, {...config(port), origin: 'http://' + host}, {...config(port), origin: 'https://owner@' + host}, {...config(port), extra: true}]) {
    assert.throws(() => validateMobileConfig(value, port));
  }
  writeMobileConfig(file, config(port + 1)); assert.equal(access.publicState().enabled, false);
  fs.writeFileSync(file, '{bad'); assert.equal(access.authorize(req(proxy())).allowed, false);
  fs.writeFileSync(file, 'x'.repeat(4097)); assert.equal(readMobileConfig(file), null);
});

test('SSO gates shell and APIs before token; writes still require matching origin and token', async t => {
  const {file} = fixture(t); const token = 'test-owned-token'; let access;
  const server = http.createServer((request, response) => {
    const auth = access.authorize(request);
    if (!auth.allowed) { response.writeHead(auth.status).end('forbidden'); return; }
    if (request.url === '/') { response.end(JSON.stringify({token})); return; }
    const validToken = request.method === 'GET' ? new URL(request.url, 'http://localhost').searchParams.get('t') === token : request.headers['x-chats-token'] === token;
    if (!validToken || (request.method === 'POST' && !access.originAllowed(request, auth))) { response.writeHead(403).end('forbidden'); return; }
    response.end('allowed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; access = new RemoteAccess({file, port}); writeMobileConfig(file, config(port));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (url, headers, method = 'GET') => new Promise((resolve, reject) => {
    const r = http.request({hostname: '127.0.0.1', port, path: url, headers, method}, response => {
      let body = ''; response.on('data', data => body += data); response.on('end', () => resolve({status: response.statusCode, body}));
    }); r.on('error', reject); r.end();
  });
  assert.equal((await request('/', proxy({'tailscale-user-login': 'other@example.invalid'}))).body.includes(token), false);
  assert.equal((await request('/', proxy())).status, 200);
  assert.equal((await request('/api/data', proxy())).status, 403);
  assert.equal((await request(`/api/data?t=${token}`, proxy())).status, 200);
  assert.equal((await request(`/api/data?t=${token}`, proxy({'tailscale-user-login': 'other@example.invalid'}))).status, 403);
  assert.equal((await request('/api/action', proxy({origin, 'x-chats-token': token}), 'POST')).status, 200);
  for (const extra of [{origin: 'https://evil.example', 'x-chats-token': token}, {origin, 'x-chats-token': 'wrong'}, {origin: `http://127.0.0.1:${port}`, 'x-chats-token': token}, {'x-chats-token': token}]) {
    assert.equal((await request('/api/action', proxy(extra), 'POST')).status, 403);
  }
  assert.equal((await request('/api/action', {host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-chats-token': token}, 'POST')).status, 200);
});

function setupFixture(t, overrides = {}) {
  const {file, port, access} = fixture(t); let serving = overrides.initial || {}, mutations = 0; const calls = [];
  const execImpl = async (_bin, args, options) => {
    calls.push(args); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    if (args.join(' ') === 'status --json') return {stdout: JSON.stringify(overrides.status || status)};
    if (args.join(' ') === 'serve status --json') return {stdout: JSON.stringify(serving)};
    assert.deepEqual(args, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
    mutations++; if (overrides.failed) throw Error('private details should not leak'); serving = serveConfig(port); return {stdout: ''};
  };
  const requestImpl = async (_port, headers) => {
    if (!headers) return {status: 200, data: {app: 'chats-dashboard', mobile: overrides.notReady ? {} : access.publicState()}};
    const auth = access.authorize(req(headers));
    return {status: auth.status, data: auth.allowed ? {app: 'chats-dashboard', mobile: access.publicState()} : {error: 'forbidden'}};
  };
  return {file, port, access, execImpl, requestImpl, calls, mutations: () => mutations};
}

test('setup derives owner from Self.UserID and refuses unidentified/tagged/offline devices', () => {
  assert.equal(deriveMobileConfig(status, 4848).ownerLogin, owner);
  for (const broken of [{...status, User: {}}, {...status, BackendState: 'NeedsLogin'}, {...status, Self: {...status.Self, Tags: ['tag:server']}}, {...status, Self: {...status.Self, DNSName: 'evil.example'}}, {...status, User: {'12': {LoginName: ''}}}]) assert.throws(() => deriveMobileConfig(broken, 4848));
});

test('explicit setup verifies backend gate before one private Serve mutation, is idempotent', async t => {
  const f = setupFixture(t);
  const checked = await enableMobile({...f, enable: false}); assert.equal(checked.enabled, false); assert.equal(fs.existsSync(f.file), false); assert.equal(f.mutations(), 0);
  const enabled = await enableMobile(f); assert.equal(enabled.enabled, true); assert.equal(f.mutations(), 1);
  assert.equal(readMobileConfig(f.file).ownerLogin, owner); assert.equal(JSON.stringify(enabled).includes(owner), false);
  const reused = await enableMobile(f); assert.equal(reused.reused, true); assert.equal(f.mutations(), 1);
  assert.equal(f.calls.some(args => args.includes('funnel') || args.includes('reset') || args.includes('off') || args.includes('--yes') || args.includes('--http')), false);
});

test('setup does not change foreign Serve or mobile configs and requires updated backend', async t => {
  for (const initial of [{TCP: {'443': {HTTPS: true}}}, {...serveConfig(4848), AllowFunnel: {[`${host}:443`]: true}}, {...serveConfig(4848), Services: {'svc:other': {}}}]) {
    const f = setupFixture(t, {initial}); await assert.rejects(enableMobile(f), /unrelated/); assert.equal(f.mutations(), 0); assert.equal(fs.existsSync(f.file), false);
  }
  const notReady = setupFixture(t, {notReady: true}); await assert.rejects(enableMobile(notReady), /mobile protection/); assert.equal(notReady.mutations(), 0); assert.equal(fs.existsSync(notReady.file), false);
  const foreign = setupFixture(t); fs.writeFileSync(foreign.file, '{unknown existing}'); await assert.rejects(enableMobile(foreign), /not replaced/); assert.equal(fs.readFileSync(foreign.file, 'utf8'), '{unknown existing}');
});

test('failed activation closes only our app gate and never removes external Serve state', async t => {
  const f = setupFixture(t, {failed: true}); await assert.rejects(enableMobile(f), /did not complete/);
  assert.equal(f.mutations(), 1); assert.equal(readMobileConfig(f.file).enabled, false);
  assert.equal(f.calls.some(args => args.includes('reset') || args.includes('off')), false);
  assert.equal(ownsServe({...serveConfig(4848), Web: {[`${host}:443`]: {Handlers: {'/': {Path: 'C:/private'}}}}}, config(4848)), false);
});
