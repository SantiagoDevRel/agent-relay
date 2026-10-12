import './config.mjs';
// Chats dashboard server: reads Claude Code and Codex chat state every few seconds
// (no LLM, read-only) and streams it to the React UI on 127.0.0.1 only.
//
//   node --disable-warning=ExperimentalWarning server/server.mjs [--open]
//
// Security: binds 127.0.0.1; every request must carry an allowed Host header
// (blocks DNS rebinding); API calls need this run's random token; POSTs also need
// an allowed Origin and a JSON body. Side effects, all on User's click: open a
// closed chat in Windows Terminal, bring an open chat's tab to the front, end an
// open chat's process (after re-checking it is that chat), open Windows Update.
// "Resumen" sends the chat's messages to the local model on the DGX (summary.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearClaudeCache, collectClaude, sessionOf, stopClaudeWatcher } from './claude.mjs';
import { clearCodexCache, closeCodexDbs, collectCodex } from './codex.mjs';
import { askModel, buildPrompt, factsOf, ModelError, readConversation, SUMMARY_MODEL } from './summary.mjs';
import { Preferences, NotificationTransitions } from './preferences.mjs';
import { windowsNotification, notificationLink, verifyNotificationLink } from './notifications.mjs';
import { HistoryIndex } from './history.mjs';
import { Services } from './services.mjs';
import { Resources } from './resources.mjs';
import { advice } from './usage.mjs';
import { RelayCoordinator } from './relay.mjs';
import { MissionManager } from './missions.mjs';
import { MissionPlanner } from './mission-planner.mjs';
import { PromptRefiner } from './prompt-refiner.mjs';
import { collectProjects, browseProjectFolders } from './projects.mjs';
import { ChatControl } from './chat-control.mjs';
import { RemoteAccess } from './remote-access.mjs';
import { providerCatalog, openMissionTerminal } from './mission-runner.mjs';
import { MissionBudget } from './mission-budget.mjs';
import { DeliveryCollector } from './delivery.mjs';
import {
  appShortcut, focusTab, isRunning, killTree, pressCtrlC, processIdentity, ProcessWatch, rebootPending,
} from './system.mjs';

const PORT = Number(process.env.CHATS_PORT || 4848);
const HOST = '127.0.0.1';
const URL_BASE = `http://${HOST}:${PORT}`;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const CYCLE_MS = 4000;
const PING_MS = 15_000;
const WINUPDATE_MS = 5 * 60_000;
const TOKEN = crypto.randomBytes(24).toString('hex');
const remoteAccess = new RemoteAccess({ port: PORT });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTINGS_FILE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'chats-dashboard', 'settings.json');
const preferences = new Preferences(path.join(path.dirname(SETTINGS_FILE), 'preferences.json'));
const history = new HistoryIndex(os.homedir(), path.join(path.dirname(SETTINGS_FILE), 'history.sqlite'));
const services = new Services();
const resources = new Resources();
const usageIndex = new HistoryIndex(os.homedir(), path.join(path.dirname(SETTINGS_FILE), 'usage.sqlite'), './usage-worker.mjs');
let usageUpdated = 0;
const transitions = new NotificationTransitions();
const delivery = new DeliveryCollector({ onChange: () => {
  if (paused || !snapshot) return;
  const now = Date.now(), chats = snapshot.chats.map(chat => ({ ...chat, delivery: delivery.forChat(chat, now) }));
  snapshot = { ...snapshot, chats, delivery: delivery.publicState() };
  broadcast();
} });
let notificationStatus = { enabled: preferences.data.notifications, error: '', setting: 'unknown' };
let notificationJob = false;
const notificationQueue = new Map();
let activeSummary = null;
const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const log = (...args) => console.log(new Date().toISOString(), ...args);
const watch = new ProcessWatch();
const clients = new Set();
let settings = loadSettings();
let paused = false;
let pausedSince;
let running = false;
let rebootFlag = false;
let snapshot = null;
let targets = new Map(); // chat id -> what "Abrir" needs; never taken from the request
let relayError = '';
let relay;
try {
  relay = new RelayCoordinator({ file: path.join(path.dirname(SETTINGS_FILE), 'relays.json'),
    artifacts: path.join(os.homedir(), 'Downloads', 'agent-work', 'agent-relay'), targets: () => targets });
} catch {
  relayError = 'Could not read orchestration history. Check its local file before starting another cycle.';
}
let cycleTimer;
let missions, planner, refiner;
let missionError = '';
const missionTerminalViews = new Set();
try {
  const artifacts = path.join(os.homedir(), 'Downloads', 'agent-work', 'agent-relay-missions');
  planner = new MissionPlanner({ file: path.join(path.dirname(SETTINGS_FILE), 'mission-plans.json'), artifacts, onChange: broadcast });
  missions = new MissionManager({ file: path.join(path.dirname(SETTINGS_FILE), 'missions.json'), artifacts, resolveBaseline: id => planner.baseline(id), onChange: broadcast });
  refiner = new PromptRefiner({ file: path.join(path.dirname(SETTINGS_FILE), 'prompt-specs.json'), artifacts: path.join(artifacts, 'prompt-specs'), onChange: broadcast });
} catch (error) {
  missionError = 'Could not read mission state. Check the local files before starting another mission.';
  log('mission initialization:', error.message);
}
const chatControl = new ChatControl({ targets: () => targets, artifacts: path.join(os.homedir(), 'Downloads', 'agent-work', 'agent-relay-messages'),
  leased: id => (relay?.publicState() || []).some(job => !['approved', 'stopped', 'attention', 'expired'].includes(job.status) && Object.values(job.members).some(member => member.id === id)) });
let projectChoices = null, projectChoicesAt = 0;
async function projectCatalog() {
  if (!projectChoices || Date.now() - projectChoicesAt > 10000) {
    projectChoices = await collectProjects({ chats: [...targets.values()], missions: missions?.publicState() || [] }); projectChoicesAt = Date.now();
  }
  return projectChoices;
}
function missionState() {
  return { jobs: (missions?.publicState() || []).map(job => ({ ...job, orchestrator: planner?.details(job.planId) || null })), error: missionError, planning: Boolean(planner?.busy) };
}
function synchronizeMissionTerminals() {
  for (const job of missionState().jobs) {
    if (!job.terminalViews || job.status !== 'running') continue;
    const members = [...(!job.terminalWindow ? ['orchestrator'] : []), ...job.tasks.filter(task => task.startedAt).map(task => task.id)];
    for (const taskId of members) {
      const key = `${job.id}/${taskId}`;
      if (missionTerminalViews.has(key)) continue;
      missionTerminalViews.add(key);
      void openMissionTerminal({ missionId: job.id, taskId, cliPath: fileURLToPath(new URL('../relay-cli.mjs', import.meta.url)), cwd: job.project,
        windowName: job.terminalWindow || `agent-relay-${job.id}` }).catch(error => log('mission terminal view:', error.message));
    }
  }
}
function orchestratorLog(job) {
  const transcript = job.planId ? planner.log(job.planId) : '';
  return `${transcript}\n\n[Orquestador · ${job.title}]\n${job.status} · ${job.progress.completed}/${job.progress.total}\n${job.detail}\n` +
    job.events.map(event => `${new Date(event.at).toISOString()} ${event.text}`).join('\n') +
    '\n\n[Chats conectados]\n' + job.tasks.map(task => `${task.title} · ${task.status}\n${missions.log(job.id, task.id).slice(-2000)}`).join('\n\n');
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { windowDays: [1, 3, 7].includes(s.windowDays) ? s.windowDays : 3, showAutomated: s.showAutomated === true };
  } catch {
    return { windowDays: 3, showAutomated: false };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    log('settings not saved:', err.message);
  }
}

const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

function buildSnapshot(now, chats, hidden, error) {
  return {
    generatedAt: now,
    paused,
    pausedSince,
    windowDays: settings.windowDays,
    showAutomated: settings.showAutomated,
    notifications: notificationStatus,
    chats,
    hiddenAutomated: hidden,
    windowsUpdate: { rebootPending: rebootFlag },
    server: { rssMb: rssMb(), mobile: remoteAccess.publicState() },
    resources: resources.publicState(),
    assistance: preferences.data.assistance,
    delivery: delivery.publicState(),
    relays: { jobs: relay?.publicState() || [], error: relayError },
    missions: missionState(),
    error,
  };
}

async function cycle() {
  if (paused || running) return;
  running = true;
  try {
    const now = Date.now();
    const procs = watch.snapshot(now);
    const managed = missionState().jobs.flatMap(job => [job.orchestrator?.nativeId, ...job.tasks.map(task => task.nativeId)]).filter(Boolean);
    const opts = { procs, windowMs: settings.windowDays * 86400_000, now, includeAutomated: settings.showAutomated, includedIds: new Set([...preferences.favorites(), ...managed]) };
    const errors = [];
    let claude = { chats: [], hidden: 0 };
    let codex = { chats: [], hidden: 0 };
    try {
      claude = collectClaude(opts);
    } catch (err) {
      errors.push('Could not read Claude chats.');
      log('claude collector:', err.stack || err.message);
    }
    try {
      codex = collectCodex(opts);
    } catch (err) {
      closeCodexDbs();
      errors.push('Could not read Codex chats.');
      log('codex collector:', err.stack || err.message);
    }
    const all = [...claude.chats, ...codex.chats];
    delivery.refresh(all, now);
    resources.refresh(now);
    if (now - usageUpdated > 30000) {
      usageUpdated = now;
      usageIndex.request('update', { sources: all.filter(c=>c.file).map(({ id,tool,file,folder,automated,alive })=>({id,tool,file,folder,automated:Boolean(automated),alive})) })
        .catch(err=>log('usage index:',err.message));
    }
    for (const [id, since] of opening) {
      if (now - since >= 30_000 || all.some((chat) => chat.id === id && chat.alive)) opening.delete(id);
    }
    targets = new Map(all.map((c) => [c.id, c]));
    // Each explicit job has finite turns/deadline; no inference runs while waiting.
    void relay?.tick().catch(err => { relayError = 'Could not save orchestration state.'; log('relay:', err.message); });
    void missions?.tick().catch(err => { missionError = 'Could not save mission state.'; log('missions:', err.message); });
    // Paths and process identity stay server-side; the UI has cdCommand and the pid.
    const roles = new Map();
    for (const job of missionState().jobs) {
      if (job.orchestrator?.nativeId) roles.set(job.orchestrator.nativeId, { role: 'orchestrator', missionId: job.id });
      for (const task of job.tasks) if (task.nativeId) roles.set(task.nativeId, { role: 'worker', missionId: job.id });
    }
    const chats = all.map(({ cwd, file, procStart, pidSeenAt, ...pub }) => ({ ...pub, ...preferences.get(pub.id), ...roles.get(pub.id),
      delivery: delivery.forChat(pub, now),
      resources: resources.forChat({ ...pub, procStart, pidSeenAt }), advice: advice(pub.usage, preferences.data.assistance) }));
    if (errors.length) transitions.reset();
    else {
      const events = transitions.update(chats);
      if (notificationStatus.enabled) for (const chat of events) notificationQueue.set(chat.id, chat);
      deliverNotifications();
    }
    snapshot = buildSnapshot(now, chats, claude.hidden + codex.hidden, errors.join(' ') || undefined);
    broadcast();
  } finally {
    running = false;
  }
}

function scheduleCycles() {
  clearTimeout(cycleTimer);
  if (paused) return;
  cycleTimer = setTimeout(async () => {
    await cycle();
    scheduleCycles();
  }, CYCLE_MS);
}

function deliverNotifications() {
  if (!notificationStatus.enabled || notificationJob || !notificationQueue.size) return;
  notificationJob = true;
  // One chat per toast: each click has an unambiguous target. Serialize helpers.
  const first = notificationQueue.values().next().value;
  notificationQueue.delete(first.id);
  log('notification', first.id, first.notificationKind);
  windowsNotification({ title: first.notificationKind === 'cut' ? 'A chat was interrupted' : 'Your chat finished its turn',
    text: first.title.slice(0, 300), url: notificationLink(first.id, PORT, TOKEN) })
    .then(result => { notificationStatus = { ...notificationStatus, error: '', setting: result.setting }; })
    .catch(err => { notificationStatus = { ...notificationStatus, error: err.message.slice(0, 250) }; })
    .finally(() => { notificationJob = false; deliverNotifications(); });
}

async function refreshRebootFlag() {
  rebootFlag = await rebootPending();
}

function broadcast() {
  if (!snapshot) return;
  snapshot = { ...snapshot, relays: { jobs: relay?.publicState() || [], error: relayError }, missions: missionState() };
  synchronizeMissionTerminals();
  const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of clients) res.write(frame);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// `cmd /c start` only hands off to another program: its own console stays hidden.
function detached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: cmd === 'cmd.exe' });
  child.on('error', (err) => log(`spawn ${cmd} failed:`, err.message));
  child.unref();
  return child;
}

// Opens the chat in a new Windows Terminal tab, in its folder. Everything comes
// from the server's own snapshot; the request only names the chat id.
const opening = new Map(); // Reserve until the collector sees the process, at most 30 s.
async function openChat(id) {
  const chat = targets.get(id);
  if (!chat || !UUID.test(id)) return [404, { error: 'not found' }];
  if (chat.alive) return [409, { error: 'already open' }];
  if (opening.has(id) && Date.now() - opening.get(id) < 30_000) return [409, { error: 'already opening' }];
  if (!chat.cwd || /[;"]/.test(chat.cwd) || !fs.existsSync(chat.cwd)) return [422, { error: 'folder missing' }];
  const title = chat.title.replace(/[;"'`]/g, '').slice(0, 60) || 'Chat';
  const run = chat.tool === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`;
  opening.set(id, Date.now());
  try {
    const child = detached('wt.exe', ['-w', '0', 'new-tab', '--title', title, '-d', chat.cwd, 'powershell.exe', '-NoExit', '-Command', run]);
    const launched = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!launched) throw new Error('launch failed');
  } catch {
    opening.delete(id);
    return [500, { error: 'launch failed' }];
  }
  log('opened', chat.tool, id);
  return [200, { ok: true }];
}

// "Ir al chat": selects the open chat's Windows Terminal tab and brings it forward.
let focusing = false;
async function focusChat(id) {
  const chat = targets.get(id);
  if (!chat || !UUID.test(id)) return [404, { error: 'not found' }];
  if (!chat.alive) return [409, { error: 'not open' }];
  if (focusing) return [429, { error: 'busy' }];
  focusing = true;
  try {
    const out = await focusTab(chat.title);
    if (!out) return [500, { error: 'focus failed' }];
    log('focus', chat.tool, id, out.found ? `tabs=${out.matches} focused=${out.focused}` : 'no tab');
    return [200, out];
  } finally {
    focusing = false;
  }
}

const waitForExit = async (pid, ms) => {
  for (let waited = 0; waited < ms; waited += 250) {
    if (!isRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !isRunning(pid);
};

// "Cerrar": quits an open chat the way User does, with Ctrl+C in its tab, so
// Claude records a normal exit (shown as closed, not cut). Three presses cover a
// running turn (interrupt), a half-typed message (clear) and the quit itself;
// extra ones only reach the shell prompt. Force-kills only if it does not quit.
// Before anything, the process must still be that chat: the pid the UI showed,
// the right program and, for Claude, the same session and start time.
const closing = new Set();
async function closeChat(id, pid) {
  const chat = targets.get(id);
  if (!chat || !UUID.test(id)) return [404, { error: 'not found' }];
  if (!chat.alive || !chat.pid) return [409, { error: 'not open' }];
  if (pid !== chat.pid) return [409, { error: 'changed' }];
  if (closing.has(id)) return [429, { error: 'busy' }];
  closing.add(id);
  try {
    return await closeVerified(chat, id);
  } finally {
    closing.delete(id);
  }
}

async function closeVerified(chat, id) {
  const proc = await processIdentity(chat.pid);
  if (!proc) return [409, { error: 'not open' }];
  let same = proc.image === `${chat.tool}.exe`;
  if (same && chat.tool === 'claude') {
    const session = sessionOf(chat.pid);
    same = session?.sessionId === id && (!session.procStart || String(session.procStart) === proc.created);
  } else if (same && chat.pidSeenAt) {
    same = proc.createdMs <= chat.pidSeenAt + 1000; // the process existed when it logged this thread
  }
  if (!same) return [409, { error: 'changed' }];
  let how = 'clean';
  const first = await pressCtrlC(chat.pid, 3);
  let gone = first.sent > 0 && (await waitForExit(chat.pid, 5000));
  if (!gone && first.sent > 0) gone = (await pressCtrlC(chat.pid, 2)).sent > 0 && (await waitForExit(chat.pid, 3000));
  if (!gone) {
    how = 'forced';
    if (!(await killTree(chat.pid)) && isRunning(chat.pid)) return [500, { error: 'kill failed' }];
  }
  log('closed', chat.tool, id, 'pid', chat.pid, how);
  await cycle();
  return [200, { ok: true, how }];
}

// "Resumen": facts straight from the transcript, then a summary from the DGX model.
const summaries = new Map(); // chat id -> { size, at, model, summary }; memory only
const pendingSummaries = new Map(); // chat id -> Promise<[status, body]>
let modelQueue = Promise.resolve();

function conversationOf(chat) {
  const { conv, partial, size } = readConversation(chat.tool, chat.file);
  return { conv, size, facts: factsOf(conv, { partial, cwd: chat.cwd }) };
}

function chatFacts(id) {
  const chat = targets.get(id);
  if (!chat || !UUID.test(id) || !chat.file) return [404, { error: 'not found' }];
  try {
    return [200, { facts: conversationOf(chat).facts, model: SUMMARY_MODEL }];
  } catch {
    return [422, { error: 'unreadable' }];
  }
}

async function chatSummary(id, refresh) {
  const chat = targets.get(id);
  if (!chat || !UUID.test(id) || !chat.file) return [404, { error: 'not found' }];
  if (pendingSummaries.has(id)) return pendingSummaries.get(id);
  let read;
  try {
    read = conversationOf(chat);
  } catch {
    return [422, { error: 'unreadable' }];
  }
  const cached = summaries.get(id);
  if (cached && cached.size === read.size && !refresh) return [200, { ...cached, cached: true }];
  if (!read.conv.messages.length) return [422, { error: 'empty' }];
  if (pendingSummaries.size >= 3) return [429, { error: 'busy' }];
  const prompt = buildPrompt(chat, read.conv, read.facts);
  // One model request at a time: the DGX also runs other jobs.
  const job = modelQueue.then(async () => {
    activeSummary = id;
    const started = Date.now();
    try {
      const summary = await askModel(prompt);
      const entry = { size: read.size, at: Date.now(), model: SUMMARY_MODEL, summary };
      summaries.set(id, entry);
      log('summary', chat.tool, id, `${Date.now() - started} ms`);
      return [200, entry];
    } catch (err) {
      const code = err instanceof ModelError ? err.code : 'failed';
      log('summary failed', chat.tool, id, code, err.message);
      return [{ timeout: 504, unreachable: 503 }[code] || 502, { error: code }];
    } finally { activeSummary = null; }
  });
  modelQueue = job.then(() => undefined);
  pendingSummaries.set(id, job);
  try {
    return await job;
  } finally {
    pendingSummaries.delete(id);
  }
}

function summaryQueue() {
  return [...pendingSummaries.keys()].map((id, index) => ({ id, title: targets.get(id)?.title || id, status: activeSummary === id ? 'running' : 'queued', position: index + 1 }));
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/ping') return send(res, 200, { app: 'chats-dashboard', mobile: remoteAccess.publicState() });

  if (req.method === 'GET') {
    if (!tokenOk(url.searchParams.get('t'))) return send(res, 403, { error: 'forbidden' });
    if (url.pathname === '/api/snapshot') return send(res, 200, snapshot || {});
    if (url.pathname === '/api/missions') return send(res, 200, missionState());
    if (url.pathname === '/api/projects') return send(res, 200, await projectCatalog());
    if (url.pathname === '/api/projects/folders') {
      try { return send(res, 200, await browseProjectFolders({ folder: url.searchParams.get('path') || undefined })); }
      catch (error) { return send(res, error.status || 422, { error: error.message }); }
    }
    if (url.pathname === '/api/chat/conversation') {
      try { return send(res, 200, chatControl.conversation(url.searchParams.get('id'))); }
      catch (error) { return send(res, error.status || 422, { error: error.message }); }
    }
    if (url.pathname === '/api/prompts/history' || url.pathname === '/api/prompts/log') {
      if (!refiner || missionError) return send(res, 503, { error: missionError || 'Prompt preparation is unavailable.' });
      try {
        return send(res, 200, url.pathname.endsWith('/history') ? refiner.history(url.searchParams.get('kind')) : refiner.log(url.searchParams.get('id')));
      } catch (error) { return send(res, error.status || 404, { error: error.message }); }
    }
    if (url.pathname === '/api/missions/catalog') return send(res, 200, { ...(await providerCatalog()), admission: await new MissionBudget().state() });
    if (url.pathname === '/api/missions/status') {
      const job = missionState().jobs.find(value => value.id === url.searchParams.get('id'));
      return send(res, job ? 200 : 404, job || { error: 'Mission not found.' });
    }
    if (url.pathname === '/api/missions/log') {
      if (!missions) return send(res, 503, { error: 'Missions are unavailable.' });
      const id = url.searchParams.get('id'), taskId = url.searchParams.get('taskId');
      const job = missionState().jobs.find(value => value.id === id);
      if (!job) return send(res, 404, { error: 'Mission not found.' });
      try { return send(res, 200, { text: taskId === 'orchestrator' ? orchestratorLog(job) : await missions.log(id, taskId) }); }
      catch (error) { return send(res, error.status || 404, { error: error.message }); }
    }
    if (url.pathname === '/api/queue') return send(res, 200, { queue: summaryQueue() });
    if (url.pathname === '/api/insights') return send(res, 200, { ...(await usageIndex.request('stats', { automated: settings.showAutomated })), resources: resources.publicState(), templates: preferences.data.templates || [], assistance: preferences.data.assistance });
    if (url.pathname === '/api/services') {
      const dgx = await services.status();
      return send(res, 200, { dgx, history: history.state, notifications: notificationStatus,
        queue: summaryQueue() });
    }
    if (url.pathname === '/api/history') {
      const query = (url.searchParams.get('q') || '').trim();
      const offset = Number(url.searchParams.get('offset') || 0);
      if (query.length > 120 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) return send(res, 400, { error: 'invalid query' });
      const result = await history.request('search', { query, offset, automated: settings.showAutomated });
      result.results = result.results.map(hit => ({ ...hit, ...preferences.get(hit.id), current: snapshot?.chats.find(c => c.id === hit.id) }));
      return send(res, 200, result);
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      if (snapshot) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!remoteAccess.originAllowed(req, req.relayAuthorization) || !tokenOk(req.headers['x-chats-token'])) return send(res, 403, { error: 'forbidden' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
  let body;
  try {
    body = await readJson(req, url.pathname.startsWith('/api/missions/') ? 262_144 : ['/api/templates', '/api/relay/start', '/api/prompts/refine', '/api/chat/message'].includes(url.pathname) ? 65_536 : 16_384);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'bad request' });
  // A paused snapshot must agree with the persisted controls. Resume before
  // changing collection settings; otherwise a successful click looks ignored.
  if (paused && (url.pathname === '/api/window' || url.pathname === '/api/automated' || url.pathname === '/api/assistance'
    || (url.pathname === '/api/control' && body.action === 'resync'))) {
    return send(res, 409, { error: 'paused' });
  }

  switch (url.pathname) {
    case '/api/prompts/refine': {
      if (paused) return send(res, 409, { error: 'Resume Agent Relay before preparing the prompt.' });
      if (!refiner || missionError) return send(res, 503, { error: missionError || 'Prompt preparation is unavailable.' });
      if (planner?.busy) return send(res, 409, { error: 'Wait for the current plan to finish.' });
      try { return send(res, 200, await refiner.refine(body)); }
      catch (error) { return send(res, error.status || 422, { error: error.message, ...(UUID.test(error.refinementId || '') ? { refinementId: error.refinementId } : {}) }); }
    }
    case '/api/chat/message': {
      if (paused) return send(res, 409, { error: 'Resume Agent Relay before sending messages.' });
      try { const result = await chatControl.message(body.id, body.text); await cycle(); return send(res, 200, result); }
      catch (error) { return send(res, error.status || 409, { error: error.message }); }
    }
    case '/api/missions/plan':
    case '/api/missions/create':
    case '/api/missions/start':
    case '/api/missions/pause':
    case '/api/missions/resume':
    case '/api/missions/stop':
    case '/api/missions/retry':
    case '/api/missions/extend':
    case '/api/missions/message':
    case '/api/missions/apply':
    case '/api/missions/terminal': {
      if (!missions || !planner || missionError) return send(res, 503, { error: missionError || 'Misiones no disponibles.' });
      const action = url.pathname.split('/').at(-1);
      if (paused && !['stop', 'pause'].includes(action)) return send(res, 409, { error: 'Resume Agent Relay before changing missions.' });
      try {
        if (action === 'plan') {
          if (refiner?.busy) return send(res, 409, { error: 'Wait for the current specification to finish.' });
          if (missionState().jobs.some(job => job.status === 'running')) return send(res, 409, { error: 'Wait for or pause active missions before planning another.' });
          return send(res, 200, await planner.plan(body));
        }
        if (planner.busy && ['start', 'resume', 'retry'].includes(action)) return send(res, 409, { error: 'Espera a que termine el plan actual.' });
        if (action === 'create') return send(res, 200, await missions.create(body));
        if (action === 'extend') return send(res, 200, await missions.extend(body.id, { minutes: body.minutes, taskId: body.taskId }));
        if (action === 'message') { await missions.message(body.id, body.taskId, body.text); return send(res, 200, await missions.retry(body.id, body.taskId)); }
        if (action === 'retry') return send(res, 200, await missions.retry(body.id, body.taskId));
        if (action === 'terminal') {
          const job = missionState().jobs.find(value => value.id === body.id);
          if (!job || (body.taskId !== 'orchestrator' && !job.tasks.some(task => task.id === body.taskId))) return send(res, 404, { error: 'Chat no encontrado.' });
          return send(res, 200, await openMissionTerminal({ missionId: job.id, taskId: body.taskId, cliPath: fileURLToPath(new URL('../relay-cli.mjs', import.meta.url)), cwd: job.project, windowName: job.terminalWindow || `agent-relay-${job.id}` }));
        }
        return send(res, 200, await missions[action](body.id));
      } catch (error) { return send(res, error.status || 409, { error: error.message }); }
    }
    case '/api/relay/start': {
      if (paused) return send(res, 409, { error: 'paused' });
      if (!relay) return send(res, 503, { error: 'relay unavailable' });
      try {
        const id = await relay.create(body);
        await cycle();
        return send(res, 200, { id });
      } catch (err) {
        return send(res, err.message === 'invalid relay' ? 400 : 409, { error: err.message });
      }
    }
    case '/api/relay/stop': {
      if (!relay || !UUID.test(body.id || '')) return send(res, 404, { error: 'not found' });
      try { relay.stop(body.id); await cycle(); broadcast(); return send(res, 200, { ok: true }); }
      catch { return send(res, 404, { error: 'not found' }); }
    }
    case '/api/preferences': {
      if (!UUID.test(body.id || '') || !targets.has(body.id)) return send(res, 404, { error: 'not found' });
      if ((body.favorite !== undefined && typeof body.favorite !== 'boolean') || (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) || (body.outcome !== undefined && !['none','useful','corrected','abandoned'].includes(body.outcome))) return send(res, 400, { error: 'invalid preference' });
      const patch = {};
      if (body.projectFolder !== undefined) {
        if (body.projectFolder !== null && (typeof body.projectFolder !== 'string' || body.projectFolder.length > 300 || /[\x00-\x1f\x7f]/.test(body.projectFolder))) return send(res, 400, { error: 'invalid project' });
        // A visual association only. Never update targets, provider cwd or commands.
        patch.projectFolder = body.projectFolder === null ? null : body.projectFolder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      }
      if (body.favorite !== undefined) patch.favorite = body.favorite;
      if (body.note !== undefined) patch.note = body.note;
      if (body.outcome !== undefined) patch.outcome = body.outcome;
      const value = preferences.chat(body.id, patch);
      if (snapshot) snapshot = { ...snapshot, chats: snapshot.chats.map(c => c.id === body.id ? { ...c, ...value } : c) };
      broadcast();
      return send(res, 200, value);
    }
    case '/api/assistance': {
      if (!Number.isSafeInteger(body.handoffTokens) || body.handoffTokens < 10000 || body.handoffTokens > 2000000 || !Number.isSafeInteger(body.handoffPercent) || body.handoffPercent < 50 || body.handoffPercent > 95) return send(res,400,{error:'invalid thresholds'});
      const value=preferences.assistance({handoffTokens:body.handoffTokens,handoffPercent:body.handoffPercent});
      await cycle(); return send(res,200,value);
    }
    case '/api/templates': {
      if (!UUID.test(body.id || '') || typeof body.name!=='string' || !body.name.trim() || body.name.length>80 || typeof body.text!=='string' || !body.text.trim() || body.text.length>10000) return send(res,400,{error:'invalid template'});
      return send(res,200,{templates:preferences.template({id:body.id,name:body.name.trim(),text:body.text})});
    }
    case '/api/notifications': {
      if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be boolean' });
      let nextStatus = { ...notificationStatus, enabled: body.enabled, error: '' };
      if (body.enabled) {
        try {
          const candidates = [...targets.values()].filter(chat => chat.alive && !chat.automated);
          const testChat = candidates.find(chat => chat.state === 'waiting') || candidates[0];
          const status = await windowsNotification(!body.test ? {} : testChat
            ? { title: `Test: ${testChat.title}`.slice(0, 150), text: 'Click to open this chat tab.', url: notificationLink(testChat.id, PORT, TOKEN) }
            : { title: 'Chat notifications enabled', text: 'No chats are open to test the shortcut.', url: `${URL_BASE}/` });
          nextStatus = { enabled: true, error: '', setting: status.setting };
        } catch (err) { return send(res, 503, { error: 'notifications unavailable', detail: err.message.slice(0, 300) }); }
      }
      preferences.notifications(body.enabled); notificationStatus = nextStatus;
      transitions.reset(); notificationQueue.clear();
      if (snapshot) snapshot = { ...snapshot, notifications: notificationStatus };
      broadcast();
      return send(res, 200, notificationStatus);
    }
    case '/api/control': {
      const { action } = body;
      if (action === 'pause') {
        paused = true;
        pausedSince = Date.now();
        clearTimeout(cycleTimer);
        if (snapshot) snapshot = { ...snapshot, paused, pausedSince };
        broadcast();
      } else if (action === 'resume') {
        transitions.reset();
        paused = false;
        pausedSince = undefined;
        await cycle();
        scheduleCycles();
      } else if (action === 'resync') {
        clearClaudeCache();
        clearCodexCache();
        await watch.verify();
        await refreshRebootFlag();
        await cycle();
        scheduleCycles();
      } else if (action === 'quit') {
        send(res, 200, { ok: true });
        setTimeout(shutdown, 150);
        return undefined;
      } else return send(res, 400, { error: 'unknown action' });
      return send(res, 200, { ok: true });
    }
    case '/api/window': {
      if (![1, 3, 7].includes(body.days)) return send(res, 400, { error: 'days must be 1, 3 or 7' });
      settings = { ...settings, windowDays: body.days };
      saveSettings();
      await cycle();
      return send(res, 200, { ok: true });
    }
    case '/api/automated': {
      if (typeof body.show !== 'boolean') return send(res, 400, { error: 'show must be boolean' });
      settings = { ...settings, showAutomated: body.show };
      saveSettings();
      await cycle();
      return send(res, 200, { ok: true });
    }
    case '/api/open': {
      const [status, out] = await openChat(String(body.id || ''));
      return send(res, status, out);
    }
    case '/api/notification-click': {
      if (!verifyNotificationLink(body.id, body.signature, PORT, TOKEN)) return send(res, 403, { error: 'invalid notification' });
      const [status, out] = await focusChat(body.id);
      return send(res, status, out);
    }
    case '/api/focus': {
      const [status, out] = await focusChat(String(body.id || ''));
      return send(res, status, out);
    }
    case '/api/close': {
      const [status, out] = await closeChat(String(body.id || ''), body.pid);
      return send(res, status, out);
    }
    case '/api/facts': {
      const [status, out] = chatFacts(String(body.id || ''));
      return send(res, status, out);
    }
    case '/api/summary': {
      const [status, out] = await chatSummary(String(body.id || ''), body.refresh === true);
      return send(res, status, out);
    }
    case '/api/windows-update':
      detached('cmd.exe', ['/c', 'start', '', 'ms-settings:windowsupdate']);
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: 'not found' });
  }
}

// Re-read after each `npm run build`, whose asset names change.
const index = { mtimeMs: 0, html: '' };
function serveStatic(res, pathname) {
  // /shell.html is the same page without a token: the installed app caches it to
  // open while the server is off (web/public/sw.js).
  const isIndex = pathname === '/' || pathname === '/index.html';
  if (isIndex || pathname === '/shell.html') {
    try {
      const file = path.join(DIST, 'index.html');
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs !== index.mtimeMs) Object.assign(index, { mtimeMs, html: fs.readFileSync(file, 'utf8') });
    } catch {
      return send(res, 503, 'Build the interface first: run `npm run build` in tools/chats-dashboard.');
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(index.html.replace('__CHATS_TOKEN__', isIndex ? TOKEN : ''));
  }
  const file = path.resolve(DIST, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(path.resolve(DIST) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found');
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  return fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const authorization = remoteAccess.authorize(req);
    if (!authorization.allowed) return send(res, authorization.status, authorization.status === 421 ? 'Host no permitido' : 'Acceso privado no autorizado');
    req.relayAuthorization = authorization;
    if (authorization.remote) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, URL_BASE);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(res, url.pathname);
  } catch (err) {
    log('request failed:', err.stack || err.message);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
    return undefined;
  }
});

function openWindow() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const installed = appShortcut();
  if (installed) return detached('cmd.exe', ['/c', 'start', '', installed]);
  const chrome = candidates.find((c) => fs.existsSync(c));
  if (!chrome) return detached('cmd.exe', ['/c', 'start', '', `${URL_BASE}/`]);
  return detached(chrome, [`--app=${URL_BASE}/`, '--window-size=1280,900']);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  clearTimeout(cycleTimer);
  for (const res of clients) res.end();
  closeCodexDbs();
  stopClaudeWatcher();
  history.close();
  usageIndex.close();
  delivery.close();
  planner?.shutdown();
  refiner?.shutdown();
  await missions?.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 15000).unref();
}

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Already running? Then just show it.
  try {
    const r = await fetch(`${URL_BASE}/api/ping`);
    if ((await r.json()).app === 'chats-dashboard') {
      log('already running on', URL_BASE);
      if (process.argv.includes('--open')) openWindow();
      process.exit(0);
    }
  } catch {
    // Something else holds the port.
  }
  log(`port ${PORT} is taken by another program; set CHATS_PORT to use another one`);
  process.exit(1);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, async () => {
  log(`chats dashboard on ${URL_BASE}`);
  if (process.argv.includes('--open')) openWindow();
  await watch.verify();
  await refreshRebootFlag();
  setInterval(refreshRebootFlag, WINUPDATE_MS).unref();
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, PING_MS).unref();
  await cycle();
  scheduleCycles();
});
