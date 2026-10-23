// E3 correction detector: rule fixtures, programmatic mutation tests, closure
// claims, spec/task-type tables and the own-words filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULES, CATEGORIES, matchRule, detectCorrections, isDoneClaim, ownWords, excerpt } from '../evals/corrections.mjs';
import { classifyTaskType, detectSpec, TASK_TYPES } from '../evals/task-type.mjs';

const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/evals/corrections/messages.json', import.meta.url), 'utf8'));

// Guarding assertions, parameterized by the rule list so mutations can be checked.
function assertPositives(rule, rules) {
  for (const text of rule.positives) assert.equal(matchRule(text, rules)?.id, rule.id, `${rule.id} positive #${rule.positives.indexOf(text)}`);
}
function assertNegatives(rule, rules) {
  for (const text of rule.negatives) assert.equal(matchRule(text, rules), null, `${rule.id} negative #${rule.negatives.indexOf(text)}`);
}

test('rules have unique ids, schema categories, languages and fixtures', () => {
  assert.equal(new Set(RULES.map(r => r.id)).size, RULES.length);
  for (const rule of RULES) {
    assert.match(rule.id, /^[a-z0-9-]{2,60}$/);
    assert.ok(CATEGORIES.includes(rule.category), rule.id);
    assert.ok(['es', 'en'].includes(rule.lang), rule.id);
    assert.ok(rule.positives.length >= 1 && rule.negatives.length >= 1, rule.id);
  }
  for (const lang of ['es', 'en']) assert.ok(RULES.filter(r => r.lang === lang).length >= 10, lang);
});

for (const rule of RULES) {
  test(`rule ${rule.id}: positives hit it, negatives hit no rule`, () => {
    assertPositives(rule, RULES);
    assertNegatives(rule, RULES);
  });
}

test('mutation: disabling or over-matching any rule breaks its guarding test', () => {
  for (const [index, rule] of RULES.entries()) {
    const never = RULES.map((r, i) => i === index ? { ...r, test: () => false } : r);
    assert.throws(() => assertPositives(rule, never), assert.AssertionError, `${rule.id} positives survive test=()=>false`);
    const always = RULES.map((r, i) => i === index ? { ...r, test: () => true } : r);
    assert.throws(() => assertNegatives(rule, always), assert.AssertionError, `${rule.id} negatives survive test=()=>true`);
  }
});

test('extra synthetic corpus: expected rules and neutral messages', () => {
  for (const [text, id] of corpus.positives) assert.equal(matchRule(text)?.id, id, text);
  for (const text of corpus.negatives) assert.equal(matchRule(text), null, text);
});

test('priority: wrong-result/incomplete/misunderstood rules come before language-style rules', () => {
  const order = ['wrong-result', 'incomplete', 'misunderstood'];
  const lastCore = Math.max(...RULES.map((r, i) => order.includes(r.category) ? i : -1));
  const firstStyle = RULES.findIndex(r => r.category === 'language-style');
  assert.ok(lastCore < firstStyle);
  assert.equal(matchRule('no funciona, sigue saliendo Hello en español').id, 'es-no-funciona');
  assert.equal(matchRule('falta el footer, y en español').category, 'incomplete');
});

function record(messages) {
  return { userMessages: messages.map(([turn, kind, text]) => ({ turn, at: null, kind, text, chars: text.length })) };
}

test('detectCorrections skips the first prompt, turn 0, interrupts and commands; one item per message', () => {
  const items = detectCorrections(record([
    [0, 'prompt', 'no funciona el deploy, arréglalo'],
    [0, 'prompt', 'no sirve tampoco'],
    [1, 'interrupt', ''],
    [1, 'command', '/compact'],
    [1, 'prompt', 'sigue igual y falta el botón'],
    [2, 'prompt', 'gracias, perfecto'],
    [3, 'prompt', `está mal ${'x'.repeat(300)}`],
  ]));
  assert.deepEqual(items.map(i => [i.turn, i.rule, i.category, i.source]), [[1, 'es-sigue-mal', 'wrong-result', 'rule'], [3, 'es-esta-mal', 'wrong-result', 'rule']]);
  assert.equal(items[1].excerpt.length, 160);
  assert.ok(items[1].excerpt.endsWith('…'));
  assert.equal(excerpt('  a \n b  '), 'a b');
});

test('isDoneClaim accepts closure claims and rejects questions, negations and conditionals', () => {
  const yes = ['Done: Spanish greeting implemented and tests pass.', 'Committed a1b2c3d after node --test passed.', 'Listo, quedó funcionando.',
    'Ya está: el botón guarda.', 'Terminé la migración.', 'Hecho ✅', 'All tests pass.', 'Completed the refactor.', 'Finished.',
    'Verified in the browser.', '✅ Deployed to preview', 'Implementé el login y quedó listo.', 'Done. Want me to push?'];
  const no = ['No está listo todavía.', 'Not done yet.', 'Once tests pass, it will be done.', '¿Listo para el commit?', 'Should I mark this as done?',
    'Still working on it.', 'I will be done soon.', 'De hecho, falta revisar el CSS.', 'Todavía no he terminado.', 'Avísame cuando esté listo.',
    'The build is not finished', 'Let me know when it is done', 'Quedó pendiente el deploy.', '', 'I found the cause; next I need your approval.'];
  for (const text of yes) assert.equal(isDoneClaim(text), true, text);
  for (const text of no) assert.equal(isDoneClaim(text), false, text);
});

test('classifyTaskType table', () => {
  const table = [
    ["Add a Spanish greeting. Requirements: R1 greet(name,'es') returns Hola. Acceptance: node --test passes.", 'feature'],
    ['Agrega un endpoint para exportar CSV', 'feature'],
    ['Fix the crash when the list is empty', 'bugfix'],
    ['el login no funciona, arréglalo', 'bugfix'],
    ['Investiga qué librería de gráficos conviene y compara opciones', 'research'],
    ['Deploy the app to Vercel and configure the domain', 'ops'],
    ['Update the README with setup steps', 'docs'],
    ['Rediseña el layout de la landing con mejores colores', 'design'],
    ['Review this PR for security issues', 'review'],
    ['hola', 'other'],
    ['', 'other'],
  ];
  for (const [prompt, type] of table) assert.equal(classifyTaskType(prompt), type, prompt);
  for (const [, type] of table) assert.ok(TASK_TYPES.includes(type));
});

test('detectSpec table', () => {
  const table = [
    ["Add a Spanish greeting. Requirements: R1 greet(name,'es') returns Hola. Acceptance: node --test passes.", true, ['requirements-section', 'acceptance-section']],
    ['Usa agent-relay-spec para preparar la feature', true, ['agent-relay-spec']],
    ['Implement what is in docs/contract.json', true, ['contract-file']],
    ['Sigue el checklist en agent-work/x/checklist.md', true, ['checklist-reference']],
    ['## Requisitos\n1. login\n2. logout\n3. perfil\n## Verificación\nnpm test', true, ['requirements-section', 'acceptance-section', 'numbered-requirements']],
    ['R1 login. R2 logout. Acceptance: e2e passes', true, ['acceptance-section', 'numbered-requirements']],
    ['Requirements: fast and pretty', false, ['requirements-section']],
    ['<!-- ai-pack brief -->\nhaz el cambio', false, ['ai-pack']],
    ['make it nicer', false, []],
  ];
  for (const [prompt, hasSpec, signals] of table) assert.deepEqual(detectSpec(prompt), { hasSpec, signals }, prompt);
});

// ---- own words ----

test('ownWords keeps only the user\'s words: question answers, no pasted blocks, nothing another agent wrote', () => {
  const reply = '<send_user_message_question_reply>\n[{"answer":"Inglés","question":"¿Completaré el formulario o falta algo?","questionItemId":"x"}]\n</send_user_message_question_reply>';
  assert.equal(ownWords(reply), 'Inglés');
  // A truncated reply still yields the answers that survived.
  assert.equal(ownWords('<send_user_message_question_reply>\n[{"answer":"sí, \\"todo\\"","question":"¿Lo hago?"},{"answer":"no'), 'sí, "todo"');
  assert.equal(ownWords('mira esto <pasted_content id="a">no funciona nada</pasted_content id="a"> y dime'), 'mira esto  [pasted text omitted]  y dime');
  assert.equal(ownWords('revisa <pasted_content id="b">falta el botón, truncated'), 'revisa  [pasted text omitted]');
  for (const agent of ['Claude: el PC se reinició, sigue', 'Claude (supervisor). El usuario aprobó: arregla', 'SUPERVISOR (Claude): dos cosas', 'Codex (vigia): revisé',
    '# Agent Relay · Orquestador\n<!-- agent-relay-native-orchestrator:v1 -->\nYou are', 'AGENT-RELAY MESSAGE 7c4a: Read the user\'s message']) assert.equal(ownWords(agent), '', agent);
  for (const own of ['Codex hace solo las skills:', 'no funciona (otra vez): mira', 'claude dijo que estaba listo y no']) assert.equal(ownWords(own), own, own);
});

test('detectCorrections ignores the agent\'s question, pasted reviews and agent-written messages', () => {
  const items = detectCorrections(record([
    [0, 'prompt', 'Build the page'],
    [1, 'prompt', '<send_user_message_question_reply>\n[{"answer":"La segunda","question":"¿Sigue fallando el test o lo dejo?"}]\n</send_user_message_question_reply>'],
    [2, 'prompt', 'revisa esto <pasted_content id="c">Le falta una pasada de fixes</pasted_content id="c">'],
    [3, 'prompt', 'Claude (vigia): no funciona el copy de la tarjeta'],
    [4, 'prompt', 'todo quedó listo o qué hace falta para cerrar este chat?'],
    [5, 'prompt', 'envíame nuevamente el cuadro'],
    [6, 'prompt', 'sigue igual el botón'],
  ]));
  assert.deepEqual(items.map(i => [i.turn, i.rule]), [[6, 'es-sigue-mal']]);
});

test('classifyTaskType ignores URLs and pasted text', () => {
  assert.equal(classifyTaskType('llena este sheet con los emails https://docs.google.com/spreadsheets/d/abc/edit'), 'other');
  assert.equal(classifyTaskType('arregla esto <pasted_content id="d">Update the README and docs guide</pasted_content id="d">'), 'bugfix');
});
