// Small file and text helpers shared by the collectors. Read-only by design.
import fs from 'node:fs';

// Presentation role only. A transcript marker never grants execution authority.
export const isRelayOrchestrator = text => /^# Agent Relay · (?:Orchestrator|Orquestador)\n<!-- agent-relay-native-orchestrator:v1 -->/.test(String(text || '').replace(/\r\n/g, '\n').trimStart());

// Reads up to `bytes` from the end of a file and drops the first partial line.
export function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return { text, size, complete: len === size };
  } finally {
    fs.closeSync(fd);
  }
}

export function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, end - start, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads up to `bytes` from the start of a file and drops the last partial line.
export function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export function* jsonLines(text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Partial or corrupt line: skip it, never guess.
    }
  }
}

const FOOTER = /\n-{3,}\s*\n\s*📋[\s\S]*$/u;
const MD_LINK = /\[([^\]]+)\]\([^)]*\)/g;

// Plain text of the agent's last words: no task footer, links or markdown marks.
export function plainText(text) {
  return String(text || '')
    .replace(FOOTER, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(MD_LINK, '$1')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Last paragraph of a message, capped at `max` chars on a sentence or word edge.
export function lastWords(text, max = 400) {
  const cleaned = String(text || '').replace(FOOTER, '').trim();
  const paragraphs = cleaned.split(/\n\s*\n/).map(plainText).filter(Boolean);
  let out = paragraphs.at(-1) || '';
  if (out.length < 80 && paragraphs.length > 1) out = `${paragraphs.at(-2)} ${out}`;
  if (out.length <= max) return out;
  const tail = out.slice(-max);
  const sentence = tail.search(/[.!?]\s+\S/);
  if (sentence !== -1 && sentence < max / 2) return tail.slice(sentence + 1).trim();
  return `…${tail.slice(tail.indexOf(' ') + 1)}`;
}

export function endsWithQuestion(text) {
  const t = plainText(text);
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const lastSentence = t.slice(Math.max(t.lastIndexOf('. '), t.lastIndexOf('\n')) + 1);
  return lastSentence.includes('¿') && lastSentence.includes('?');
}

// Short title from a first user message (same idea as tools/claude-sessions.mjs).
export function deriveTitle(raw) {
  let t = plainText(raw).replace(/^\s*\d+[.)]\s*/, '');
  const stop = t.search(/[.?!]\s/);
  if (stop !== -1 && stop <= 80) t = t.slice(0, stop + 1);
  if (t.length > 72) {
    const cut = t.slice(0, 72);
    const sp = cut.lastIndexOf(' ');
    t = `${sp > 30 ? cut.slice(0, sp) : cut}…`;
  }
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

export const toMs = (ts) => {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
};
