// Codex rollout parser (~/.codex/sessions/**/rollout-*.jsonl and archived_sessions).
// Supports the current item_completed items, the classic event_msg/response_item
// shapes and the oldest top-level response items. Read-only; bounded text only.
import path from 'node:path';
import { tokens } from '../../server/usage.mjs';
import { readLines } from './lines.mjs';
import { ChatBuilder, consume, validSessionId } from './record.mjs';
import { exitCodeOf } from './shell.mjs';

const IGNORED = new Set(['token_usage_record', 'world_state', 'inter_agent_communication_metadata']);
const LEGACY_ITEMS = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'local_shell_call', 'reasoning', 'web_search_call']);
const HEAVY = /"type"\s*:\s*"response_item"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"reasoning"/;
const INJECTED_BLOCK = /<(environment_context|user_instructions|permissions instructions|user_shell_command|turn_aborted|subagent_notification|collaboration_mode)\b[^>]*>[\s\S]*?<\/\1>/g;
const INJECTED_START = /^(?:# AGENTS\.md instructions|<environment_context|<user_instructions|<permissions|<INSTRUCTIONS>|<developer)/;
const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const ZERO = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

const contentText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n') : '';

export function codexPrompt(raw) {
  const text = String(raw || '').replace(INJECTED_BLOCK, '').trim();
  return !text || INJECTED_START.test(text) ? null : text;
}

function shellCommand(_name, args, fallback) {
  const value = args?.command ?? args?.cmd ?? fallback;
  if (Array.isArray(value)) {
    const list = value.map(String);
    return list.length >= 3 && /(?:^|[\\/])(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i.test(list[0]) && /^-(?:l?c|Command)$/i.test(list[1]) ? list.slice(2).join(' ') : list.join(' ');
  }
  return typeof value === 'string' ? value : null;
}
const parseArgs = raw => { if (raw && typeof raw === 'object') return raw; try { return JSON.parse(raw); } catch { return null; } };

export async function parseCodex(file, { signal, maxLineBytes } = {}) {
  const builder = new ChatBuilder({ provider: 'codex', file });
  const fromName = UUID_IN_NAME.exec(path.basename(file))?.[1];
  let metaSeen = false, forked = false, last = null, epoch = 0, lastPrompt = null;

  const prompt = (raw, at) => {
    const text = codexPrompt(raw);
    if (!text) return;
    // The same prompt arrives as user_message and as an item_completed UserMessage.
    if (lastPrompt && lastPrompt.text === text && lastPrompt.epoch === epoch) return;
    if (!lastPrompt && text.startsWith('<!-- ai-pack')) builder.automated = true;
    lastPrompt = { text, epoch };
    builder.addMessage('prompt', text, at);
  };

  const meta = (p) => {
    if (metaSeen) return; // Forks can replay the parent's session_meta later in the file.
    metaSeen = true;
    if (validSessionId(p.id)) builder.sessionId = p.id;
    builder.setCwd(p.cwd);
    builder.setBranch(p.git?.branch);
    const source = p.source;
    builder.setEntrypoint(p.originator || (typeof source === 'string' ? source : source && typeof source === 'object' ? Object.keys(source)[0] : null));
    forked = Boolean(p.forked_from_id || p.parent_thread_id || p.forkedFromId || (source && typeof source === 'object' && source.subagent));
    if (forked || source === 'exec' || p.originator === 'codex_exec' || (source && typeof source === 'object') || p.thread_source === 'subagent') builder.automated = true;
    builder.setParent('codex', p.parent_thread_id || p.forked_from_id || p.forkedFromId);
  };

  const usage = (info, at) => {
    const total = tokens('codex', info?.total_token_usage);
    if (!total) return;
    // Forks inherit the parent's cumulative totals: the first total is a baseline.
    if (!last && forked) { last = total; return; }
    const before = last || ZERO;
    last = total;
    if (total.input < before.input || total.output < before.output) return; // Reset: rebaseline.
    builder.usage(Object.fromEntries(Object.keys(ZERO).map(key => [key, Math.max(0, total[key] - before[key])])), at);
  };

  const itemTool = (item, at) => {
    const add = (name, category, failed, extra = {}) => {
      const events = builder.tool({ name, category, source: 'items', at, ...extra });
      builder.result({ failed, events, source: 'items', output: extra.output ?? null });
    };
    switch (item.type) {
      case 'UserMessage': return prompt(contentText(item.content), at);
      case 'AgentMessage': return builder.final(contentText(item.content));
      case 'CommandExecution': {
        const failed = Number.isInteger(item.exit_code) ? item.exit_code !== 0 : item.status === 'failed' ? true : item.status === 'completed' ? false : null;
        const events = builder.tool({ name: 'CommandExecution', category: 'shell', command: shellCommand('', { command: item.command }), cwd: typeof item.cwd === 'string' ? item.cwd : null, source: 'items', at });
        return builder.result({ failed, events, source: 'items', output: item.aggregated_output ?? item.stdout ?? null });
      }
      case 'FileChange': return add('FileChange', 'edit', ['failed', 'declined'].includes(item.status) ? true : item.status ? false : null);
      case 'ImageView': return add('ImageView', 'read', null);
      case 'McpToolCall': return add(`mcp__${item.server || 'unknown'}__${item.tool || 'tool'}`, undefined, item.status === 'failed' || item.result?.isError === true ? true : item.status ? false : null);
      case 'Extension': return add('Extension', item.query || item.action ? 'web' : 'other', null);
      case 'WebSearch': return add('WebSearch', 'web', null);
      case 'SubAgentActivity': case 'CollabAgentToolCall': return add(item.type, 'agent', null);
      case 'ContextCompaction': return builder.compaction(at);
      default: return undefined;
    }
  };

  const responseItem = (p, at, legacy) => {
    switch (p.type) {
      case 'message':
        if (p.role === 'assistant') builder.final(contentText(p.content));
        else if (p.role === 'user' && legacy) prompt(contentText(p.content), at);
        return;
      case 'function_call': {
        const args = parseArgs(p.arguments);
        const shell = ['shell', 'exec_command', 'shell_command', 'container.exec', 'unified_exec'].includes(p.name);
        builder.tool({ name: p.name, id: p.call_id, command: shell ? shellCommand(p.name, args) : null, cwd: typeof args?.workdir === 'string' ? args.workdir : null, at });
        return;
      }
      case 'custom_tool_call':
        builder.tool({ name: p.name, category: p.name === 'exec' ? 'shell' : undefined, id: p.call_id, command: p.name === 'exec' && typeof p.input === 'string' ? p.input : null, at });
        return;
      case 'local_shell_call':
        builder.tool({ name: 'local_shell_call', category: 'shell', id: p.call_id || p.id, command: shellCommand('', p.action), cwd: typeof p.action?.working_directory === 'string' ? p.action.working_directory : null, at });
        return;
      case 'web_search_call':
        builder.tool({ name: 'web_search_call', category: 'web', at });
        return;
      case 'function_call_output': case 'custom_tool_call_output': {
        const output = Array.isArray(p.output) ? contentText(p.output) : p.output;
        const code = exitCodeOf(output);
        const text = typeof output === 'string' ? output : output && typeof output === 'object' ? JSON.stringify(output) : '';
        let failed = code === null ? null : code !== 0;
        if (failed === null && /^(?:error\b|Error:|failed\b)/i.test(text.trimStart())) failed = true;
        if (failed === null && output?.success === false) failed = true;
        let body = text;
        try { const parsed = text.startsWith('{') ? JSON.parse(text) : null; if (typeof parsed?.output === 'string') body = parsed.output; } catch { /* Plain text. */ }
        builder.result({ id: p.call_id, failed, output: body });
        builder.forget(p.call_id);
        return;
      }
      default: return;
    }
  };

  const event = (p, at) => {
    switch (p.type) {
      case 'user_message': return prompt(p.message, at);
      case 'item_completed': return p.item && typeof p.item === 'object' ? itemTool(p.item, at) : undefined;
      case 'task_started': epoch += 1; return undefined;
      case 'turn_aborted': epoch += 1; return builder.addMessage('interrupt', '', at);
      case 'task_complete': epoch += 1; return builder.final(p.last_agent_message);
      case 'agent_message': return builder.final(p.message);
      case 'token_count': return usage(p.info, at);
      case 'context_compacted': return builder.compaction(at);
      case 'exec_command_end': {
        const failed = Number.isInteger(p.exit_code) ? p.exit_code !== 0 : null;
        const output = p.aggregated_output ?? p.stdout ?? null;
        if (p.call_id && builder.pending.has(p.call_id)) builder.result({ id: p.call_id, failed, output });
        else builder.result({ failed, output, events: builder.tool({ name: 'exec_command', category: 'shell', command: shellCommand('', p), cwd: typeof p.cwd === 'string' ? p.cwd : null, at }) });
        return undefined;
      }
      case 'patch_apply_end':
        if (p.call_id && p.success === false) builder.result({ id: p.call_id, failed: true });
        return undefined;
      default: return undefined;
    }
  };

  const apply = entry => {
    const at = builder.stamp(entry.timestamp);
    const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    switch (entry.type) {
      case 'session_meta': return meta(p);
      case 'turn_context':
        builder.setCwd(p.cwd);
        return builder.context(p.model, p.effort ?? p.reasoning_effort ?? p.model_reasoning_effort);
      case 'event_msg': return event(p, at);
      case 'response_item': return responseItem(p, at, false);
      case 'compacted': return builder.compaction(at);
      default:
        if (IGNORED.has(entry.type) || entry.record_type) return undefined;
        if (LEGACY_ITEMS.has(entry.type)) return responseItem(entry, at, true);
        // Oldest rollouts start with a bare { id, timestamp, instructions } header.
        if (!entry.type && entry.id && !metaSeen) return meta({ id: entry.id, ...(entry.git ? { git: entry.git } : {}) });
        builder.coverage.unknownEvents += 1;
        return undefined;
    }
  };

  await consume(readLines(file, { signal, maxLineBytes }), builder, apply, peek => HEAVY.test(peek));
  if (!builder.sessionId && fromName) builder.sessionId = fromName;
  return builder;
}
