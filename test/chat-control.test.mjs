import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatControl } from '../server/chat-control.mjs';
import { createTmuxBackend } from '../server/chat-tab-tmux.mjs';
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

test('certain transport refusals write not-sent receipts and actionable 409 messages without replay', async () => {
  for (const reason of ['draft', 'busy', 'menu', 'copy-mode', 'no-composer', 'frame-changed', 'no-style', 'identity']) {
    let calls = 0;
    const f = fixture({ deliver: async () => { calls++; throw Object.assign(Error('Guard refused before typing'), { code: 'RELAY_NOT_SENT', reason }); } });
    try {
      await assert.rejects(f.control.message(f.id, 'hello'), error => error.status === 409 && error.code === 'RELAY_NOT_SENT' &&
        error.reason === reason && /Not sent: .*Nothing was typed/.test(error.message) &&
        (reason !== 'draft' || /draft/.test(error.message)) && (reason !== 'no-composer' || /screen \(claude\).*Claude app/.test(error.message)));
      assert.equal(calls, 1); assert.equal(f.control.pending.size, 0);
      const folder = path.join(f.dir, 'messages', fs.readdirSync(path.join(f.dir, 'messages'))[0]);
      const receipt = JSON.parse(fs.readFileSync(path.join(folder, 'message.json'), 'utf8'));
      assert.equal(receipt.status, 'not-sent'); assert.equal(receipt.reason, reason);
    } finally { fs.rmSync(f.dir, { recursive: true }); }
  }
});

test('only Windows Claude draft refusals explain the grey prompt suggestion limitation', async () => {
  const hint = "Not sent: the chat's input field shows text. On Windows, Relay cannot tell Claude's grey suggestion from a draft. Nothing was typed; clear the input field or turn off prompt suggestions in /config before trying again.";
  const usual = "Not sent: the chat's input field has a draft. Nothing was typed; clear the draft in the chat before trying again.";
  for (const [platform, tool, expected] of [['win32', 'claude', hint], ['linux', 'claude', usual], ['win32', 'codex', usual]]) {
    const f = fixture({ platform, deliver: async () => { throw Object.assign(Error('Draft refused'), { code: 'RELAY_NOT_SENT', reason: 'draft' }); } });
    f.chat.tool = tool;
    try {
      await assert.rejects(f.control.message(f.id, 'hello'), error => {
        assert.equal(error.message, expected, `${platform}/${tool}`);
        assert.equal(error.status, 409); assert.equal(error.code, 'RELAY_NOT_SENT'); assert.equal(error.reason, 'draft');
        return true;
      });
      const folder = path.join(f.dir, 'messages', fs.readdirSync(path.join(f.dir, 'messages'))[0]);
      const receipt = JSON.parse(fs.readFileSync(path.join(folder, 'message.json'), 'utf8'));
      assert.equal(receipt.status, 'not-sent'); assert.equal(receipt.reason, 'draft');
      assert.equal(fs.existsSync(path.join(folder, 'refusal.json')), false);
    } finally { fs.rmSync(f.dir, { recursive: true }); }
  }
});

test('refusal diagnostics are private, bounded and only saved for recognition failures, never drafts', async () => {
  for (const reason of ['no-composer', 'frame-changed', 'no-style', 'draft', 'busy', 'menu', 'identity']) {
    const refusal = { tool: 'untrusted', cursor: [8, 2, 24, 0], cliVersion: '2.1.319',
      plain: Array(20).fill('界'.repeat(3000)), styled: Array(20).fill('\x1b[2m' + '😀'.repeat(3000)), secret: 'not an allowed field' };
    const f = fixture({ deliver: async () => { throw Object.assign(Error('Refused'), { code: 'RELAY_NOT_SENT', reason, refusal }); } });
    try {
      await assert.rejects(f.control.message(f.id, 'hello'), /Nothing was typed/);
      const folder = path.join(f.dir, 'messages', fs.readdirSync(path.join(f.dir, 'messages'))[0]);
      const file = path.join(folder, 'refusal.json');
      const expected = ['no-composer', 'frame-changed', 'no-style'].includes(reason);
      assert.equal(fs.existsSync(file), expected, reason);
      if (expected) {
        assert.ok(fs.statSync(file).size <= 16384);
        if (process.platform === 'linux') assert.equal(fs.statSync(file).mode & 0o7777, 0o600);
        const diagnostic = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(diagnostic.tool, 'claude'); assert.equal(diagnostic.reason, reason);
        assert.deepEqual(diagnostic.cursor, refusal.cursor); assert.equal(diagnostic.cliVersion, '2.1.319');
        assert.equal(diagnostic.plain.length, 12); assert.equal(diagnostic.styled.length, 12);
        assert.equal(diagnostic.secret, undefined);
      }
    } finally { fs.rmSync(f.dir, { recursive: true }); }
  }
});

test('an actual tmux transport failure after literal send-keys remains uncertain in ChatControl', async () => {
  let typed = 0, checks = 0;
  const backend = createTmuxBackend({ env: {}, sleep() {}, readStart: () => '456', runner(_file, argv) {
    if (argv[0] === 'send-keys') typed++;
    if (argv[0] === 'display-message') return '%7\t123\t@2\n';
    return '';
  } });
  const f = fixture({ deliver: async () => backend.sendGuarded({ pane: '%7', pid: 123, windowId: '@2', started: '456' }, 'hello',
    { empty: () => true, check() { if (++checks === 3) throw Error('Identity changed after typing'); } }) });
  try {
    await assert.rejects(f.control.message(f.id, 'hello'), /Delivery could not be confirmed/);
    assert.equal(typed, 1);
    const folder = path.join(f.dir, 'messages', fs.readdirSync(path.join(f.dir, 'messages'))[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'message.json'))).status, 'uncertain');
    assert.equal(fs.existsSync(path.join(folder, 'refusal.json')), false);
  } finally { fs.rmSync(f.dir, { recursive: true }); }
});
