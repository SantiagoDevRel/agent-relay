// Pure state decisions. No I/O here, so every rule is covered by tests.
//
// States: working | waiting | cut | closed | unknown
//   working  process open and the agent is busy (or its background agents are)
//   waiting  process open, turn finished: the agent waits for you
//   cut      process gone while a turn or background work was in flight
//   closed   process gone after the turn finished
//   unknown  not enough evidence; never guessed

const MID_TURN = new Set(['assistant-tool', 'user-tool-result', 'user-real']);

// `cleanExit`: the transcript ends with the `cost-state` entry Claude Code writes
// when it quits normally (Ctrl+C twice or /exit). That is User closing the
// chat, even mid-turn; a crash, a reboot or a killed window never writes it.
export function classifyClaude({ alive, status, lastKind, bgAfterReply, bgActive, cleanExit = false }) {
  const midTurn = MID_TURN.has(lastKind);
  if (alive) {
    if (status === 'busy' || status === 'shell') return 'working';
    if (status === 'idle') return bgActive ? 'working' : 'waiting';
    if (!lastKind) return 'unknown';
    return midTurn || bgActive ? 'working' : 'waiting';
  }
  if (cleanExit) return 'closed';
  if (!lastKind) return 'unknown';
  return midTurn || bgAfterReply ? 'cut' : 'closed';
}

export function classifyCodex({ alive, lastTask, unreadable = false }) {
  if (unreadable) return 'unknown';
  // A readable rollout with no turn event yet: the chat waits for your first message.
  if (!lastTask) return alive ? 'waiting' : 'unknown';
  const open = lastTask === 'started';
  if (alive) return open ? 'working' : 'waiting';
  return open ? 'cut' : 'closed';
}

// What the last Claude transcript message means for the turn.
export function claudeMessageKind(entry) {
  const content = entry.message?.content;
  if (entry.type === 'assistant') {
    const hasTool = Array.isArray(content) && content.some((c) => c.type === 'tool_use');
    return hasTool ? 'assistant-tool' : 'assistant-text';
  }
  if (entry.type !== 'user') return null;
  if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) return 'user-tool-result';
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : '';
  const t = text.trim();
  if (entry.isMeta || !t) return 'user-meta';
  if (t.startsWith('[Request interrupted')) return 'user-interrupt';
  if (t.startsWith('<task-notification') || t.startsWith('<system-reminder')) return 'user-notification';
  if (t.startsWith('<command-') || t.startsWith('<local-command')) return 'user-meta';
  return 'user-real';
}
