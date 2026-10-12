#!/usr/bin/env node
// Terminal view of the same data the dashboard shows. No server or LLM needed.
//
//   chats                 open chats + recent ones, grouped by topic (last 3 days)
//   chats --folder        group by folder instead
//   chats --days 7        widen the window for closed chats (1, 3 or 7)
//   chats --all           also list closed chats (default: just their count)
//   chats start           start the dashboard (or just open it if it is running)
//   chats stop            stop the dashboard server
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectClaude, stopClaudeWatcher } from './server/claude.mjs';
import { closeCodexDbs, collectCodex } from './server/codex.mjs';
import { ProcessWatch } from './server/system.mjs';

const BASE = `http://127.0.0.1:${Number(process.env.CHATS_PORT || 4848)}`;
const args = process.argv.slice(2);
const ORDER = { working: 0, waiting: 1, cut: 2, unknown: 3, closed: 4 };
const LABEL = { working: '⚙️  Working', waiting: '🟡 Waiting for you', cut: '🔴 Interrupted', unknown: '❔ Unknown', closed: '⚪ Closed' };

async function start() {
  const vbs = fileURLToPath(new URL('./start-hidden.vbs', import.meta.url));
  spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Opening the dashboard at ${BASE}`);
}

async function stop() {
  try {
    const page = await (await fetch(`${BASE}/`)).text();
    const token = page.match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1];
    const r = await fetch(`${BASE}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Chats-Token': token || '' },
      body: JSON.stringify({ action: 'quit' }),
    });
    console.log(r.ok ? 'Dashboard stopped.' : `The dashboard could not be stopped (HTTP ${r.status}).`);
  } catch {
    console.log('The dashboard is not running.');
  }
}

async function list() {
  const days = Number(args[args.indexOf('--days') + 1]) || 3;
  const byFolder = args.includes('--folder');
  const all = args.includes('--all');
  const watch = new ProcessWatch();
  await watch.verify();
  const opts = { procs: watch.snapshot(), windowMs: days * 86400_000, now: Date.now() };
  const chats = [...collectClaude(opts).chats, ...collectCodex(opts).chats];
  closeCodexDbs();
  stopClaudeWatcher();
  const groups = new Map();
  for (const c of chats) {
    const key = byFolder ? c.folder || 'workspace' : c.topic;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const open = chats.filter((c) => c.alive).length;
  console.log(`\n${chats.length} chats (last ${days} days) · ${open} open now\n`);
  for (const [name, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    list.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.lastActivity - a.lastActivity);
    const shown = all ? list : list.filter((c) => c.state !== 'closed');
    const hiddenClosed = list.length - shown.length;
    console.log(`## ${name}`);
    for (const c of shown) {
      const tool = c.tool === 'claude' ? 'Claude' : 'Codex';
      console.log(`  ${LABEL[c.state]} · ${tool} · ${c.title}${c.worktree ? ` [${c.worktree}]` : ''}${c.alive ? ' · open' : ''}`);
      console.log(`     ${c.cdCommand}`);
      console.log(`     ${c.runCommand}`);
    }
    if (hiddenClosed) console.log(`  (${hiddenClosed} closed; use --all to view them)`);
    console.log('');
  }
}

const cmd = args[0];
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else await list();
