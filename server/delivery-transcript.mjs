// Agent/tool records only. User messages, tool results and quoted prose confer no evidence.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export function parseDelivery(text) {
  const line = String(text || '').trimEnd().split(/\r?\n/).at(-1);
  if (!line || line.length > 2048) return null;
  const match = /^DELIVERY: sha=([a-f0-9]{7,40}) ci=(\S+) prod=(\S+) verified=(\S[^\r\n]*)$/.exec(line || '');
  return match ? { sha: match[1], ci: match[2], prod: match[3], verified: match[4] } : null;
}

export function toolEvidence(record, tool, cwd) {
  let calls = [];
  if (tool === 'codex' && record.type === 'response_item') {
    const p = record.payload;
    if (['function_call', 'custom_tool_call'].includes(p?.type)) calls = [p.arguments || p.input || ''];
  } else if (tool === 'claude' && record.type === 'assistant') {
    calls = (Array.isArray(record.message?.content) ? record.message.content : []).filter(c => c.type === 'tool_use').map(c => c.input);
  }
  const found = [];
  for (const call of calls) {
    let input = call;
    if (typeof call === 'string') { try { input = JSON.parse(call); } catch { input = call; } }
    const callCwd = input?.workdir || input?.cwd || cwd;
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) {
          if (['workdir', 'cwd', 'file_path', 'path'].includes(name) && typeof item === 'string') {
            const base = ['workdir', 'cwd'].includes(name) ? cwd : callCwd;
            found.push(/^(?:[A-Za-z]:[\\/]|\/)/.test(item) ? item : String(base).startsWith('/') ? path.posix.resolve(base, item) : path.resolve(base, item));
          }
          else visit(item);
        }
      } else if (typeof value === 'string') {
        // Also handles shell/JS wrappers around tool calls, without evaluating them.
        const matches = [...value.matchAll(/(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/)[^\s"'`<>\r\n;)]+|["'](\/(?:[^"'\r\n]+))["']/g)];
        found.push(...matches.map(m => m[1] || m[0]));
        if (!matches.length && /(?:\bgit\b|\brg\b|Get-Content|Set-Content|apply_patch|\b(?:npm|node|pnpm)\b)/.test(value)) found.push(callCwd);
      }
    };
    visit(input);
  }
  return found;
}

export function agentMessage(record, tool) {
  if (tool === 'claude' && record.type === 'assistant') {
    const content = record.message?.content;
    return Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : null;
  }
  if (tool === 'codex' && record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'assistant') return (record.payload.content || []).map(c => c.text || '').join('\n');
  if (tool === 'codex' && record.type === 'event_msg' && record.payload?.type === 'task_complete') return record.payload.last_agent_message || null;
  if (tool === 'codex' && record.type === 'event_msg' && record.payload?.type === 'agent_message') return record.payload.message || null;
  return null;
}

export class DeliveryTranscripts {
  cache = new Map();
  async read(chat, { maxBytes = 2 * 1024 * 1024 } = {}) {
    if (!chat.file) return { paths: [], complete: false, atEnd: true, report: null };
    const handle = await fs.promises.open(chat.file, 'r');
    try {
      const { size } = await handle.stat();
      let state = this.cache.get(chat.file);
      if (!state || size < state.offset) state = { offset: 0, paths: new Set(), message: '', messageAt: 0, pending: '', skipped: 0, entire: true };
      // Match collector cold-start bounds: Claude head + tail, Codex recent tools.
      // Omitted old bytes are explicit coverage, never proof that a chat has no code.
      const tailBytes = chat.tool === 'claude' ? 1536 * 1024 : 4 * 1024 * 1024;
      if (!state.offset && size > tailBytes + 256 * 1024) {
        const head = Buffer.alloc(256 * 1024);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const newline = head.subarray(0, bytesRead).lastIndexOf(10);
        if (newline >= 0) {
          for (const line of head.subarray(0, newline).toString('utf8').split('\n')) {
            try { for (const item of toolEvidence(JSON.parse(line), chat.tool, chat.cwd)) state.paths.add(item); } catch { /* Truncated initial evidence stays untrusted. */ }
          }
        }
        state.offset = size - tailBytes; state.dropping = true; state.entire = false;
      }
      const end = Math.min(size, state.offset + maxBytes);
      while (state.offset < end) {
        const started = Date.now(), buffer = Buffer.alloc(Math.min(256 * 1024, end - state.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        // Keep bytes until a newline: UTF-8 code points can cross chunk boundaries.
        state.pending = Buffer.concat([Buffer.isBuffer(state.pending) ? state.pending : Buffer.alloc(0), buffer.subarray(0, bytesRead)]);
        let cut;
        while ((cut = state.pending.indexOf(10)) >= 0) {
          const line = state.pending.subarray(0, cut); state.pending = state.pending.subarray(cut + 1);
          if (state.dropping) { state.dropping = false; continue; }
          try {
            const record = JSON.parse(line.toString('utf8'));
            for (const item of toolEvidence(record, chat.tool, chat.cwd)) {
              if (state.paths.size < 20000 || state.paths.has(item)) state.paths.add(item);
              else state.skipped++;
            }
            const message = agentMessage(record, chat.tool);
            if (message !== null) { state.message = message; state.messageAt = Date.parse(record.timestamp) || 0; }
          } catch { state.skipped++; }
        }
        if (state.pending.length > 4 * 1024 * 1024) { state.pending = Buffer.alloc(0); state.dropping = true; state.skipped++; }
        await pause(Math.max(5, Date.now() - started));
      }
      this.cache.set(chat.file, state);
      return { paths: [...state.paths], complete: state.offset === size && !state.skipped && !state.pending.length && !state.dropping, atEnd: state.offset === size, entire: state.entire, scannedBytes: state.offset, totalBytes: size, report: parseDelivery(state.message), messageAt: state.messageAt, skipped: state.skipped };
    } finally { await handle.close(); }
  }
}

export const pathKey = value => {
  let normalized = String(value || '').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '');
  normalized = normalized.replace(/^\/mnt\/([a-z])\//i, (_, drive) => drive.toUpperCase() + ':/');
  return /^[a-z]:/i.test(normalized) || process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
export function attributeWorktrees(paths, worktrees) {
  const matches = new Map();
  for (const value of paths) {
    const normalized = pathKey(value);
    const candidates = worktrees.filter(w => normalized === pathKey(w.path) || normalized.startsWith(pathKey(w.path) + '/'));
    candidates.sort((a, b) => b.path.length - a.path.length);
    if (candidates.length && (candidates.length === 1 || candidates[0].path.length > candidates[1].path.length)) matches.set(pathKey(candidates[0].path), candidates[0]);
  }
  return [...matches.values()];
}
