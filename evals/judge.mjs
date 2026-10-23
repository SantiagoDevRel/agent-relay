// Relay Evals Layer 3 (E5): spec judge. A four-criterion rubric scored by a
// deterministic heuristic or an injected model, a labeling kit for the owner,
// and the calibration status (kappa against his labels, correlation with outcomes).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cohenKappa, bootstrapCorrelation, excludesZero, seededRandom, MIN_N } from './stats.mjs';

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

// Anchors match evals/judge/rubric.md word for word (tested).
export const RUBRIC = deepFreeze({
  version: 1,
  ids: ['literal', 'acceptance', 'scope', 'verification'],
  maxScore: 2,
  maxTotal: 8,
  criteria: [
    { id: 'literal', label: 'Literal requirements', anchors: {
      0: 'No identifiable requirement: only a goal or a wish.',
      1: 'Requirements are present but mixed into prose, merged or partly implicit.',
      2: "Each requirement is a separate, numbered or labeled item, kept in the user's own words." } },
    { id: 'acceptance', label: 'Observable acceptance', anchors: {
      0: 'No observable result: "make it work", "fix it", "should be good".',
      1: 'Some observable results, but not for every requirement or not precise.',
      2: 'Each requirement has a concrete observable result: values, states, screens or limits.' } },
    { id: 'scope', label: 'Scope limits', anchors: {
      0: 'No boundary: any file, any action.',
      1: 'A partial boundary: an area is named, or one thing is off limits.',
      2: 'Explicit allowed scope plus what must not be touched or done without asking.' } },
    { id: 'verification', label: 'Verification', anchors: {
      0: 'No verification is mentioned.',
      1: 'Verification is mentioned in general terms only.',
      2: 'Specific checks and the evidence to report: commands, tests, viewports or screenshots.' } },
  ],
});

// ---------- Deterministic heuristic baseline ----------

const MAX_SCAN = 20000;
// Lowercase without accents so Spanish cues match with or without tildes.
const normalize = text => text.slice(0, MAX_SCAN).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const count = (text, re) => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

// Strong cues alone give 1; two strong cues, or strong plus weak, give 2;
// two weak cues alone give 1.
function cueScore(text, raw, cues) {
  const signals = [];
  let strong = 0, weak = 0;
  for (const cue of cues) {
    if (!cue.test(text, raw)) continue;
    signals.push(cue.id);
    if (cue.strong) strong++; else weak++;
  }
  const score = strong >= 2 || (strong >= 1 && weak >= 1) ? 2 : strong === 1 || weak >= 2 ? 1 : 0;
  return { score, signals };
}
const cue = (id, strong, re) => ({ id, strong, test: text => re.test(text) });

const LITERAL_CUES = [
  { id: 'numbered-items', strong: true, test: text =>
    count(text, /^[ \t]*(?:\d{1,2}[.)]|[-*•]|[a-h][.)])[ \t]+\S/m) >= 2 || count(text, /\(\d{1,2}\)\s/) >= 2 },
  { id: 'requirement-ids', strong: true, test: (_, raw) => count(raw.slice(0, MAX_SCAN), /\b(?:R|REQ-?|AC-?|F)\d{1,3}\b/) >= 2 },
  cue('requirements-section', true, /\b(?:requirements?|requisitos?|requerimientos?|features?|deliverables?|entregables?)\s*[:\n]|\bliteral\b/),
  cue('modal-verbs', false, /\b(?:must|shall|needs? to|has to|debe|deben|tiene que|tienen que|hay que|necesito que)\b/),
  cue('quoted-text', false, /["“«][^"”»\n]{3,200}["”»]/),
];

const ACCEPTANCE_CUES = [
  cue('acceptance-section', true, /\b(?:acceptance|aceptacion|criterios? de exito|success criteria|definition of done|done when|listo cuando|terminado cuando|esta listo si)\b/),
  cue('observable-result', true, /\b(?:returns?|devuelve|retorna|responds? with|responde con|shows?|muestra|displays?|renders?|aparece|expected|esperado|status \d{3}|\d{3} (?:status|error)|equals?|igual a)\b/),
  cue('numbers-with-units', true, /\b\d+(?:[.,]\d+)?\s?(?:ms|s|seg|segundos?|seconds?|min|minutos?|minutes?|px|%|kb|mb|gb|items?|rows?|filas?|elementos?|tokens?)\b/),
  cue('example', false, /\b(?:e\.g\.|for example|por ejemplo|ej\.|such as|como por ejemplo)|=>|→/),
  cue('comparison', false, /\b(?:instead of|en vez de|en lugar de|no more than|at most|at least|maximo|minimo|como maximo|al menos)\b/),
];

const SCOPE_CUES = [
  cue('do-not-touch', true, /\b(?:do not|don't|never|no) (?:touch|modify|change|edit|alter)\b|\bno (?:toques|modifiques|cambies|edites|tocar|alteres)\b|\bsin tocar\b|\bout of scope\b|\bfuera de(?:l)? alcance\b|\bleave [\w ./-]{1,60} (?:unchanged|alone|as is)\b/),
  cue('only-scope', true, /\b(?:only|solo|solamente|unicamente)\s+(?:in|en|edit|edita|change|cambia|touch|toca|modify|modifica|these|estos|estas|the files?|los archivos?)\b|\b(?:file )?scopes?\s*:|\balcance\s*:|\ballowed (?:files|paths|areas?)\b|\barchivos permitidos\b/),
  cue('authorization', true, /\b(?:do not|don't|never|no) (?:commit|push|deploy|install|delete|publish|merge)\b|\bno (?:hagas commit|hagas push|despliegues|instales|borres|publiques)\b|\b(?:without|sin) (?:asking|preguntar|permission|permiso)\b|\b(?:ask|pregunta(?:me)?) (?:before|antes)\b/),
  { id: 'file-paths', strong: false, test: text => /\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|md|json|css|html|sql|ya?ml)\b/.test(text) },
  cue('preserve', false, /\b(?:keep|preserve|preserva|conserva|mantener|manten|mantiene|existing behavior|comportamiento actual)\b/),
];

const VERIFICATION_CUES = [
  cue('tests', true, /\b(?:tests?|pruebas?|testea|unit tests?|e2e|node --test|npm test|pytest|jest|vitest|playwright)\b/),
  cue('commands', true, /\b(?:npm (?:run|test|ci)|pnpm (?:run|test)|yarn (?:run|test)|(?:run|the|el|que) build|build (?:passes|pasa)|lint|typecheck|tsc|curl|smoke tests?)\b/),
  cue('viewport', true, /\b(?:viewports?|390|375|360|414|768|1024|1280|1440|screenshots?|capturas?|pantallazos?)\b/),
  cue('verify-verb', false, /\b(?:verify|verifica|verificar|verifies|check that|comprueba|confirma|confirm that|prove|demuestra)\b/),
  cue('evidence', false, /\b(?:evidence|evidencia|report back|reporta|reportame|output|salida|logs?)\b/),
];

// One function per criterion: (normalizedText, rawText) -> { score: 0-2, signals }.
// scoreSpec accepts replacements so mutation tests can disable a single rule.
export const HEURISTICS = Object.freeze({
  literal: (text, raw) => cueScore(text, raw, LITERAL_CUES),
  acceptance: (text, raw) => cueScore(text, raw, ACCEPTANCE_CUES),
  scope: (text, raw) => cueScore(text, raw, SCOPE_CUES),
  verification: (text, raw) => cueScore(text, raw, VERIFICATION_CUES),
});

export function scoreSpec(prompt, { heuristics = HEURISTICS } = {}) {
  const raw = typeof prompt === 'string' ? prompt : '';
  const text = normalize(raw);
  const scores = {}, signals = [];
  for (const id of RUBRIC.ids) {
    const result = raw.trim() ? heuristics[id](text, raw) : { score: 0, signals: [] };
    const score = Number.isInteger(result?.score) ? Math.max(0, Math.min(2, result.score)) : 0;
    scores[id] = score;
    for (const signal of result?.signals ?? []) signals.push(`${id}:${signal}`);
  }
  return { scores, total: RUBRIC.ids.reduce((sum, id) => sum + scores[id], 0), signals };
}

// ---------- Model judge ----------

const MAX_SPEC = 8000;
let templates = null;
const loadTemplates = () => templates ??= {
  rubric: fs.readFileSync(new URL('./judge/rubric.md', import.meta.url), 'utf8').trim(),
  prompt: fs.readFileSync(new URL('./judge/prompt.md', import.meta.url), 'utf8'),
};

export function judgePrompt(spec) {
  const { rubric, prompt } = loadTemplates();
  let text = typeof spec === 'string' ? spec : '';
  if (text.length > MAX_SPEC) text = `${truncate(text, MAX_SPEC - 1)}…`;
  // The spec cannot close its own delimiter.
  text = text.replace(/<\/?spec>/gi, match => match.replace('<', '< '));
  return prompt.replace('{{RUBRIC}}', () => rubric).replace('{{SPEC}}', () => text);
}

export function parseJudgeResponse(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) return null;
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  let value = null;
  for (const candidate of [unfenced, unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1)]) {
    try { value = JSON.parse(candidate); break; } catch { /* try the next candidate */ }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scores = {};
  for (const id of RUBRIC.ids) {
    if (!Number.isInteger(value[id]) || value[id] < 0 || value[id] > 2) return null;
    scores[id] = value[id];
  }
  const why = typeof value.why === 'string' ? value.why.slice(0, 300) : '';
  return { ...scores, total: RUBRIC.ids.reduce((sum, id) => sum + scores[id], 0), why };
}

class JudgeTimeout extends Error {}

// Sequential, one request at a time. The first transport failure (rejection or
// timeout) or an outer abort stops the run; that item and the rest are missing.
export async function runModelJudge({ items, complete, timeoutMs = 60000, signal } = {}) {
  if (typeof complete !== 'function') throw new Error('runModelJudge needs a complete(prompt, { signal }) function.');
  const results = [];
  let stopped = null;
  for (const item of items ?? []) {
    const base = { id: item.id ?? null, chatId: item.chatId ?? null };
    if (!stopped && signal?.aborted) stopped = 'aborted';
    if (stopped) { results.push({ ...base, status: 'missing', reason: stopped === 'aborted' ? 'aborted' : 'not-run', scores: null, total: null }); continue; }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new JudgeTimeout()); controller.abort(); }, timeoutMs);
      });
      const text = await Promise.race([Promise.resolve().then(() => complete(judgePrompt(item.prompt), { signal: controller.signal })), timeout]);
      const parsed = parseJudgeResponse(text);
      if (parsed) {
        const { total, why, ...scores } = parsed;
        results.push({ ...base, status: 'ok', scores, total, why });
      } else results.push({ ...base, status: 'invalid', reason: 'unparseable', scores: null, total: null });
    } catch (error) {
      stopped = signal?.aborted ? 'aborted' : error instanceof JudgeTimeout ? 'timeout' : 'transport';
      results.push({ ...base, status: 'missing', reason: stopped, scores: null, total: null });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return { status: stopped ? 'missing' : 'ok', results };
}

// ---------- Labeling kit ----------

export const MIN_KIT_PROMPT = 80;
const KIT_PROMPT_MAX = 3000;
const LENGTH_BUCKETS = [[300, 'short'], [1200, 'medium'], [Infinity, 'long']];

export const firstPrompt = record => record?.userMessages?.find(m => m.kind === 'prompt' && m.text?.trim())?.text ?? null;
const lengthBucket = chars => LENGTH_BUCKETS.find(([limit]) => chars < limit)[1];
const dedupKey = text => createHash('sha256').update(text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');

// Code-point-safe cut that never leaves half of a [REDACTED:kind] marker.
function truncate(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const open = cut.lastIndexOf('[');
  if (open >= 0 && open >= cut.length - 64 && !cut.slice(open).includes(']')) {
    const tail = cut.slice(open), marker = '[REDACTED';
    if (marker.startsWith(tail) || tail.startsWith(marker)) cut = cut.slice(0, open);
  }
  return cut;
}
const clip = text => text.length > KIT_PROMPT_MAX ? `${truncate(text, KIT_PROMPT_MAX - 1)}…` : text;

async function defaultRedact() {
  try { return (await import('./redact.mjs')).redact; } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null; // Records are already redacted at extraction.
    throw error;
  }
}

function shuffle(values, random) {
  for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}

// One item per stratum first (all strata when n allows), then D'Hondt
// proportional allocation by stratum size.
function allocate(strata, take, random) {
  const alloc = new Map(strata.map(s => [s.key, 0]));
  let picked = 0;
  for (const s of shuffle([...strata], random)) if (picked < take) { alloc.set(s.key, 1); picked++; }
  while (picked < take) {
    let best = null;
    for (const s of strata) {
      const a = alloc.get(s.key);
      if (a >= s.items.length) continue;
      if (!best || s.items.length / (a + 1) > best.items.length / (alloc.get(best.key) + 1)) best = s;
    }
    alloc.set(best.key, alloc.get(best.key) + 1);
    picked++;
  }
  return alloc;
}

const KIT_README = `# Spec labeling kit (Relay Evals)

1. Read \`rubric.md\`: four criteria (literal, acceptance, scope, verification), each scored 0, 1 or 2.
2. Open \`items.md\` (or \`items.jsonl\`) and read each prompt; each \`id\` matches a row of \`labels.csv\`.
3. In \`labels.csv\`, write 0, 1 or 2 in the four columns of each row; \`notes\` is optional and you can leave a row empty if unsure.
4. Score only the prompt text, not how the chat ended or who solved it.
5. Save \`labels.csv\` in this folder (comma- or semicolon-separated); with 80 or more complete rows, Relay Evals computes kappa.
`;

const longestRun = (text, char) => Math.max(0, ...(text.match(new RegExp(`${char}+`, 'g')) ?? []).map(run => run.length));

export async function buildLabelingKit({ store, outDir, n = 100, seed = 20261022, redact } = {}) {
  if (!store || typeof store.chats !== 'function') throw new Error('buildLabelingKit needs an evals store.');
  if (typeof outDir !== 'string' || !outDir) throw new Error('buildLabelingKit needs an output folder.');
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('Kit size must be an integer from 1 to 1000.');
  const target = path.resolve(outDir);
  if (fs.existsSync(target)) throw new Error(`Labeling kit folder already exists (${path.basename(target)}); refusing to overwrite it. Choose a new folder.`);
  const redactFn = redact === undefined ? await defaultRedact() : redact;

  // Interactive chats, first human prompt with >= 80 characters, deduplicated by text (earliest wins).
  const candidates = [], seen = new Set();
  for (const record of store.chats({ automated: false })) {
    let prompt = firstPrompt(record);
    if (!prompt || prompt.trim().length < MIN_KIT_PROMPT) continue;
    if (redactFn) { const redacted = redactFn(prompt); prompt = typeof redacted === 'string' ? redacted : redacted.text; }
    const key = dedupKey(prompt);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chatId: record.id, provider: record.provider, prompt: prompt.trim() });
  }
  const groups = new Map();
  for (const c of candidates) {
    c.taskType = store.metricsFor?.(c.chatId)?.taskType ?? 'unknown';
    c.stratum = `${c.provider}|${c.taskType}|${lengthBucket(c.prompt.length)}`;
    if (!groups.has(c.stratum)) groups.set(c.stratum, []);
    groups.get(c.stratum).push(c);
  }
  const random = seededRandom(seed);
  const strata = [...groups.keys()].sort().map(key => ({ key, items: shuffle(groups.get(key).sort((a, b) => a.chatId < b.chatId ? -1 : 1), random) }));
  const alloc = allocate(strata, Math.min(n, candidates.length), random);
  const picked = shuffle(strata.flatMap(s => s.items.slice(0, alloc.get(s.key))), random);
  const width = Math.max(3, String(picked.length).length);
  const items = picked.map((c, i) => ({ id: `J${String(i + 1).padStart(width, '0')}`, chatId: c.chatId, prompt: clip(c.prompt), stratum: c.stratum }));

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.tmp-`));
  try {
    const write = (name, content) => fs.writeFileSync(path.join(temp, name), content, { encoding: 'utf8', flag: 'wx' });
    write('items.jsonl', items.map(({ id, chatId, prompt }) => JSON.stringify({ id, chatId, prompt })).join('\n') + (items.length ? '\n' : ''));
    write('labels.csv', '﻿' + ['id,literal,acceptance,scope,verification,notes', ...items.map(item => `${item.id},,,,,`)].join('\r\n') + '\r\n');
    write('items.md', `# Items to label\n\n${items.map(item => {
      const fence = '`'.repeat(Math.max(3, longestRun(item.prompt, '`') + 1));
      return `## ${item.id}\n\n${fence}text\n${item.prompt}\n${fence}\n`;
    }).join('\n')}`);
    fs.copyFileSync(new URL('./judge/rubric.md', import.meta.url), path.join(temp, 'rubric.md'), fs.constants.COPYFILE_EXCL);
    write('README.md', KIT_README);
    if (fs.existsSync(target)) throw new Error(`Labeling kit folder already exists (${path.basename(target)}); refusing to overwrite it. Choose a new folder.`);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true }); // Only the temporary folder created above.
    throw error;
  }
  return { dir: target, items };
}

export function readKitItems(dir) {
  return fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

// ---------- Labels ----------

const MAX_LABELS_BYTES = 5 * 1024 * 1024;

// RFC 4180 records with their starting row number (header = row 1).
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      if (ch === '\n') line++;
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push({ line: rowLine, cells: row }); row = []; field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1; line++; rowLine = line; continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new Error(`labels.csv row ${rowLine}: a quoted field is not closed.`);
  if (field !== '' || row.length) { row.push(field); rows.push({ line: rowLine, cells: row }); }
  return rows;
}

export function readLabels(csvPath) {
  const stat = fs.statSync(csvPath);
  if (stat.size > MAX_LABELS_BYTES) throw new Error('labels.csv is larger than 5 MB.');
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r|\n|$/));
  // Spreadsheets in Spanish locales save CSV with semicolons.
  const delimiter = count(firstLine, /;/) > count(firstLine, /,/) ? ';' : ',';
  const [header, ...rows] = parseCsv(text, delimiter);
  const columns = (header?.cells ?? []).map(cell => cell.trim().toLowerCase());
  const index = Object.fromEntries(['id', ...RUBRIC.ids].map(name => [name, columns.indexOf(name)]));
  if (Object.values(index).some(i => i < 0)) throw new Error(`labels.csv header must include id, ${RUBRIC.ids.join(', ')}.`);
  const labels = new Map();
  for (const { line, cells } of rows) {
    if (cells.every(cell => !cell.trim())) continue;
    const id = (cells[index.id] ?? '').trim();
    if (!id) throw new Error(`labels.csv row ${line}: missing id.`);
    if (labels.has(id)) throw new Error(`labels.csv row ${line}: repeated id.`);
    const entry = {};
    for (const criterion of RUBRIC.ids) {
      const value = (cells[index[criterion]] ?? '').trim();
      if (value === '') { entry[criterion] = null; continue; }
      if (!/^[012]$/.test(value)) throw new Error(`labels.csv row ${line}: ${criterion} must be 0, 1 or 2 (or empty).`);
      entry[criterion] = Number(value);
    }
    const complete = RUBRIC.ids.every(c => entry[c] !== null);
    labels.set(id, { ...entry, total: complete ? RUBRIC.ids.reduce((sum, c) => sum + entry[c], 0) : null });
  }
  return labels;
}

// ---------- Calibration ----------

export const PROBLEM_OUTCOME = 'chat had a correction, broken done or 72 h fix';
const amount = value => typeof value === 'number' ? value : typeof value?.count === 'number' ? value.count : 0;

// 1 when the chat had a correction, a false done claim or a commit fixed/reverted within 72 h.
export const problemOutcome = metrics =>
  amount(metrics?.corrections) > 0 || amount(metrics?.falseDone) > 0 || amount(metrics?.commitsFixedOrReverted72h) > 0 ? 1 : 0;

// Judge scores: iterable of { id?, chatId?, total } (or { scores }); id joins kit labels, chatId joins outcomes.
function indexScores(judgeScores) {
  const byId = new Map(), byChat = new Map();
  for (const entry of judgeScores ?? []) {
    const total = Number.isInteger(entry?.total) ? entry.total
      : entry?.scores && RUBRIC.ids.every(id => Number.isInteger(entry.scores[id])) ? RUBRIC.ids.reduce((s, id) => s + entry.scores[id], 0) : null;
    if (total === null) continue;
    if (entry.id) byId.set(entry.id, total);
    if (entry.chatId) byChat.set(entry.chatId, total);
  }
  return { byId, byChat };
}
const labelEntries = labels => labels instanceof Map ? [...labels] : Object.entries(labels ?? {});
const round = (value, digits = 3) => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

function kappaFor(labels, byId) {
  const pairs = labelEntries(labels).filter(([id, label]) => Number.isInteger(label?.total) && byId.has(id));
  if (!pairs.length) return null;
  return round(cohenKappa(pairs.map(([id]) => byId.get(id)), pairs.map(([, label]) => label.total), { weights: 'quadratic' }));
}

export function chooseJudge({ labels, candidates = [] } = {}) {
  let best = { id: null, kappa: null };
  for (const candidate of candidates) {
    const kappa = kappaFor(labels, indexScores(candidate.scores).byId);
    if (kappa !== null && (best.kappa === null || kappa > best.kappa)) best = { id: candidate.id, kappa };
  }
  return best;
}

function correlate(pairs, seed) {
  const result = bootstrapCorrelation(pairs.map(p => p[0]), pairs.map(p => p[1]), { seed });
  return { result, value: result.status === 'ok' ? { r: result.r, ci95: result.ci95, n: result.n, outcome: PROBLEM_OUTCOME } : null };
}

// E4: judge score of each catalog task's first scored source chat versus its aggregated outcome.
export function taskCorrelation({ judgeScores, tasks = [], seed = 42 } = {}) {
  const { byChat } = indexScores(judgeScores), pairs = [];
  for (const task of tasks) {
    if (task?.excluded || !task?.outcome) continue;
    const chatId = (task.sources?.chatIds ?? []).find(id => byChat.has(id));
    if (!chatId) continue;
    const o = task.outcome;
    pairs.push([byChat.get(chatId), o.corrections > 0 || o.falseDone > 0 || o.fixedOrReverted72h > 0 ? 1 : 0]);
  }
  const { result, value } = correlate(pairs, seed);
  return value ? { ...value, outcome: 'task had a correction, broken done or 72 h fix' } : { r: null, ci95: null, n: result.n, outcome: null };
}

const fmt = value => String(Math.round(value * 100) / 100);

export function judgeStatus({ labels, judgeScores = [], outcomes = [], minLabels = 80, minKappa = 0.6, target = 100, seed = 42 } = {}) {
  const { byId, byChat } = indexScores(judgeScores);
  const labeled = labelEntries(labels).filter(([, label]) => Number.isInteger(label?.total)).length;
  const kappa = labeled ? kappaFor(labels, byId) : null;

  const pairs = [];
  const outcomeEntries = outcomes instanceof Map ? [...outcomes] : [...(outcomes ?? [])].map(m => [m?.id, m]);
  for (const [chatId, metrics] of outcomeEntries) {
    if (!byChat.has(chatId) || metrics?.automated === true) continue;
    pairs.push([byChat.get(chatId), typeof metrics === 'number' ? (metrics > 0 ? 1 : 0) : problemOutcome(metrics)]);
  }
  const { result, value: correlation } = correlate(pairs, seed);

  const missing = [];
  if (labeled < minLabels) missing.push(`Needs ${Math.max(target, minLabels)} labels from the owner: ${labeled} labeled so far.`);
  else if (kappa === null) missing.push('The judge has no scores for the labeled items.');
  else if (kappa < minKappa) missing.push(`Agreement with the owner's labels is too low: kappa ${fmt(kappa)}, needs ${fmt(minKappa)}.`);
  if (!correlation) missing.push(`Needs at least ${MIN_N} scored chats with outcomes to test the judge against real results: ${result.n} so far.`);
  else if (!excludesZero(correlation.ci95)) missing.push(`Its score does not yet predict problems: r ${fmt(correlation.r)}, 95% interval ${fmt(correlation.ci95[0])} to ${fmt(correlation.ci95[1])} includes zero.`);
  // A useful judge gives higher scores to specs whose chats had fewer problems.
  else if (correlation.ci95[0] > 0) missing.push(`Higher scores went with more problems (r ${fmt(correlation.r)}), the opposite of a useful judge.`);

  const status = missing.length ? 'not-calibrated' : 'calibrated';
  let note = status === 'calibrated'
    ? `Calibrated: kappa ${fmt(kappa)} on ${labeled} labels; higher scores went with fewer problems (r ${fmt(correlation.r)}, ${correlation.n} chats).`
    : missing.join(' ');
  if (note.length > 300) note = `${note.slice(0, 299).replace(/\s+\S*$/, '')}…`;
  return { status, labeled, kappa, correlation, note };
}
