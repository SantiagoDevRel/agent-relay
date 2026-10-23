// Label check: a short yes/no list that tells whether the model labels can be trusted.
// buildLabelCheck samples labeled messages (corrections, broken "done" reports and
// messages the labeler did not count) into a private CSV next to the reports folder
// (<evals home>/label-check, outside Git); a reviewer answers yes/no
// and names itself in checked_by (blank = owner); readLabelCheck turns the answers into confirmed shares with
// Wilson 95% intervals for the report.
import fs from 'node:fs';
import path from 'node:path';
import { seededRandom } from './stats.mjs';
import { reportsDir } from './store.mjs';
import { DEFAULT_LABEL_MODEL, labelItems, labelKey } from './claude-labels.mjs';

export const CHECK_KINDS = [
  { kind: 'correction', count: 50, label: 'Corrections', question: 'Is this message a correction of the agent?' },
  { kind: 'broken-done', count: 20, label: 'Broken "done"', question: 'Did the agent claim it was done, and does the message report it was not?' },
  { kind: 'not-correction', count: 20, label: 'Messages not counted', question: 'Is it right that this message is NOT a correction?' },
];
const HEADER = ['kind', 'question', 'previous_reply', 'message', 'label_category', 'your_answer', 'checked_by', 'labeled_by'];

const csvCell = value => `"${String(value ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

export const checkDir = (env = process.env) => path.join(path.dirname(reportsDir(env)), 'label-check');

/**
 * Writes <dir>/<date>/label-check.csv with seeded random samples of one model's labels (labeled_by names it).
 * Never overwrites: an existing file for the date gets -2, -3 … instead.
 */
export function buildLabelCheck({ store, dir = checkDir(), model = DEFAULT_LABEL_MODEL, seed = 42, now = new Date() } = {}) {
  const pools = Object.fromEntries(CHECK_KINDS.map(k => [k.kind, []]));
  for (const record of store.chats({ automated: false })) {
    for (const item of labelItems(record)) {
      const label = store.label(labelKey(item, model));
      if (!label) continue;
      const entry = { item, label };
      if (label.brokenDone) pools['broken-done'].push(entry);
      else if (label.correction) pools.correction.push(entry);
      else pools['not-correction'].push(entry);
    }
  }
  const random = seededRandom(seed), rows = [];
  for (const { kind, count, question } of CHECK_KINDS) {
    const pool = [...pools[kind]];
    for (let i = 0; i < count && pool.length; i++) {
      const { item, label } = pool.splice(Math.floor(random() * pool.length), 1)[0];
      rows.push([kind, question, item.prev, item.text, label.category ?? 'none', '', '', model]);
    }
  }
  if (!rows.length) throw new Error(`No ${model} labels to check yet: run the weekly report first.`);
  const day = new Date(now).toISOString().slice(0, 10);
  let file = path.join(dir, day, 'label-check.csv');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, day, `label-check-${n}.csv`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `﻿${[HEADER, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`, { flag: 'wx' });
  return { file, rows: rows.length };
}

// Wilson 95% interval for a proportion, in percent with one decimal.
export function wilson(hits, n) {
  if (!n) return null;
  const z = 1.96, p = hits / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d, half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.round(Math.max(0, center - half) * 1000) / 10, Math.round(Math.min(1, center + half) * 1000) / 10];
}

const YES = /^(y|yes|s|si|sí|1|true|ok)$/i, NO = /^(n|no|0|false)$/i;

/** Answers of the newest label-check CSV, or null when none exists. */
export function readLabelCheck({ dir = checkDir() } = {}) {
  let files = [];
  try {
    for (const day of fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()) {
      for (const name of fs.readdirSync(path.join(dir, day)).filter(n => /^label-check(-\d+)?\.csv$/.test(n))) {
        const file = path.join(dir, day, name);
        files.push({ file, key: `${day} ${String(Number(name.match(/-(\d+)\.csv$/)?.[1] ?? 1)).padStart(4, '0')}` });
      }
    }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  files = files.sort((a, b) => a.key.localeCompare(b.key));
  if (!files.length) return null;
  const rows = parseCsv(fs.readFileSync(files.at(-1).file, 'utf8').replace(/^﻿/, '')).slice(1);
  const kinds = CHECK_KINDS.map(({ kind, label }) => {
    const answers = rows.filter(r => r[0] === kind).map(r => String(r[5] ?? '').trim());
    const confirmed = answers.filter(a => YES.test(a)).length, answered = confirmed + answers.filter(a => NO.test(a)).length;
    return { kind, label, total: answers.length, answered, confirmed,
      rate: answered ? Math.round((confirmed / answered) * 1000) / 10 : null, ci95: wilson(confirmed, answered) };
  });
  // Who answered: a model review is not a human check, so the report names the reviewer.
  const checkedBy = [...new Set(rows.filter(r => YES.test(String(r[5] ?? '').trim()) || NO.test(String(r[5] ?? '').trim())).map(r => String(r[6] ?? '').trim() || 'owner'))];
  // Whose labels were checked; files from before 2026-10-23 have no column and checked Claude Sonnet 5.5.
  const labeledBy = [...new Set(rows.map(r => String(r[7] ?? '').trim() || 'claude-sonnet-5-5'))];
  return { total: kinds.reduce((s, k) => s + k.total, 0), answered: kinds.reduce((s, k) => s + k.answered, 0), checkedBy, labeledBy, kinds };
}
