// E4a complete task catalog. Every chat record maps to exactly one task entry
// (a task or an excluded entry with a reason); every agent-work contract either
// merges into the task of its earliest linked chat or becomes its own task.
// Git access is read-only through an injectable exec with a timeout per call.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { assertValid } from '../schema.mjs';
import { readContracts, DEFAULT_CONTRACTS_DIR, parseListItems, normalizeItems, literalOf, scrub, MAX_REQUIREMENTS } from './contracts.mjs';

export const REASONS = {
  automated: 'automated lane',
  noPrompt: 'no human prompt',
  duplicate: 'same-session duplicate',
  noChat: 'contract has no linked chat',
  chatsTaken: 'contract chats already merged into another contract task',
  noRepo: 'no git repository',
  noBase: 'base commit not found',
  noFinal: 'no accepted commit',
  sameCommit: 'final commit equals base commit',
  research: 'research task without code',
  ops: 'ops task without code',
  device: 'needs device, account or credentials',
  ok: 'base and accepted final commits resolve in git',
};

const MAX_CHATS_PER_TASK = 200;
const SHA = /^[a-f0-9]{40}$/;
const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,250}$/;
const DEVICE = /\b(?:iphone|ipad|ios device|android|adb|emulator|testflight|app store connect|play console|google play|deploy\w*|despleg\w*|despliegue|payments?|pagos?|stripe|checkout|log ?in|sign ?in|iniciar? sesi[oó]n|credentials?|credenciales|passwords?|contraseñ\w*|2fa|otp)\b/i;

// Default read-only git runner: shell:false, hidden window, bounded output and time.
export function createGitExec({ env } = {}) {
  return (args, { cwd, timeoutMs = 10000 } = {}) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024, env: env ?? process.env },
      (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

// Runs one git command; any failure, non-zero exit or timeout yields null.
async function runGit(exec, args, cwd, timeoutMs) {
  let timer;
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const result = await Promise.race([Promise.resolve().then(() => exec(args, { cwd, timeoutMs })), timeout]);
    if (result === null || result === undefined) return null;
    return String(typeof result === 'object' ? result.stdout ?? '' : result).trim();
  } catch { return null; } finally { clearTimeout(timer); }
}

export const taskId = keys => 'task:' + crypto.createHash('sha256').update([...keys].sort().join('\n')).digest('hex').slice(0, 16);

const norm = value => String(value ?? '').replace(/\\/g, '/').toLowerCase();
const sameRepo = (a, b) => norm(a).replace(/\/+$/, '') === norm(b).replace(/\/+$/, '');
const cap = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const byStart = (a, b) => (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿') || a.id.localeCompare(b.id);
const topValue = list => [...(list ?? [])].sort((a, b) => b.turns - a.turns)[0]?.value ?? null;

// A folder name links on its own only when it is distinctive; otherwise only its checklist path does.
function needlesOf(contract) {
  const folder = norm(contract.folder);
  const distinctive = folder.length >= 8 && /[-\d]/.test(folder);
  return (contract.mentions ?? [contract.folder]).map(norm).filter(n => n && (n !== folder || distinctive));
}

function mentions(haystack, needle) {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? ' ', after = haystack[at + needle.length] ?? ' ';
    if (!/[a-z0-9_-]/.test(before) && !/[a-z0-9_-]/.test(after)) return at;
  }
  return -1;
}

// One streaming pass keeps only the small summary each catalog rule needs.
function summarize(record, contracts) {
  const prompts = record.userMessages.filter(m => m.kind === 'prompt' && m.text.trim());
  const first = prompts[0] ?? null;
  const texts = [...prompts.map(m => m.text), ...record.turns.map(t => t.agentFinal?.text ?? '')];
  const haystack = norm(texts.join('\n'));
  const linked = [];
  for (const contract of contracts) if (contract.needles.some(n => mentions(haystack, n) >= 0)) linked.push(contract.folder);
  return {
    id: record.id, provider: record.provider, automated: record.automated, startedAt: record.startedAt,
    gitBranch: record.gitBranch, project: record.project, model: topValue(record.models), effort: topValue(record.efforts),
    firstPrompt: first?.text ?? null, firstAt: first?.at ?? null, prompts: prompts.length, tokens: record.tokens.total, linked,
  };
}

function titleOf(text, fallback) {
  const line = String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  return cap(scrub(line).replace(/\s+/g, ' '), 120) || fallback;
}

// First prompt as P1 plus the numbered/bulleted items it contains.
export function promptRequirements(prompt) {
  if (!prompt) return [];
  const { numbered, bullets } = parseListItems(prompt);
  const items = normalizeItems([...numbered, ...bullets].map(item => ({ ...item, n: undefined })), 'P1.');
  return [{ id: 'P1', literal: literalOf(prompt), status: null }, ...items.filter(item => item.id !== 'P1')].slice(0, MAX_REQUIREMENTS);
}

function outcomeOf(chats, metricsOf) {
  const outcome = { corrections: 0, falseDone: 0, interruptions: 0, fixedOrReverted72h: 0, turnsToFirstVerifiedCommit: null, userTurns: 0, tokens: 0 };
  for (const chat of chats) {
    const m = metricsOf(chat.id);
    if (!m) { outcome.userTurns += chat.prompts; outcome.tokens += chat.tokens; continue; }
    outcome.corrections += m.corrections.count;
    outcome.falseDone += m.falseDone.count;
    outcome.interruptions += m.interruptions;
    outcome.fixedOrReverted72h += m.commitsFixedOrReverted72h;
    outcome.userTurns += m.userTurns;
    outcome.tokens += m.tokens.total;
    const turns = m.turnsToFirstVerifiedCommit;
    if (turns !== null && (outcome.turnsToFirstVerifiedCommit === null || turns < outcome.turnsToFirstVerifiedCommit)) outcome.turnsToFirstVerifiedCommit = turns;
  }
  return outcome;
}

// Last accepted commit across the task's chats in its repo: a fixed follow-up
// replaces its commit; reverted commits are skipped.
function finalCandidate(chats, metricsOf, repoRoot) {
  for (const chat of [...chats].reverse()) {
    const commits = metricsOf(chat.id)?.commits ?? [];
    for (const commit of [...commits].reverse()) {
      if (commit.repoRoot && !sameRepo(commit.repoRoot, repoRoot)) continue;
      if (commit.followUp === 'reverted') continue;
      return commit.followUp === 'fixed' && commit.followUpSha ? commit.followUpSha : commit.sha;
    }
  }
  return null;
}

export async function buildCatalog({ store, contractsDir = DEFAULT_CONTRACTS_DIR, contracts, exec = createGitExec(), timeoutMs = 10000 } = {}) {
  const contractList = (contracts ?? readContracts({ dir: contractsDir })).map(c => ({ ...c, needles: needlesOf(c) }));
  const chats = [];
  for (const record of store.chats()) chats.push(summarize(record, contractList));
  chats.sort(byStart);

  const metricsCache = new Map();
  const metricsOf = id => {
    if (!metricsCache.has(id)) metricsCache.set(id, store.metricsFor(id));
    return metricsCache.get(id);
  };
  const gitCache = new Map();
  const git = (args, cwd) => {
    const key = `${norm(cwd)}\n${args.join('\0')}`;
    if (!gitCache.has(key)) gitCache.set(key, runGit(exec, args, cwd, timeoutMs));
    return gitCache.get(key);
  };

  // 1. Exclusions: automated lanes, chats without a human prompt, same-session duplicates.
  const seen = new Map(), excluded = new Map();
  for (const chat of chats) {
    if (chat.automated) { excluded.set(chat.id, REASONS.automated); continue; }
    if (!chat.prompts) { excluded.set(chat.id, REASONS.noPrompt); continue; }
    // Forks/resumed copies repeat the same first prompt at the same instant.
    if (!chat.firstAt) continue;
    const key = `${chat.provider}\n${chat.firstAt}\n${chat.firstPrompt}`;
    if (seen.has(key)) { excluded.set(chat.id, REASONS.duplicate); continue; }
    seen.set(key, chat.id);
  }

  // 2. Contracts take their linked included chats, earliest first; a chat joins one contract.
  const included = chats.filter(chat => !excluded.has(chat.id));
  const linkedTo = new Map(contractList.map(c => [c.folder, included.filter(chat => chat.linked.includes(c.folder))]));
  const order = [...contractList].sort((a, b) => {
    const x = linkedTo.get(a.folder)[0], y = linkedTo.get(b.folder)[0];
    return (x ? 0 : 1) - (y ? 0 : 1) || (x && y ? byStart(x, y) : 0) || a.folder.localeCompare(b.folder);
  });
  const owner = new Map(), groups = [];
  for (const contract of order) {
    const linked = linkedTo.get(contract.folder);
    const free = linked.filter(chat => !owner.has(chat.id)).slice(0, MAX_CHATS_PER_TASK);
    free.forEach(chat => owner.set(chat.id, contract.folder));
    groups.push({ contract, chats: free, reason: free.length ? null : linked.length ? REASONS.chatsTaken : REASONS.noChat });
  }
  for (const chat of included) if (!owner.has(chat.id)) groups.push({ contract: null, chats: [chat], reason: null });

  const tasks = [];
  for (const group of groups) tasks.push(await buildTask(group, { metricsOf, git }));
  for (const chat of chats) if (excluded.has(chat.id)) tasks.push(excludedTask(chat, excluded.get(chat.id), metricsOf));
  for (const task of tasks) assertValid('task', task);

  const counts = { total: tasks.length, excluded: 0, reproducible: 0, byReason: {} };
  for (const task of tasks) {
    if (task.excluded) counts.excluded++;
    if (task.reproducible) counts.reproducible++;
    const reason = task.excluded ? task.excludedReason : task.reproducibleReason;
    counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
  }
  return { tasks, counts };
}

function baseFields(chats, metricsOf) {
  const lead = chats[0], m = lead ? metricsOf(lead.id) : null;
  const project = m?.project ?? lead?.project ?? null;
  return {
    project: project === null ? null : cap(project, 300),
    repoRoot: m?.repoRoot ?? null,
    taskType: m?.taskType ?? 'other',
    model: m?.model ?? lead?.model ?? null,
    effort: m?.effort ?? lead?.effort ?? null,
    hasSpec: m?.hasSpec ?? false,
  };
}

async function buildTask({ contract, chats, reason }, { metricsOf, git }) {
  const lead = chats[0] ?? null;
  const fields = baseFields(chats, metricsOf);
  const fromContract = contract?.requirements?.length ? contract.requirements.slice(0, MAX_REQUIREMENTS) : [];
  const task = {
    schemaVersion: 1,
    id: taskId([...chats.map(chat => chat.id), ...(contract ? [contract.folder] : [])]),
    sources: { chatIds: chats.map(chat => chat.id), contract: contract ? cap(contract.folder, 300) : null },
    title: contract ? cap(contract.title || contract.folder, 200) : titleOf(lead?.firstPrompt, 'Untitled chat'),
    ...fields,
    baseCommit: null,
    finalCommit: null,
    requirements: fromContract.length ? fromContract : promptRequirements(lead?.firstPrompt),
    outcome: outcomeOf(chats, metricsOf),
    reproducible: false,
    reproducibleReason: reason ?? REASONS.noRepo,
    excluded: false,
    excludedReason: null,
  };
  if (!lead) return task;

  const repoRoot = fields.repoRoot;
  const repoExists = repoRoot && fs.existsSync(repoRoot) && (await git(['rev-parse', '--is-inside-work-tree'], repoRoot)) === 'true';
  if (repoExists) {
    if (lead.startedAt) {
      const refs = [...(lead.gitBranch && SAFE_REF.test(lead.gitBranch) ? [lead.gitBranch] : []), 'HEAD'];
      for (const ref of refs) {
        const sha = await git(['rev-list', '-1', `--before=${lead.startedAt}`, ref, '--'], repoRoot);
        if (sha && SHA.test(sha)) { task.baseCommit = sha; break; }
      }
    }
    const candidate = finalCandidate(chats, metricsOf, repoRoot);
    if (candidate) {
      const sha = await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], repoRoot);
      if (sha && SHA.test(sha)) task.finalCommit = sha;
    }
  }

  const deviceText = [lead.firstPrompt ?? '', ...task.requirements.map(r => r.literal)].join('\n');
  task.reproducibleReason = !repoExists ? REASONS.noRepo
    : !task.baseCommit ? REASONS.noBase
    : !task.finalCommit ? REASONS.noFinal
    : task.finalCommit === task.baseCommit ? REASONS.sameCommit
    : task.taskType === 'research' ? REASONS.research
    : task.taskType === 'ops' ? REASONS.ops
    : DEVICE.test(deviceText) ? REASONS.device
    : REASONS.ok;
  task.reproducible = task.reproducibleReason === REASONS.ok;
  return task;
}

function excludedTask(chat, reason, metricsOf) {
  const fields = baseFields([chat], metricsOf);
  return {
    schemaVersion: 1,
    id: taskId([chat.id]),
    sources: { chatIds: [chat.id], contract: null },
    title: titleOf(chat.firstPrompt, 'Untitled chat'),
    ...fields,
    baseCommit: null,
    finalCommit: null,
    requirements: [],
    outcome: outcomeOf([chat], metricsOf),
    reproducible: false,
    reproducibleReason: `excluded: ${reason}`,
    excluded: true,
    excludedReason: reason,
  };
}

// Builds the catalog and replaces the stored task table as a whole.
export async function catalogAndSave({ store, ...options } = {}) {
  const result = await buildCatalog({ store, ...options });
  store.replaceTasks(result.tasks);
  store.setMeta('catalog', { builtAt: new Date().toISOString(), counts: result.counts });
  return result;
}
