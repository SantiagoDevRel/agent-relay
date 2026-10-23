// Shared chat-record assembly for both providers. Every stored string passes
// through redact(); only bounded text is kept, so memory does not grow with the
// size of tool outputs in the transcript.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { redact } from '../redact.mjs';
import { placeOf } from '../../server/places.mjs';
import { classifyCommand, commitShas, localDir, toolCategory } from './shell.mjs';

export const MESSAGE_LIMIT = 4000;
export const FINAL_LIMIT = 600;
const REDACT_MARGIN = 1024; // Secrets straddling the cut are still redacted before truncation.
const MAX_EVENTS = 500;
const MAX_PENDING = 1024;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN_KEYS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning'];

export const validSessionId = id => typeof id === 'string' && ID.test(id);
export const emptyTokens = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
export function isoOf(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function addTokens(target, delta) {
  for (const key of TOKEN_KEYS) target[key] += Math.max(0, Math.trunc(delta[key] || 0));
  target.total = target.input + target.output;
}

const newTools = () => ({ toolCalls: 0, toolErrors: 0, toolCounts: {}, events: [] });

export class ChatBuilder {
  constructor({ provider, file }) {
    this.provider = provider;
    this.sourceKey = createHash('sha256').update(String(file)).digest('hex');
    this.sessionId = null;
    this.cwd = null; this.gitBranch = null; this.entrypoint = null;
    this.startedAt = null; this.endedAt = null;
    this.automated = false; this.parentId = null;
    this.turns = []; this.userMessages = []; this.compactions = [];
    this.redactions = 0;
    this.coverage = { bytes: 0, lines: 0, skippedLines: 0, oversizedLines: 0, unknownEvents: 0 };
    this.model = null; this.effort = null; this.lastAt = null;
    this.pending = new Map(); // tool call id -> { turn, source, events, errored }
  }

  // Redacts, then truncates. `chars` is the original length.
  text(raw, limit) {
    const source = String(raw ?? '');
    const { text, count } = redact(source.length > limit + REDACT_MARGIN ? source.slice(0, limit + REDACT_MARGIN) : source);
    this.redactions += count;
    return { text: text.length > limit ? text.slice(0, limit) : text, chars: source.length };
  }
  shortValue(raw, limit) {
    if (raw == null || raw === '') return null;
    return this.text(String(raw), limit).text || null;
  }

  setCwd(cwd) { if (!this.cwd && typeof cwd === 'string' && cwd) this.cwd = this.shortValue(localDir(cwd), 1000); }
  setBranch(branch) { if (!this.gitBranch && typeof branch === 'string' && branch) this.gitBranch = this.shortValue(branch, 300); }
  setEntrypoint(value) { if (!this.entrypoint && typeof value === 'string' && value) this.entrypoint = value.slice(0, 64); }
  setParent(provider, id) { if (!this.parentId && validSessionId(id)) this.parentId = `${provider}:${id}`; }

  stamp(timestamp) {
    const at = isoOf(timestamp);
    this.lastAt = at; // Lines without a timestamp never extend a turn.
    if (!at) return null;
    if (!this.startedAt || at < this.startedAt) this.startedAt = at;
    if (!this.endedAt || at > this.endedAt) this.endedAt = at;
    this.lastAt = at;
    return at;
  }
  // Only activity of the turn itself extends it (not the next prompt's metadata lines).
  touch(turn) { if (turn && this.lastAt && (!turn.endedAt || this.lastAt > turn.endedAt)) turn.endedAt = this.lastAt; }

  openTurn(at, userChars = 0) {
    const turn = {
      i: this.turns.length, startedAt: at, endedAt: at, userChars, model: null, effort: null,
      interrupted: false, tokens: emptyTokens(), agentFinal: null,
      calls: newTools(), items: newTools(), models: new Set(), efforts: new Set(), active: false,
    };
    this.turns.push(turn);
    if (this.model) this.noteModel(this.model);
    if (this.effort) this.noteEffort(this.effort);
    return turn;
  }
  // Activity before any prompt (e.g. a resumed tail) opens an implicit turn.
  turn(at = null) { return this.turns.at(-1) || this.openTurn(at, 0); }

  addMessage(kind, raw, at) {
    if (kind === 'interrupt') {
      const turn = this.turns.at(-1);
      if (!turn) return;
      turn.interrupted = true;
      this.touch(turn);
      this.userMessages.push({ turn: turn.i, at, kind, text: '', chars: 0 });
      return;
    }
    const { text, chars } = this.text(raw, MESSAGE_LIMIT);
    const turn = this.openTurn(at, chars);
    this.userMessages.push({ turn: turn.i, at, kind, text, chars });
  }

  noteModel(model) {
    if (typeof model !== 'string' || !model || model === '<synthetic>') return;
    this.model = model.slice(0, 80);
    const turn = this.turns.at(-1);
    if (turn) { turn.model = this.model; turn.models.add(this.model); }
  }
  noteEffort(effort) {
    if (typeof effort !== 'string' || !effort) return;
    this.effort = effort.slice(0, 40);
    const turn = this.turns.at(-1);
    if (turn) { turn.effort = this.effort; turn.efforts.add(this.effort); }
  }
  // Codex turn_context arrives around the prompt; it describes the open turn
  // until that turn shows agent activity, and later turns afterwards.
  context(model, effort) {
    const turn = this.turns.at(-1);
    if (turn?.active) {
      if (typeof model === 'string' && model) this.model = model.slice(0, 80);
      if (typeof effort === 'string' && effort) this.effort = effort.slice(0, 40);
      return;
    }
    if (turn) { turn.models.clear(); turn.efforts.clear(); }
    this.noteModel(model); this.noteEffort(effort);
  }

  // Records one tool call. `command` (shell only) is classified and dropped.
  tool({ name, category = toolCategory(name), id = null, command = null, cwd = null, source = 'calls', at = null }) {
    const turn = this.turn(at);
    turn.active = true;
    this.touch(turn);
    const bucket = turn[source];
    bucket.toolCalls += 1;
    bucket.toolCounts[category] = (bucket.toolCounts[category] || 0) + 1;
    const events = [];
    if (category === 'shell' && command) {
      for (const event of classifyCommand(command, cwd)) {
        if (bucket.events.length >= MAX_EVENTS) break;
        const stored = { category: event.category, failed: null, cwd: event.cwd ? this.shortValue(event.cwd, 1000) : null };
        if (event.category === 'git-commit' || event.category === 'git-revert') stored.commits = [];
        bucket.events.push(stored); events.push(stored);
      }
    }
    if (id) {
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
      this.pending.set(id, { turn, source, events, errored: false });
    }
    return events;
  }

  // Applies a tool result. `failed` true/false/null; `output` only for SHA scanning.
  result({ id = null, failed = null, output = null, events = null, turn = null, source = 'calls' }) {
    const pending = id ? this.pending.get(id) : null;
    const target = pending?.turn || turn || this.turns.at(-1);
    const bucket = target?.[pending?.source || source];
    if (!bucket) return;
    this.touch(target);
    if (failed === true && !(pending?.errored)) {
      bucket.toolErrors += 1;
      if (pending) pending.errored = true;
    }
    const list = events || pending?.events || [];
    const shas = output && list.some(e => e.commits) ? commitShas(output) : [];
    for (const event of list) {
      if (failed !== null && (event.failed === null || failed)) event.failed = failed;
      if (event.commits && shas.length) for (const sha of shas) if (!event.commits.includes(sha) && event.commits.length < 20) event.commits.push(sha);
    }
  }
  forget(id) { if (id) this.pending.delete(id); }

  usage(delta, at = null) {
    if (!delta) return;
    const turn = this.turn(at);
    this.touch(turn);
    addTokens(turn.tokens, delta);
  }

  final(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const turn = this.turn();
    turn.active = true;
    this.touch(turn);
    turn.agentFinal = this.text(raw.trim(), FINAL_LIMIT);
  }

  compaction(at, trigger = 'unknown') {
    const turn = this.turns.at(-1);
    const index = turn ? turn.i : 0;
    const last = this.compactions.at(-1);
    // One compaction can appear as several Codex lines; count it once per turn and minute.
    if (last && last.turn === index && at && last.at && Math.abs(Date.parse(at) - Date.parse(last.at)) < 120000) {
      if (last.trigger === 'unknown' && trigger !== 'unknown') last.trigger = trigger;
      return;
    }
    this.compactions.push({ at, trigger: ['auto', 'manual'].includes(trigger) ? trigger : 'unknown', turn: index });
  }

  build() {
    if (!this.turns.length && !this.userMessages.length) return null;
    const counted = key => {
      const map = new Map();
      for (const turn of this.turns) for (const value of turn[key]) map.set(value, (map.get(value) || 0) + 1);
      return [...map].map(([value, turns]) => ({ value, turns })).sort((a, b) => b.turns - a.turns || a.value.localeCompare(b.value));
    };
    const tokens = emptyTokens();
    const turns = this.turns.map(turn => {
      const tools = turn.items.toolCalls ? turn.items : turn.calls;
      addTokens(tokens, turn.tokens);
      return {
        i: turn.i, startedAt: turn.startedAt, endedAt: turn.endedAt, userChars: turn.userChars,
        model: turn.model, effort: turn.effort, interrupted: turn.interrupted,
        toolCalls: tools.toolCalls, toolErrors: tools.toolErrors, toolCounts: { ...tools.toolCounts },
        events: tools.events.map(event => ({ ...event, ...(event.commits ? { commits: [...event.commits] } : {}) })),
        tokens: { ...turn.tokens }, agentFinal: turn.agentFinal,
      };
    });
    const { complete: _ignored, ...coverage } = this.coverage;
    return {
      schemaVersion: 1,
      id: `${this.provider}:${this.sessionId}`,
      provider: this.provider,
      sessionId: this.sessionId,
      sourceKey: this.sourceKey,
      cwd: this.cwd,
      project: this.cwd ? placeOf(this.cwd).folder.slice(0, 300) : null,
      gitBranch: this.gitBranch,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      entrypoint: this.entrypoint,
      automated: this.automated,
      parentId: this.parentId,
      models: counted('models').slice(0, 32),
      efforts: counted('efforts').slice(0, 16),
      userMessages: this.userMessages,
      turns,
      compactions: this.compactions,
      tokens,
      coverage: { complete: !coverage.skippedLines && !coverage.oversizedLines, ...coverage },
      redactions: this.redactions,
    };
  }
}

// Shared line loop: parses JSON lines, tracks coverage and hands records to `apply`.
// `skip(peek)` may drop known-irrelevant heavy lines before JSON parsing.
export async function consume(lines, builder, apply, skip = null) {
  for await (const line of lines) {
    builder.coverage.lines += 1;
    if (line.oversized) { builder.coverage.oversizedLines += 1; continue; }
    builder.coverage.bytes += Buffer.byteLength(line.text) + 1;
    if (!line.text.trim()) continue;
    if (skip?.(line.text.slice(0, 400))) continue;
    let entry;
    try { entry = JSON.parse(line.text); } catch { builder.coverage.skippedLines += 1; continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { builder.coverage.skippedLines += 1; continue; }
    apply(entry);
  }
}
