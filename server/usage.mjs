// Shared provider accounting. No prompts or tool output retained here.
const n = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
export function tokens(tool, u) {
  if (!u || typeof u !== 'object' || !['input_tokens', 'output_tokens'].some(k => Number.isSafeInteger(u[k]) && u[k] >= 0)) return null;
  const cached = n(u[tool === 'claude' ? 'cache_read_input_tokens' : 'cached_input_tokens']);
  const cacheWrite = n(u[tool === 'claude' ? 'cache_creation_input_tokens' : 'cache_write_input_tokens']);
  const input = tool === 'claude' ? n(u.input_tokens) + cached + cacheWrite : n(u.input_tokens);
  const output = n(u.output_tokens);
  return { input, cached: Math.min(cached, input), cacheWrite, output,
    reasoning: Math.min(n(u.reasoning_output_tokens), output), total: input + output };
}
export function applyUsage(p, e, tool) {
  const at = Date.parse(e.timestamp) || 0;
  if (tool === 'codex' && e.type === 'turn_context' && e.payload?.model) p.model = e.payload.model;
  const compact = e.type === 'compacted' || e.subtype === 'compact_boundary';
  if (compact) { p.compactions = (p.compactions || 0) + 1; p.contextTokens = null; p.contextPercent = null; }
  if (e.type === 'user' && e.message?.content?.some?.(x => x.type === 'tool_result' && x.is_error === true)) p.toolErrors = (p.toolErrors || 0) + 1;
  if (e.type === 'event_msg' && e.payload?.type === 'turn_aborted') p.interruptions = (p.interruptions || 0) + 1;
  const u = tool === 'claude' ? e.type === 'assistant' && e.message?.usage
    : e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.info?.last_token_usage;
  const last = tokens(tool, u);
  if (!last || !at) return;
  const window = tool === 'codex' ? n(e.payload.info.model_context_window) || null : null;
  Object.assign(p, { at, model: tool === 'claude' ? e.message.model : p.model || null, last,
    cumulative: tool === 'codex' ? tokens(tool, e.payload.info.total_token_usage) : null,
    contextTokens: last.input, contextWindow: window,
    contextPercent: window ? Math.round(last.input / window * 100) : null });
}
export function publicUsage(p) {
  if (!p?.at) return null;
  return { at: p.at, model: p.model || null, last: p.last, cumulative: p.cumulative,
    contextTokens: p.contextTokens ?? null, contextWindow: p.contextWindow ?? null,
    contextPercent: p.contextPercent ?? null, toolErrors: p.toolErrors || 0, interruptions: p.interruptions || 0,
    compactions: p.compactions || 0, coverage: 'latest-and-observed-tail' };
}
export function advice(usage, { handoffTokens = 300000, handoffPercent = 80 } = {}) {
  if (!usage) return [];
  const result = [];
  if ((usage.contextTokens ?? 0) >= handoffTokens || (usage.contextPercent ?? 0) >= handoffPercent)
    result.push({ kind: 'handoff', text: 'Consider preparing a handoff: the last request used a large amount of context.' });
  if (usage.toolErrors >= 3) result.push({ kind: 'errors', text: 'Several tool errors appear in the observed portion. Review the cause before repeating.' });
  if (usage.interruptions >= 2) result.push({ kind: 'interruptions', text: 'This chat has several interrupted turns.' });
  return result;
}
