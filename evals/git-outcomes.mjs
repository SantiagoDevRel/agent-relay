// 72-hour Git follow-up of commits made in chats. Read-only git only:
// rev-parse --show-toplevel, cat-file -e, show -s, log --all and diff-tree.
// Every call has a timeout, and the whole run has a deadline.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { localDir } from './sources/shell.mjs';

const WINDOW_S = 72 * 3600;
const SHA = /^[a-f0-9]{7,40}$/;
// Shared docs, lockfiles and generated or built files change in most commits of a busy
// repo; overlap there is not a fix signal.
const NOT_CODE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$|\.mdx?$|generated|\.tsbuildinfo$|(?:^|\/)(?:dist|\.next[^/]*|node_modules)\//i;
const FIX = /\b(fix|fixes|fixed|fixing|hotfix|repair|repairs|repaired|bug|bugs|bugfix|broken)\b|arregl|corrig/i;

// Default runner: git with shell:false (execFile), hidden window, timeout and no optional locks.
export function defaultExec(args, { cwd, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export const createGitCache = () => ({ roots: new Map(), commits: new Map(), logs: new Map(), files: new Map() });

// Runs one git call; resolves to stdout, or null on error, timeout or exhausted deadline.
async function run(exec, args, cwd, timeoutMs, deadline) {
  const budget = Math.min(timeoutMs, deadline - Date.now());
  if (budget <= 0) return null;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), budget); });
  try {
    return await Promise.race([Promise.resolve().then(() => exec(args, { cwd, timeoutMs: budget })).then(out => String(out ?? ''), () => null), timeout]);
  } finally { clearTimeout(timer); }
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** git rev-parse --show-toplevel of cwd, cached; null for missing directories and non-repos. */
export async function repoRootOf(rawCwd, { exec = defaultExec, timeoutMs = 10000, cache = createGitCache(), deadline = Date.now() + 120000 } = {}) {
  // Records extracted before localDir existed can still hold file: URLs or /c/ paths.
  const cwd = localDir(rawCwd);
  if (!cwd || typeof cwd !== 'string') return null;
  if (cache.roots.has(cwd)) return cache.roots.get(cwd);
  let root = null;
  if (isDirectory(cwd)) {
    const out = await run(exec, ['rev-parse', '--show-toplevel'], cwd, timeoutMs, deadline);
    root = out?.trim() || null;
  }
  cache.roots.set(cwd, root);
  return root;
}

async function commitInfo(exec, root, sha, timeoutMs, deadline, cache) {
  const key = `${root}\u0000${sha}`;
  if (cache.commits.has(key)) return cache.commits.get(key);
  let info = null;
  if (await run(exec, ['cat-file', '-e', `${sha}^{commit}`], root, timeoutMs, deadline) !== null) {
    const out = await run(exec, ['show', '-s', '--format=%H%x1f%ct', sha], root, timeoutMs, deadline);
    const [full, ct] = (out ?? '').trim().split('\x1f');
    if (/^[a-f0-9]{40}$/.test(full ?? '') && /^\d+$/.test(ct ?? '')) info = { fullSha: full, committedAt: Number(ct) };
  }
  cache.commits.set(key, info);
  return info;
}

async function logWindow(exec, root, start, end, timeoutMs, deadline, cache) {
  const key = `${root}\u0000${start}\u0000${end}`;
  if (cache.logs.has(key)) return cache.logs.get(key);
  const out = await run(exec, ['log', '--all', '--no-color', `--since=@${start - 1}`, `--until=@${end + 1}`, '--format=%x1e%H%x1f%ct%x1f%B'], root, timeoutMs, deadline);
  const entries = out === null ? null : out.split('\x1e').filter(Boolean).map(chunk => {
    const [sha, ct, ...body] = chunk.split('\x1f');
    return { sha: sha.trim(), ct: Number(ct), body: body.join('\x1f') };
  }).filter(entry => /^[a-f0-9]{40}$/.test(entry.sha) && Number.isFinite(entry.ct)).sort((a, b) => a.ct - b.ct);
  cache.logs.set(key, entries);
  return entries;
}

async function filesOf(exec, root, sha, timeoutMs, deadline, cache) {
  const key = `${root}\u0000${sha}`;
  if (cache.files.has(key)) return cache.files.get(key);
  const out = await run(exec, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], root, timeoutMs, deadline);
  const files = out === null ? null : new Set(out.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  cache.files.set(key, files);
  return files;
}

/**
 * Follow-up of each commit within 72 h of its committer time, across all refs:
 * - reverted: a later commit whose message contains "This reverts commit <fullSha>";
 * - fixed: a later commit touching at least one same file (not Markdown, a lockfile or a generated/built file)
 *   whose subject line looks like a fix (fix, hotfix, arregl, corrig, repair, bug, broken);
 * - none: the window was inspected and neither happened;
 * - unknown: no cwd, missing directory, not a repository, unknown SHA, git error or
 *   timeout, or a window that has not closed yet (commit younger than 72 h).
 * The earliest follow-up (by committer time) wins. Later commits of the same chat (same
 * `chat` value) are normal iteration and are never a follow-up.
 * @param {{sha:string, cwd:string|null, chat?:string}[]} commits
 * @returns {Promise<Map<string, {repoRoot:string|null, fullSha:string|null, followUp:string, followUpSha?:string, hoursToFollowUp?:number, committedAt?:number, reason?:string}>>}
 */
export async function gitOutcomes(commits, { exec = defaultExec, timeoutMs = 10000, now = Date.now(), cache = createGitCache(), deadline } = {}) {
  const nowS = Math.floor((now instanceof Date ? now.getTime() : Number(now)) / 1000);
  const end = deadline ?? Date.now() + 120000;
  const result = new Map();
  const unknown = (sha, repoRoot, reason, extra = {}) => result.set(sha, { repoRoot, fullSha: null, followUp: 'unknown', reason, ...extra });
  const pending = new Map(); // root -> [{ sha, fullSha, committedAt, chat }]
  const byChat = new Map(); // chat -> SHAs (possibly abbreviated) the chat committed
  for (const { sha, chat } of commits ?? []) {
    if (typeof chat !== 'string' || typeof sha !== 'string') continue;
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(sha.toLowerCase());
  }
  const sameChat = (item, fullSha) => (byChat.get(item.chat) ?? []).some(own => fullSha.startsWith(own));
  for (const { sha, cwd, chat } of commits ?? []) {
    if (typeof sha !== 'string' || !SHA.test(sha) || result.has(sha)) continue;
    const root = await repoRootOf(cwd, { exec, timeoutMs, cache, deadline: end });
    if (!root) { unknown(sha, null, 'no-repo'); continue; }
    const info = await commitInfo(exec, root, sha, timeoutMs, end, cache);
    if (!info) { unknown(sha, root, 'unknown-sha'); continue; }
    if (info.committedAt + WINDOW_S > nowS) { unknown(sha, root, 'window-open', { fullSha: info.fullSha, committedAt: info.committedAt }); continue; }
    result.set(sha, { repoRoot: root, fullSha: info.fullSha, followUp: 'pending', committedAt: info.committedAt });
    if (!pending.has(root)) pending.set(root, []);
    pending.get(root).push({ sha, chat, ...info });
  }

  for (const [root, list] of pending) {
    list.sort((a, b) => a.committedAt - b.committedAt);
    // Overlapping 72 h windows share one cached log call.
    const spans = [];
    for (const item of list) {
      const last = spans.at(-1);
      if (last && item.committedAt <= last.end) { last.end = Math.max(last.end, item.committedAt + WINDOW_S); last.items.push(item); }
      else spans.push({ start: item.committedAt, end: item.committedAt + WINDOW_S, items: [item] });
    }
    for (const span of spans) {
      const entries = await logWindow(exec, root, span.start, span.end, timeoutMs, end, cache);
      for (const item of span.items) {
        const outcome = result.get(item.sha);
        if (!entries) { Object.assign(outcome, { followUp: 'unknown', reason: 'git-error' }); continue; }
        let found = null, failed = false;
        for (const entry of entries) {
          if (entry.sha === item.fullSha || entry.ct < item.committedAt || entry.ct > item.committedAt + WINDOW_S || sameChat(item, entry.sha)) continue;
          if (entry.body.includes(`This reverts commit ${item.fullSha}`)) { found = { followUp: 'reverted', entry }; break; }
          if (entry.ct > item.committedAt && FIX.test(entry.body.trimStart().split('\n')[0])) {
            const own = await filesOf(exec, root, item.fullSha, timeoutMs, end, cache);
            const theirs = own && await filesOf(exec, root, entry.sha, timeoutMs, end, cache);
            if (!own || !theirs) { failed = true; break; }
            if ([...theirs].some(file => own.has(file) && !NOT_CODE.test(file))) { found = { followUp: 'fixed', entry }; break; }
          }
        }
        if (failed) Object.assign(outcome, { followUp: 'unknown', reason: 'git-error' });
        else if (found) Object.assign(outcome, { followUp: found.followUp, followUpSha: found.entry.sha, hoursToFollowUp: Math.round((found.entry.ct - item.committedAt) / 36) / 100 });
        else outcome.followUp = 'none';
      }
    }
  }
  return result;
}
