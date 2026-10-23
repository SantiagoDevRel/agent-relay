// Relay Evals spec judge (E5): heuristic ordering with mutation checks, model
// response parsing, the injected model runner, the labeling kit, label CSV
// parsing and calibration status. Synthetic text and isolated temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../evals/schema.mjs';
import { openStore } from '../evals/store.mjs';
import {
  RUBRIC, HEURISTICS, scoreSpec, judgePrompt, parseJudgeResponse, runModelJudge, buildLabelingKit,
  readKitItems, readLabels, judgeStatus, chooseJudge, taskCorrelation, problemOutcome,
} from '../evals/judge.mjs';

const SPECS = JSON.parse(fs.readFileSync(new URL('./fixtures/evals/judge/specs.json', import.meta.url), 'utf8'));
const sample = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/evals/${name}.sample.json`, import.meta.url), 'utf8'));
// Closers (open stores) run before the temporary folder is removed.
const tempDir = (t, closers = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-judge-'));
  t.after(() => { for (const close of closers) close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
};

// ---------- Heuristic ordering (and the guard the mutation tests rely on) ----------

function assertOrdering(scorer, criterion) {
  for (const strong of SPECS.strong) for (const vague of SPECS.vague) {
    const a = scorer(strong).scores[criterion], b = scorer(vague).scores[criterion];
    assert.ok(a > b, `${criterion}: strong spec (${a}) must score above vague spec (${b})`);
  }
  const focused = scorer(SPECS.only[criterion]).scores[criterion];
  for (const vague of SPECS.vague) assert.ok(focused > scorer(vague).scores[criterion], `${criterion}: focused spec must beat vague spec`);
}

for (const criterion of RUBRIC.ids) {
  test(`scoreSpec ranks a strong spec above a vague one on ${criterion}`, () => assertOrdering(scoreSpec, criterion));

  test(`mutation: a ${criterion} heuristic stuck at 0 breaks its ordering test`, () => {
    const mutated = { ...HEURISTICS, [criterion]: () => ({ score: 0, signals: [] }) };
    assert.throws(() => assertOrdering(prompt => scoreSpec(prompt, { heuristics: mutated }), criterion), assert.AssertionError);
    // The other criteria stay unaffected by this mutation.
    for (const other of RUBRIC.ids.filter(id => id !== criterion)) assertOrdering(prompt => scoreSpec(prompt, { heuristics: mutated }), other);
  });
}

test('scoreSpec is robust to empty, short and non-string input and reports signals', () => {
  for (const input of ['', '   ', 'ok', null, undefined, 42]) {
    const result = scoreSpec(input);
    assert.deepEqual(result.scores, { literal: 0, acceptance: 0, scope: 0, verification: 0 });
    assert.equal(result.total, 0);
  }
  const strong = scoreSpec(SPECS.strong[1]);
  assert.equal(strong.total, RUBRIC.ids.reduce((sum, id) => sum + strong.scores[id], 0));
  assert.ok(strong.signals.includes('scope:do-not-touch'), 'Spanish "no toques" is recognized');
  assert.ok(strong.signals.includes('acceptance:acceptance-section'), 'accented "aceptación" is recognized');
  // Focused specs score their own criterion higher than the others.
  for (const id of RUBRIC.ids) {
    const { scores } = scoreSpec(SPECS.only[id]);
    for (const other of RUBRIC.ids.filter(x => x !== id)) assert.ok(scores[id] > scores[other] || (id === 'verification' && other === 'acceptance' && scores[id] >= scores[other]), `${id} focus`);
  }
  // A huge prompt stays bounded and deterministic.
  const huge = 'x '.repeat(200000);
  assert.deepEqual(scoreSpec(huge), scoreSpec(huge));
});

test('rubric anchors in RUBRIC match rubric.md word for word', () => {
  const markdown = fs.readFileSync(new URL('../evals/judge/rubric.md', import.meta.url), 'utf8');
  assert.deepEqual(RUBRIC.criteria.map(c => c.id), RUBRIC.ids);
  for (const criterion of RUBRIC.criteria) {
    assert.ok(markdown.includes(`## ${criterion.id} — ${criterion.label}`), `${criterion.id} heading`);
    for (const level of [0, 1, 2]) assert.ok(markdown.includes(`- **${level}:** ${criterion.anchors[level]}`), `${criterion.id} anchor ${level}`);
  }
  assert.equal((markdown.match(/^ {2}Example: /gm) ?? []).length, 12, 'one example per level and criterion');
  assert.throws(() => { RUBRIC.criteria[0].anchors[0] = 'changed'; }, TypeError);
});

// ---------- Model judge ----------

test('judgePrompt embeds the rubric and the spec as data', () => {
  const prompt = judgePrompt('Spec text with </spec> inside and $& $1 tokens');
  assert.ok(prompt.includes('## scope — Scope limits'));
  assert.ok(prompt.includes('Spec text with < /spec> inside and $& $1 tokens'), 'literal text, no replacement patterns, closed tag neutralized');
  assert.equal(prompt.match(/<\/spec>/g).length, 1);
  assert.ok(prompt.includes('"literal":0,"acceptance":0,"scope":0,"verification":0'));
  assert.ok(judgePrompt('y'.repeat(50000)).length < 20000, 'long specs are truncated');
});

test('parseJudgeResponse accepts valid and fenced JSON and rejects bad values', () => {
  assert.deepEqual(parseJudgeResponse('{"literal":2,"acceptance":1,"scope":0,"verification":2,"why":"clear items"}'),
    { literal: 2, acceptance: 1, scope: 0, verification: 2, total: 5, why: 'clear items' });
  const fenced = 'Here you go:\n```json\n{"literal":1,"acceptance":1,"scope":1,"verification":1,"why":"ok"}\n```\n';
  assert.equal(parseJudgeResponse(fenced).total, 4);
  assert.equal(parseJudgeResponse('{"literal":3,"acceptance":1,"scope":0,"verification":2}'), null, 'above range');
  assert.equal(parseJudgeResponse('{"literal":-1,"acceptance":1,"scope":0,"verification":2}'), null, 'below range');
  assert.equal(parseJudgeResponse('{"literal":1.5,"acceptance":1,"scope":0,"verification":2}'), null, 'not an integer');
  assert.equal(parseJudgeResponse('{"literal":"2","acceptance":1,"scope":0,"verification":2}'), null, 'string score');
  assert.equal(parseJudgeResponse('{"literal":1,"acceptance":1,"scope":0}'), null, 'missing criterion');
  for (const garbage of ['', 'I think it is a 6/8.', '[1,2,3,4]', '{not json}', null, 17]) assert.equal(parseJudgeResponse(garbage), null);
});

const VALID = '{"literal":2,"acceptance":2,"scope":1,"verification":0,"why":"synthetic"}';
const ITEMS = [1, 2, 3, 4].map(i => ({ id: `J00${i}`, chatId: `claude:chat-${i}`, prompt: `Synthetic spec number ${i}.` }));

test('runModelJudge scores items sequentially through the injected complete()', async () => {
  let active = 0, peak = 0;
  const prompts = [];
  const complete = async (prompt, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    active++; peak = Math.max(peak, active); prompts.push(prompt);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return prompt.includes('number 3') ? 'not json at all' : VALID;
  };
  const { status, results } = await runModelJudge({ items: ITEMS, complete, timeoutMs: 1000 });
  assert.equal(status, 'ok');
  assert.equal(peak, 1, 'one request at a time');
  assert.equal(prompts.length, 4);
  assert.ok(prompts[1].includes('Synthetic spec number 2.'));
  assert.deepEqual(results.map(r => r.status), ['ok', 'ok', 'invalid', 'ok'], 'unparseable output does not stop the run');
  assert.deepEqual(results[0].scores, { literal: 2, acceptance: 2, scope: 1, verification: 0 });
  assert.equal(results[0].total, 5);
  assert.equal(results[0].chatId, 'claude:chat-1');
});

test('runModelJudge stops at a timeout and marks the rest missing', async () => {
  let calls = 0, sawAbort = false;
  const complete = (_, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); })); };
  const { status, results } = await runModelJudge({ items: ITEMS, complete, timeoutMs: 30 });
  assert.equal(status, 'missing');
  assert.equal(calls, 1);
  assert.ok(sawAbort, 'the timed-out request is aborted');
  assert.deepEqual(results.map(r => [r.status, r.reason]), [['missing', 'timeout'], ['missing', 'not-run'], ['missing', 'not-run'], ['missing', 'not-run']]);
});

test('runModelJudge stops at the first transport failure', async () => {
  let calls = 0;
  const complete = async () => { calls++; if (calls === 2) throw new Error('connection refused'); return VALID; };
  const { status, results } = await runModelJudge({ items: ITEMS, complete, timeoutMs: 1000 });
  assert.equal(status, 'missing');
  assert.equal(calls, 2);
  assert.deepEqual(results.map(r => r.status), ['ok', 'missing', 'missing', 'missing']);
  assert.equal(results[1].reason, 'transport');
  assert.ok(results.slice(1).every(r => r.scores === null && r.total === null));

  const controller = new AbortController(); controller.abort();
  const aborted = await runModelJudge({ items: ITEMS, complete: async () => VALID, signal: controller.signal });
  assert.equal(aborted.status, 'missing');
  assert.ok(aborted.results.every(r => r.reason === 'aborted'));
});

// ---------- Labeling kit ----------

const PROVIDERS = ['claude', 'codex'];
const TYPES = ['feature', 'bugfix', 'docs'];
const LENGTHS = { short: 120, medium: 600, long: 1500 };

function seedStore(home, { perStratum = 4 } = {}) {
  const store = openStore({ home }), base = sample('chat-record'), metricsBase = sample('chat-metrics');
  let k = 0;
  const save = ({ provider, taskType, text, automated = false }) => {
    const sessionId = `synthetic-${String(++k).padStart(4, '0')}`, id = `${provider}:${sessionId}`;
    const startedAt = new Date(Date.UTC(2026, 8, 1) + k * 60000).toISOString();
    store.saveChat({ ...base, id, provider, sessionId, startedAt, automated,
      userMessages: [{ turn: 0, at: startedAt, kind: 'prompt', text, chars: text.length }, base.userMessages[1]] });
    if (taskType) store.saveMetrics({ ...metricsBase, id, provider, startedAt, automated, taskType });
    return id;
  };
  for (const provider of PROVIDERS) for (const taskType of TYPES) for (const [bucket, length] of Object.entries(LENGTHS))
    for (let i = 0; i < perStratum; i++) {
      const head = `Synthetic ${bucket} ${taskType} spec ${i} for ${provider}: update the demo widget as described. `;
      save({ provider, taskType, text: (head + 'Details follow. '.repeat(200)).slice(0, length) });
    }
  return { store, save };
}

test('buildLabelingKit writes a stratified, deduplicated, redacted kit and never overwrites', async t => {
  const closers = [], dir = tempDir(t, closers), { store, save } = seedStore(path.join(dir, 'home'));
  closers.push(() => store.close());
  const duplicate = 'Synthetic duplicated request: please rename the demo widget and keep its tests green, thanks a lot!!';
  const first = save({ provider: 'claude', taskType: 'feature', text: duplicate });
  const second = save({ provider: 'codex', taskType: 'feature', text: `  ${duplicate.toUpperCase()}  ` });
  const automated = save({ provider: 'claude', taskType: 'feature', automated: true, text: 'Synthetic automated lane brief that is long enough to qualify by length alone, yes indeed.' });
  const tooShort = save({ provider: 'claude', taskType: 'feature', text: 'Synthetic short ask.' });
  const marker = '[REDACTED:api-key]';
  const secret = save({ provider: 'codex', taskType: 'docs', text: `Synthetic docs task: call the API with FAKE-SECRET-123 and ${marker}. ` + 'Pad '.repeat(900) });
  const redact = text => ({ text: text.replaceAll('FAKE-SECRET-123', '[REDACTED:token]'), count: 1 });

  const outDir = path.join(dir, 'labeling', '2026-10-22');
  const { dir: kitDir, items } = await buildLabelingKit({ store, outDir, n: 36, redact });
  assert.equal(kitDir, path.resolve(outDir));
  assert.equal(items.length, 36, 'exactly n items when enough exist');
  const strata = new Set(items.map(item => item.stratum));
  assert.equal(strata.size, PROVIDERS.length * TYPES.length * Object.keys(LENGTHS).length, 'every provider × taskType × length stratum is covered');
  const chatIds = items.map(item => item.chatId);
  assert.equal(new Set(chatIds).size, 36);
  assert.ok(!chatIds.includes(automated) && !chatIds.includes(tooShort), 'automated and short prompts are excluded');
  assert.ok(!(chatIds.includes(first) && chatIds.includes(second)), 'duplicate texts appear once');
  assert.ok(items.every(item => item.prompt.length <= 3000 && /^J\d{3}$/.test(item.id)));
  assert.equal(new Set(items.map(item => item.id)).size, 36);

  assert.deepEqual(fs.readdirSync(kitDir).sort(), ['README.md', 'items.jsonl', 'items.md', 'labels.csv', 'rubric.md']);
  assert.deepEqual(readKitItems(kitDir), items.map(({ id, chatId, prompt }) => ({ id, chatId, prompt })));
  const csv = fs.readFileSync(path.join(kitDir, 'labels.csv'), 'utf8').replace(/^﻿/, '').split('\r\n');
  assert.equal(csv[0], 'id,literal,acceptance,scope,verification,notes');
  assert.deepEqual(csv.slice(1, -1), items.map(item => `${item.id},,,,,`));
  assert.equal(fs.readFileSync(path.join(kitDir, 'rubric.md'), 'utf8'), fs.readFileSync(new URL('../evals/judge/rubric.md', import.meta.url), 'utf8'));
  const readme = fs.readFileSync(path.join(kitDir, 'README.md'), 'utf8');
  assert.equal(readme.split('\n').filter(line => /^\d\. /.test(line)).length, 5);
  assert.match(readme, /Read `rubric\.md`/);
  assert.equal(readLabels(path.join(kitDir, 'labels.csv')).size, 36, 'the empty kit CSV parses');
  assert.equal(judgeStatus({ labels: readLabels(path.join(kitDir, 'labels.csv')) }).labeled, 0);

  // n larger than the pool: every eligible deduplicated chat, with redaction applied and markers intact.
  const all = await buildLabelingKit({ store, outDir: path.join(dir, 'labeling', 'all'), n: 1000, redact });
  assert.equal(all.items.length, 72 + 1 + 1, '72 seeded + one of the duplicates + the docs task');
  const docs = all.items.find(item => item.chatId === secret);
  assert.ok(docs.prompt.includes(marker) && docs.prompt.includes('[REDACTED:token]') && !docs.prompt.includes('FAKE-SECRET-123'));
  assert.ok(!fs.readFileSync(path.join(all.dir, 'items.jsonl'), 'utf8').includes('FAKE-SECRET-123'));
  assert.ok(docs.prompt.length <= 3000 && docs.prompt.endsWith('…'));

  // Same seed and store, same sample.
  const again = await buildLabelingKit({ store, outDir: path.join(dir, 'labeling', 'again'), n: 36, redact });
  assert.deepEqual(again.items, items);

  const before = fs.readFileSync(path.join(kitDir, 'labels.csv'));
  await assert.rejects(buildLabelingKit({ store, outDir, n: 36, redact }), /already exists/);
  assert.deepEqual(fs.readFileSync(path.join(kitDir, 'labels.csv')), before, 'existing kit untouched');
  const empty = path.join(dir, 'labeling', 'empty-existing'); fs.mkdirSync(empty);
  await assert.rejects(buildLabelingKit({ store, outDir: empty, redact }), /already exists/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'labeling')).sort(), ['2026-10-22', 'again', 'all', 'empty-existing'], 'no temporary folders left');
});

test('buildLabelingKit cuts long prompts without splitting a redaction marker', async t => {
  const closers = [], dir = tempDir(t, closers), store = openStore({ home: path.join(dir, 'home') });
  closers.push(() => store.close());
  const base = sample('chat-record');
  const text = 'S'.repeat(2990) + '[REDACTED:private-key] tail';
  store.saveChat({ ...base, userMessages: [{ turn: 0, at: base.startedAt, kind: 'prompt', text, chars: text.length }] });
  const { items } = await buildLabelingKit({ store, outDir: path.join(dir, 'kit'), n: 5, redact: null });
  assert.equal(items.length, 1);
  assert.equal(items[0].prompt, `${'S'.repeat(2990)}…`);
  assert.ok(items[0].stratum.endsWith('|unknown|long'), 'missing metrics give an unknown task type');
});

test('buildLabelingKit keeps a rare stratum that proportional allocation alone would skip', async t => {
  const closers = [], dir = tempDir(t, closers), { store, save } = seedStore(path.join(dir, 'home'));
  closers.push(() => store.close());
  const rare = save({ provider: 'codex', taskType: 'design', text: 'Synthetic rare design request: sketch three layout options for the demo widget header, please.' });
  const { items } = await buildLabelingKit({ store, outDir: path.join(dir, 'kit'), n: 19, redact: null });
  assert.equal(items.length, 19);
  assert.equal(new Set(items.map(item => item.stratum)).size, 19, 'one item from each of the 19 strata');
  assert.ok(items.some(item => item.chatId === rare));
});

// ---------- Labels CSV ----------

test('readLabels parses RFC 4180 quoting, blank rows and partial rows', t => {
  const dir = tempDir(t), file = path.join(dir, 'labels.csv');
  fs.writeFileSync(file, '﻿id,literal,acceptance,scope,verification,notes\r\n'
    + 'J001,2,1,0,2,"clear, but no ""scope"" at all\nsecond line"\r\n'
    + ',,,,,\r\n\r\n'
    + 'J002,1,,1,1,\r\n'
    + 'J003, 0 ,0,0,0,plain\r\n');
  const labels = readLabels(file);
  assert.deepEqual([...labels.keys()], ['J001', 'J002', 'J003']);
  assert.deepEqual(labels.get('J001'), { literal: 2, acceptance: 1, scope: 0, verification: 2, total: 5 });
  assert.deepEqual(labels.get('J002'), { literal: 1, acceptance: null, scope: 1, verification: 1, total: null });
  assert.equal(labels.get('J003').total, 0);

  const semicolon = path.join(dir, 'semicolon.csv');
  fs.writeFileSync(semicolon, 'id;literal;acceptance;scope;verification;notes\nJ001;2;2;1;1;"uno; dos"\n');
  assert.equal(readLabels(semicolon).get('J001').total, 6);
});

test('readLabels rejects invalid values naming the row without echoing content', t => {
  const dir = tempDir(t), file = path.join(dir, 'labels.csv');
  fs.writeFileSync(file, 'id,literal,acceptance,scope,verification,notes\nJ001,2,2,2,2,"private note\nwith a newline"\nJ002,1,7,1,1,private-note-text\n');
  assert.throws(() => readLabels(file), error => {
    assert.match(error.message, /row 4: acceptance must be 0, 1 or 2/);
    assert.ok(!error.message.includes('private') && !error.message.includes('7'), 'no cell content in the error');
    return true;
  });
  fs.writeFileSync(file, 'id,literal,acceptance,scope,verification,notes\nJ001,2,2,2,2,\nJ001,1,1,1,1,\n');
  assert.throws(() => readLabels(file), /row 3: repeated id/);
  fs.writeFileSync(file, 'id,literal,notes\nJ001,2,\n');
  assert.throws(() => readLabels(file), /header must include/);
  fs.writeFileSync(file, 'id,literal,acceptance,scope,verification,notes\nJ001,2,2,2,2,"open\n');
  assert.throws(() => readLabels(file), /row 2: a quoted field is not closed/);
});

// ---------- Calibration ----------

// 100 kit items; the judge total equals the label total, spread over 0-8.
const N = 100;
const kitScores = () => Array.from({ length: N }, (_, i) => ({ id: `J${String(i + 1).padStart(3, '0')}`, chatId: `claude:chat-${i}`, total: i % 9 }));
const labelsFrom = scores => new Map(scores.map(({ id, total }) => {
  const parts = [Math.min(2, total), Math.min(2, Math.max(0, total - 2)), Math.min(2, Math.max(0, total - 4)), Math.max(0, total - 6)];
  return [id, { literal: parts[0], acceptance: parts[1], scope: parts[2], verification: parts[3], total }];
}));
const metricsFor = (chatId, problem) => ({ id: chatId, automated: false, corrections: { count: problem ? 1 : 0 }, falseDone: { count: 0 }, commitsFixedOrReverted72h: 0 });
const assertSchemaValid = judge => assert.deepEqual(validate('report', { ...sample('report'), judge }), []);

test('judgeStatus without labels is not calibrated and says what is missing', () => {
  const judge = judgeStatus({ labels: new Map(), judgeScores: [], outcomes: [] });
  assert.equal(judge.status, 'not-calibrated');
  assert.equal(judge.labeled, 0);
  assert.equal(judge.kappa, null);
  assert.equal(judge.correlation, null);
  assert.match(judge.note, /^Needs 100 labels from the owner: 0 labeled so far\./);
  assertSchemaValid(judge);
  assert.match(judgeStatus({}).note, /^Needs 100 labels from the owner: 0 labeled so far\./);
});

test('judgeStatus is calibrated with agreeing labels and correlating outcomes', () => {
  const scores = kitScores();
  const outcomes = scores.map(s => metricsFor(s.chatId, s.total <= 3));
  const judge = judgeStatus({ labels: labelsFrom(scores), judgeScores: scores, outcomes });
  assert.equal(judge.status, 'calibrated', judge.note);
  assert.equal(judge.labeled, N);
  assert.equal(judge.kappa, 1);
  assert.equal(judge.correlation.n, N);
  assert.ok(judge.correlation.r < 0 && judge.correlation.ci95[1] < 0);
  assert.equal(judge.correlation.outcome, 'chat had a correction, broken done or 72 h fix');
  assert.match(judge.note, /^Calibrated: kappa 1 on 100 labels/);
  assertSchemaValid(judge);

  // Below the label minimum the same evidence is not enough.
  const few = new Map([...labelsFrom(scores)].slice(0, 79));
  const partial = judgeStatus({ labels: few, judgeScores: scores, outcomes });
  assert.equal(partial.status, 'not-calibrated');
  assert.match(partial.note, /Needs 100 labels from the owner: 79 labeled so far\./);
  // Low agreement blocks calibration.
  const shifted = scores.map(s => ({ ...s, total: 8 - s.total }));
  const disagree = judgeStatus({ labels: labelsFrom(scores), judgeScores: shifted, outcomes: shifted.map(s => metricsFor(s.chatId, s.total <= 3)) });
  assert.equal(disagree.status, 'not-calibrated');
  assert.match(disagree.note, /kappa -?\d.*needs 0\.6/);
});

test('judgeStatus agreement without correlation is not calibrated', () => {
  const scores = kitScores();
  // Every score level has the same problem rate: no relation to outcomes.
  const outcomes = scores.map((s, i) => metricsFor(s.chatId, Math.floor(i / 9) % 2 === 0));
  const judge = judgeStatus({ labels: labelsFrom(scores), judgeScores: scores, outcomes });
  assert.equal(judge.kappa, 1);
  assert.equal(judge.status, 'not-calibrated');
  assert.ok(judge.correlation && judge.correlation.ci95[0] <= 0 && judge.correlation.ci95[1] >= 0);
  assert.match(judge.note, /does not yet predict problems/);
  assertSchemaValid(judge);

  // A significant correlation in the wrong direction is not calibration either.
  const backwards = judgeStatus({ labels: labelsFrom(scores), judgeScores: scores, outcomes: scores.map(s => metricsFor(s.chatId, s.total >= 5)) });
  assert.equal(backwards.status, 'not-calibrated');
  assert.match(backwards.note, /more problems/);
  // Too few outcomes.
  const sparse = judgeStatus({ labels: labelsFrom(scores), judgeScores: scores, outcomes: scores.slice(0, 5).map(s => metricsFor(s.chatId, true)) });
  assert.equal(sparse.correlation, null);
  assert.match(sparse.note, /Needs at least 10 scored chats with outcomes.*5 so far/);
});

test('problemOutcome follows corrections, false done and 72 h fixes', () => {
  const metrics = sample('chat-metrics');
  assert.equal(problemOutcome(metrics), 1);
  const clean = { ...metrics, corrections: { ...metrics.corrections, count: 0 }, falseDone: { ...metrics.falseDone, count: 0 }, commitsFixedOrReverted72h: 0 };
  assert.equal(problemOutcome(clean), 0);
  assert.equal(problemOutcome({ ...clean, falseDone: { count: 2, items: [] } }), 1);
  assert.equal(problemOutcome({ ...clean, commitsFixedOrReverted72h: 1 }), 1);
});

test('chooseJudge adopts the candidate with the higher kappa', () => {
  const scores = kitScores(), labels = labelsFrom(scores);
  const heuristic = { id: 'heuristic', scores: scores.map(s => ({ ...s, total: Math.min(8, s.total + (s.total % 3 === 0 ? 1 : 0)) })) };
  const model = { id: 'model', scores };
  assert.equal(chooseJudge({ labels, candidates: [heuristic, model] }).id, 'model');
  assert.equal(chooseJudge({ labels, candidates: [model, heuristic] }).id, 'model');
  const worse = { id: 'model', scores: scores.map(s => ({ ...s, total: 8 - s.total })) };
  const choice = chooseJudge({ labels, candidates: [heuristic, worse] });
  assert.equal(choice.id, 'heuristic');
  assert.ok(choice.kappa > 0.6);
  assert.deepEqual(chooseJudge({ labels: new Map(), candidates: [heuristic, model] }), { id: null, kappa: null });
});

test('taskCorrelation relates judge scores to E4 task outcomes', () => {
  const scores = kitScores(), task = sample('task');
  const tasks = scores.map(s => ({ ...task, sources: { chatIds: [s.chatId], contract: null }, excluded: false,
    outcome: { ...task.outcome, corrections: s.total <= 3 ? 2 : 0, falseDone: 0, fixedOrReverted72h: 0 } }));
  const result = taskCorrelation({ judgeScores: scores, tasks });
  assert.equal(result.n, N);
  assert.ok(result.r < 0 && result.ci95[1] < 0);
  assert.equal(taskCorrelation({ judgeScores: scores, tasks: tasks.map(t => ({ ...t, excluded: true })) }).r, null);
});
