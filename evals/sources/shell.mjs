// In-memory classification of shell commands and tool names. Command text is
// inspected here and dropped; only categories, outcomes, SHAs and directories
// leave this module.
import path from 'node:path';

const MAX_COMMAND = 64 * 1024;

const RUNNER = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:=\S+|\s+(?!-)[\w@./-]+)?)*\s+(?:run(?:-script)?\s+)?`;
const RULES = [
  ['git-commit', /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/],
  ['git-push', /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b/],
  ['git-revert', /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+revert\b/],
  ['git-reset', /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+reset\b/],
  ['test', new RegExp(String.raw`\bnode(?:\s+--?[\w-]+(?:=\S+)?)*\s+--test\b|\b${RUNNER}test(?::[\w:-]+)?\b|\b(?:npm|pnpm|yarn|bun)\s+t\b|\b(?:vitest|jest|pytest|mocha)(?![.\w/-])|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\b(?:go|cargo|deno|bun|dotnet|mvn|gradlew?|swift)\s+test\b|\bplaywright\s+test\b`)],
  ['typecheck', new RegExp(String.raw`\b(?:tsc|vue-tsc|mypy|pyright|tsgo)(?![.\w/-])|\b${RUNNER}(?:typecheck|type-check|check-types|types)\b`)],
  ['lint', new RegExp(String.raw`\b(?:eslint|stylelint|ruff|flake8|pylint|golangci-lint|shellcheck)(?![.\w/-])|\bnext\s+lint\b|\bbiome\s+(?:lint|check)\b|\bprettier\s+(?:--check|-c)\b|\bcargo\s+clippy\b|\b${RUNNER}lint(?::[\w:-]+)?\b`)],
  ['build', new RegExp(String.raw`\b${RUNNER}build(?::[\w:-]+)?\b|\b(?:vite|next|nuxt|astro|turbo|cargo|go|dotnet|gradlew?|mvn|webpack|esbuild|tsup|rollup)\s+(?:build|package|-c)\b|\bexpo\s+export\b`)],
  ['deploy', new RegExp(String.raw`\bvercel(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:deploy|--prod)\b|\bvercel\s+--prod\b|\b(?:netlify|fly|flyctl|firebase|wrangler|railway|gcloud\s+app|eas)\s+(?:deploy|publish|up|submit)\b|\b${RUNNER}deploy(?::[\w:-]+)?\b|\bsupabase\s+(?:db\s+push|functions\s+deploy)\b`)],
];

const unquote = value => String(value || '').replace(/^["']|["']$/g, '');
// Codex can report directories as file: URLs and Git Bash as /c/... paths; both
// become native Windows paths so Git lookups can use them. Other values pass through.
export function localDir(dir) {
  if (typeof dir !== 'string' || !dir) return dir || null;
  let value = dir;
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; }
    if (!/^\/[A-Za-z]:/.test(value)) return value;
    value = value.slice(1);
  } else {
    const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value);
    if (!msys) return value;
    value = `${msys[1].toUpperCase()}:/${msys[2] ?? ''}`;
  }
  return value.replace(/\//g, '\\');
}
const isAbsolute = dir => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(dir);
function joinDir(base, dir) {
  if (!dir || dir === '-' || dir.startsWith('~') || dir.startsWith('$')) return null;
  if (isAbsolute(dir) || /^file:/i.test(dir)) return localDir(dir);
  if (!base) return null;
  return /^[A-Za-z]:|\\/.test(base) ? path.win32.join(base, dir) : path.posix.join(base, dir);
}

// Splits on shell separators; quoted separators may split too, which only
// costs precision of the cwd, never stores text.
const SEGMENTS = /&&|\|\||[;|\n]/;
const CD = /^\s*(?:cd|Set-Location|Push-Location|pushd|sl)\s+(?:-Path\s+|-LiteralPath\s+)?("[^"]+"|'[^']+'|\S+)\s*$/i;
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/;

// Returns [{ category, cwd }] in order. `baseCwd` is the explicit working
// directory of the call (Codex workdir) or null.
export function classifyCommand(command, baseCwd = null) {
  const text = String(command || '').slice(0, MAX_COMMAND);
  const events = [];
  let cwd = localDir(baseCwd), explicit = Boolean(cwd);
  for (const segment of text.split(SEGMENTS)) {
    const cd = CD.exec(segment);
    if (cd) {
      const next = joinDir(cwd, unquote(cd[1]));
      if (next) { cwd = next; explicit = true; }
      continue;
    }
    const gitDir = GIT_C.exec(segment);
    const segmentCwd = gitDir ? joinDir(cwd, unquote(gitDir[1])) || cwd : cwd;
    const segmentExplicit = explicit || Boolean(gitDir);
    for (const [category, re] of RULES) {
      if (!re.test(segment)) continue;
      // `git commit` inside a test name or a lint inside a build script: one category per rule and segment.
      events.push({ category, cwd: segmentExplicit && segmentCwd ? segmentCwd.slice(0, 1000) : null });
    }
  }
  return events;
}

// "[main a1b2c3d] message" / "[detached HEAD 1a2b3c4] ..." / "[main (root-commit) 1a2b3c4]".
const COMMIT_LINE = /^\[[^\]\r\n]*?\s([a-f0-9]{7,40})\]\s/gm;
// `git commit -q && git log --oneline -1` (or `rev-parse HEAD`) prints no summary line;
// then the first line that starts with a SHA is the new commit (log lists newest first).
// At least one letter, so sizes or counts (`du`, line numbers) never pass as SHAs.
const SHA_LINE = /^(?=[0-9]*[a-f])([a-f0-9]{7,40})(?:[ \t]|\r?$)/m;
export function commitShas(output) {
  const text = String(output || '').slice(0, 1024 * 1024);
  const found = [];
  for (const match of text.matchAll(COMMIT_LINE)) if (!found.includes(match[1])) found.push(match[1]);
  if (!found.length) { const line = SHA_LINE.exec(text); if (line) found.push(line[1]); }
  return found.slice(0, 20);
}

// Tool name -> toolCounts category.
const TOOL_CATEGORIES = [
  ['edit', /^(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch|write_file|edit_file|str_replace|FileChange)$/i],
  ['read', /^(?:Read|NotebookRead|LS|read_file|view_image|ImageView|list_dir|view)$/i],
  ['shell', /^(?:Bash|PowerShell|shell|exec_command|shell_command|local_shell_call|container\.exec|unified_exec|CommandExecution)$/i],
  ['search', /^(?:Grep|Glob|grep|glob|find|search|file_search|codebase_search|grep_search)$/i],
  ['web', /^(?:WebFetch|WebSearch|web_search|web_search_call|web_fetch|fetch|browser.*)$|^mcp__(?:playwright|browser|chrome)[\w-]*__/i],
  ['agent', /^(?:Agent|Task|Workflow|SendMessage|spawn_agent|send_input|send_message|wait_agent|close_agent|resume_agent|SubAgentActivity|CollabAgentToolCall)$/i],
];
export function toolCategory(name) {
  const value = String(name || '');
  for (const [category, re] of TOOL_CATEGORIES) if (re.test(value)) return category;
  return 'other';
}
export const isShellTool = name => toolCategory(name) === 'shell';

// Exit code from Codex classic tool outputs: JSON { metadata: { exit_code } } or
// "Exit code: N" / "Process exited with code N" text. null when unknown.
export function exitCodeOf(output) {
  if (output && typeof output === 'object') {
    const code = output.metadata?.exit_code ?? output.exit_code;
    return Number.isInteger(code) ? code : null;
  }
  const text = String(output ?? '');
  if (text.startsWith('{')) {
    try { return exitCodeOf(JSON.parse(text)); } catch { /* Plain text below. */ }
  }
  const match = /^(?:Exit code|Process exited with code):?\s*(-?\d+)/im.exec(text.slice(0, 4096));
  return match ? Number(match[1]) : null;
}
