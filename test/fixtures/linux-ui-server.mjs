// Browser-only fixture server. Never imports the production collectors or CLIs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.env.CHATS_DIST), port = Number(process.env.CHATS_PORT || 4880);
const token = crypto.randomBytes(24).toString('hex'), now = Date.now();
const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const chats = ids.map((id, i) => ({ id, tool: i ? 'codex' : 'claude', title: i ? 'Codex Linux fixture' : 'Claude Linux fixture',
  state: 'waiting', alive: true, folder: '/home/owner/project', topic: 'Example', lastActivity: now, stateSince: now,
  lastLine: 'Fixture answer for the Linux phone workflow.', endsWithQuestion: false, cdCommand: "cd '/home/owner/project'",
  runCommand: (i ? 'codex resume ' : 'claude --resume ') + id, resumeCommand: 'resume fixture', canOpen: false,
  pid: 100 + i, terminalMode: 'tmux', attachCommand: "tmux attach -t 'ai-chats'", ...(i ? {} : { role: 'orchestrator' }) }));
const conversations = new Map(ids.map(id => [id, [{ role: 'user', text: 'Check the Linux phone workflow.', ts: now - 5000 }, { role: 'agent', text: 'The fixture is ready for a message.', ts: now - 1000 }]]));
const snapshot = () => ({ generatedAt: Date.now(), paused: false, windowDays: 3, showAutomated: false,
  notifications: { enabled: false, error: '', setting: 'Windows only' }, chats, hiddenAutomated: 0,
  windowsUpdate: { rebootPending: false }, server: { rssMb: 30, platform: 'linux' }, relays: { jobs: [], error: '' },
  missions: { jobs: [], error: '', planning: false }, assistance: { handoffTokens: 100000, handoffPercent: 80 } });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(421, {});
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    if ((req.method === 'POST' ? req.headers['x-chats-token'] : url.searchParams.get('t')) !== token) return send(403, {});
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const emit = () => res.write('data: ' + JSON.stringify(snapshot()) + '\n\n'); emit();
      const timer = setInterval(emit, 3000); req.on('close', () => clearInterval(timer)); return;
    }
    if (url.pathname === '/api/chat/conversation') {
      const id = url.searchParams.get('id');
      return send(200, { id, title: chats.find(c => c.id === id)?.title, messages: conversations.get(id) || [], partial: false, alive: true, state: 'waiting', canSend: true, leased: false });
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== `http://127.0.0.1:${port}`) return send(403, {});
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) return send(400, {}); }
      const value = JSON.parse(body);
      if (url.pathname === '/api/chat/message' && conversations.has(value.id)) {
        conversations.get(value.id).push({ role: 'user', text: value.text, ts: Date.now() }); return send(200, { id: crypto.randomUUID(), status: 'submitted' });
      }
      return send(409, { error: 'Read-only browser fixture.' });
    }
    if (url.pathname === '/api/evals/latest') return send(200, { report: null, reason: 'missing' });
    if (url.pathname === '/api/services') return send(200, { queue: [], dgx: { ok: false } });
    if (url.pathname === '/api/missions/catalog') return send(200, {
      claude: { available: false, models: [], efforts: [], detail: 'Synthetic browser fixture; no provider runs.' },
      codex: { available: false, models: [], efforts: [], detail: 'Synthetic browser fixture; no provider runs.' },
    });
    if (url.pathname === '/api/projects') return send(200, { projects: [], errors: [] });
    if (url.pathname === '/api/prompts/history') return send(200, { attempts: [] });
    return send(200, {});
  }
  if (url.pathname === '/sw.js') { res.writeHead(404).end(); return; }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) return send(403, {});
  try {
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'");
    const content = fs.readFileSync(file);
    res.end(path.extname(file) === '.html' ? content.toString().replaceAll('__CHATS_TOKEN__', token) : content);
  } catch { send(404, {}); }
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
