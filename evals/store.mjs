// Private Relay Evals dataset: one SQLite file outside Git. Records are validated
// against evals/schema/*.schema.json before they are written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertValid } from './schema.mjs';

// %LOCALAPPDATA%/chats-dashboard/evals unless RELAY_EVALS_HOME is set (tests always set it).
export function evalsHome(env = process.env) {
  if (env.RELAY_EVALS_HOME) return path.resolve(env.RELAY_EVALS_HOME);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'chats-dashboard', 'evals');
}

// <evals home>/reports unless RELAY_EVALS_REPORTS is set. Labeling kits and label checks
// live next to it (labeling/, label-check/).
export function reportsDir(env = process.env) {
  if (env.RELAY_EVALS_REPORTS) return path.resolve(env.RELAY_EVALS_REPORTS);
  return path.join(evalsHome(env), 'reports');
}

const SCHEMA = `
 pragma journal_mode=WAL; pragma synchronous=NORMAL;
 create table if not exists checkpoints (path text primary key, provider text not null, size integer not null,
   mtimeMs integer not null, chatId text, status text not null, detail text, extractedAt integer not null);
 create table if not exists chats (id text primary key, provider text not null, startedAt text, endedAt text,
   automated integer not null, record text not null);
 create index if not exists chats_started on chats(startedAt);
 create table if not exists metrics (id text primary key, startedAt text, week text, computedAt integer not null, record text not null);
 create index if not exists metrics_week on metrics(week);
 create table if not exists tasks (id text primary key, record text not null);
 create table if not exists meta (key text primary key, value text not null);
 create table if not exists labels (key text primary key, model text not null, label text not null, labeledAt integer not null);`;

export class EvalsStore {
  constructor({ home = evalsHome() } = {}) {
    fs.mkdirSync(home, { recursive: true });
    this.home = home;
    this.db = new DatabaseSync(path.join(home, 'dataset.sqlite'));
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('begin');
    try { const value = fn(); this.db.exec('commit'); return value; } catch (error) { this.db.exec('rollback'); throw error; }
  }

  // Checkpoint per provider file: path, size and mtime. Unchanged files are skipped.
  checkpoint(file) { return this.db.prepare('select * from checkpoints where path=?').get(file) ?? null; }
  checkpoints() { return this.db.prepare('select path,provider,size,mtimeMs,chatId,status,detail,extractedAt from checkpoints').all(); }
  markFile({ path: file, provider, size, mtimeMs, chatId = null, status, detail = null }) {
    if (!['ok', 'partial', 'error', 'empty'].includes(status)) throw new Error('Invalid checkpoint status.');
    this.db.prepare(`insert into checkpoints values(?,?,?,?,?,?,?,?) on conflict(path) do update set provider=excluded.provider,
      size=excluded.size,mtimeMs=excluded.mtimeMs,chatId=excluded.chatId,status=excluded.status,detail=excluded.detail,extractedAt=excluded.extractedAt`)
      .run(file, provider, size, Math.trunc(mtimeMs), chatId, status, detail, Date.now());
  }
  // Saves a chat record and its file checkpoint atomically.
  saveChat(record, file) {
    assertValid('chat-record', record);
    this.transaction(() => {
      this.db.prepare(`insert into chats values(?,?,?,?,?,?) on conflict(id) do update set provider=excluded.provider,
        startedAt=excluded.startedAt,endedAt=excluded.endedAt,automated=excluded.automated,record=excluded.record`)
        .run(record.id, record.provider, record.startedAt, record.endedAt, Number(record.automated), JSON.stringify(record));
      if (file) this.markFile({ ...file, chatId: record.id, status: record.coverage.complete ? 'ok' : 'partial' });
    });
  }
  chat(id) { const row = this.db.prepare('select record from chats where id=?').get(id); return row ? JSON.parse(row.record) : null; }
  // Iterates records without loading the whole dataset into memory.
  *chats({ automated } = {}) {
    const sql = automated === undefined ? 'select record from chats order by startedAt' : 'select record from chats where automated=? order by startedAt';
    const statement = this.db.prepare(sql);
    for (const row of automated === undefined ? statement.iterate() : statement.iterate(Number(automated))) yield JSON.parse(row.record);
  }
  chatCount() { return this.db.prepare('select count(*) n from chats').get().n; }
  // Coverage counters without loading records into memory.
  chatStats({ from, to } = {}) {
    const row = this.db.prepare(`select count(*) chatsTotal, sum(automated=0) chatsInteractive,
      sum(automated=0 and startedAt>=? and startedAt<?) chatsInPeriod, min(startedAt) firstChatAt, max(startedAt) lastChatAt from chats`)
      .get(from ?? '', to ?? '');
    return { chatsTotal: row.chatsTotal, chatsInteractive: row.chatsInteractive ?? 0, chatsInPeriod: row.chatsInPeriod ?? 0,
      firstChatAt: row.firstChatAt ?? null, lastChatAt: row.lastChatAt ?? null };
  }

  saveMetrics(record) {
    assertValid('chat-metrics', record);
    this.db.prepare(`insert into metrics values(?,?,?,?,?) on conflict(id) do update set startedAt=excluded.startedAt,
      week=excluded.week,computedAt=excluded.computedAt,record=excluded.record`)
      .run(record.id, record.startedAt, record.week, Date.now(), JSON.stringify(record));
  }
  metricsFor(id) { const row = this.db.prepare('select record from metrics where id=?').get(id); return row ? JSON.parse(row.record) : null; }
  *metrics() { for (const row of this.db.prepare('select record from metrics order by startedAt').iterate()) yield JSON.parse(row.record); }

  // The catalog is rebuilt as a whole so excluded/removed tasks never linger.
  replaceTasks(tasks) {
    for (const task of tasks) assertValid('task', task);
    this.transaction(() => {
      this.db.exec('delete from tasks');
      const insert = this.db.prepare('insert into tasks values(?,?)');
      for (const task of tasks) insert.run(task.id, JSON.stringify(task));
    });
  }
  tasks() { return this.db.prepare('select record from tasks order by id').all().map(row => JSON.parse(row.record)); }

  // Claude labels of follow-up messages, keyed by a hash of prompt version, model and message (claude-labels.mjs).
  label(key) { const row = this.db.prepare('select label from labels where key=?').get(key); return row ? JSON.parse(row.label) : null; }
  saveLabels(entries) {
    this.transaction(() => {
      const insert = this.db.prepare('insert into labels values(?,?,?,?) on conflict(key) do update set model=excluded.model,label=excluded.label,labeledAt=excluded.labeledAt');
      for (const { key, model, label } of entries) insert.run(key, model, JSON.stringify(label), Date.now());
    });
  }

  getMeta(key) { const row = this.db.prepare('select value from meta where key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setMeta(key, value) { this.db.prepare('insert into meta values(?,?) on conflict(key) do update set value=excluded.value').run(key, JSON.stringify(value)); }
}

export const openStore = options => new EvalsStore(options);
