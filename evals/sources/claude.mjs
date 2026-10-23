// Claude Code transcript parser (~/.claude/projects/<project>/<id>.jsonl and
// <id>/subagents/agent-*.jsonl). Read-only; keeps only bounded, redacted text.
import path from 'node:path';
import { tokens } from '../../server/usage.mjs';
import { readLines } from './lines.mjs';
import { ChatBuilder, consume, validSessionId } from './record.mjs';

const KNOWN = new Set(['user', 'assistant', 'system', 'summary', 'attachment', 'api-request', 'api-request-blob',
  'api-request-shape', 'last-prompt', 'atis-latch', 'mode', 'isolation-latch', 'queue-operation', 'file-history-snapshot',
  'file-history-delta', 'cost-state', 'ai-title', 'custom-title', 'progress', 'tag', 'agent-name', 'pr-link',
  'permission-mode', 'launched', 'started', 'result', 'fork-context-ref', 'artifact-comment-monitor',
  'artifact-autoreact-ledger', 'frame-link', 'relocated', 'worktree-state']);
// Heavy lines that never carry evals data; skipped before JSON parsing when the type is near the start.
const HEAVY = /"type"\s*:\s*"(?:api-request-blob|api-request-shape|file-history-snapshot|file-history-delta)"/;
const USAGE_MEMORY = 256; // Recent message ids: one response is split into consecutive lines.

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';

// Removes injected blocks; returns { kind, text } or null when nothing human remains.
export function humanText(raw) {
  let text = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  text = text.replace(/<local-command-(?:stdout|stderr|caveat)>[\s\S]*?<\/local-command-(?:stdout|stderr|caveat)>/g, '');
  const command = /<command-name>\s*([^<]{1,200}?)\s*<\/command-name>/.exec(text);
  if (command) return { kind: 'command', text: command[1] };
  text = text.replace(/<command-(?:message|args)>[\s\S]*?<\/command-(?:message|args)>/g, '').trim();
  if (!text || text.startsWith('<task-notification') || text.startsWith('<local-command')) return null;
  return { kind: 'prompt', text };
}

function isHumanOrigin(entry) {
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false;
  if (entry.turnOrigin && !['human', 'sdk'].includes(entry.turnOrigin)) return false;
  if (entry.origin?.kind && entry.origin.kind !== 'human') return false;
  return entry.promptSource !== 'system';
}

export async function parseClaude(file, { signal, maxLineBytes } = {}) {
  const builder = new ChatBuilder({ provider: 'claude', file });
  const parts = path.resolve(file).split(/[\\/]/);
  const stem = path.basename(file, '.jsonl');
  builder.sessionId = validSessionId(stem) ? stem : null;
  const subagentAt = parts.lastIndexOf('subagents');
  if (subagentAt > 0) { builder.automated = true; builder.setParent('claude', parts[subagentAt - 1]); }
  if (stem.startsWith('agent-')) builder.automated = true;
  const seenUsage = new Map();
  let firstPrompt = true;

  const onUser = (entry, at) => {
    const content = entry.message?.content;
    const results = Array.isArray(content) ? content.filter(block => block?.type === 'tool_result') : [];
    for (const block of results) {
      const output = [textOf(block.content), typeof entry.toolUseResult?.stdout === 'string' ? entry.toolUseResult.stdout : ''].join('\n');
      builder.result({ id: block.tool_use_id, failed: block.is_error === true, output });
      builder.forget(block.tool_use_id);
    }
    const raw = textOf(content);
    if (raw.trim().startsWith('[Request interrupted')) { builder.addMessage('interrupt', '', at); return; }
    if (results.length || !isHumanOrigin(entry)) return;
    const human = humanText(raw);
    if (!human) return;
    if (firstPrompt && human.kind === 'prompt') {
      firstPrompt = false;
      if (human.text.startsWith('<!-- ai-pack')) builder.automated = true;
    }
    builder.addMessage(human.kind, human.text, at);
  };

  const onAssistant = (entry, at) => {
    const message = entry.message || {};
    builder.noteModel(message.model);
    builder.noteEffort(typeof entry.perTurnEffort === 'string' ? entry.perTurnEffort : entry.effort);
    const usage = tokens('claude', message.usage);
    if (usage) {
      // Same accounting as usage-worker: one response id counts once, with monotonic component maxima.
      const previous = message.id ? seenUsage.get(message.id) : null;
      const delta = {};
      for (const key of ['input', 'cached', 'cacheWrite', 'output', 'reasoning']) delta[key] = Math.max(0, usage[key] - (previous?.[key] || 0));
      if (message.id) {
        const merged = previous ? Object.fromEntries(Object.keys(delta).map(key => [key, Math.max(previous[key], usage[key])])) : usage;
        seenUsage.delete(message.id); seenUsage.set(message.id, merged);
        if (seenUsage.size > USAGE_MEMORY) seenUsage.delete(seenUsage.keys().next().value);
      }
      builder.usage(delta, at);
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const command = typeof block.input?.command === 'string' ? block.input.command : null;
      builder.tool({ name: block.name, id: block.id, command, at });
    }
    const text = textOf(content);
    if (text.trim() && !entry.isApiErrorMessage) builder.final(text);
  };

  const apply = entry => {
    const at = builder.stamp(entry.timestamp);
    if (entry.cwd) builder.setCwd(entry.cwd);
    if (entry.gitBranch) builder.setBranch(entry.gitBranch);
    if (entry.entrypoint) builder.setEntrypoint(entry.entrypoint);
    if (entry.entrypoint === 'sdk-cli' || entry.isSidechain === true) builder.automated = true;
    // Sidechain transcripts carry their parent's session id.
    if ((entry.isSidechain === true || stem.startsWith('agent-')) && !builder.parentId && entry.sessionId && entry.sessionId !== builder.sessionId) builder.setParent('claude', entry.sessionId);
    if (entry.type === 'user') onUser(entry, at);
    else if (entry.type === 'assistant') onAssistant(entry, at);
    else if (entry.type === 'system' && entry.subtype === 'compact_boundary') builder.compaction(at, entry.compactMetadata?.trigger || 'unknown');
    else if (entry.type === 'api-request') builder.noteEffort(entry.params?.output_config?.effort);
    else if (!KNOWN.has(entry.type)) builder.coverage.unknownEvents += 1;
  };

  await consume(readLines(file, { signal, maxLineBytes }), builder, apply, peek => HEAVY.test(peek));
  return builder;
}
