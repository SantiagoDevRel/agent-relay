#!/usr/bin/env node
// Global CLI uses the same authenticated local server as the React app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { openOrchestratorTerminal } from './server/mission-runner.mjs';

const CLI = fileURLToPath(import.meta.url);
export class RelayClient {
  constructor({ port = Number(process.env.CHATS_PORT || 4848), fetcher = fetch } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid relay port');
    this.port = port; this.base = `http://127.0.0.1:${port}`; this.fetcher = fetcher; this.token = '';
  }
  async connect({ start = true } = {}) {
    const probe = async () => {
      const ping = await this.fetcher(this.base + '/api/ping', { signal: AbortSignal.timeout(2000) });
      if (!ping.ok || (await ping.json()).app !== 'chats-dashboard') throw Error('Another process is using the Relay port.');
      const page = await this.fetcher(this.base + '/', { signal: AbortSignal.timeout(5000) });
      this.token = (await page.text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1] || '';
      if (!this.token) throw Error('Build Agent Relay before starting the CLI.');
    };
    try { await probe(); return; } catch (error) { if (!start || !String(error.cause?.code || '').includes('ECONNREFUSED')) throw error; }
    const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('./server/server.mjs', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CHATS_PORT: String(this.port) } });
    child.on('error', () => {}); child.unref();
    for (let n = 0; n < 100; n++) { await new Promise(resolve => setTimeout(resolve, 100)); try { await probe(); return; } catch { /* Startup collector can be slow. */ } }
    throw Error('Agent Relay did not respond at startup. Check the local server.');
  }
  async request(route, body) {
    const options = body === undefined ? { signal: AbortSignal.timeout(15000) } : { method: 'POST', headers: { Origin: this.base, 'Content-Type': 'application/json', 'X-Chats-Token': this.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(route.endsWith('/apply') ? 1860000 : route.endsWith('/plan') || route.endsWith('/refine') || route.endsWith('/message') ? 360000 : 45000) };
    const response = await this.fetcher(this.base + route + (body === undefined ? `${route.includes('?') ? '&' : '?'}t=${this.token}` : ''), options);
    const value = await response.json(); if (!response.ok) throw Error(value.detail || value.error || `HTTP ${response.status}`); return value;
  }
}
export function parseOptions(args) {
  const positional = [], options = {};
  for (let n = 0; n < args.length; n++) {
    if (!args[n].startsWith('--')) { positional.push(args[n]); continue; }
    const key = args[n].slice(2); if (['start', 'json', 'once'].includes(key)) options[key] = true;
    else { if (!args[n + 1] || args[n + 1].startsWith('--')) throw Error(`Missing value for --${key}`); options[key] = args[++n]; }
  }
  return { positional, options };
}
const readJson = filename => JSON.parse(fs.readFileSync(path.resolve(filename.replace(/^@/, '')), 'utf8').replace(/^\uFEFF/, ''));
function summarize(job) { return `${job.id} · ${job.status} · ${job.progress.completed}/${job.progress.total} · ${job.title}\n  ${job.detail || ''}`; }
const help = `Agent Relay — from any folder, Codex or Claude

relay orchestrate --provider codex --project C:/path/repo --effort high
relay models
relay plan @request.json                       Generate a contract without running tasks
relay refine @request.json                     Improve a prompt without implementing it
relay create @contract.json --start            Create and start a mission
relay list                                    All missions
relay status MISSION --json                    State and dependencies
relay log MISSION TASK                         Chat log
relay chat MISSION TASK                        Managed chat in this terminal
relay terminal MISSION TASK                    Tab in the mission window
relay start|pause|resume|stop|apply MISSION
relay retry MISSION TASK                       Explicit retry with the same budget
relay extend MISSION --minutes 60              Extend the deadline without starting agents
relay extend MISSION --minutes 60 --task TASK   Extend an idle task
relay message MISSION TASK @message.txt        Continue a chat only when idle
relay serve                                   Start the local server

The project must be tracked in Git. Results are verified in isolated worktrees;
apply integrates only when the original branch and captured source remain unchanged.
Skill: agent-relay-orchestrator. No API keys or native subagents are used.`;

async function chat(client, missionId, taskId) {
  if (!process.stdin.isTTY) throw Error('chat requires an interactive terminal; use log or message with files.');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let prior = '', pending = false;
  const refresh = async () => {
    if (pending) return; pending = true;
    try {
      const result = await client.request(`/api/missions/log?id=${encodeURIComponent(missionId)}&taskId=${encodeURIComponent(taskId)}`);
      if (result.text !== prior) { console.log(result.text.startsWith(prior) ? result.text.slice(prior.length) : result.text); prior = result.text; }
    } catch (error) { console.error(error.message); } finally { pending = false; }
  };
  console.log(`Chat ${taskId} · mission ${missionId}\n/refresh /status /retry /open /exit. Text continues the idle session.`);
  await refresh(); const timer = setInterval(refresh, 4000);
  try {
    while (true) {
      const text = (await input.question('relay> ')).trim(); if (text === '/exit') break; if (!text) continue;
      try {
        if (text === '/refresh') await refresh();
        else if (text === '/status') console.log(JSON.stringify(await client.request(`/api/missions/status?id=${encodeURIComponent(missionId)}`), null, 2));
        else if (text === '/retry') console.log(await client.request('/api/missions/retry', { id: missionId, taskId }));
        else if (text === '/open') console.log(await client.request('/api/missions/terminal', { id: missionId, taskId }));
        else console.log(await client.request('/api/missions/message', { id: missionId, taskId, text }));
      } catch (error) { console.error(error.message); }
    }
  } finally { clearInterval(timer); input.close(); }
}
export async function main(args = process.argv.slice(2)) {
  const { positional: values, options } = parseOptions(args), [command = 'help', id, taskId, content] = values;
  if (command === 'help' || command === '-h') { console.log(help); return; }
  const client = new RelayClient({ port: Number(options.port || process.env.CHATS_PORT || 4848) }); await client.connect();
  if (command === 'serve') { console.log(`Agent Relay is running at ${client.base}`); return; }
  if (command === 'orchestrate') {
    if (process.env.AI_RELAY_MANAGED === '1') throw Error('A worker cannot open an orchestrator.');
    const provider = options.provider || 'codex', project = path.resolve(options.project || process.cwd());
    const out = await openOrchestratorTerminal({ provider, model: options.model || '', effort: options.effort || 'high', cwd: project, cliPath: CLI, port: client.port, windowName: `agent-relay-${crypto.randomUUID().slice(0, 8)}` });
    console.log(JSON.stringify(out, null, 2)); return;
  }
  let result;
  if (command === 'models') result = await client.request('/api/missions/catalog');
  else if (command === 'list') { result = await client.request('/api/missions'); if (!options.json) { console.log(result.jobs.length ? result.jobs.map(summarize).join('\n') : 'No missions yet.'); return; } }
  else if (command === 'status') result = await client.request(`/api/missions/status?id=${encodeURIComponent(id || '')}`);
  else if (command === 'plan') result = await client.request('/api/missions/plan', { ...readJson(id), ...((options.window || process.env.AGENT_RELAY_WINDOW) ? { terminalWindow: options.window || process.env.AGENT_RELAY_WINDOW, terminalViews: true } : {}) });
  else if (command === 'refine') result = await client.request('/api/prompts/refine', readJson(id));
  else if (command === 'create' || command === 'run') { result = await client.request('/api/missions/create', { ...readJson(id), ...((options.window || process.env.AGENT_RELAY_WINDOW) ? { terminalWindow: options.window || process.env.AGENT_RELAY_WINDOW, terminalViews: true } : {}) }); if (options.start || command === 'run') result = await client.request('/api/missions/start', { id: result.id }); }
  else if (['start', 'pause', 'resume', 'stop', 'apply'].includes(command)) result = await client.request(`/api/missions/${command}`, { id });
  else if (command === 'retry') result = await client.request('/api/missions/retry', { id, taskId });
  else if (command === 'extend') result = await client.request('/api/missions/extend', { id, minutes: Number(options.minutes), ...(options.task ? { taskId: options.task } : {}) });
  else if (command === 'message') result = await client.request('/api/missions/message', { id, taskId, text: fs.readFileSync(path.resolve((content || '').replace(/^@/, '')), 'utf8') });
  else if (command === 'terminal') result = await client.request('/api/missions/terminal', { id, taskId });
  else if (command === 'log') { result = await client.request(`/api/missions/log?id=${encodeURIComponent(id || '')}&taskId=${encodeURIComponent(taskId || '')}`); console.log(result.text); return; }
  else if (command === 'chat') { await chat(client, id, taskId); return; }
  else throw Error(`Unknown command: ${command}. Use relay help.`);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(`relay: ${error.message}`); process.exitCode = 1; });
