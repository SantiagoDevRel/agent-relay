// Turns a chat's working directory into a display folder, worktree tag, topic
// and resume command. Topic rules live in ../topics.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
import { WORKSPACE, TOPICS_FILE } from './config.mjs';
export { WORKSPACE };

export function normalizeCwd(cwd) {
  return String(cwd || '').replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
}

// "C:\...\workspace\sample-app\.claude\worktrees\sample-worker"
//   -> { folder: "sample-app", worktree: "sample-worker" }
export function placeOf(rawCwd) {
  const cwd = normalizeCwd(rawCwd);
  let rel;
  const lower = cwd.toLowerCase();
  if (lower === WORKSPACE.toLowerCase()) rel = '';
  else if (lower.startsWith(`${WORKSPACE.toLowerCase()}\\`)) rel = cwd.slice(WORKSPACE.length + 1);
  else if (lower.startsWith(`${HOME.toLowerCase()}\\`)) rel = `~\\${cwd.slice(HOME.length + 1)}`;
  else rel = cwd;
  rel = rel.replace(/\\/g, '/');
  const wt = rel.match(/^(.*?)\/?\.(?:claude|codex)\/worktrees\/([^/]+)(?:\/(.*))?$/);
  if (wt) {
    const [, base, worktree, inner] = wt;
    return { folder: [base, inner].filter(Boolean).join('/'), worktree };
  }
  return { folder: rel, worktree: undefined };
}

let topicRules = null;
let topicStamp = 0;

function loadTopics() {
  try {
    const stamp = fs.statSync(TOPICS_FILE).mtimeMs;
    if (topicRules && stamp === topicStamp) return topicRules;
    const raw = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
    topicRules = (raw.topics || []).map((t) => ({
      topic: t.topic,
      folders: (t.folders || []).map((f) => f.toLowerCase()),
      title: t.titleRegex ? new RegExp(t.titleRegex, 'i') : null,
    }));
    topicStamp = stamp;
  } catch {
    topicRules = [];
  }
  return topicRules;
}

// Longest matching folder prefix wins; title rules apply only when no folder matches.
export function topicOf(folder, title) {
  const f = folder.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const rule of loadTopics()) {
    for (const prefix of rule.folders) {
      const hit = f === prefix || f.startsWith(`${prefix}/`);
      if (hit && prefix.length > bestLen) {
        best = rule.topic;
        bestLen = prefix.length;
      }
    }
  }
  if (best) return best;
  for (const rule of loadTopics()) if (rule.title?.test(title)) return rule.topic;
  return 'Other';
}

// Two separate copy targets per chat, plus the combined line used by "Abrir".
// `;` works as a separator in both PowerShell 5.1 and bash.
export function commandsFor(tool, rawCwd, id) {
  const cwd = normalizeCwd(rawCwd);
  const cdCommand = `cd "${cwd}"`;
  const runCommand = tool === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`;
  return { cdCommand, runCommand, resumeCommand: `${cdCommand}; ${runCommand}` };
}
