import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTmuxBackend, processStart } from '../server/chat-tab-tmux.mjs';
import { LinuxChats, emptyLinuxInput, linuxProcess } from '../server/linux-chats.mjs';
import { ChatControl } from '../server/chat-control.mjs';
import { deriveMobileConfig, enableMobile } from '../scripts/enable-mobile.mjs';
import { RemoteAccess } from '../server/remote-access.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const linuxOnly = { skip: process.platform !== 'linux' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const screen = prompt => `${prompt}\n bypass permissions on\n\n`;
test('Linux composer guard refuses drafts, wrapped input, busy/permission menus and shell prompts', () => {
  assert.equal(emptyLinuxInput('claude', screen('❯ '), [0, 2, 3, 0]), true);
  assert.equal(emptyLinuxInput('claude', 'Approved the revision.\n❯ \n bypass permissions on\n', [1, 2, 3, 0]), true);
  assert.equal(emptyLinuxInput('claude', screen('❯ ') + 'Approve this command', [0, 2, 4, 0]), false);
  assert.equal(emptyLinuxInput('claude', screen('❯ \ntext below cursor'), [0, 2, 4, 0]), false);
  for (const [value, cursor] of [[screen('❯ draft'), [0, 7, 3, 0]], [screen('❯ \nwrapped draft'), [1, 3, 4, 0]], [screen('$ '), [0, 2, 3, 0]], [screen('❯ ') + 'esc to interrupt', [0, 2, 4, 0]], [screen('❯ ') + 'permission required', [0, 2, 4, 0]], [screen('❯ '), [0, 2, 3, 1]]]) {
    assert.equal(emptyLinuxInput('claude', value, cursor), false);
  }
});

test('old resume argv cannot substitute for a current native session record', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chats = new LinuxChats({ home: root });
  for (const tool of ['claude', 'codex']) assert.equal(chats.nativeId({ pid: 123, started: '1', tool,
    createdMs: Date.now(), argv: [tool, '--resume', id] }), null);
});

test('real private tmux transport delivers once and refuses drafts, unknown panes and stale pid identity', { ...linuxOnly, timeout: 30000 }, async t => {
  execFileSync('tmux', ['-V']); // A missing tmux is a failed prerequisite, never a skipped Linux test.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-linux-'));
  const socket = `relay-${process.pid}-${Date.now()}`, store = path.join(root, 'tabs');
  fs.mkdirSync(store, { mode: 0o700 });
  const backend = createTmuxBackend({ env: { CHAT_TAB_TMUX_SOCKET: socket } });
  const fixture = path.join(root, 'fake.mjs'), delivered = path.join(root, 'delivered.jsonl');
  fs.writeFileSync(fixture, `import fs from 'node:fs';
const draw=()=>{const row=Math.max(1,(process.stdout.rows||24)-3);process.stdout.write('\\x1b[2J\\x1b['+row+';1H❯ \\n bypass permissions on\\n? for shortcuts\\x1b['+row+';3H');};
process.stdin.setRawMode(true);process.stdin.resume();let value='';draw();
process.stdin.on('data',chunk=>{for(const c of chunk.toString()){if(c==='\\x15'){value='';draw();}else if(c==='\\r'||c==='\\n'){fs.appendFileSync(process.argv[2],JSON.stringify(value)+'\\n');value='';draw();}else{value+=c;process.stdout.write(c);}}});`);
  t.after(() => {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tab = { ...backend.open({ session: 'ai-chats', title: 'fake', cwd: root, command: 'exec node', extra: [fixture, delivered],
    sessionVars: [], pidFile: path.join(root, 'handle'), closing: path.join(root, 'closing') }), name: 'fake', lane: 'claude', window: 'ai-chats' };
  fs.writeFileSync(path.join(store, 'fake.json'), JSON.stringify(tab), { mode: 0o600 });
  for (let i = 0; i < 50 && !backend.call(tab, 'read', { lines: 10 }).includes('bypass permissions'); i++) await wait(50);
  const file = path.join(root, 'chat.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Ready' }] } }) + '\n');
  // Only tool recognition is injected: pane, pid, /proc start, terminal rendering,
  // delivery and identity recycling checks use the real private tmux server.
  const readProcess = pid => pid === tab.pid ? { ...linuxProcess(pid), tool: tab.lane, argv: ['fake-lane'] } : null;
  const chats = new LinuxChats({ home: root, store, backend, readProcess });
  chats.processes = () => [readProcess(tab.pid)].filter(Boolean);
  chats.nativeId = () => id;
  const chat = { id, pid: tab.pid, alive: true, state: 'waiting', tool: 'claude', file, title: 'Fake lane' };
  const control = new ChatControl({ targets: () => new Map([[id, chat]]), artifacts: path.join(root, 'messages'),
    enroll: value => chats.enroll(value), deliver: (value, enrolled, messageFile, requestId) => chats.send(value, enrolled, `AGENT-RELAY MESSAGE ${requestId}: Read ${messageFile}`) });
  let result;
  try { result = await control.message(id, 'Unicode: Bogotá\nSecond line'); }
  catch (error) {
    const failed = fs.readdirSync(path.join(root, 'messages'))[0];
    const detail = JSON.parse(fs.readFileSync(path.join(root, 'messages', failed, 'message.json'), 'utf8')).detail;
    const cursor = execFileSync('tmux', ['-L', socket, 'display-message', '-p', '-t', tab.pane, '#{cursor_y},#{cursor_x},#{pane_height},#{pane_in_mode}'], { encoding: 'utf8' });
    throw Error(`Fixture transport: ${detail}; cursor=${cursor}; screen=${JSON.stringify(backend.call(tab, 'read', { lines: 30 }))}`, { cause: error });
  }
  assert.equal(result.status, 'submitted');
  for (let i = 0; i < 40 && !fs.existsSync(delivered); i++) await wait(50);
  const lines = fs.readFileSync(delivered, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.match(JSON.parse(lines[0]), /^AGENT-RELAY MESSAGE/);
  const messageDir = path.join(root, 'messages', result.id);
  assert.equal(fs.statSync(messageDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(messageDir, 'user-message.md')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(messageDir, 'message.json')).mode & 0o777, 0o600);
  execFileSync('tmux', ['-L', socket, 'send-keys', '-t', tab.pane, '-l', '--', 'draft']); await wait(100);
  assert.throws(() => chats.send(chat, chats.enroll(chat), 'ordinary message'), /Input draft/);
  assert.equal(fs.readFileSync(delivered, 'utf8').trim().split('\n').length, 1);
  execFileSync('tmux', ['-L', socket, 'send-keys', '-t', tab.pane, 'C-u']); await wait(100);
  tab.lane = 'codex'; fs.writeFileSync(path.join(store, 'fake.json'), JSON.stringify(tab));
  const codexFile = path.join(root, 'codex.jsonl');
  fs.writeFileSync(codexFile, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
  const codex = { ...chat, tool: 'codex', file: codexFile };
  assert.equal(chats.send(codex, chats.enroll(codex), 'Codex fixture message').submitted, true);
  for (let i = 0; i < 40 && fs.readFileSync(delivered, 'utf8').trim().split('\n').length < 2; i++) await wait(50);
  assert.equal(JSON.parse(fs.readFileSync(delivered, 'utf8').trim().split('\n')[1]), 'Codex fixture message');
  fs.writeFileSync(path.join(store, 'fake.json'), JSON.stringify({ ...tab, lane: 'claude' })); tab.lane = 'claude';
  const enrolled = chats.enroll(chat);
  fs.writeFileSync(path.join(store, 'fake.json'), JSON.stringify({ ...tab, started: String(BigInt(tab.started) + 1n) }));
  assert.throws(() => chats.send(chat, enrolled, 'no stale delivery'), /uniquely bound/);
  fs.unlinkSync(path.join(store, 'fake.json'));
  assert.throws(() => chats.enroll(chat), /chat-tab/);
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'foreign']);
  assert.throws(() => chats.enroll(chat), /chat-tab/);
  assert.equal(fs.readFileSync(delivered, 'utf8').trim().split('\n').length, 2);
});

test('Linux fixture discovery reads Claude projects and Codex sessions with native Linux paths', { ...linuxOnly, timeout: 15000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-discovery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, '.claude/projects/-home-owner-project'), codex = path.join(root, '.codex/sessions/2026/11/08');
  fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(codex, { recursive: true });
  const now = new Date().toISOString(), cid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.writeFileSync(path.join(claude, id + '.jsonl'), [
    { type: 'user', cwd: '/home/owner/project', timestamp: now, message: { content: 'Claude fixture' } },
    { type: 'assistant', timestamp: now, message: { content: [{ type: 'text', text: 'Claude answer' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(codex, `rollout-${cid}.jsonl`), [
    { type: 'session_meta', payload: { id: cid, cwd: '/home/owner/project', source: 'cli' }, timestamp: now },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Codex answer' }, timestamp: now },
  ].map(JSON.stringify).join('\n') + '\n');
  const module = new URL('../server/linux-chats.mjs', import.meta.url).href;
  const claudeModule = new URL('../server/claude.mjs', import.meta.url).href;
  const script = `import {LinuxChats} from ${JSON.stringify(module)};import {stopClaudeWatcher} from ${JSON.stringify(claudeModule)};const result=new LinuxChats().collect({now:Date.now(),windowMs:86400000,includedIds:new Set()});stopClaudeWatcher();console.log(JSON.stringify(result));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: root, USERPROFILE: root } }));
  assert.deepEqual(new Set(result.chats.map(c => c.tool)), new Set(['claude', 'codex']));
  for (const chat of result.chats) { assert.equal(chat.cwd, '/home/owner/project'); assert.equal(chat.terminalMode, 'tmux'); assert.equal(chat.canOpen, false); assert.equal(chat.alive, false); }
  const liveScript = `
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {LinuxChats} from ${JSON.stringify(module)};
import {stopClaudeWatcher} from ${JSON.stringify(claudeModule)};
const home=process.env.HOME,store=path.join(home,'.claude/chat-tabs');fs.mkdirSync(store,{recursive:true});
const processes=[{pid:101,ppid:0,tty:'11',started:'10'}, {pid:201,ppid:101,tty:'11',started:'30',tool:'claude',createdMs:Date.now()-10000}, {pid:102,ppid:0,tty:'12',started:'20'}, {pid:202,ppid:102,tty:'12',started:'40',tool:'codex',createdMs:Date.now()-10000}];
for(const [name,lane,pid,started,pane,windowId] of [['claude','claude',101,'10','%1','@1'],['codex','codex',102,'20','%2','@2']])fs.writeFileSync(path.join(store,name+'.json'),JSON.stringify({name,lane,pid,started,pane,windowId,window:'ai-chats',backend:'tmux'}));
fs.mkdirSync(path.join(home,'.claude/sessions'),{recursive:true});
fs.writeFileSync(path.join(home,'.claude/sessions/201.json'),JSON.stringify({pid:201,sessionId:${JSON.stringify(id)},procStart:'30',status:'idle',kind:'interactive',cwd:'/home/owner/project'}));
const db=new DatabaseSync(path.join(home,'.codex/logs_1.sqlite'));
db.exec('create table logs (id integer, process_uuid text, thread_id text, ts integer, ts_nanos integer)');
db.prepare('insert into logs values (1,?,?,?,0)').run('pid:202:fixture',${JSON.stringify(cid)},Math.floor(Date.now()/1000));db.close();
const chats=new LinuxChats({home,store,readProcess:pid=>processes.find(p=>p.pid===pid),backend:{alive:()=>true,call:()=> 'bypass permissions on\\n? for shortcuts'}});chats.processes=()=>processes;
const opts={now:Date.now(),windowMs:86400000,includedIds:new Set()};
const live=chats.collect(opts);for(const c of live.chats)chats.enroll(c);
processes.find(p=>p.pid===202).createdMs=Date.now()+100000;
const stale=chats.collect(opts).chats.find(c=>c.tool==='codex');stopClaudeWatcher();
console.log(JSON.stringify({live,stale}));`;
  const mapped = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', liveScript], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: root, USERPROFILE: root } }));
  for (const chat of mapped.live.chats) { assert.equal(chat.alive, true); assert.equal(chat.state, 'waiting'); assert.match(chat.attachCommand, /^tmux attach -t 'ai-chats'$/); assert.ok([201, 202].includes(chat.pid)); }
  assert.equal(mapped.stale.alive, false);
});

test('tagged Linux server requires explicit local owner, keeps the same remote identity gates and makes no check-time changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tagged-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const status = { BackendState: 'Running', Self: { Tags: ['tag:relay'], DNSName: 'relay.tailtest.ts.net.' }, User: {} };
  assert.throws(() => deriveMobileConfig(status, 4869), /locally configured/);
  assert.equal(deriveMobileConfig(status, 4869, 'owner@example.invalid').ownerLogin, 'owner@example.invalid');
  const file = path.join(root, 'mobile.json'), access = new RemoteAccess({ file, port: 4869 }); let mutations = 0, serving = {};
  const execImpl = async (bin, args) => {
    if (process.platform === 'linux') assert.equal(bin, 'tailscale');
    if (args.join(' ') === 'status --json') return { stdout: JSON.stringify(status) };
    if (args.join(' ') === 'serve status --json') return { stdout: JSON.stringify(serving) };
    assert.deepEqual(args, ['serve', '--bg', '--https=443', 'http://127.0.0.1:4869']); mutations++;
    serving = { TCP: { '443': { HTTPS: true } }, Web: { 'relay.tailtest.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4869' } } } } };
    return { stdout: '' };
  };
  const requestImpl = async (_port, headers) => ({ status: headers ? access.authorize({ headers, socket: { remoteAddress: '127.0.0.1' } }).status : 200, data: { app: 'chats-dashboard', mobile: access.publicState() } });
  assert.equal((await enableMobile({ port: 4869, file, ownerLogin: 'owner@example.invalid', enable: false, execImpl, requestImpl })).ready, true);
  assert.equal(mutations, 0); assert.equal(fs.existsSync(file), false);
  assert.equal((await enableMobile({ port: 4869, file, ownerLogin: 'owner@example.invalid', enable: true, execImpl, requestImpl })).enabled, true);
  assert.equal(mutations, 1);
  assert.equal((await enableMobile({ port: 4869, file, enable: false, execImpl, requestImpl })).enabled, true);
  if (process.platform === 'linux') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
