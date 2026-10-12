// Private file transport between Windows Terminal and an actual provider TUI.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOrchestratorCommand,nativeLaunchDirectory,NATIVE_LAUNCH_LIMIT,subscriptionEnvironment} from './mission-runner.mjs';

function readLaunch(argument,dependencies) {
  if (typeof argument !== 'string' || !argument.startsWith('@')) throw Error('An owned native launch file is required');
  const file = argument.slice(1);
  if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file) || !/^[a-f0-9-]{36}\.json$/i.test(path.basename(file))) throw Error('Invalid native launch file');
  const root = fs.realpathSync(nativeLaunchDirectory(dependencies)), resolved = fs.realpathSync(file);
  if (path.dirname(resolved) !== root) throw Error('Native launch file is outside its owned directory');
  const fd = fs.openSync(resolved,'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > NATIVE_LAUNCH_LIMIT) throw Error('Native launch file exceeds its bound');
    // The file may grow after fstat; never let a changed file allocate unbounded memory.
    const bytes = Buffer.alloc(NATIVE_LAUNCH_LIMIT+1); let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd,bytes,length,bytes.length-length,null);
      if (!read) break; length += read;
    }
    if (length > NATIVE_LAUNCH_LIMIT) throw Error('Native launch file exceeds its bound');
    try { return JSON.parse(bytes.subarray(0,length).toString('utf8')); }
    catch { throw Error('Invalid native launch JSON'); }
  } finally { fs.closeSync(fd); }
}

export async function runOrchestratorTerminal(argument,{spawnImpl = spawn,home = os.homedir(),env = process.env} = {}) {
  if (env.AI_RELAY_MANAGED === '1') throw Error('Managed workers cannot launch native orchestrators');
  const config = readLaunch(argument,{home}), native = createOrchestratorCommand(config,{home,env});
  const child = spawnImpl(native.command,native.args,{cwd:config.cwd,
    env:{...subscriptionEnvironment(env),AGENT_RELAY_WINDOW:config.windowName,CHATS_PORT:String(config.port),
      ...(config.provider==='claude'?{CLAUDE_CODE_DISABLE_WORKFLOWS:'1'}:{})},
    stdio:'inherit',shell:false,windowsHide:false});
  return await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({exitCode:Number.isInteger(code)?code:1,signal:signal || null}));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Agent Relay: expected one private native launch file'); process.exitCode = 2;
  } else {
    try { process.exitCode = (await runOrchestratorTerminal(process.argv[2])).exitCode; }
    catch (error) { console.error('Agent Relay: '+error.message); process.exitCode = 2; }
  }
}
