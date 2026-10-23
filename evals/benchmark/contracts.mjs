// E4a contract reader: parses every agent-work/<folder>/checklist.md (and an
// optional sibling requirements.json, which takes precedence) into literal
// requirements. Read-only, bounded reads, no symlinks followed.
import fs from 'node:fs';
import os from 'node:os';
import { Buffer } from 'node:buffer';
import path from 'node:path';

// Folders with a checklist.md or requirements.json per task (RELAY_EVALS_CONTRACTS overrides).
export const DEFAULT_CONTRACTS_DIR = process.env.RELAY_EVALS_CONTRACTS || path.join(os.homedir(), 'Downloads', 'agent-work');
export const MAX_LITERAL = 2000;
export const MAX_REQUIREMENTS = 200;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STATUS = 40;
const MAX_TITLE = 200;

// Literals stay verbatim except for secret-like spans and personal data, which are
// replaced with [REDACTED:<kind>] like the E1 extractor does for chat text.
const SCRUB = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g],
  ['auth', /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
  ['secret', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|token|contraseña|clave)\s*[:=]\s*\S+/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['phone', /\+\d[\d\s-]{8,}\d/g],
  ['digits', /\b\d{9,}\b/g],
];

export function scrub(text) {
  let out = String(text ?? '');
  for (const [kind, pattern] of SCRUB) out = out.replace(pattern, `[REDACTED:${kind}]`);
  return out;
}

const cap = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
export const literalOf = text => cap(scrub(String(text).trim()), MAX_LITERAL);

function readBounded(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8').replace(/^﻿/, '');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const QUOTES = { '"': '"', '“': '”', '«': '»', '„': '“', '‘': '’', "'": "'" };
const STATUS_WORD = /^(?:status:\s*|estado:\s*)?(completed|complete|done|pending|blocked|partial|in progress|open|closed|failed|waiting|verified|hecho|pendiente|bloqueado|completado|esperando|parcial|ok)\b/i;
const ID_TOKEN = /^([A-Za-z]{0,6}\d+[a-z]?|[A-Z][A-Z0-9_-]{1,23})\s*(?:—|–|:|\s-)\s+(.*)$/s;
const SEPARATOR = /\s+(?:—|–)\s+/;

// Removes one surrounding pair of quotes when the whole text is quoted.
function unquote(text) {
  const t = text.trim(), close = QUOTES[t[0]];
  return close && t.length > 1 && t.endsWith(close) && !t.slice(1, -1).includes(close) ? t.slice(1, -1) : t;
}

function statusFrom(text) {
  const explicit = /\b(?:status|estado)\s*:\s*([^\s.,;()]+(?:\s+progress)?)/i.exec(text);
  if (explicit) return explicit[1].toLowerCase().slice(0, MAX_STATUS);
  for (const segment of text.split(SEPARATOR)) {
    const match = STATUS_WORD.exec(segment.trim());
    if (match) return match[1].toLowerCase();
  }
  return null;
}

// "R1 — "literal" — completed." / ""literal" — done" / "plain requirement text".
function parseItemText(text) {
  let rest = text.trim(), id = null;
  const idMatch = ID_TOKEN.exec(rest);
  if (idMatch) {
    rest = idMatch[2].trim();
    // "DONE — text" is a status prefix, not an id.
    if (STATUS_WORD.test(idMatch[1]) && !/\d/.test(idMatch[1])) {
      const item = parseItemText(rest);
      return { ...item, status: item.status ?? idMatch[1].toLowerCase() };
    }
    id = idMatch[1];
  }
  const close = QUOTES[rest[0]];
  if (close) {
    const end = rest.indexOf(close, 1);
    if (end > 1) return { id, literal: rest.slice(1, end), status: statusFrom(rest.slice(end + 1)) };
  }
  const segments = rest.split(SEPARATOR);
  if (segments.length > 1) return { id, literal: unquote(segments[0]), status: statusFrom(segments.slice(1).join(' — ')) };
  const explicit = /\s*\b(?:status|estado)\s*:/i.exec(rest);
  if (explicit && explicit.index > 0) return { id, literal: rest.slice(0, explicit.index).trim(), status: statusFrom(rest.slice(explicit.index)) };
  return { id, literal: unquote(rest), status: null };
}

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isSeparatorRow = cells => cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/.test(cell));

function parseTables(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) block.push(splitRow(lines[i++]));
    let rows = block, cols = { id: 0, literal: 1, status: 2 };
    if (block.length > 1 && isSeparatorRow(block[1])) {
      const header = block[0].map(cell => cell.toLowerCase());
      const find = pattern => header.findIndex(cell => pattern.test(cell));
      const literal = find(/literal|pedido|requirement|requisito|request|item|text|descrip/);
      const id = find(/^(?:#|id|req\.?|n|no\.?|nº)$/);
      if (literal < 0 && id < 0) continue;
      const status = find(/status|estado|state/);
      cols = { id, literal: literal >= 0 ? literal : id + 1, status };
      rows = block.slice(2);
    }
    for (const row of rows) {
      if (isSeparatorRow(row)) continue;
      const literal = unquote(row[cols.literal] ?? '');
      if (!literal) continue;
      const rawId = cols.id >= 0 ? (row[cols.id] ?? '').replace(/^#/, '') : '';
      const status = cols.status >= 0 ? row[cols.status] ?? null : null;
      items.push({ id: rawId || null, literal, status: status ? status.slice(0, MAX_STATUS) : null });
    }
  }
  return items;
}

// Numbered ("1. ...", "2) ...") and bulleted ("- ...", "- [x] ...") first lines.
export function parseListItems(text) {
  const numbered = [], bullets = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const number = /^\s{0,3}(\d{1,3})[.)]\s+(\S.*)$/.exec(line);
    if (number) { numbered.push({ n: Number(number[1]), ...parseItemText(number[2]) }); continue; }
    const bullet = /^\s{0,3}[-*+]\s+(?:\[([ xX])\]\s+)?(\S.*)$/.exec(line);
    if (bullet) {
      const item = parseItemText(bullet[2]);
      if (bullet[1] && !item.status) item.status = bullet[1] === ' ' ? 'pending' : 'completed';
      bullets.push(item);
    }
  }
  return { numbered, bullets };
}

// Assigns stable, unique ids: numeric ids become R<n>, missing ids <prefix><position>.
export function normalizeItems(items, prefix = 'R') {
  const used = new Set(), out = [];
  items.forEach((item, index) => {
    if (out.length >= MAX_REQUIREMENTS) return;
    const literal = literalOf(item.literal ?? '');
    if (!literal) return;
    let id = String(item.id ?? '').trim();
    if (/^\d+$/.test(id)) id = `R${id}`;
    if (!id) id = `${prefix}${item.n ?? index + 1}`;
    id = id.slice(0, 36);
    let unique = id;
    for (let k = 2; used.has(unique); k++) unique = `${id}-${k}`;
    used.add(unique);
    out.push({ id: unique, literal, status: typeof item.status === 'string' && item.status.trim() ? item.status.trim().slice(0, MAX_STATUS) : null });
  });
  return out;
}

// Priority inside a checklist: table rows, then numbered items, then bullets.
export function parseChecklist(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const table = parseTables(lines);
  if (table.length) return normalizeItems(table);
  const { numbered, bullets } = parseListItems(text);
  return normalizeItems(numbered.length ? numbered : bullets);
}

function parseRequirementsJson(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(json?.items) ? json.items : Array.isArray(json?.requirements) ? json.requirements : null;
  if (!list) return null;
  const items = list.filter(item => item && typeof item === 'object').map(item => ({
    id: typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : null,
    literal: [item.literal, item.text, item.request, item.requirement].find(value => typeof value === 'string') ?? '',
    status: typeof item.status === 'string' ? item.status : null,
  }));
  const requirements = normalizeItems(items);
  return requirements.length ? { requirements, title: typeof json.title === 'string' ? json.title : null } : null;
}

const titleOf = (markdown, fallback) => {
  const heading = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m.exec(markdown ?? '');
  return cap(scrub(heading ? heading[1] : fallback).replace(/\s+/g, ' ').trim() || fallback, MAX_TITLE);
};

// Strings that link a chat to this contract (matched case-insensitively with / separators).
export const mentionsOf = folder => [folder, `agent-work/${folder}/checklist.md`];

export function readContracts({ dir = DEFAULT_CONTRACTS_DIR } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const contracts = [];
  for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = entry.name;
    const checklist = readBounded(path.join(dir, folder, 'checklist.md'));
    const json = readBounded(path.join(dir, folder, 'requirements.json'));
    if (checklist === null && json === null) continue;
    const fromJson = json === null ? null : parseRequirementsJson(json);
    const requirements = fromJson?.requirements ?? parseChecklist(checklist ?? '');
    const title = checklist !== null ? titleOf(checklist, folder) : titleOf(fromJson?.title ? `# ${fromJson.title}` : '', folder);
    contracts.push({ folder, title, requirements, mentions: mentionsOf(folder) });
  }
  return contracts;
}
