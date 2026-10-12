#!/usr/bin/env node
// Private-file transport for Relay's installed Claude Code and Codex CLIs only.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import { RUNNER_SESSIONS } from '../server/config.mjs';
const HOME=os.homedir(),STORE=process.env.CHATS_RUNNER_SESSIONS || RUNNER_SESSIONS;
const MODE=process.env.AI_MODE || 'plan',ACTS=MODE==='write'||MODE==='work';
const TIMEOUT=Number(process.env.AI_TIMEOUT || 900)*1000;
const RELAY_MANAGED=process.env.AI_RELAY_MANAGED==='1';
const RELAY_READ_ONLY=RELAY_MANAGED && process.env.AI_RELAY_READ_ONLY==='1';
const RELAY_MAX_TURNS=Number(process.env.AI_RELAY_MAX_TURNS || 20),RELAY_OUTPUT_LIMIT=1024*1024;
const boundedText=(previous,next,limit)=>Buffer.concat([Buffer.from(previous),Buffer.from(next)]).subarray(-limit).toString('utf8');
const toWin=value=>value;
const die=(message,code=2)=>{console.error('ai-chat: '+message);process.exit(code);};
if(!Number.isInteger(RELAY_MAX_TURNS)||RELAY_MAX_TURNS<1||RELAY_MAX_TURNS>100)die('Invalid managed turn limit');
if(!Number.isFinite(TIMEOUT)||TIMEOUT<1||TIMEOUT>24*60*60*1000)die('Invalid turn timeout');
function run(cmd, args, opts = {}) {
  const { cwd, input, timeout = TIMEOUT, env } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: cwd ? toWin(cwd) : undefined,
        env: Object.assign({}, process.env, env || {}),
        windowsHide: true,
        // A mission runner already owns the wrapper process group. Its provider
        // must stay inside that group so canceling the wrapper reaches the tree.
        detached: RELAY_MANAGED && process.platform !== 'win32' && process.env.AI_RELAY_OWNED_PROCESS_GROUP !== '1',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false }); }

    let out = '', err = '', timedOut = false, relayNativeId = null, timeoutCleanup = null;
    let pendingLine = '';
    child.stdout.on('data', d => {
      out = RELAY_MANAGED ? boundedText(out, d, RELAY_OUTPUT_LIMIT * 3 / 4) : out + d;
      if (RELAY_MANAGED) {
        process.stderr.write(d);
        pendingLine = boundedText(pendingLine, d, RELAY_OUTPUT_LIMIT / 16);
        const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop();
        for (const line of lines) try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started') relayNativeId = event.thread_id || relayNativeId;
        } catch { /* Progress is not necessarily JSON. */ }
      }
    });
    child.stderr.on('data', d => {
      err = RELAY_MANAGED ? boundedText(err, d, RELAY_OUTPUT_LIMIT * 3 / 16) : err + d;
      if (RELAY_MANAGED) process.stderr.write(d);
    });

    const t = setTimeout(() => {
      if (child.exitCode != null || child.signalCode != null) return;
      timedOut = true;
      if (RELAY_MANAGED) {
        // Keep the provider parent alive until Windows has enumerated its tree.
        // Otherwise child.kill() can race taskkill and orphan descendants.
        timeoutCleanup = Promise.resolve().then(async () => {
          if (process.platform === 'win32' && child.pid) {
            await new Promise(done => {
              let killer, guard;
              const finish = () => { clearTimeout(guard); done(); };
              try {
                killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true,stdio:'ignore'});
                killer.once('error',finish); killer.once('close',finish);
                guard = setTimeout(() => { try { killer.kill('SIGKILL'); } catch {} finish(); },5000);
              } catch { finish(); }
            });
          } else if (child.pid) {
            const group = process.env.AI_RELAY_OWNED_PROCESS_GROUP === '1' ? process.pid : child.pid;
            try { process.kill(-group,'SIGKILL'); } catch {}
          }
          if (child.exitCode == null && child.signalCode == null) try { child.kill('SIGKILL'); } catch {}
        });
        return;
      }
      // Windows: child.kill() leaves the grandchildren (node -> agent -> shells) alive.
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
      }
      try { child.kill('SIGKILL'); } catch (e) {}
    }, timeout);

    child.on('error', async e => { clearTimeout(t); await timeoutCleanup; resolve({ code: -1, stdout: out, stderr: err + String(e), timedOut }); });
    child.on('close', async code => { clearTimeout(t); await timeoutCleanup; resolve({ code, stdout: out, stderr: err, timedOut, relayNativeId }); });

    // NEVER leave stdin an open pipe in a headless harness: codex appends piped stdin
    // as a <stdin> block and blocks waiting for EOF. Always write-then-end.
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/* Provider discovery never reads credentials. */
function codexEntry(){
 const candidates=[process.env.CODEX_JS,path.join(path.dirname(process.execPath),'node_modules/@openai/codex/bin/codex.js'),path.join(process.env.APPDATA || HOME,'npm/node_modules/@openai/codex/bin/codex.js')];
 return candidates.find(file=>file && fs.existsSync(file));
}
async function runCodex(sess, prompt) {
  const entry = codexEntry();
  if (!entry) die('codex.js not found (npm i -g @openai/codex, or set CODEX_JS)', 3);
  const resuming = !!sess.native_id;
  const args = [entry, 'exec'];
  if (resuming) args.push('resume', sess.native_id);
  args.push('--skip-git-repo-check', '--json');
  if (!resuming) args.push('--color', 'never');
  if (RELAY_MANAGED) {
    args.push('--disable', 'multi_agent');
    if (sess.effort) args.push('-c', 'model_reasoning_effort="' + sess.effort + '"');
  }
  if (!process.env.AI_NO_WEB) args.push('-c', 'tools.web_search=true');
  if (MODE !== 'work' || RELAY_READ_ONLY) {
    const policy = !RELAY_READ_ONLY && (MODE === 'read' || MODE === 'write') ? 'workspace-write' : 'read-only';
    if (resuming) args.push('-c', 'sandbox_mode="' + policy + '"');
    else args.push('-s', policy);
    if (policy === 'read-only') {
      console.error('ai-chat: nota — codex en modo plan corre sin NINGUNA MCP (el sandbox ' +
        'read-only no lo deja levantar los servidores). Lee el repo igual. Si la tarea ' +
        'necesita browser/Supabase/context7, relanzá con AI_MODE=read.');
    }
  }
  if (!resuming && sess.workdir) args.push('-C', toWin(sess.workdir));
  if (sess.model) args.push('-m', sess.model);
  if (process.env.AI_IMAGE) for (const im of process.env.AI_IMAGE.split(',').map(s => s.trim()).filter(Boolean)) args.push('-i', toWin(im));
  args.push('-');                                   // prompt from STDIN — no argv limits at all
  const r = await run(process.execPath, args, { cwd: sess.workdir, input: prompt, env: {} });

  let answer = null, nativeId = r.relayNativeId || sess.native_id;
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o.type === 'thread.started' && o.thread_id) nativeId = o.thread_id;
      if (o.type === 'item.completed' && o.item && o.item.type === 'agent_message') answer = o.item.text;
    } catch (e) {}
  }
  return { answer, nativeId, raw: r };
}

function claudeBin() {
  for (const c of [path.join(HOME, '.local', 'bin', 'claude.exe'), 'claude']) {
    try { if (c === 'claude' || fs.existsSync(c)) return c; } catch (e) {}
  }
  return 'claude';
}
async function runClaudeCode(sess, prompt) {
  const args = ['-p', '--output-format', 'json', '--permission-prompts', 'none'];
  const pmode = RELAY_READ_ONLY ? 'plan' : MODE === 'work' ? 'bypassPermissions' : (ACTS ? 'acceptEdits' : 'plan');
  args.push('--permission-mode', pmode);
  if (RELAY_MANAGED) {
    if (sess.model === 'fable' || sess.model === 'best' || /^claude-fable-/.test(sess.model || ''))
      die('Fable may use additional usage credits in headless mode; select an included model for managed Relay workers', 2);
    if (sess.effort === 'ultra') die('Claude does not support ultra effort; use max', 2);
    args.push('--disallowedTools', 'Agent,Task,Workflow','--settings','{"disableWorkflows":true,"ultracode":false}');
    args.push('--max-turns', String(sess.relay_max_turns || RELAY_MAX_TURNS));
    if (sess.effort) args.push('--effort', sess.effort);
    if (RELAY_READ_ONLY) args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  }
  if (sess.model) args.push('--model', sess.model);
  if (process.env.AI_SUBAGENT) args.push('--agent', process.env.AI_SUBAGENT);
  if (sess.workdir) args.push('--add-dir', toWin(sess.workdir));
  if (sess.native_id) args.push('--resume', sess.native_id);
  else { sess.native_id = crypto.randomUUID(); args.push('--session-id', sess.native_id); }

  const r = await run(claudeBin(), args, { cwd: sess.workdir, input: prompt,
    ...(RELAY_MANAGED?{env:{CLAUDE_CODE_DISABLE_WORKFLOWS:'1'}}:{}) });

  let answer = null, nativeId = sess.native_id;
  for (const line of r.stdout.split(/\r?\n/)) {          // hooks can print around the JSON
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o.session_id) nativeId = o.session_id;
      if (o.type === 'result' || o.result != null) {
        if (o.is_error) { throw Error('Provider returned an error result'); }
        answer = o.result != null ? o.result : answer;
      }
    } catch (e) {}
  }
  return { answer, nativeId, raw: r };
}

const argv=process.argv.slice(2),lane=argv[0],action=argv[1];
if(!['codex','claude'].includes(lane)||!['new','say'].includes(action))die('Use codex|claude new @prompt-file project or say handle @prompt-file');
const promptArgument=argv[action==='new'?2:3];
if(!promptArgument?.startsWith('@')||!path.isAbsolute(promptArgument.slice(1)))die('An absolute private prompt file is required');
const promptFile=promptArgument.slice(1);if(fs.statSync(promptFile).size>1024*1024)die('Prompt exceeds 1 MB');
const prompt=fs.readFileSync(promptFile,'utf8');if(!prompt.trim())die('Empty prompt');
const handle=action==='say'?argv[2]:lane+'-'+crypto.randomBytes(3).toString('hex');
if(!new RegExp('^'+lane+'-[a-f0-9]{6}$').test(handle))die('Invalid handle');
fs.mkdirSync(STORE,{recursive:true,mode:0o700});const file=path.join(STORE,handle+'.json');
let sess;
if(action==='say'){
 sess=JSON.parse(fs.readFileSync(file,'utf8'));
 if(sess.lane!==lane)die('Wrong provider');
 if(RELAY_MANAGED){
  if(sess.relay_managed!==true||sess.relay_read_only!==RELAY_READ_ONLY)die('Session is not enrolled with this managed role');
  if(process.env.AI_MODEL && process.env.AI_MODEL!==sess.model)die('Managed resume cannot change the model');
  if(process.env.AI_EFFORT && process.env.AI_EFFORT!==sess.effort)die('Managed resume cannot change the effort');
 }
 if(!sess.native_id)die('Missing native session; uncertain delivery is not replayed');
}else{
 const workdir=argv[3];if(!path.isAbsolute(workdir||'')||!fs.statSync(workdir).isDirectory())die('An existing absolute project directory is required');
 sess={handle,lane,workdir,model:process.env.AI_MODEL || null,effort:process.env.AI_EFFORT || null,native_id:null,turns:[],relay_managed:RELAY_MANAGED,relay_read_only:RELAY_READ_ONLY,relay_max_turns:RELAY_MAX_TURNS};
}
fs.writeFileSync(file,JSON.stringify(sess,null,2),{mode:0o600});
process.stdout.write('AI_RELAY_SESSION '+JSON.stringify({sessionHandle:handle,nativeId:sess.native_id})+'\n');
const result=await (lane==='codex'?runCodex:runClaudeCode)(sess,prompt);
sess.native_id=result.nativeId || sess.native_id;sess.turns.push({at:new Date().toISOString(),ok:!!result.answer,timed_out:result.raw.timedOut});
fs.writeFileSync(file,JSON.stringify(sess,null,2),{mode:0o600});
const caps=RELAY_READ_ONLY?'repo_read+web+images':'repo_read+shell+write';
process.stdout.write('<<<AI-CHAT:BEGIN>>>\n'+(result.answer || '')+'\n<<<AI-CHAT:END lane='+lane+' handle='+handle+' native_id='+(sess.native_id || '-')+' caps='+caps+'>>>\n');
process.exitCode=result.raw.timedOut?5:result.raw.code!==0?4:!result.answer?4:0;
