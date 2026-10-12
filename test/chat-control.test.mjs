import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatControl } from '../server/chat-control.mjs';
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-')), id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', file = path.join(dir, 'conversation.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Original request' } }) + '\n');
  const chat = { id, tool: 'claude', file, title: 'Fixture chat', alive: true, automated: false, state: 'waiting', pid: 10 };
  const control = new ChatControl({ targets: () => new Map([[id, chat]]), artifacts: path.join(dir, 'messages'), enroll: async () => ({ id, pid: 10 }), deliver: async () => {}, ...overrides });
  return { dir, id, chat, control };
}
test('conversation uses server-owned transcript and Unicode user messages are delivered once by file', async () => {
  let delivered = 0; const f = fixture({ deliver: async (_chat, _enrolled, file) => { delivered++; assert.match(fs.readFileSync(file, 'utf8'), /Añade una función\ncon pruebas/); } });
  try {
    const conversation = f.control.conversation(f.id); assert.equal(conversation.messages[0].text, 'Original request'); assert.equal(conversation.canSend, true);
    const result = await f.control.message(f.id, 'Añade una función\ncon pruebas'); assert.equal(result.status, 'submitted'); assert.equal(delivered, 1);
    await assert.rejects(f.control.message('../file', 'message'), /not found/); assert.equal(delivered, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('busy or leased chats and slash commands spend no turn; uncertain delivery is never retried', async () => {
  let delivered = 0; const f = fixture({ deliver: async () => { delivered++; throw Error('Partial input'); } });
  try {
    f.chat.state = 'working'; await assert.rejects(f.control.message(f.id, 'new message'), /Wait/); f.chat.state = 'waiting';
    f.control.leased = () => true; await assert.rejects(f.control.message(f.id, 'new message'), /active cycle/); f.control.leased = () => false;
    await assert.rejects(f.control.message(f.id, '/permissions'), /terminal commands/); assert.equal(delivered, 0);
    await assert.rejects(f.control.message(f.id, 'new message'), /confirmed/); assert.equal(delivered, 1); assert.equal(f.control.pending.size, 0);
    const folder = path.join(f.dir, 'messages', fs.readdirSync(path.join(f.dir, 'messages'))[0]); assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'message.json'), 'utf8')).status, 'uncertain');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
