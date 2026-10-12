// Derived local FTS index. Never writes to provider data. Streamed in a worker,
// with a small yield per chunk so background indexing does not monopolize a CPU.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeConversation, codexConversation } from './summary.mjs';
import { normalizeCwd, placeOf, commandsFor } from './places.mjs';
import { deriveTitle } from './util.mjs';
import { createHash } from 'node:crypto';

fs.mkdirSync(path.dirname(workerData.file), { recursive: true });
const db = new DatabaseSync(workerData.file);
db.exec(`pragma journal_mode=WAL; pragma synchronous=NORMAL;
  create table if not exists files (key text primary key, file text, offset integer, size integer, mtime real, meta text);
  create virtual table if not exists messages using fts5(body, chat unindexed, role unindexed, ts unindexed, tokenize='unicode61 remove_diacritics 2');
  create table if not exists seen (hash text primary key, chat text);
  create index if not exists seen_chat on seen(chat);`);
const columns = db.prepare('pragma table_info(files)').all().map(c => c.name);
if (!columns.includes('skipped')) db.exec('alter table files add column skipped integer default 0');
if (!columns.includes('errors')) db.exec('alter table files add column errors integer default 0');
const insert = db.prepare('insert into messages(body, chat, role, ts) values(?,?,?,?)');
const remember = db.prepare('insert or ignore into seen(hash,chat) values(?,?)');
const save = db.prepare('insert into files(key,file,offset,size,mtime,meta) values(?,?,?,?,?,?) on conflict(key) do update set file=excluded.file,offset=excluded.offset,size=excluded.size,mtime=excluded.mtime,meta=excluded.meta');
let state = { phase: 'idle', files: 0, total: 0, bytes: 0, messages: Number(db.prepare('select count(*) as n from messages').get().n), skipped: 0, errors: 0 };
const publish = () => parentPort.postMessage({ state });
const names = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const stat = file => { const fd = fs.openSync(file, 'r'); try { return fs.fstatSync(fd); } finally { fs.closeSync(fd); } };

async function sources() {
  await delay(0);
  const result = new Map();
  const projects = path.join(workerData.home, '.claude', 'projects');
  for (const dir of names(projects)) {
    if (!dir.isDirectory()) continue;
    for (const entry of names(path.join(projects, dir.name))) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(entry.name)) continue;
      const file = path.join(projects, dir.name, entry.name);
      try {
        const st = fs.statSync(file), id = entry.name.slice(0, -6), key = `claude:${id}`;
        if ((result.get(key)?.st.mtimeMs ?? -1) > st.mtimeMs) continue;
        result.set(key, { key, id, tool: 'claude', file, st, title: '', cwd: '', automated: false });
      } catch { state.errors++; }
    }
    state.total = result.size; publish(); await delay(1);
  }
  const codex = path.join(workerData.home, '.codex');
  const newest = names(codex).map(e => e.name).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a,b) => +b.match(/\d+/)[0] - +a.match(/\d+/)[0])[0];
  if (newest) {
    const source = new DatabaseSync(path.join(codex, newest), { readOnly: true });
    try {
      for (const row of source.prepare('select id, name, title, first_user_message, cwd, rollout_path, source from threads').all()) {
        try {
          const file = normalizeCwd(row.rollout_path);
          const key = `codex:${row.id}`;
          result.set(key, { key, id: row.id, tool: 'codex', file, st: fs.statSync(file), cwd: normalizeCwd(row.cwd),
            title: row.name || deriveTitle(row.title || row.first_user_message || ''), automated: row.source === 'exec' || String(row.source).includes('subagent') });
        } catch { state.errors++; }
        if (result.size % 50 === 0) { state.total = result.size; publish(); await delay(1); }
      }
    } finally { source.close(); }
  }
  return [...result.values()].sort((a,b) => b.st.mtimeMs - a.st.mtimeMs);
}

function publicMeta(source) {
  const { id, tool, title, cwd, automated, seenUser = false } = source;
  return { id, tool, title: title || 'Untitled', cwd, seenUser, ...placeOf(cwd), ...commandsFor(tool, cwd, id), automated };
}

let indexing = null, lastScan = 0;
async function index() {
  const started = Date.now();
  state = { ...state, phase: 'indexing', files: 0, bytes: 0, skipped: 0, errors: 0 };
  publish();
  try {
    const list = await sources(); state.total = list.length; publish();
    for (const source of list) {
      try { source.st = stat(source.file); } catch { state.errors++; state.files++; continue; }
      if (state.files % 25 === 0) await delay(1);
      const old = db.prepare('select file, offset, size, mtime, meta, skipped, errors from files where key=?').get(source.key);
      if (old && !old.errors && old.file === source.file && old.size === source.st.size && old.mtime === source.st.mtimeMs) { state.files++; state.skipped += old.skipped; continue; }
      let offset = old?.offset || 0;
      let skipped = old?.skipped || 0, errors = 0;
      // Replace only this app's derived rows when a source was rewritten/moved.
      if (!old || old.file !== source.file || source.st.size < offset || (source.st.size === old.size && old.mtime !== source.st.mtimeMs)) {
        db.prepare('delete from messages where chat=?').run(source.key); offset = 0;
        db.prepare('delete from seen where chat=?').run(source.key);
        skipped = 0;
      }
      if (old && offset) Object.assign(source, JSON.parse(old.meta));
      let carry = Buffer.alloc(0), consumed = offset, discard = false;
      const stream = fs.createReadStream(source.file, { start: offset, end: Math.max(0, source.st.size - 1), highWaterMark: 256 * 1024 });
      try {
        for await (const chunk of stream) {
          const chunkStarted = performance.now();
          state.bytes += chunk.length;
          const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
          let start = 0, end;
          db.exec('begin');
          try {
            while ((end = buf.indexOf(10, start)) >= 0) {
              const raw = buf.subarray(start, end);
              consumed += end - start + 1; start = end + 1;
              if (discard) { discard = false; continue; }
              // Most Codex bytes are tool output, not conversation. Avoid
              // decoding/parsing these potentially huge JSON payloads.
              if (source.tool === 'codex' && /^\s*\{\s*"timestamp"\s*:\s*"[^"]+"\s*,\s*"type"\s*:\s*"response_item"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"(?:function_call_output|custom_tool_call_output|function_call|custom_tool_call|reasoning)"/.test(raw.subarray(0, 512).toString('utf8'))) continue;
              const line = raw.toString('utf8');
              let e;
              try { e = JSON.parse(line); } catch { if (line.trim()) skipped++; continue; }
                if (source.tool === 'claude') {
                  source.cwd ||= e.cwd || '';
                  if (e.customTitle) source.title = e.customTitle;
                  if (e.slug && !source.title) source.title = e.slug;
                  if (e.entrypoint === 'sdk-cli') source.automated = true;
                }
                const conv = (source.tool === 'claude' ? claudeConversation : codexConversation)([e]);
                for (const m of conv.messages) {
                  if (m.role === 'user' && !source.seenUser) {
                    source.seenUser = true;
                    if (source.tool === 'claude' && m.text.startsWith('<!-- ai-pack')) source.automated = true;
                  }
                  if (!source.title && m.role === 'user') source.title = deriveTitle(m.text);
                  // New and legacy Codex events can carry the same message.
                  const hash = createHash('sha256').update(`${source.key}:${m.role}:${Math.floor(m.ts / 5000)}:${m.text}`).digest('hex');
                  const added = remember.run(hash, source.key).changes;
                  if (added) insert.run(m.text, source.key, m.role, m.ts);
                }
            }
            carry = buf.subarray(start);
            if (carry.length > 16 * 1024 * 1024) { consumed += carry.length; carry = Buffer.alloc(0); discard = true; skipped++; }
            save.run(source.key, source.file, consumed, source.st.size, source.st.mtimeMs, JSON.stringify(publicMeta(source)));
            db.exec('commit');
          } catch (err) { db.exec('rollback'); throw err; }
          // At most roughly 25% of one CPU core, independent of source size.
          await delay(Math.max(10, (performance.now() - chunkStarted) * 3));
          if (Date.now() - (state.updatedAt || 0) > 300) { state.updatedAt = Date.now(); publish(); }
        }
      } catch { errors++; }
      state.skipped += skipped; state.errors += errors;
      db.prepare('update files set skipped=?,errors=? where key=?').run(skipped, errors, source.key);
      state.files++; publish();
    }
    state.messages = Number(db.prepare('select count(*) as n from messages').get().n);
    state.phase = 'ready'; state.elapsedMs = Date.now() - started; lastScan = Date.now();
  } catch (err) { state.phase = 'error'; state.error = err.message; }
  publish();
}

export function searchQuery(query) {
  return (String(query).match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12).map(w => `"${w}"*`).join(' AND ');
}
parentPort.on('message', async ({ request, action, query = '', offset = 0, automated = false }) => {
  try {
    if (!indexing && (action === 'refresh' || Date.now() - lastScan > 30_000)) { indexing = index().finally(() => { indexing = null; }); }
    if (action === 'refresh') { await indexing; parentPort.postMessage({ request, result: state }); return; }
    if (action === 'search') {
      const match = searchQuery(query);
      if (!match) { parentPort.postMessage({ request, result: { results: [], total: 0, state } }); return; }
      const where = `messages match ? ${automated ? '' : "and json_extract(f.meta, '$.automated') = 0"}`;
      const rows = db.prepare(`select m.rowid, m.role, m.ts, snippet(messages,0,'','', ' … ',40) as excerpt, f.meta
        from messages m join files f on f.key=m.chat where ${where} order by rank limit 20 offset ?`).all(match, offset);
      const total = Number(db.prepare(`select count(*) as n from messages m join files f on f.key=m.chat where ${where}`).get(match).n);
      parentPort.postMessage({ request, result: { results: rows.map(r => {
        const { cwd, seenUser, ...meta } = JSON.parse(r.meta);
        return { ...meta, rowid: r.rowid, role: r.role, ts: r.ts, excerpt: r.excerpt };
      }), total, state } });
    }
  } catch (err) { parentPort.postMessage({ request, error: err.message }); }
});
publish();
