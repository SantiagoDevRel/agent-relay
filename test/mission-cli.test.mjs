import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RelayClient, parseOptions } from '../relay-cli.mjs';

test('CLI shares local Host/Origin/token auth and preserves request fields without shell interpolation', async () => {
  const token = 'a'.repeat(48), seen = [];
  const client = new RelayClient({ port: 4899, fetcher: async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/api/ping')) return Response.json({ app: 'chats-dashboard' });
    if (url.endsWith('/')) return new Response(`<meta name="chats-token" content="${token}">`);
    if (init?.method === 'POST') return Response.json({ id: 'owned-mission' });
    return Response.json({ jobs: [] });
  } });
  await client.connect({ start: false }); await client.request('/api/missions/create', { title: 'Quote " and $(never-execute)', project: 'C:/path with spaces' }); await client.request('/api/missions');
  const post = seen.find(value => value.init?.method === 'POST');
  assert.equal(post.init.headers.Origin, 'http://127.0.0.1:4899'); assert.equal(post.init.headers['X-Chats-Token'], token);
  assert.equal(JSON.parse(post.init.body).title, 'Quote " and $(never-execute)'); assert.ok(seen.at(-1).url.endsWith(`?t=${token}`));
  assert.deepEqual(parseOptions(['create', '@contract.json', '--start', '--project', 'path with spaces']), { positional: ['create', '@contract.json'], options: { start: true, project: 'path with spaces' } });
  assert.throws(() => parseOptions(['--project']), /Missing/); assert.throws(() => new RelayClient({ port: 80 }), /port/);
});
test('installer works idempotently and refuses an existing user-owned command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-install-')), script = fileURLToPath(new URL('../scripts/install-relay.mjs', import.meta.url));
  try {
    for (let n = 0; n < 2; n++) execFileSync(process.execPath, [script, '--home', dir], { windowsHide: true, stdio: 'pipe' });
    const command = path.join(dir, '.local/bin/relay.cmd'); assert.ok(fs.readFileSync(command, 'utf8').includes('relay-cli.mjs'));
    for (const area of ['.codex', '.claude']) for (const skill of ['agent-relay-orchestrator', 'agent-relay-spec']) assert.ok(fs.readFileSync(path.join(dir, area, 'skills', skill, 'SKILL.md'), 'utf8').startsWith('---'));
    fs.writeFileSync(command, '@echo user command\n');
    assert.throws(() => execFileSync(process.execPath, [script, '--home', dir], { windowsHide: true, stdio: 'pipe' }));
    assert.equal(fs.readFileSync(command, 'utf8'), '@echo user command\n');
  } finally { fs.rmSync(dir, { force: true, recursive: true }); }
});

test('native CLI orchestrator keeps the explicitly selected server port and provider in its launch', async () => {
  const filename = fileURLToPath(new URL('../relay-cli.mjs', import.meta.url)), source = fs.readFileSync(filename, 'utf8');
  const begin = source.indexOf('export async function main('), end = source.indexOf('\nif (process.argv[1]', begin), calls = [];
  class Client { constructor({ port }) { this.port = port; } async connect() {} }
  const main = vm.runInNewContext('(' + source.slice(begin, end).replace(/^export /, '') + ')', {
    parseOptions, RelayClient: Client, path, CLI: filename, crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    process: { env: {}, cwd: () => os.tmpdir() }, console: { log() {} },
    openOrchestratorTerminal: async options => { calls.push(options); return { launched: true }; },
  });
  await main(['orchestrate', '--port', '4927', '--provider', 'claude', '--model', 'sonnet', '--effort', 'high', '--project', os.tmpdir()]);
  assert.equal(calls.length, 1); assert.equal(calls[0].port, 4927); assert.equal(calls[0].provider, 'claude');
  assert.equal(calls[0].model, 'sonnet'); assert.equal(calls[0].cwd, path.resolve(os.tmpdir()));
  assert.equal(calls[0].windowName, 'agent-relay-aaaaaaaa');
});
