// E1: private incremental extractor of Claude and Codex transcripts into the
// Relay Evals store. Provider files are opened read-only and never modified;
// records hold only redacted user messages, metadata, classified tool events,
// tokens and compactions (see evals/schema/chat-record.schema.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from './schema.mjs';
import { parseClaude } from './sources/claude.mjs';
import { parseCodex } from './sources/codex.mjs';
import { throwIfAborted } from './sources/lines.mjs';

const MAX_DEPTH = 12;
const DEFAULT_MAX_LINE = 8 * 1024 * 1024;

// Regular *.jsonl files below a root; symlinks/junctions are never followed.
function walk(root, provider, out) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { return; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) visit(full, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.lstatSync(full);
        if (stat.isFile()) out.push({ provider, file: full, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
      } catch { /* Rotated away between listing and stat. */ }
    }
  };
  visit(root, 0);
}

export function discoverSources({ home = os.homedir() } = {}) {
  const out = [];
  walk(path.join(home, '.claude', 'projects'), 'claude', out);
  walk(path.join(home, '.codex', 'sessions'), 'codex', out);
  walk(path.join(home, '.codex', 'archived_sessions'), 'codex', out);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const isAbort = (error, signal) => error?.name === 'AbortError' || (signal?.aborted && error === signal.reason);
// Short, non-secret failure detail: error codes only, never messages that may carry paths.
const failure = error => typeof error?.code === 'string' ? `read failed: ${error.code}`.slice(0, 120) : 'parse failed';

export async function extractFile({ provider, file, signal, maxLineBytes = DEFAULT_MAX_LINE }) {
  if (!['claude', 'codex'].includes(provider)) return { record: null, status: 'error', detail: 'unknown provider' };
  let builder;
  try {
    builder = await (provider === 'claude' ? parseClaude : parseCodex)(file, { signal, maxLineBytes });
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    return { record: null, status: 'error', detail: failure(error) };
  }
  if (!builder.turns.length && !builder.userMessages.length) return { record: null, status: 'empty', detail: 'no user messages or turns' };
  if (!builder.sessionId) return { record: null, status: 'error', detail: 'no session id' };
  const record = builder.build();
  const errors = validate('chat-record', record);
  // Schema errors name fields and limits, never values.
  if (errors.length) return { record: null, status: 'error', detail: `invalid record: ${errors[0]}`.slice(0, 200) };
  return record.coverage.complete
    ? { record, status: 'ok', detail: null }
    : { record, status: 'partial', detail: `${record.coverage.skippedLines} unparseable, ${record.coverage.oversizedLines} oversized lines` };
}

// Keep the existing record when it has more turns, or as many and a newer or equal end.
function keepExisting(existing, candidate) {
  if (existing.turns.length !== candidate.turns.length) return existing.turns.length > candidate.turns.length;
  return (existing.endedAt || '') >= (candidate.endedAt || '');
}

// Bump when extraction output changes: every file is read again once.
// 2: directories normalized with localDir (file: URLs, /c/ paths).
// 3: commit SHAs from quiet commits followed by a one-line log or rev-parse.
export const EXTRACTOR_VERSION = 3;

export async function extractAll({ store, home = os.homedir(), signal, onProgress, maxLineBytes = DEFAULT_MAX_LINE } = {}) {
  if (!store) throw new Error('extractAll needs an open evals store.');
  const current = store.getMeta('extractorVersion') === EXTRACTOR_VERSION;
  const sources = discoverSources({ home });
  const totals = { files: sources.length, processed: 0, unchanged: 0, partial: 0, empty: 0, errors: 0, chats: 0 };
  for (let index = 0; index < sources.length; index += 1) {
    throwIfAborted(signal);
    const { provider, file, size, mtimeMs } = sources[index];
    const checkpoint = store.checkpoint(file);
    // Windows can keep a stale mtime on open files, so a size change alone also counts.
    if (current && checkpoint && checkpoint.size === size && checkpoint.mtimeMs === mtimeMs) {
      totals.unchanged += 1;
    } else {
      totals.processed += 1;
      const { record, status, detail } = await extractFile({ provider, file, signal, maxLineBytes });
      const where = { path: file, provider, size, mtimeMs };
      if (record) {
        if (status === 'partial') totals.partial += 1;
        const existing = store.chat(record.id);
        // Claude can move a resumed chat between project folders: the richer copy wins,
        // and both files are checkpointed.
        if (existing && existing.sourceKey !== record.sourceKey && keepExisting(existing, record)) store.markFile({ ...where, chatId: record.id, status, detail });
        else store.saveChat(record, where);
      } else {
        if (status === 'empty') totals.empty += 1; else totals.errors += 1;
        store.markFile({ ...where, status, detail });
      }
    }
    onProgress?.({ done: index + 1, total: sources.length, processed: totals.processed, unchanged: totals.unchanged });
  }
  if (!current) store.setMeta('extractorVersion', EXTRACTOR_VERSION);
  totals.chats = store.chatCount();
  return totals;
}
