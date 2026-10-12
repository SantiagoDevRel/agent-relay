import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PromptRefiner, validatePromptSpec, REFINEMENT_TIMEOUT_MS } from '../server/prompt-refiner.mjs';

const request = { kind: 'mission', goal: 'Implement login and preserve existing reports.', acceptance: 'Reports remain accessible to their owners.', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
const answer = { status: 'ready', goal: 'Implement login, preserve reports, handle invalid sessions.', acceptance: 'Owners sign in and access their existing reports; other users cannot.', requirements: [{ id: 'R1', literal: 'Implement login', criterion: 'An owner signs in.' }, { id: 'R2', literal: 'preserve existing reports', criterion: 'Existing reports are preserved.' }], assumptions: [], questions: [], verification: ['Check owner and non-owner access with the existing integration suite.'] };
function fixture(runner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-spec-'));
  return { dir, refiner: new PromptRefiner({ file: path.join(dir, 'specs.json'), artifacts: path.join(dir, 'artifacts'), home: dir, runner }) };
}
test('refinement preserves literal goal and tester criteria, pins controls, and performs one read-only turn', async () => {
  let calls = 0;
  const f = fixture(async input => {
    calls++; assert.equal(input.role, 'planner'); assert.equal(input.model, request.model); assert.equal(input.effort, '');
    assert.match(fs.readFileSync(input.promptFile, 'utf8'), /No target project was supplied/);
    assert.match(fs.readFileSync(input.promptFile, 'utf8'), /Never replace a difficult requirement/);
    return { exitCode: 0, answer: JSON.stringify(answer), sessionHandle: 'codex-fixture' };
  });
  try {
    const result = await f.refiner.refine({ ...request, effort: '' });
    assert.equal(calls, 1); assert.equal(result.provider, request.provider); assert.equal(result.effort, '');
    assert.ok(result.spec.goal.includes(request.goal)); assert.ok(result.spec.goal.includes(request.acceptance)); assert.ok(result.spec.goal.includes(answer.verification[0]));
    assert.ok(result.spec.acceptance.includes(request.acceptance)); assert.deepEqual(f.refiner.records[0].original, { goal: request.goal, acceptance: request.acceptance });
    const restarted = new PromptRefiner({ file: f.refiner.file, artifacts: f.refiner.artifacts, runner: () => { throw Error('No inference on restart'); } });
    assert.equal(restarted.records[0].status, 'ready');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('unresolved questions stay explicit; invented literal requirements and contradictory state are rejected', () => {
  const source = { goal: request.goal, acceptance: request.acceptance };
  const result = validatePromptSpec({ ...answer, status: 'needs_input', questions: ['Which identity provider do owners use?'] }, source, 'relay');
  assert.equal(result.status, 'needs_input'); assert.equal(result.spec.questions.length, 1);
  assert.throws(() => validatePromptSpec({ ...answer, requirements: [{ id: 'R1', literal: 'Charge each owner monthly', criterion: 'Invoices exist.' }] }, source, 'mission'), /traceability/);
  assert.throws(() => validatePromptSpec({ ...answer, questions: ['Unknown decision'] }, source, 'mission'), /do not match/);
});
test('invalid inputs spend no turn; malformed output and interrupted refinements retain the original request', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { exitCode: 0, answer: 'not json' }; });
  try {
    await assert.rejects(f.refiner.refine({ ...request, effort: 'ultracode' }), /valid/); assert.equal(calls, 0);
    await assert.rejects(f.refiner.refine(request), /valid JSON/); assert.equal(calls, 1); assert.equal(f.refiner.records[0].status, 'attention'); assert.equal(f.refiner.busy, false);
    assert.equal(f.refiner.records[0].diagnostic.code, 'response-invalid'); assert.match(f.refiner.log(f.refiner.records[0].id).text, /valid JSON/);
    fs.writeFileSync(f.refiner.file, JSON.stringify([{ status: 'refining', original: request }]));
    const restarted = new PromptRefiner({ file: f.refiner.file, artifacts: f.refiner.artifacts, runner: async () => { calls++; } });
    assert.equal(restarted.records[0].status, 'attention'); assert.equal(calls, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('dirty repository can be read without changing HEAD, index, or user files; refinements are serialized', async () => {
  let release; const f = fixture(async input => { assert.equal(fs.readFileSync(path.join(input.cwd, 'README.md'), 'utf8'), 'user edits'); await new Promise(resolve => { release = resolve; }); return { exitCode: 0, answer: JSON.stringify(answer) }; });
  const project = path.join(f.dir, 'project'); fs.mkdirSync(project);
  const git = args => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(['init']); git(['config', 'user.name', 'Relay Tests']); git(['config', 'user.email', 'relay-tests@localhost']); fs.writeFileSync(path.join(project, 'README.md'), 'baseline'); git(['add', '--', 'README.md']); git(['commit', '-m', 'Initialize fixture']); fs.writeFileSync(path.join(project, 'README.md'), 'user edits');
    const head = git(['rev-parse', 'HEAD']), index = fs.readFileSync(path.join(project, '.git', 'index'));
    const pending = f.refiner.refine({ ...request, project });
    await assert.rejects(f.refiner.refine(request), /already/); release(); await pending;
    assert.equal(git(['rev-parse', 'HEAD']), head); assert.deepEqual(fs.readFileSync(path.join(project, '.git', 'index')), index); assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), 'user edits');
  } finally { release?.(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('refinement reads the selected nested folder and generates English prose while retaining literal input', async () => {
  let context;
  const f = fixture(async input => {
    assert.equal(input.cwd, context);
    const prompt = fs.readFileSync(input.promptFile, 'utf8');
    assert.ok(prompt.includes(`Selected project folder: ${JSON.stringify(context)}`));
    assert.match(prompt, /all generated prose in English/);
    assert.match(prompt, /preserve literal input excerpts/i);
    return { exitCode: 0, answer: JSON.stringify(answer) };
  });
  const project = path.join(f.dir, 'project'); context = path.join(project, 'MCP'); fs.mkdirSync(context, { recursive: true });
  try {
    execFileSync('git', ['init'], { cwd: project, windowsHide: true, stdio: 'ignore' });
    const result = await f.refiner.refine({ ...request, project: context });
    assert.ok(result.spec.goal.startsWith('Original request'));
    assert.equal(f.refiner.records[0].context, context); assert.equal(f.refiner.records[0].project, project);
    assert.ok(result.spec.goal.includes(request.goal));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('refinement keeps a bounded 15-minute deadline and exposes pending history without launching more turns', async () => {
  let release, calls = 0;
  const f = fixture(async input => {
    calls++; assert.equal(REFINEMENT_TIMEOUT_MS, 15 * 60000); assert.equal(input.timeoutMs, REFINEMENT_TIMEOUT_MS);
    input.onOutput('', 'metadata', { sessionHandle: 'claude-abcdef', nativeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    await new Promise(resolve => { release = resolve; });
    return { exitCode: 0, answer: JSON.stringify(answer), sessionHandle: 'claude-abcdef', nativeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  });
  try {
    const pending = f.refiner.refine({ ...request, provider: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    const history = f.refiner.history('mission'); assert.equal(history.total, 1); assert.equal(history.attempts[0].status, 'refining');
    assert.equal(f.refiner.records[0].sessionHandle, 'claude-abcdef'); assert.equal(f.refiner.records[0].nativeId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(f.refiner.history('relay').total, 0); assert.equal(calls, 1);
    release(); const result = await pending; assert.equal(f.refiner.history('mission').attempts[0].id, result.id);
    assert.equal(f.refiner.history('mission').attempts[0].status, 'ready'); assert.equal(calls, 1);
  } finally { release?.(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('timeout, cancellation, exit error and missing answer preserve one attempt with retrievable diagnostics', async () => {
  for (const [failure, code] of [
    [{ exitCode: 1, answer: '', timedOut: true }, 'timeout'],
    [{ exitCode: 0, answer: JSON.stringify(answer), timedOut: true }, 'timeout'],
    [{ exitCode: 1, answer: '', aborted: true }, 'canceled'],
    [{ exitCode: 0, answer: JSON.stringify(answer), aborted: true }, 'canceled'],
    [{ exitCode: 4, answer: '', error: 'Fixture provider rejected the request.' }, 'provider-failed'],
    [{ exitCode: 0, answer: '' }, 'empty-answer'],
  ]) {
    let calls = 0;
    const f = fixture(async input => {
      calls++; fs.writeFileSync(input.outputFile, 'Provider fixture output\n'); return failure;
    });
    try {
      let error; try { await f.refiner.refine(request); } catch (value) { error = value; }
      assert.match(error.refinementId, /^[a-f0-9-]{36}$/); assert.equal(calls, 1); assert.equal(f.refiner.busy, false);
      const history = f.refiner.history('mission'); assert.equal(history.attempts[0].id, error.refinementId);
      assert.equal(history.attempts[0].diagnostic.code, code); assert.equal(history.attempts[0].diagnostic.exitCode, failure.exitCode);
      const log = f.refiner.log(error.refinementId); assert.match(log.text, /Provider fixture output/);
      assert.ok(log.text.includes(log.diagnostic.reason)); assert.equal(log.diagnostic.code, code);
      assert.deepEqual(log.original, { goal: request.goal, acceptance: request.acceptance });
      assert.equal(JSON.stringify(history).includes(request.goal), false); assert.equal(JSON.stringify(history).includes('promptFile'), false);
      assert.equal(f.refiner.history('mission').total, 1); assert.equal(calls, 1);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('historical output remains readable after restart without invented timeout evidence or inference', () => {
  const f = fixture(() => { throw Error('No inference from history'); });
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', directory = path.join(f.refiner.artifacts, id);
  try {
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'spec-output.txt'), 'AI_RELAY_SESSION {"sessionHandle":"claude-abcdef","nativeId":null}\n');
    fs.writeFileSync(f.refiner.file, JSON.stringify([{ id, kind: 'mission', status: 'attention', provider: 'claude', model: 'claude-opus-5-5', effort: 'max', createdAt: 123, original: request }]));
    const before = fs.readFileSync(f.refiner.file);
    const restarted = new PromptRefiner({ file: f.refiner.file, artifacts: f.refiner.artifacts, runner: () => { throw Error('No inference'); } });
    assert.equal(restarted.history('mission').attempts[0].id, id); const result = restarted.log(id);
    assert.match(result.text, /AI_RELAY_SESSION/); assert.match(result.diagnostic.reason, /No exit diagnostics saved/);
    assert.equal(result.diagnostic.timedOut, undefined); assert.equal(result.diagnostic.exitCode, undefined);
    assert.deepEqual(fs.readFileSync(f.refiner.file), before);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('owned refinement log rejects unknown UUIDs and linked files or directories and bounds plain text', async () => {
  const f = fixture(async input => { fs.writeFileSync(input.outputFile, '\u001b[31m'+ 'x'.repeat(200000) +'\u001b[0m\n'); return { exitCode: 0, answer: JSON.stringify(answer) }; });
  try {
    const result = await f.refiner.refine(request), log = f.refiner.log(result.id);
    assert.equal(log.truncated, true); assert.ok(log.text.length <= 131072); assert.equal(log.text.includes('\u001b'), false);
    assert.throws(() => f.refiner.log('../file'), { status: 404 }); assert.throws(() => f.refiner.log('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), { status: 404 });
    assert.throws(() => f.refiner.history('anything'), { status: 400 });
    const record = f.refiner.records[0], directory = path.join(f.refiner.artifacts, result.id), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
    fs.renameSync(directory, directory+'-owned'); fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(outside, 'spec-output.txt'), 'Do not expose this content.');
    assert.throws(() => f.refiner.log(record.id), { status: 409 });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('history reports total and returns its latest 100 attempts without prompts or file paths', () => {
  const f = fixture(() => { throw Error('No inference from history'); });
  try {
    f.refiner.records = Array.from({ length: 105 }, (_, index) => ({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`, kind: 'mission', status: 'attention', provider: 'claude', model: 'claude-opus-5-5', effort: 'max', createdAt: index, original: request, outputFile: 'Do not expose this path' }));
    const history = f.refiner.history('mission'); assert.equal(history.total, 105); assert.equal(history.attempts.length, 100); assert.equal(history.attempts[0].createdAt, 104); assert.equal(history.attempts.at(-1).createdAt, 5);
    assert.equal(JSON.stringify(history).includes(request.goal), false); assert.equal(JSON.stringify(history).includes('outputFile'), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

function nativeFailure(f, { diagnostic, prompt = 'Complete saved specification with a unique fixture boundary.' } = {}) {
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nativeId = randomUUID();
  const context = path.join(f.dir, 'project'), createdAt = Date.now(), directory = path.join(f.refiner.artifacts, id);
  const nativeDirectory = path.join(f.dir, '.claude', 'projects', context.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'spec-prompt.md'), prompt);
  fs.writeFileSync(path.join(directory, 'spec-output.txt'), 'AI_RELAY_SESSION {"sessionHandle":"claude-abcdef","nativeId":null}\n');
  const record = { id, kind: 'mission', status: 'attention', provider: 'claude', model: 'claude-opus-5-5', effort: 'max', createdAt, context, sessionHandle: 'claude-abcdef', original: { goal: request.goal, acceptance: request.acceptance }, ...(diagnostic ? { diagnostic } : {}) };
  f.refiner.records.push(record); f.refiner.save();
  const user = { type: 'user', cwd: context, sessionId: nativeId, timestamp: new Date(createdAt + 3000).toISOString(), message: { content: '# === Reglas activas: fixture/AGENTS.md ===\nExisting rules\n\n---\n\n' + prompt } };
  const error = { type: 'system', subtype: 'api_error', cwd: context, sessionId: nativeId, timestamp: new Date(createdAt + 200000).toISOString(), error: { message: 'Connection error.', formatted: 'Never expose arbitrary diagnostic fields or credentials.' } };
  const file = path.join(nativeDirectory, nativeId + '.jsonl');
  const write = (events, target = file) => fs.writeFileSync(target, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  write([user, error]); return { record, user, error, file, nativeDirectory, directory, write, nativeId };
}

test('historical Claude connection failures recover exact native evidence without changing records or running inference', () => {
  const f = fixture(() => { throw Error('No provider invocation'); });
  try {
    const source = nativeFailure(f), before = fs.readFileSync(f.refiner.file), transcript = fs.readFileSync(source.file);
    const restarted = new PromptRefiner({ file: f.refiner.file, artifacts: f.refiner.artifacts, home: f.dir, runner: () => { throw Error('No provider invocation'); } });
    const history = restarted.history('mission'), log = restarted.log(source.record.id);
    assert.equal(log.diagnostic.code, 'provider-api-error'); assert.equal(log.diagnostic.source, 'claude-native');
    assert.match(log.text, /Claude reported: Connection error\./); assert.equal(log.diagnostic.nativeId, source.nativeId);
    assert.equal(log.diagnostic.timestamp, source.error.timestamp); assert.equal(log.diagnostic.exitCode, undefined); assert.equal(log.diagnostic.timedOut, undefined);
    assert.deepEqual(history.attempts[0].diagnostic, log.diagnostic); assert.deepEqual(log.original, source.record.original);
    assert.equal(JSON.stringify(history).includes(request.goal), false); assert.equal(JSON.stringify(history).includes(source.file), false);
    assert.deepEqual(fs.readFileSync(f.refiner.file), before); assert.deepEqual(fs.readFileSync(source.file), transcript);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('native evidence rejects original-only matches, wrong context/time, ambiguous sessions and later answers', () => {
  for (const variant of ['original-only', 'context', 'time', 'ambiguous', 'ambiguous-completed', 'answered', 'sidechain', 'later-user', 'oversized', 'linked-native', 'linked-prompt', 'no-start', 'corrupt']) {
    const f = fixture(() => { throw Error('No provider invocation'); });
    try {
      const s = nativeFailure(f);
      if (variant === 'original-only') s.user.message.content = request.goal;
      if (variant === 'context') s.user.cwd = path.join(f.dir, 'another-project');
      if (variant === 'time') s.user.timestamp = new Date(s.record.createdAt - 600000).toISOString();
      if (variant === 'sidechain') s.user.isSidechain = true;
      if (variant === 'no-start') delete s.record.sessionHandle;
      const events = [s.user, s.error];
      if (variant === 'answered') events.push({ type: 'assistant', timestamp: s.error.timestamp, message: { content: 'A later answer means the earlier transport error is not the final result.' } });
      if (variant === 'later-user') events.push({ ...s.user, timestamp: new Date(s.record.createdAt + 400000).toISOString(), message: { content: 'A separate later request.' } });
      s.write(events);
      if (variant === 'ambiguous' || variant === 'ambiguous-completed') {
        const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const second = events.map(event => ({ ...event, sessionId: other }));
        if (variant === 'ambiguous-completed') second.push({ type: 'assistant', sessionId: other, message: { content: 'An answer in the identical concurrent session.' } });
        s.write(second, path.join(s.nativeDirectory, other + '.jsonl'));
      }
      if (variant === 'oversized') fs.appendFileSync(s.file, 'x'.repeat(1100000));
      if (variant === 'corrupt') fs.appendFileSync(s.file, 'An incomplete native event');
      if (variant === 'linked-native') {
        fs.renameSync(s.nativeDirectory, s.nativeDirectory + '-owned');
        fs.symlinkSync(s.nativeDirectory + '-owned', s.nativeDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (variant === 'linked-prompt') {
        fs.renameSync(s.directory, s.directory + '-owned');
        fs.symlinkSync(s.directory + '-owned', s.directory, process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal(f.refiner.history('mission').attempts[0].diagnostic.code, 'unknown');
        assert.throws(() => f.refiner.log(s.record.id), { status: 409 }); continue;
      }
      assert.equal(f.refiner.log(s.record.id).diagnostic.code, 'unknown', variant);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('cached native matches invalidate when an answer arrives or another matching session appears', () => {
  for (const variant of ['answer', 'duplicate']) {
    const f = fixture(() => { throw Error('No provider invocation'); });
    try {
      const s = nativeFailure(f);
      assert.equal(f.refiner.log(s.record.id).diagnostic.code, 'provider-api-error');
      if (variant === 'answer') s.write([s.user, s.error, { type: 'assistant', sessionId: s.nativeId, message: { content: 'Later completed answer.' } }]);
      else {
        const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        s.write([s.user, s.error].map(event => ({ ...event, sessionId: other })), path.join(s.nativeDirectory, other + '.jsonl'));
      }
      assert.equal(f.refiner.log(s.record.id).diagnostic.code, 'unknown', variant);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('new failed turns retain wrapper diagnostics and recover native errors in the saved log without retries', async () => {
  let calls = 0, f;
  f = fixture(async input => {
    calls++;
    const record = f.refiner.records[0], nativeId = randomUUID();
    const directory = path.join(f.dir, '.claude', 'projects', input.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, nativeId + '.jsonl'), [
      { type: 'user', cwd: input.cwd, sessionId: nativeId, timestamp: new Date(record.createdAt).toISOString(), message: { content: fs.readFileSync(input.promptFile, 'utf8') } },
      { type: 'system', subtype: 'api_error', cwd: input.cwd, sessionId: nativeId, timestamp: new Date(record.createdAt + 1).toISOString(), error: { message: 'Connection error.' } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    input.onOutput('', 'metadata', { sessionHandle: 'claude-abcdef', nativeId });
    return { exitCode: 1, answer: '', timedOut: true };
  });
  try {
    await assert.rejects(f.refiner.refine({ ...request, provider: 'claude', model: 'claude-opus-5-5', effort: 'max' }), /Connection error/);
    const record = f.refiner.records[0], log = f.refiner.log(record.id);
    assert.equal(calls, 1); assert.equal(record.diagnostic.code, 'timeout'); assert.equal(record.diagnostic.timedOut, true); assert.equal(record.diagnostic.exitCode, 1);
    assert.match(log.text, /15-minute operation limit/); assert.match(log.text, /Connection error/);
    assert.equal(log.diagnostic.source, 'claude-native'); assert.match(fs.readFileSync(path.join(f.refiner.artifacts, record.id, 'spec-output.txt'), 'utf8'), /Connection error/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('native transport evidence cannot override a completed response or an authoritative provider exit', () => {
  for (const code of ['completed', 'response-invalid', 'provider-failed']) {
    const f = fixture(() => { throw Error('No provider invocation'); });
    try {
      const diagnostic = { code, exitCode: code === 'provider-failed' ? 4 : 0, reason: 'Authoritative captured result.' };
      const s = nativeFailure(f, { diagnostic });
      assert.deepEqual(f.refiner.log(s.record.id).diagnostic, diagnostic); assert.equal(f.refiner.log(s.record.id).text.includes('Connection error'), false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});
