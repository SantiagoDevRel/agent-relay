import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeConversation, codexConversation, factsOf, parseSummary, promptLines, shortPath } from '../server/summary.mjs';

const lines = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');
const at = (s) => `2026-10-08T10:00:${String(s).padStart(2, '0')}Z`;

test('Claude: real messages, edited files and commands; the compaction recap is not User', () => {
  const conv = claudeConversation([lines(
    { type: 'user', timestamp: at(1), message: { content: 'Arregla el login <system-reminder>ruido</system-reminder>' } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'text', text: 'Reviso.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\repo\\auth.ts' } }] } },
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', timestamp: at(4), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', timestamp: at(5), message: { content: [{ type: 'text', text: 'Listo.' }] } },
    { type: 'user', timestamp: at(6), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } },
    { type: 'user', timestamp: at(7), message: { content: '<command-name>/clear</command-name>' } },
  )]);
  assert.deepEqual(conv.messages.map((m) => [m.role, m.text]), [['user', 'Arregla el login'], ['agent', 'Reviso.\nListo.']]);
  assert.equal(conv.commands, 1);
  const facts = factsOf(conv, { cwd: 'C:\\repo' });
  assert.deepEqual(facts.files, ['auth.ts']);
  assert.equal(facts.userTurns, 1);
  assert.equal(facts.lastAsk, '', 'one message is not repeated as the last one');
});

test('Codex: item_completed events, older events and a /goal objective, each counted once', () => {
  const goal = '<codex_internal_context source="goal">\nContinue.\n<objective>\ncrea todas las skills\n</objective>\n</codex_internal_context>';
  const conv = codexConversation([lines(
    { type: 'response_item', timestamp: at(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for C:\\repo' }] } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: goal }] } },
    { type: 'event_msg', timestamp: at(3), payload: { type: 'agent_message', message: 'Empiezo por el plan.' } },
    { type: 'response_item', timestamp: at(4), payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: C:\\repo\\a.md\n*** End Patch' } },
    { type: 'response_item', timestamp: at(5), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: goal }] } },
    { type: 'event_msg', timestamp: at(6), payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '¿cómo va?' }] } } },
    { type: 'event_msg', timestamp: at(6), payload: { type: 'user_message', message: '¿cómo va?' } },
    { type: 'event_msg', timestamp: at(7), payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['node', 'x'] } } },
    { type: 'event_msg', timestamp: at(8), payload: { type: 'item_completed', item: { type: 'FileChange', changes: { 'C:\\repo\\b.md': { type: 'update' } } } } },
    { type: 'event_msg', timestamp: at(9), payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Van 3 de 17.' }] } } },
  )]);
  assert.deepEqual(conv.messages.map((m) => [m.role, m.text]), [
    ['user', 'Goal: crea todas las skills'],
    ['agent', 'Empiezo por el plan.'],
    ['user', '¿cómo va?'],
    ['agent', 'Van 3 de 17.'],
  ]);
  assert.equal(conv.commands, 1);
  assert.deepEqual(factsOf(conv, { cwd: 'C:\\repo' }).files.sort(), ['a.md', 'b.md']);
});

test('prompt: whole timeline short, latest in full; agent replies go first, never the first request', () => {
  const messages = [{ role: 'user', text: 'Primer pedido', ts: 1 }];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: 'agent', text: `Respuesta ${i} ${'x'.repeat(900)}`, ts: i + 2 });
    messages.push({ role: 'user', text: `Pedido ${i}`, ts: i + 2 });
  }
  const out = promptLines(messages, 6000);
  assert.ok(out.join('\n').length <= 6000, 'fits the budget, markers included');
  assert.equal(out[0], '[User] Primer pedido');
  assert.ok(out.filter((l) => l.startsWith('[User]')).length === 41, 'every request of User is kept');
  assert.match(out.join('\n'), /\[… \d+ messages? omitted …\]/);
  assert.ok(out.at(-2).includes('Respuesta 39'), 'the latest reply is kept');
  const roomy = promptLines(messages.slice(0, 5), 24_000);
  assert.ok(roomy.at(-2).length > 900, 'with room, recent messages go in full');
});

test('model output: only the expected JSON shape, trimmed and capped', () => {
  const s = parseSummary(JSON.stringify({ tema: '  Login ', hecho: ['a', 7, '', 'b'], estado: 'Listo', pendiente: 'no es lista', extra: 'x' }));
  assert.deepEqual(s, { tema: 'Login', hecho: ['a', 'b'], estado: 'Listo', pendiente: [] });
  assert.throws(() => parseSummary('no json'));
  assert.throws(() => parseSummary(JSON.stringify({ estado: 'x' })), 'no topic and nothing done is not a summary');
});

test('file paths are shown relative to the chat folder', () => {
  assert.equal(shortPath('C:\\repo\\src\\auth.ts', 'C:\\repo'), 'src/auth.ts');
  assert.equal(shortPath('D:\\elsewhere\\deep\\file.md', 'C:\\repo'), 'deep/file.md');
});
