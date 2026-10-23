// E4c frozen reproducible suite: freezes every reproducible catalog task with its base
// commit, redacted original prompt and visible/hidden checks, assigns a seeded stratified
// holdout and writes suite-<date>.json atomically with a sha256 sidecar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertValid } from '../schema.mjs';
import { evalsHome } from '../store.mjs';
import { median, seededRandom } from '../stats.mjs';
import { deriveChecks, execArgv } from './hidden-checks.mjs';

export const SAMPLE_LIMIT = 10;
export const SUITE_VERSION = 1;
const PROMPT_LIMIT = 20000;

// Optional defense in depth: records are already redacted by the extractor (L1). When its
// redact() module is present the prompt passes through it again; otherwise it is kept as stored.
let redactor;
async function redactText(text) {
  if (redactor === undefined) redactor = await import('../redact.mjs').then(m => typeof m.redact === 'function' ? m.redact : null).catch(() => null);
  if (!redactor) return text;
  const out = redactor(text);
  return typeof out === 'string' ? out : typeof out?.text === 'string' ? out.text : text;
}

const providerOf = task => /^(claude|codex):/.exec(task.sources?.chatIds?.[0] || '')?.[1] ?? 'unknown';
export const stratumOf = task => `${task.taskType}|${providerOf(task)}|${task.hasSpec ? 'spec' : 'nospec'}`.slice(0, 120);

// First typed human prompt across the task's source chats, by timestamp then chat order.
export function firstPrompt(task, store) {
  let best = null;
  (task.sources?.chatIds ?? []).forEach((id, chatIndex) => {
    const record = store.chat(id);
    for (const [index, message] of (record?.userMessages ?? []).entries()) {
      if (message.kind !== 'prompt' || !message.text?.trim()) continue;
      const key = [message.at ?? '9999', chatIndex, index];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { key, text: message.text };
    }
  });
  return best?.text ?? null;
}

// Deterministic Fisher-Yates over a copy, seeded per call site.
function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function hashSeed(seed, text) { return crypto.createHash('sha256').update(`${seed}:${text}`).digest().readUInt32LE(0); }
function groupBy(entries, key) {
  const groups = new Map();
  for (const entry of entries) { const k = key(entry); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(entry); }
  return new Map([...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

// Within each stratum a seeded shuffle sends round(n * share) tasks to holdout; single-task strata stay dev.
export function assignSplits(entries, { seed = 20261022, holdoutShare = 0.2 } = {}) {
  if (!(holdoutShare >= 0 && holdoutShare < 1)) throw new Error('holdoutShare must be in [0, 1).');
  const split = new Map();
  for (const [stratum, members] of groupBy(entries, e => e.suite?.stratum ?? stratumOf(e))) {
    const ordered = shuffle([...members].sort((a, b) => a.id < b.id ? -1 : 1), seededRandom(hashSeed(seed, stratum)));
    const holdout = members.length > 1 ? Math.round(members.length * holdoutShare) : 0;
    ordered.forEach((entry, i) => split.set(entry.id, i < holdout ? 'holdout' : 'dev'));
  }
  return split;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export async function freezeSuite({ store, exec = execArgv, now = Date.now, seed = 20261022, holdoutShare = 0.2, outDir, persist = true, timeoutMs = 60_000 } = {}) {
  if (!store) throw new Error('freezeSuite needs a store.');
  const frozenAt = new Date(now()).toISOString();
  const catalog = store.tasks();
  const reproducible = catalog.filter(task => task.reproducible && !task.excluded);
  const skipped = [], frozen = [];
  for (const task of reproducible) {
    const raw = firstPrompt(task, store);
    if (!raw) { skipped.push({ id: task.id, reason: 'no human prompt in the source chats' }); continue; }
    const prompt = (await redactText(raw)).slice(0, PROMPT_LIMIT);
    const { visible, hidden, reason } = await deriveChecks({ task, exec, timeoutMs });
    const { suite: _old, ...base } = task;
    frozen.push({ ...base, suite: { frozenAt, prompt, visibleChecks: visible, hiddenChecks: hidden, split: 'dev', stratum: stratumOf(task) }, ...(reason ? { _checkNote: reason } : {}) });
  }
  const splits = assignSplits(frozen, { seed, holdoutShare });
  const notes = {};
  const entries = frozen.map(({ _checkNote, ...entry }) => {
    if (_checkNote) notes[entry.id] = _checkNote;
    return assertValid('task', { ...entry, suite: { ...entry.suite, split: splits.get(entry.id) } });
  }).sort((a, b) => a.id < b.id ? -1 : 1);
  const strata = {};
  for (const entry of entries) {
    const s = (strata[entry.suite.stratum] ??= { dev: 0, holdout: 0 });
    s[entry.suite.split] += 1;
  }
  const counts = {
    catalog: catalog.length, reproducible: reproducible.length, frozen: entries.length, skipped: skipped.length,
    dev: entries.filter(e => e.suite.split === 'dev').length, holdout: entries.filter(e => e.suite.split === 'holdout').length,
    withVisibleChecks: entries.filter(e => e.suite.visibleChecks.length).length, strata,
  };
  const document = { schemaVersion: SUITE_VERSION, frozenAt, seed, holdoutShare, counts, skipped, checkNotes: notes, entries };
  const dir = path.resolve(outDir ?? path.join(store.home ?? evalsHome(), 'benchmark'));
  fs.mkdirSync(dir, { recursive: true });
  const name = `suite-${frozenAt.slice(0, 10)}.json`, file = path.join(dir, name);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  writeAtomic(file, text);
  writeAtomic(`${file}.sha256`, `${sha256}  ${name}\n`);
  if (persist) {
    // Keeps the whole catalog; only reproducible frozen tasks carry suite fields.
    const bySuite = new Map(entries.map(e => [e.id, e]));
    store.replaceTasks(catalog.map(task => bySuite.get(task.id) ?? (({ suite: _s, ...rest }) => rest)(task)));
  }
  return { file, sha256, entries, counts };
}

// Reads a frozen suite file and verifies its sha256 sidecar.
export function readSuite(file) {
  const text = fs.readFileSync(file, 'utf8');
  const expected = fs.readFileSync(`${file}.sha256`, 'utf8').split(/\s+/)[0];
  if (crypto.createHash('sha256').update(text).digest('hex') !== expected) throw new Error('The frozen suite does not match its sha256 sidecar.');
  const document = JSON.parse(text);
  for (const entry of document.entries) assertValid('task', entry);
  return document;
}

const specCountOf = variants => Array.isArray(variants) ? variants.filter(v => v?.spec).length : Math.floor(variants / 2);

// Turns needed to run every entry under every variant, and days at the Relay daily turn limit.
export function estimateSuite(entries, { variants = 2, turnsPerDay = 128, turnsPerTask } = {}) {
  if (!Number.isInteger(turnsPerDay) || turnsPerDay < 1) throw new Error('turnsPerDay must be a positive integer.');
  const variantCount = Array.isArray(variants) ? variants.length : variants;
  if (!Number.isInteger(variantCount) || variantCount < 1) throw new Error('variants must be a positive count or a list.');
  let perTask = turnsPerTask;
  if (perTask === undefined) {
    const dev = entries.filter(e => e.suite?.split !== 'holdout');
    const observed = (dev.length ? dev : entries).map(e => e.outcome?.userTurns).filter(Number.isFinite);
    perTask = Math.max(1, Math.ceil(median(observed) ?? 1));
  }
  if (!Number.isInteger(perTask) || perTask < 1) throw new Error('turnsPerTask must be a positive integer.');
  const turns = entries.length * (perTask * variantCount + specCountOf(variants));
  return { turns, days: Math.ceil((turns / turnsPerDay) * 10) / 10, turnsPerDay };
}

// Why a task cannot run unattended in a scratch clone, or null. Checked 2026-10-23 on the
// frozen suite: most history tasks ask to send or publish something, need files or services
// outside the repo (Downloads, screenshots, Slack, Drive, Cloudflare), are questions with no
// code change, or clone the whole workspace root (CHATS_WORKSPACE_ROOT: long paths, private tools).
const sameFolder = (a, b) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
const SIDE_EFFECT = /\b(?:env[ií]a\w*|send|sms|whatsapp|e-?mail|correo|gmail|deploy\w*|desplieg\w*|publica\w*|publish|push|prod(?:ucci[oó]n)?|paga\w*|pay|compra\w*|borra\w*|elimina\w*|delete)\b|vercel\.app/i;
const OUTSIDE_REPO = /\b(?:downloads?[\\/]|screenshot|pantallazo|localhost|slack|drive|tally|artifact|cloudflare|cl+aude design|x\.com|twitter|escucha|audio\w*)\b/i;
const NO_CODE = /\b(?:investiga\w*|research|dime|expl[ií]ca\w*|revisa)\b|\?/i;
export function liveBlocker(entry, env = process.env) {
  const prompt = entry?.suite?.prompt ?? '';
  if (entry?.repoRoot && env.CHATS_WORKSPACE_ROOT && sameFolder(entry.repoRoot, env.CHATS_WORKSPACE_ROOT)) return 'workspace-root';
  if (SIDE_EFFECT.test(prompt)) return 'side-effect';
  if (OUTSIDE_REPO.test(prompt)) return 'outside-repo';
  if (/^(?:review|other)\|/.test(entry?.suite?.stratum ?? '') || NO_CODE.test(prompt)) return 'no-code-change';
  if (!entry?.suite?.visibleChecks?.length) return 'no-visible-checks';
  return null;
}

// Stratified sample from the dev split: seeded order inside each stratum, strata visited
// round-robin in seeded order so as many strata as possible are covered. safe keeps only
// tasks with no liveBlocker (the CLI always passes it).
export function sampleTasks(entries, { limit = SAMPLE_LIMIT, seed = 20261022, allowFull = false, safe = false } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer.');
  if (limit > SAMPLE_LIMIT && allowFull !== true) throw new Error(`The sample is capped at ${SAMPLE_LIMIT} tasks; pass allowFull after the owner's explicit OK.`);
  const dev = entries.filter(e => e.suite?.split === 'dev' && (!safe || !liveBlocker(e)));
  const queues = [...groupBy(dev, e => e.suite.stratum ?? stratumOf(e))].map(([stratum, members]) =>
    shuffle([...members].sort((a, b) => a.id < b.id ? -1 : 1), seededRandom(hashSeed(seed, stratum))));
  const order = shuffle(queues, seededRandom(hashSeed(seed, 'strata')));
  const picked = [];
  while (picked.length < limit && order.some(q => q.length)) for (const queue of order) if (queue.length && picked.length < limit) picked.push(queue.shift());
  return picked;
}
