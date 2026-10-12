import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-role-'));
process.env.USERPROFILE = home; process.env.HOME = home;
const projects = path.join(home, '.claude', 'projects', 'fixture');
fs.mkdirSync(projects, { recursive: true });
const now = Date.now(), native = '11111111-1111-4111-8111-111111111111', managed = '22222222-2222-4222-8222-222222222222';
const line = value => JSON.stringify({ timestamp: new Date(now).toISOString(), cwd: home, ...value }) + '\n';
const marker = '# Agent Relay · Orquestador\n<!-- agent-relay-native-orchestrator:v1 -->\nWait for the task.';
const nativeFile = path.join(projects, native + '.jsonl');
fs.writeFileSync(nativeFile, line({ type: 'user', message: { content: marker } }) + line({ type: 'custom-title', customTitle: 'User-renamed coordinator' }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready for the request.' }] } }));
const managedFile = path.join(projects, managed + '.jsonl');
fs.writeFileSync(managedFile, line({ type: 'user', entrypoint: 'sdk-cli', message: { content: 'Implement only the assigned file.' } }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Verified the actual checks.\nSTATUS: OK' }] } }));
const original = fs.readFileSync(managedFile);
const { collectClaude, stopClaudeWatcher } = await import('../server/claude.mjs');
const options = { procs: { get: () => undefined }, windowMs: 86400000, now };
after(() => { stopClaudeWatcher(); fs.rmSync(home, { recursive: true, force: true }); });

test('native Claude orchestrator role survives rename; a managed owned chat reads its real tail without showing unrelated automation', () => {
  const hidden = collectClaude(options);
  assert.equal(hidden.chats.find(chat => chat.id === native).role, 'orchestrator');
  assert.equal(hidden.chats.find(chat => chat.id === native).title, 'User-renamed coordinator');
  assert.equal(hidden.hidden, 1);
  assert.ok(!hidden.chats.some(chat => chat.id === managed));
  const included = collectClaude({ ...options, includedIds: new Set([managed]) });
  const worker = included.chats.find(chat => chat.id === managed);
  assert.equal(worker.state, 'closed');
  assert.match(worker.lastLine, /STATUS: OK/);
  assert.equal(included.hidden, 0);
  assert.deepEqual(fs.readFileSync(managedFile), original, 'collection remains read-only');
});
