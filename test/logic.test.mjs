import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeMessageKind, classifyClaude, classifyCodex } from '../server/classify.mjs';
import { backgroundEventAt, noteSubagentEvent, parseClaudeTranscript, projectKey, readTranscript, resumeCwd } from '../server/claude.mjs';
import { agentTextOf, readRollout, taskOf } from '../server/codex.mjs';
import { commandsFor, placeOf, topicOf, WORKSPACE } from '../server/places.mjs';
import { appShortcut } from '../server/system.mjs';
import { endsWithQuestion, lastWords } from '../server/util.mjs';

const lines = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');

test('Claude state: open sessions follow the status file, closed ones the transcript', () => {
  assert.equal(classifyClaude({ alive: true, status: 'busy', lastKind: 'assistant-text' }), 'working');
  assert.equal(classifyClaude({ alive: true, status: 'shell', lastKind: 'assistant-text' }), 'working');
  assert.equal(classifyClaude({ alive: true, status: 'idle', lastKind: 'assistant-text' }), 'waiting');
  assert.equal(classifyClaude({ alive: true, status: 'idle', lastKind: 'assistant-text', bgActive: true }), 'working');
  assert.equal(classifyClaude({ alive: false, lastKind: 'assistant-tool' }), 'cut');
  assert.equal(classifyClaude({ alive: false, lastKind: 'user-tool-result' }), 'cut');
  assert.equal(classifyClaude({ alive: false, lastKind: 'user-real' }), 'cut');
  // Turn ended with "waiting for the report" while a background agent kept writing.
  assert.equal(classifyClaude({ alive: false, lastKind: 'assistant-text', bgAfterReply: true }), 'cut');
  assert.equal(classifyClaude({ alive: false, lastKind: 'assistant-text' }), 'closed');
  assert.equal(classifyClaude({ alive: false, lastKind: 'user-interrupt' }), 'closed');
  assert.equal(classifyClaude({ alive: false, lastKind: null }), 'unknown');
});

test('Codex state: open turn plus process decides working / cut', () => {
  assert.equal(classifyCodex({ alive: true, lastTask: 'started' }), 'working');
  assert.equal(classifyCodex({ alive: true, lastTask: 'complete' }), 'waiting');
  assert.equal(classifyCodex({ alive: true, lastTask: 'aborted' }), 'waiting');
  assert.equal(classifyCodex({ alive: false, lastTask: 'started' }), 'cut');
  assert.equal(classifyCodex({ alive: false, lastTask: 'complete' }), 'closed');
  assert.equal(classifyCodex({ alive: true, lastTask: null }), 'waiting');
  assert.equal(classifyCodex({ alive: false, lastTask: null }), 'unknown');
  // A missing or unreadable rollout is no evidence, even with the process open.
  assert.equal(classifyCodex({ alive: true, lastTask: null, unreadable: true }), 'unknown');
  assert.equal(classifyCodex({ alive: true, lastTask: 'started', unreadable: true }), 'unknown');
});

test('Claude message kinds ignore notifications and commands', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { content }, ...extra });
  assert.equal(claudeMessageKind({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }), 'assistant-tool');
  assert.equal(claudeMessageKind({ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }] } }), 'assistant-text');
  assert.equal(claudeMessageKind(user([{ type: 'tool_result' }])), 'user-tool-result');
  assert.equal(claudeMessageKind(user('revisa esto')), 'user-real');
  assert.equal(claudeMessageKind(user('<pasted_content id="1">x</pasted_content>')), 'user-real');
  assert.equal(claudeMessageKind(user('[Request interrupted by user]')), 'user-interrupt');
  assert.equal(claudeMessageKind(user('<task-notification><status>failed</status>')), 'user-notification');
  assert.equal(claudeMessageKind(user('<command-name>/clear</command-name>')), 'user-meta');
  assert.equal(claudeMessageKind(user('x', { isMeta: true })), 'user-meta');
});

test('Claude transcript: custom title wins, recap and automation are read', () => {
  const head = lines({ type: 'user', entrypoint: 'cli', cwd: 'C:\\x', message: { content: 'Arregla el login. Luego lo demás' } });
  const tail = lines(
    { type: 'ai-title', aiTitle: 'Arreglo de login' },
    { type: 'assistant', timestamp: '2026-10-08T01:00:00Z', message: { content: [{ type: 'text', text: '¿Lo despliego?' }] } },
    { type: 'system', subtype: 'away_summary', timestamp: '2026-10-08T01:05:00Z', content: 'Falta tu OK. (disable recaps in /config)' },
    { type: 'custom-title', customTitle: 'Login' },
    { type: 'user', timestamp: '2026-10-08T01:06:00Z', message: { content: '<task-notification>done' } },
  );
  const p = parseClaudeTranscript(head, tail);
  assert.equal(p.customTitle, 'Login');
  assert.equal(p.aiTitle, 'Arreglo de login');
  assert.equal(p.away.text, 'Falta tu OK.');
  assert.equal(p.lastKind, 'assistant-text'); // the notification does not reopen the turn
  assert.equal(p.automated, false);
  assert.equal(parseClaudeTranscript(lines({ type: 'user', entrypoint: 'sdk-cli', message: { content: 'x' } }), '').automated, true);
  assert.equal(parseClaudeTranscript(lines({ type: 'user', message: { content: '<!-- ai-pack v1 --> brief' } }), '').automated, true);
});

test('Claude incremental read equals a full read, even across a half-written line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-dashboard-test-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    const first = lines(
      { type: 'user', cwd: 'C:\\repo', message: { content: 'Arregla el login' } },
      { type: 'assistant', timestamp: '2026-10-08T01:00:00Z', message: { content: [{ type: 'tool_use' }] } },
    );
    const late = JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T01:01:00Z', message: { content: [{ type: 'text', text: 'Listo. ¿Lo despliego?' }] } });
    const title = JSON.stringify({ type: 'ai-title', aiTitle: 'Login' });
    fs.writeFileSync(file, `${first}\n${late.slice(0, 30)}`); // writer caught mid-line
    assert.equal(readTranscript(file).lastKind, 'assistant-tool');
    fs.appendFileSync(file, `${late.slice(30)}\n${title}\n`);
    const incremental = readTranscript(file);
    const full = parseClaudeTranscript('', fs.readFileSync(file, 'utf8'));
    for (const key of ['lastKind', 'aiTitle', 'lastTs', 'cwd']) assert.deepEqual(incremental[key], full[key], key);
    assert.equal(incremental.lastAssistant.text, 'Listo. ¿Lo despliego?');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('places: worktrees become tags, topics use the longest folder rule', () => {
  assert.deepEqual(placeOf(`${WORKSPACE}\\sample-app\\.claude\\worktrees\\sample-worker`), { folder: 'sample-app', worktree: 'sample-worker' });
  assert.deepEqual(placeOf(WORKSPACE), { folder: '', worktree: undefined });
  assert.deepEqual(placeOf(`\\\\?\\${WORKSPACE}\\projects\\example-team\\MCP`), { folder: 'projects/example-team/MCP', worktree: undefined });
  assert.equal(placeOf(path.join(os.homedir(), 'Downloads', 'x')).folder, '~/Downloads/x');
  assert.equal(topicOf('projects/example-team/MCP/dashboard', 'x'), 'MCP');
  assert.equal(topicOf('sample-app', 'x'), 'Development');
  assert.equal(topicOf('', 'documentation task'), 'Documentation');
  assert.equal(topicOf('somewhere/else', 'otra cosa'), 'Other');
});

test('Claude resume folder is the one its project folder is named after', () => {
  const root = 'C:\\Users\\me\\repo';
  const sub = 'C:\\Users\\me\\repo\\apps\\web';
  assert.equal(projectKey(root), 'C--Users-me-repo');
  // The agent cd'ed into a subfolder; resume must still run from the project root.
  assert.equal(resumeCwd('C--Users-me-repo', [sub, root]), root);
  assert.equal(resumeCwd('C--Users-me-repo-apps-web', [root, sub]), sub);
  assert.equal(resumeCwd('unknown', [sub, root]), sub);
});

test('commands: separate cd and resume lines, valid in PowerShell and bash', () => {
  const c = commandsFor('claude', '\\\\?\\C:\\a b\\c', 'abc');
  assert.equal(c.cdCommand, 'cd "C:\\a b\\c"');
  assert.equal(c.runCommand, 'claude --resume abc');
  assert.equal(c.resumeCommand, 'cd "C:\\a b\\c"; claude --resume abc');
  assert.equal(commandsFor('codex', 'C:\\x', 'id1').runCommand, 'codex resume id1');
});

test('last words drop the task footer and markdown', () => {
  const msg = 'Intro.\n\nListo en **daleve.co**: ver [reporte](C:/x.md). ¿Lo cierro?\n\n---\n📋 **Tareas activas**\n- #1 · algo';
  // A short last paragraph keeps the one before it for context.
  assert.equal(lastWords(msg), 'Intro. Listo en daleve.co: ver reporte. ¿Lo cierro?');
  assert.equal(endsWithQuestion(msg), true);
  assert.equal(endsWithQuestion('Ya puedes cerrar el chat.'), false);
});

test('Codex events are recognised only at top level', () => {
  assert.deepEqual(taskOf({ type: 'event_msg', timestamp: 1000, payload: { type: 'task_started' } }), { lastTask: 'started', lastTaskTs: 1_000_000 });
  assert.equal(taskOf({ type: 'response_item', payload: { type: 'task_started' } }), null);
  assert.equal(agentTextOf({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Hecho' } }).lastAgent, 'Hecho');
  assert.equal(agentTextOf({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Hola' }] } }).lastAgent, 'Hola');
});

test('rollout scan finds an old event behind huge lines and keeps up with appends', { timeout: 20_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-dashboard-test-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    const started = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-08T00:00:00Z', payload: { type: 'task_started' } });
    const chunk = 4 * 1024 * 1024;
    // A line longer than a whole chunk leaves a window whose only newline is its
    // last byte; that window used to make the scan loop forever.
    const huge = `{"type":"response_item","payload":{"type":"function_call_output","output":"${'x'.repeat(chunk + 100)}"}}`;
    const medium = `{"type":"response_item","payload":{"type":"function_call_output","output":"${'y'.repeat(chunk - 80)}"}}`;
    fs.writeFileSync(file, `${started}\n${medium}\n${huge}\n`);
    assert.equal(readRollout(file).lastTask, 'started');
    fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', timestamp: '2026-10-08T00:10:00Z', payload: { type: 'task_complete', last_agent_message: 'Terminé' } })}\n`);
    const after = readRollout(file);
    assert.equal(after.lastTask, 'complete');
    assert.equal(after.lastAgent, 'Terminé');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installed app: only a Chats.lnk that launches an app id counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-startmenu-'));
  // A fake .lnk: binary header, then UTF-16LE strings at an odd byte offset.
  const lnk = (args) => Buffer.concat([Buffer.from([0x4c, 0, 0, 0, 1]), Buffer.from(args, 'utf16le')]);
  try {
    assert.equal(appShortcut(dir), null, 'nothing installed');
    fs.writeFileSync(path.join(dir, 'Chats.lnk'), lnk('"start-hidden.vbs" --boot'));
    assert.equal(appShortcut(dir), null, 'our own wscript shortcut is not the app');
    fs.mkdirSync(path.join(dir, 'Aplicaciones de Chrome'));
    fs.writeFileSync(path.join(dir, 'Aplicaciones de Chrome', 'Otra.lnk'), lnk('--profile-directory=Default --app-id=zzz'));
    assert.equal(appShortcut(dir), null, 'another app is ignored');
    const app = path.join(dir, 'Aplicaciones de Chrome', 'Chats.lnk');
    fs.writeFileSync(app, lnk('--profile-directory=Default --app-id=abcdefghijklmnopabcdefghijklmnop'));
    assert.equal(appShortcut(dir), app);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude: a normal quit (Ctrl+C or /exit) is closed, even mid-turn; a resumed chat clears it', () => {
  assert.equal(classifyClaude({ alive: false, lastKind: 'assistant-tool', cleanExit: true }), 'closed');
  assert.equal(classifyClaude({ alive: false, lastKind: 'assistant-text', bgAfterReply: true, cleanExit: true }), 'closed');
  assert.equal(classifyClaude({ alive: false, lastKind: 'assistant-tool', cleanExit: false }), 'cut', 'no exit mark: reboot or killed window');
  assert.equal(classifyClaude({ alive: true, status: 'busy', lastKind: 'assistant-tool', cleanExit: true }), 'working');
  const reply = { type: 'assistant', timestamp: '2026-10-08T14:08:27Z', message: { content: [{ type: 'text', text: 'Listo.' }] } };
  const quit = [{ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-08T14:08:27Z' }, { type: 'last-prompt' }, { type: 'cost-state', sessionId: 'x' }];
  assert.equal(parseClaudeTranscript('', lines(reply, ...quit)).cleanExit, true);
  const resumed = { type: 'user', timestamp: '2026-10-08T15:00:00Z', message: { content: 'sigamos' } };
  assert.equal(parseClaudeTranscript('', lines(reply, ...quit, resumed)).cleanExit, false);
  assert.equal(parseClaudeTranscript('', lines(reply)).cleanExit, false);
});

test('subagent watcher: only growth counts as background work, not a read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-bg-'));
  const file = path.join(dir, 'agent-a.jsonl');
  try {
    fs.writeFileSync(file, '{"a":1}\n');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    noteSubagentEvent('p/old', file);
    assert.equal(backgroundEventAt('p/old'), 0, 'an old file that was only touched');
    noteSubagentEvent('p/old', file);
    assert.equal(backgroundEventAt('p/old'), 0, 'same size again');
    fs.appendFileSync(file, '{"a":2}\n');
    fs.utimesSync(file, old, old); // Windows can keep a stale mtime while writing
    noteSubagentEvent('p/old', file, 5000);
    assert.equal(backgroundEventAt('p/old'), 5000, 'growth counts');
    const fresh = path.join(dir, 'agent-b.jsonl');
    fs.writeFileSync(fresh, '{"b":1}\n');
    noteSubagentEvent('p/new', fresh);
    assert.ok(backgroundEventAt('p/new') > 0, 'a file just written counts on its first event');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
