import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createMissionRunner,subscriptionEnvironment,providerCatalog,openMissionTerminal,openOrchestratorTerminal,nativeLaunchDirectory,NATIVE_LAUNCH_LIMIT} from '../server/mission-runner.mjs';
import {runOrchestratorTerminal} from '../server/orchestrator-terminal.mjs';

const exec = promisify(execFile), id = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'mission-runner-'));
  const promptFile = path.join(home,'prompt.txt'), outputFile = path.join(home,'output.log'), cliPath = path.join(home,'relay-cli.mjs');
  fs.writeFileSync(promptFile,'Implement only the authorized fixture.'); fs.writeFileSync(cliPath,'// fake CLI');
  return {home,promptFile,outputFile,cliPath,cwd:home,cleanup:()=>fs.rmSync(home,{recursive:true,force:true})};
}
function fakeChild() {
  const child = new EventEmitter(); child.pid = 12345; child.exitCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = ()=>{};
  child.finish = (code=0)=>{child.exitCode=code;child.emit('close',code);};
  child.kill = ()=>{child.finish(1);return true;}; return child;
}
function budgetFixture() {
  const calls = [], state = {released:0};
  return {calls,state,reserve:async spec=>{calls.push(spec);return {release:async()=>{state.released++;}};}};
}
function receipt(handle='codex-abcdef',answer='Verified fixture.') {
  return '<<<AI-CHAT:BEGIN>>>\n'+answer+'\n<<<AI-CHAT:END lane='+handle.split('-')[0]+' handle='+handle+' native_id='+id+' ok=true>>>\n';
}

test('managed runner uses argv files, subscriptions, bounded roles, session evidence and original cwd',async()=>{
  const f = fixture(), budget = budgetFixture(), calls = [], output = [];
  try {
    const run = createMissionRunner({budget,env:{PATH:'fixture',OPENAI_API_KEY:'not-a-real-key',anthropic_api_key:'not-a-real-key',
      ANTHROPIC_AUTH_TOKEN:'not-a-real-key',CLAUDECODE:'1',AI_SUBAGENT:'nested',NODE_OPTIONS:'malicious fixture option'},
      spawnImpl:(command,args,options)=>{calls.push({command,args,options});const child=fakeChild();
        queueMicrotask(()=>{child.stdout.write('AI_RELAY_SESSION {"sessionHandle":"codex-abcdef"}\n');
          child.stderr.write('provider progress');child.stdout.write(receipt());child.finish();});return child;}});
    const result = await run({...f,provider:'codex',model:'gpt-6.1-sol',effort:'ultra',timeoutMs:1000,onOutput:(value,channel)=>output.push({value,channel})});
    assert.equal(result.sessionHandle,'codex-abcdef'); assert.equal(result.nativeId,id); assert.equal(result.answer,'Verified fixture.');assert.equal(result.exitCode,0);
    const call = calls[0];assert.equal(call.command,process.execPath);assert.deepEqual(call.args.slice(1),['codex','new','@'+f.promptFile,f.cwd]);
    assert.equal(call.options.shell,undefined);assert.equal(call.options.cwd,f.cwd);assert.equal(call.options.windowsHide,true);
    assert.deepEqual(Object.keys(call.options.env).sort(),['AI_EFFORT','AI_MODE','AI_MODEL','AI_NO_AUTOMODE','AI_RELAY_MANAGED','AI_RELAY_MAX_TURNS','AI_TIMEOUT','PATH'].sort());
    assert.equal(call.options.env.AI_RELAY_MAX_TURNS,'20'); assert.equal(call.options.env.AI_EFFORT,'ultra');
    assert.equal(budget.calls.length,1);assert.equal(budget.state.released,1);assert.ok(output.some(value=>value.channel==='stderr'));
    assert.ok(fs.readFileSync(f.outputFile,'utf8').includes('provider progress'));
  } finally {f.cleanup();}
});

test('resume reserves a turn without creating another session and planner restricts mutation',async()=>{
  const f=fixture(),budget=budgetFixture(),calls=[];
  try {
    const run=createMissionRunner({budget,spawnImpl:(command,args,options)=>{calls.push({args,options});const child=fakeChild();queueMicrotask(()=>{child.stdout.write(receipt('claude-abcdef','{"tasks":[]}'));child.finish();});return child;}});
    await run({...f,provider:'claude',sessionHandle:'claude-abcdef',model:'opus',effort:'max',role:'planner',timeoutMs:1000});
    assert.deepEqual(calls[0].args.slice(1),['claude','say','claude-abcdef','@'+f.promptFile]);
    assert.equal(calls[0].options.env.AI_MODE,'plan');assert.equal(calls[0].options.env.AI_RELAY_READ_ONLY,'1');assert.equal(calls[0].options.env.AI_RELAY_MAX_TURNS,'8');
    assert.deepEqual(budget.calls,[{role:'planner',sessionHandle:'claude-abcdef'}]);assert.equal(budget.state.released,1);
  } finally {f.cleanup();}
});

test('timeout and cancellation terminate only the runner child and release admission',async()=>{
  const f=fixture();
  try {
    for (const kind of ['timeout','abort']) {
      const budget=budgetFixture(),kills=[],controller=new AbortController();
      const run=createMissionRunner({budget,spawnImpl:()=>fakeChild(),killTree:async child=>{kills.push(child.pid);child.finish(1);}});
      const promise=run({...f,provider:'codex',timeoutMs:kind==='timeout'?10:1000,signal:controller.signal});
      if(kind==='abort')setTimeout(()=>controller.abort(),10);
      const result=await promise;assert.deepEqual(kills,[12345]);assert.equal(result.timedOut,kind==='timeout');assert.equal(result.aborted,kind==='abort');assert.equal(budget.state.released,1);
      assert.match(result.error, kind === 'timeout' ? /timed out/ : /canceled/);
      const diagnostic = fs.readFileSync(f.outputFile, 'utf8').trim().split('\n').at(-1);
      assert.ok(diagnostic.startsWith('AI_RELAY_DIAGNOSTIC '));
      const saved = JSON.parse(diagnostic.slice('AI_RELAY_DIAGNOSTIC '.length));
      assert.equal(saved.reason, kind === 'timeout' ? 'timeout' : 'canceled'); assert.equal(saved.exitCode, 1);
    }
  } finally {f.cleanup();}
});

test('failed provider exit keeps its real error even when a partial answer was captured, without exposing prompt in diagnostics', async () => {
  const f = fixture(), budget = budgetFixture();
  try {
    const run = createMissionRunner({ budget, spawnImpl: () => {
      const child = fakeChild(); queueMicrotask(() => { child.stderr.write('Fixture provider error.'); child.stdout.write(receipt('claude-abcdef', 'Partial result')); child.finish(7); }); return child;
    } });
    const result = await run({ ...f, provider: 'claude', role: 'planner', timeoutMs: 1000 });
    assert.equal(result.exitCode, 7); assert.equal(result.error, 'Fixture provider error.'); assert.equal(result.answer, 'Partial result');
    const marker = fs.readFileSync(f.outputFile, 'utf8').trim().split('\n').at(-1);
    assert.match(marker, /^AI_RELAY_DIAGNOSTIC /); assert.equal(JSON.parse(marker.slice('AI_RELAY_DIAGNOSTIC '.length)).reason, 'provider-exit');
    assert.equal(marker.includes(f.promptFile), false); assert.equal(marker.includes('Partial result'), false); assert.equal(budget.state.released, 1);
  } finally { f.cleanup(); }
});

test('admission and spawn failures close without running unauthorized processes',async()=>{
  const f=fixture();
  try {
    let spawned=0;const blocked=createMissionRunner({budget:{reserve:async()=>{throw Error('budget denied');}},spawnImpl:()=>{spawned++;}});
    await assert.rejects(blocked({...f,provider:'codex'}),/budget denied/);assert.equal(spawned,0);assert.equal(fs.existsSync(f.outputFile),false);
    const budget=budgetFixture(),broken=createMissionRunner({budget,spawnImpl:()=>{throw Error('spawn fixture failed');}});
    await assert.rejects(broken({...f,provider:'codex'}),/spawn fixture failed/);assert.equal(budget.state.released,1);
    const controller=new AbortController();controller.abort();await assert.rejects(broken({...f,provider:'codex',signal:controller.signal}),{name:'AbortError'});
    assert.equal(budget.calls.length,1);
  } finally {f.cleanup();}
});

test('large output caps disk at 8MB while preserving the session and final response',async()=>{
  const f=fixture();
  try {
    const run=createMissionRunner({budget:budgetFixture(),spawnImpl:()=>{const child=fakeChild();queueMicrotask(()=>{
      child.stdout.write('AI_RELAY_SESSION {"sessionHandle":"codex-abcdef"}\n');
      for(let n=0;n<140;n++)child.stderr.write(Buffer.alloc(64*1024,120));
      child.stdout.write(receipt());child.finish();});return child;}});
    const result=await run({...f,provider:'codex',timeoutMs:2000});assert.equal(fs.statSync(f.outputFile).size,8*1024*1024);
    assert.equal(result.sessionHandle,'codex-abcdef');assert.equal(result.answer,'Verified fixture.');
  } finally {f.cleanup();}
});

test('log close failures still release global admission',async()=>{
  const f=fixture(),budget=budgetFixture();
  try {
    const run=createMissionRunner({budget,closeLog:fd=>{fs.closeSync(fd);throw Error('fixture close failed');},spawnImpl:()=>{
      const child=fakeChild();queueMicrotask(()=>{child.stdout.write(receipt());child.finish();});return child;}});
    await assert.rejects(run({...f,provider:'codex',timeoutMs:1000}),/fixture close failed/);
    assert.equal(budget.state.released,1);
  } finally {f.cleanup();}
});

test('invalid providers, reasoning, paths and handles fail before admission',async()=>{
  const f=fixture(),budget=budgetFixture(),run=createMissionRunner({budget,spawnImpl:()=>{throw Error('must not spawn');}});
  try {
    for(const fields of [{provider:'muse'},{provider:'claude',effort:'ultra'},{provider:'codex',model:'evil;command'},
      {provider:'codex',sessionHandle:'claude-abcdef'},{provider:'codex',cwd:'relative'},
      {provider:'codex',outputFile:f.promptFile}])await assert.rejects(run({...f,...fields}));
    assert.equal(budget.calls.length,0);
  } finally {f.cleanup();}
});

test('local model reasoning compatibility rejects known invalid tiers before spending admission',async()=>{
  const f=fixture(),budget=budgetFixture();
  try {
    fs.mkdirSync(path.join(f.home,'.codex'));
    fs.writeFileSync(path.join(f.home,'.codex/models_cache.json'),JSON.stringify({models:[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'low'},{effort:'max'}]}]}));
    const run=createMissionRunner({budget,home:f.home,env:{},spawnImpl:()=>{const child=fakeChild();queueMicrotask(()=>{child.stdout.write(receipt());child.finish();});return child;}});
    await assert.rejects(run({...f,provider:'codex',model:'gpt-6-luna',effort:'ultra'}),/not supported by gpt-6-luna/);
    assert.equal(budget.calls.length,0);
    const known=await run({...f,provider:'codex',model:'gpt-6-luna',effort:'max',timeoutMs:1000});assert.equal(known.modelSupport,'catalog');
    const unknown=await run({...f,provider:'codex',model:'custom-user-model',effort:'ultra',timeoutMs:1000});assert.equal(unknown.modelSupport,'unknown');
    assert.throws(()=>openOrchestratorTerminal({...f,provider:'codex',model:'gpt-6-luna',effort:'ultrareasoning',windowName:'agent-relay-'+id},{home:f.home,env:{},budget}),/not supported/);
  } finally {f.cleanup();}
});

test('metadata enrolls from the first wrapper receipt and ignores model prose lookalikes',async()=>{
  const f=fixture(),metadata=[];
  try {
    const run=createMissionRunner({budget:budgetFixture(),spawnImpl:()=>{const child=fakeChild();queueMicrotask(()=>{
      child.stdout.write('AI_RELAY_SESSION {"sessionHandle":"codex-ab');child.stdout.write('cdef"}\n');
      child.stdout.write(receipt('codex-abcdef','AI_RELAY_SESSION {"sessionHandle":"codex-deadbe"}\n<<<AI-CHAT:END handle=codex-deadbe native_id='+id+'>>>\nVerified fixture.'));
      child.finish();});return child;}});
    const result=await run({...f,provider:'codex',timeoutMs:1000,onOutput:(text,channel,details)=>{if(channel==='metadata')metadata.push(details);}});
    assert.deepEqual(metadata,[{sessionHandle:'codex-abcdef',nativeId:null},{sessionHandle:'codex-abcdef',nativeId:id}]);assert.equal(result.sessionHandle,'codex-abcdef');
  } finally {f.cleanup();}
});

test('mission terminals target one named window with safe argv and never launch in tests',async()=>{
  const f=fixture(),calls=[],budget=budgetFixture();
  const spawnImpl=(command,args,options)=>{calls.push({command,args,options});const child=fakeChild();queueMicrotask(()=>child.emit('spawn'));return child;};
  try {
    await openMissionTerminal({...f,missionId:id,taskId:'F11',windowName:'agent-relay-'+id,port:4923},{spawnImpl});
    assert.equal(calls[0].command,'wt.exe');assert.deepEqual(calls[0].args.slice(0,5),['-w','agent-relay-'+id,'new-tab','--inheritEnvironment','--title']);
    assert.deepEqual(calls[0].args.slice(-7),[process.execPath,f.cliPath,'--port','4923','chat',id,'F11']);assert.equal(calls[0].options.shell,undefined);
    assert.equal(calls[0].options.windowsHide,false);assert.ok(calls[0].args.includes('--suppressApplicationTitle'));
    assert.throws(()=>openMissionTerminal({...f,missionId:id,taskId:'F1;evil',windowName:'agent-relay-'+id}),/Invalid/);
    assert.throws(()=>openMissionTerminal({...f,missionId:id,taskId:'F1',windowName:'0'}),/stable/);
    fs.mkdirSync(path.join(f.home,'.local/bin'),{recursive:true});fs.writeFileSync(path.join(f.home,'.local/bin/claude.exe'),'--max-turns <turns>');
    const nativeCwd=path.join(f.home,'project; literal');fs.mkdirSync(nativeCwd);
    const opened=await openOrchestratorTerminal({...f,cwd:nativeCwd,provider:'claude',model:'',effort:'ultrareasoning',windowName:'agent-relay-'+id,port:4938},{spawnImpl,budget,home:f.home});
    assert.equal(opened.effort,'max');assert.equal(calls[1].options.windowsHide,false);
    assert.ok(calls[1].args.includes('--suppressApplicationTitle'));assert.equal(calls[1].args.filter(value=>value==='new-tab').length,1);
    assert.ok(calls[1].args.every(value=>!/[;\r\n]/.test(value)));assert.ok(!calls[1].args.join(' ').includes('agent-relay-native-orchestrator'));
    assert.equal(calls[1].args.at(-3),process.execPath);assert.equal(path.basename(calls[1].args.at(-2)),'orchestrator-terminal.mjs');
    const launchArgument=calls[1].args.at(-1),config=JSON.parse(fs.readFileSync(launchArgument.slice(1),'utf8'));
    assert.equal(path.dirname(launchArgument.slice(1)),nativeLaunchDirectory({home:f.home}));
    assert.equal(config.cwd,nativeCwd);assert.equal(config.port,4938);assert.equal(config.effort,'max');assert.equal(config.model,'');
    const initialPrompt=config.prompt;assert.ok(initialPrompt.startsWith('# Agent Relay · Orchestrator\n<!-- agent-relay-native-orchestrator:v1 -->\n'));
    assert.ok(initialPrompt.includes(JSON.stringify({terminalWindow:'agent-relay-'+id,terminalViews:true})));
    assert.ok(initialPrompt.includes('--port 4938'));assert.ok(initialPrompt.includes(';'));assert.ok(initialPrompt.includes('"'));
    const nativeCalls=[];
    const result=await runOrchestratorTerminal(launchArgument,{home:f.home,env:{OPENAI_API_KEY:'blocked',ANTHROPIC_API_KEY:'blocked',CHATS_PORT:'1'},
      spawnImpl:(command,args,options)=>{nativeCalls.push({command,args,options});const child=fakeChild();queueMicrotask(()=>child.finish());return child;}});
    assert.equal(nativeCalls.length,1);assert.equal(result.exitCode,0);assert.equal(nativeCalls[0].args.at(-1),initialPrompt);assert.equal(nativeCalls[0].args.at(-2),'--');
    assert.equal(nativeCalls[0].args[nativeCalls[0].args.indexOf('--disallowedTools')+1],'Agent,Task,Workflow');assert.equal(nativeCalls[0].args[nativeCalls[0].args.indexOf('--effort')+1],'max');
    assert.deepEqual(JSON.parse(nativeCalls[0].args[nativeCalls[0].args.indexOf('--settings')+1]),{disableWorkflows:true,ultracode:false});
    assert.equal(nativeCalls[0].options.cwd,nativeCwd);assert.equal(nativeCalls[0].options.stdio,'inherit');assert.equal(nativeCalls[0].options.shell,false);
    assert.equal(nativeCalls[0].options.env.AGENT_RELAY_WINDOW,config.windowName);assert.equal(nativeCalls[0].options.env.CHATS_PORT,'4938');
    assert.equal(nativeCalls[0].options.env.OPENAI_API_KEY,undefined);assert.equal(nativeCalls[0].options.env.ANTHROPIC_API_KEY,undefined);
    assert.equal(nativeCalls[0].options.env.CLAUDE_CODE_DISABLE_WORKFLOWS,'1');
    assert.deepEqual(budget.calls,[{role:'orchestrator'}]);assert.equal(budget.state.released,1);
  } finally {f.cleanup();}
});

test('native entry validates bounded owned metadata and transports Codex prompt verbatim',async()=>{
  const f=fixture(),root=nativeLaunchDirectory({home:f.home}),configFile=path.join(root,id+'.json');let spawned=0;
  const config={schema:1,provider:'codex',model:'gpt-6.1-sol',effort:'ultra',cwd:f.cwd,cliPath:f.cliPath,windowName:'agent-relay-'+id,port:4951,
    prompt:'# Agent Relay · Orquestador\n<!-- agent-relay-native-orchestrator:v1 -->\nLiteral "quoted" ; prompt\n'+JSON.stringify({terminalWindow:'agent-relay-'+id,terminalViews:true})};
  const options={home:f.home,env:{APPDATA:f.home},spawnImpl:(command,args,opts)=>{
    spawned++;assert.equal(command,process.execPath);assert.equal(args.at(-1),config.prompt);
    assert.equal(args[args.indexOf('--disable')+1],'multi_agent');assert.equal(args[args.indexOf('-m')+1],'gpt-6.1-sol');
    assert.equal(args[args.indexOf('-c')+1],'model_reasoning_effort="ultra"');assert.equal(opts.shell,false);assert.equal(opts.stdio,'inherit');
    const child=fakeChild();queueMicrotask(()=>child.finish());return child;
  }};
  try {
    await assert.rejects(runOrchestratorTerminal('@missing-file',{...options,env:{AI_RELAY_MANAGED:'1'}}),/Managed workers/);assert.equal(spawned,0);
    fs.mkdirSync(root,{recursive:true});fs.mkdirSync(path.join(f.home,'npm/node_modules/@openai/codex/bin'),{recursive:true});
    fs.writeFileSync(path.join(f.home,'npm/node_modules/@openai/codex/bin/codex.js'),'// fake installed CLI');
    fs.writeFileSync(configFile,JSON.stringify(config));await runOrchestratorTerminal('@'+configFile,options);assert.equal(spawned,1);
    await assert.rejects(runOrchestratorTerminal(configFile,options),/owned native/);
    const outside=path.join(f.home,id+'.json');fs.writeFileSync(outside,JSON.stringify(config));
    await assert.rejects(runOrchestratorTerminal('@'+outside,options),/outside/);
    fs.writeFileSync(configFile,JSON.stringify({...config,command:'powershell.exe'}));await assert.rejects(runOrchestratorTerminal('@'+configFile,options),/configuration/);
    fs.writeFileSync(configFile,' '.repeat(NATIVE_LAUNCH_LIMIT+1));await assert.rejects(runOrchestratorTerminal('@'+configFile,options),/bound/);
    fs.writeFileSync(configFile,JSON.stringify({...config,prompt:'missing role marker'}));await assert.rejects(runOrchestratorTerminal('@'+configFile,options),/prompt/);
    assert.equal(spawned,1);
  } finally {f.cleanup();}
});

test('managed wrapper waits for its own Windows tree cleanup before resolving timeout',async()=>{
  const wrapper=fileURLToPath(new URL('../tools/ai-chat.mjs',import.meta.url)),source=fs.readFileSync(wrapper,'utf8');
  const begin=source.indexOf('function run(cmd, args, opts = {}) {');
  const runSource=source.slice(begin,source.indexOf('\n/*',begin));
  const provider=fakeChild(),killer=fakeChild(),calls=[],timers=new Map();let timerId=0,providerKills=0,resolved=false;
  provider.stdin={end(){}};provider.kill=()=>{providerKills++;provider.finish(1);};
  const run=vm.runInNewContext('('+runSource+')',{
    RELAY_MANAGED:true,RELAY_OUTPUT_LIMIT:1024,TIMEOUT:100,toWin:value=>value,
    process:{platform:'win32',env:{},stderr:{write(){}}},
    spawn:(command,args,options)=>{calls.push({command,args:Array.from(args),options});return calls.length===1?provider:killer;},
    setTimeout:(callback)=>{const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id),
  });
  const pending=run('fixture-provider',[],{timeout:100});pending.then(()=>{resolved=true;});
  timers.get(1)();await Promise.resolve();
  assert.equal(calls[1].command,'taskkill.exe');assert.deepEqual(calls[1].args,['/PID','12345','/T','/F']);
  assert.equal(calls[1].options.windowsHide,true);assert.equal(providerKills,0);
  provider.finish(1);await Promise.resolve();assert.equal(resolved,false);
  killer.finish(0);const result=await pending;
  assert.equal(result.timedOut,true);assert.equal(providerKills,0);assert.equal(timers.size,0);
});

test('managed POSIX wrapper preserves the mission process group and standalone owns its provider group',async()=>{
  const wrapper=fileURLToPath(new URL('../tools/ai-chat.mjs',import.meta.url)),source=fs.readFileSync(wrapper,'utf8');
  const begin=source.indexOf('function run(cmd, args, opts = {}) {'),runSource=source.slice(begin,source.indexOf('\n/*',begin));
  for (const missionOwned of [true,false]) {
    const provider=fakeChild(),calls=[],killed=[],timers=new Map();let timerId=0;provider.stdin={end(){}};
    const run=vm.runInNewContext('('+runSource+')',{
      RELAY_MANAGED:true,RELAY_OUTPUT_LIMIT:1024,TIMEOUT:100,toWin:value=>value,
      process:{platform:'linux',pid:22222,env:missionOwned?{AI_RELAY_OWNED_PROCESS_GROUP:'1'}:{},stderr:{write(){}},
        kill:(pid,signal)=>{killed.push({pid,signal});provider.signalCode=signal;provider.emit('close',null);}},
      spawn:(command,args,options)=>{calls.push(options);return provider;},
      setTimeout:callback=>{const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id),
    });
    const pending=run('fixture-provider',[],{timeout:100});timers.get(1)();const result=await pending;
    assert.equal(calls[0].detached,!missionOwned);assert.deepEqual(killed,[{pid:missionOwned?-22222:-12345,signal:'SIGKILL'}]);
    assert.equal(result.timedOut,true);assert.equal(timers.size,0);
  }
});

test('catalog reads installed capability evidence and safe model metadata without auth secrets',async()=>{
  const f=fixture();
  try {
    fs.mkdirSync(path.join(f.home,'.local/bin'),{recursive:true});fs.mkdirSync(path.join(f.home,'.codex'));
    fs.writeFileSync(path.join(f.home,'.local/bin/claude.exe'),'--max-turns <turns>');
    fs.writeFileSync(path.join(f.home,'.codex/models_cache.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol',display_name:'GPT 6.1',supported_reasoning_levels:[{effort:'ultra'},{effort:'bogus'}],private:'never returned'}]}));
    const calls=[];const catalog=await providerCatalog({home:f.home,env:{OPENAI_API_KEY:'never forwarded'},execImpl:async(command,args,options)=>{
      calls.push(options);return {stdout:args.includes('--version')?'fixture-version':'--model <model> --model <MODEL> --effort --config --disable --disallowedTools'};}});
    assert.equal(catalog.claude.available,true);assert.equal(catalog.claude.maxTurns,true);assert.equal(catalog.codex.models[0].id,'gpt-6.1-sol');
    assert.deepEqual(catalog.codex.models[0].efforts,['ultra']);assert.ok(!JSON.stringify(catalog).includes('never'));
    assert.ok(calls.every(options=>!options.env.OPENAI_API_KEY));
    assert.equal(subscriptionEnvironment({OPENAI_API_KEY:'x',ANTHROPIC_AUTH_TOKEN:'x',PATH:'safe'}).PATH,'safe');
  } finally {f.cleanup();}
});

test('Claude catalog preserves exact local versions, per-model efforts, aliases and workflow restrictions',async()=>{
  const f=fixture(),cacheRoot=path.join(f.home,'.claude/cache/model-catalog');
  const effortOptions=levels=>levels.map(id=>({id,...(id==='medium'?{badge:{message:'Recommended'}}:{})}));
  try {
    fs.mkdirSync(cacheRoot,{recursive:true});fs.mkdirSync(path.join(f.home,'.local/bin'),{recursive:true});
    fs.writeFileSync(path.join(f.home,'.local/bin/claude.exe'),'--max-turns <turns> CLAUDE_CODE_DISABLE_WORKFLOWS ultracode');
    fs.writeFileSync(path.join(cacheRoot,'older.json'),JSON.stringify({fetchedAt:10,catalog:{surface:'cc',config:{models:[{id:'claude-sonnet-5-4',name:'old fixture'}]}}}));
    fs.writeFileSync(path.join(cacheRoot,'desktop.json'),JSON.stringify({fetchedAt:999,catalog:{surface:'ccd',config:{models:[{id:'claude-opus-99',name:'wrong surface'}]}}}));
    fs.writeFileSync(path.join(cacheRoot,'current.json'),JSON.stringify({fetchedAt:20,staleAt:Date.now()+60000,organizationUuid:'private account value',catalog:{surface:'cc',config:{models:[
      {id:'claude-opus-5-5',name:'Opus 5.5',quick_select:true,thinking:{type:'effort',effort_options:effortOptions(['low','medium','high','xhigh','max'])}},
      {id:'claude-sonnet-5-5',name:'Sonnet 5.5',quick_select:true,thinking:{type:'effort',effort_options:effortOptions(['low','medium','high','xhigh','max'])}},
      {id:'claude-opus-4-6',name:'Opus 4.6',thinking:{type:'effort',effort_options:effortOptions(['low','medium','high','max'])}},
      {id:'claude-haiku-4-5-20251001',name:'Haiku 4.5',thinking:{type:'none'}},
      {id:'claude-fable-5-1',name:'Fable 5.1',quick_select:true,thinking:{type:'effort',effort_options:effortOptions(['low','medium','high','xhigh','max'])}},
    ]},state:{model:'claude-opus-5-5',selection_source:'user_setting'}}}));
    fs.writeFileSync(path.join(f.home,'.claude/settings.json'),JSON.stringify({model:'opus',modelSettings:{'claude-opus-5-5':{effortLevel:'xhigh'}},secretFixture:'not returned'}));
    const catalog=await providerCatalog({home:f.home,env:{},execImpl:async()=>({stdout:'--model <model> --effort --disallowedTools'})});
    const opus=catalog.claude.models.find(row=>row.id==='claude-opus-5-5'),alias=catalog.claude.models.find(row=>row.id==='opus');
    assert.equal(opus.label,'Opus 5.5');assert.deepEqual(opus.efforts,['low','medium','high','xhigh','max']);assert.equal(opus.dynamic,false);
    assert.equal(alias.dynamic,true);assert.equal(alias.resolvedId,opus.id);assert.ok(alias.label.includes('dynamic alias'));
    assert.equal(catalog.claude.currentModel.id,'opus');assert.equal(catalog.claude.currentModel.resolvedId,opus.id);assert.equal(catalog.claude.currentModel.effort,'xhigh');
    assert.deepEqual(catalog.claude.models.find(row=>row.id==='claude-haiku-4-5-20251001').efforts,[]);
    assert.equal(catalog.claude.models.find(row=>row.id==='claude-fable-5-1').managedSupported,false);
    assert.ok(catalog.claude.models.find(row=>row.id==='fable').managedReason.includes('credits'));
    assert.equal(catalog.claude.workflows[0].available,true);assert.equal(catalog.claude.workflows[0].managedSupported,false);
    assert.equal(catalog.effortAliases.ultracode,undefined);assert.equal(catalog.claude.cache.stale,false);
    assert.ok(!catalog.claude.models.some(row=>row.id==='claude-opus-99'||row.id==='claude-sonnet-5-4'));
    assert.ok(!JSON.stringify(catalog).includes('private account value'));assert.ok(!JSON.stringify(catalog).includes('secretFixture'));
    const pinned=await providerCatalog({home:f.home,env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-fable-5-1'},execImpl:async()=>({stdout:'--model <model> --effort'})});
    assert.equal(pinned.claude.models.find(row=>row.id==='opus').managedSupported,false);assert.equal(pinned.claude.currentModel.managedSupported,false);

    const budget=budgetFixture(),calls=[],run=createMissionRunner({home:f.home,env:{},budget,spawnImpl:(command,args,options)=>{
      calls.push(options);const child=fakeChild();queueMicrotask(()=>{child.stdout.write(receipt('claude-abcdef'));child.finish();});return child;}});
    await assert.rejects(run({...f,provider:'claude',model:'claude-opus-4-6',effort:'xhigh'}),/not supported/);
    await assert.rejects(run({...f,provider:'claude',model:'claude-haiku-4-5-20251001',effort:'high'}),/not supported/);
    for(const model of ['fable','best','claude-fable-5','claude-fable-5-1'])await assert.rejects(run({...f,provider:'claude',model,effort:''}),/usage credits/);
    const redirected=createMissionRunner({home:f.home,env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-fable-5-1'},budget,spawnImpl:()=>{throw Error('must not spawn');}});
    await assert.rejects(redirected({...f,provider:'claude',model:'opus',effort:''}),/usage credits/);
    assert.equal(budget.calls.length,0);assert.equal(calls.length,0);
    await run({...f,provider:'claude',model:'claude-sonnet-5-5',effort:'',timeoutMs:1000});
    assert.equal(calls[0].env.AI_MODEL,'claude-sonnet-5-5');assert.equal(calls[0].env.AI_EFFORT,undefined);
    fs.writeFileSync(path.join(f.home,'.claude/settings.json'),JSON.stringify({model:'fable'}));
    await assert.rejects(run({...f,provider:'claude',model:'',effort:''}),/usage credits/);assert.equal(budget.calls.length,1);
    fs.mkdirSync(path.join(f.home,'.claude/ai-sessions'));fs.writeFileSync(path.join(f.home,'.claude/ai-sessions/claude-bbbbbb.json'),JSON.stringify({model:'claude-fable-5-1'}));
    await assert.rejects(run({...f,provider:'claude',model:'opus',effort:'',sessionHandle:'claude-bbbbbb'}),/usage credits/);assert.equal(budget.calls.length,1);
    assert.throws(()=>openOrchestratorTerminal({...f,provider:'claude',effort:'ultracode',windowName:'agent-relay-'+id},{home:f.home,budget}),/Unsupported reasoning/);
    let launch;
    await openOrchestratorTerminal({...f,provider:'claude',model:'claude-fable-5-1',effort:'max',windowName:'agent-relay-'+id},{home:f.home,env:{},budget,
      spawnImpl:(command,args)=>{launch=JSON.parse(fs.readFileSync(args.at(-1).slice(1),'utf8'));const child=fakeChild();queueMicrotask(()=>child.emit('spawn'));return child;}});
    assert.equal(launch.model,'claude-fable-5-1');assert.equal(launch.effort,'max');
  } finally {f.cleanup();}
});

test('real ai-chat wrapper enforces Codex guards, preserves native session and rejects effort changes',async()=>{
  const f=fixture(),wrapper=fileURLToPath(new URL('../tools/ai-chat.mjs',import.meta.url));
  try {
    const entry=path.join(f.home,'fake-codex.mjs'),marker=path.join(f.home,'arguments.jsonl');
    fs.writeFileSync(entry,`import fs from 'node:fs';fs.appendFileSync(process.env.FIXTURE_ARGS,JSON.stringify(process.argv.slice(2))+'\\n');process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'${id}'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'STATUS: OK'}}));});`);
    const env={...subscriptionEnvironment(process.env),HOME:f.home,USERPROFILE:f.home,CODEX_JS:entry,FIXTURE_ARGS:marker,
      AI_NO_PARITY:'1',AI_MODE:'work',AI_NO_AUTOMODE:'1',AI_RELAY_MANAGED:'1',AI_MODEL:'gpt-6.1-sol',AI_EFFORT:'ultra'};
    const first=await exec(process.execPath,[wrapper,'codex','new','@'+f.promptFile,f.cwd],{env,windowsHide:true,timeout:15000});
    const handle=first.stdout.match(/handle=(codex-[a-f0-9]{6})/)?.[1];assert.ok(handle);assert.ok(first.stdout.includes('native_id='+id));
    await exec(process.execPath,[wrapper,'codex','say',handle,'@'+f.promptFile],{env,windowsHide:true,timeout:15000});
    const args=fs.readFileSync(marker,'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(args.every(value=>value.includes('multi_agent')&&value.includes('model_reasoning_effort="ultra"')));
    assert.deepEqual(args[1].slice(0,3),['exec','resume',id]);
    await assert.rejects(exec(process.execPath,[wrapper,'codex','say',handle,'@'+f.promptFile],{env:{...env,AI_EFFORT:'high'},windowsHide:true,timeout:15000}),error=>error.stderr.includes('cannot change the effort'));
    assert.equal(fs.readFileSync(marker,'utf8').trim().split('\n').length,2);
    const ordinary=await exec(process.execPath,[wrapper,'codex','new','@'+f.promptFile,f.cwd],{env:{...env,AI_RELAY_MANAGED:'0'},windowsHide:true,timeout:15000});
    assert.ok(ordinary.stdout.includes('STATUS: OK'));
    const ordinaryArgs=JSON.parse(fs.readFileSync(marker,'utf8').trim().split('\n').at(-1));
    assert.ok(!ordinaryArgs.includes('multi_agent'));assert.ok(!ordinaryArgs.includes('model_reasoning_effort="ultra"'),'ordinary lanes keep existing reasoning behavior');
  } finally {f.cleanup();}
});

test('real wrapper Claude managed planner restricts tools and includes the confirmed local turn limit',async()=>{
  const f=fixture(),wrapper=fileURLToPath(new URL('../tools/ai-chat.mjs',import.meta.url));
  try {
    const bootstrap=path.join(f.home,'spawn-fixture.cjs'),fake=path.join(f.home,'fake-claude.cjs'),marker=path.join(f.home,'arguments.json');
    fs.writeFileSync(fake,`const fs=require('node:fs');fs.writeFileSync(process.env.FIXTURE_ARGS,JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.env.FIXTURE_ARGS+'.workflow',process.env.CLAUDE_CODE_DISABLE_WORKFLOWS||'');process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',session_id:'${id}',result:'STATUS: OK'})));`);
    fs.writeFileSync(bootstrap,`const cp=require('node:child_process');const original=cp.spawn;cp.spawn=function(command,args,options){if(command==='claude'||/claude\\.exe$/i.test(command))return original(process.execPath,[process.env.FIXTURE_CLAUDE,...args],options);return original(command,args,options);};require('node:module').syncBuiltinESMExports();`);
    const env={...subscriptionEnvironment(process.env),HOME:f.home,USERPROFILE:f.home,FIXTURE_CLAUDE:fake,FIXTURE_ARGS:marker,
      NODE_OPTIONS:'--require='+bootstrap,AI_NO_PARITY:'1',AI_MODE:'plan',AI_NO_AUTOMODE:'1',AI_RELAY_MANAGED:'1',AI_RELAY_READ_ONLY:'1',AI_RELAY_MAX_TURNS:'8',AI_MODEL:'opus',AI_EFFORT:'max',CLAUDE_CODE_DISABLE_WORKFLOWS:'0'};
    const response=await exec(process.execPath,[wrapper,'claude','new','@'+f.promptFile,f.cwd],{env,windowsHide:true,timeout:15000});
    const args=JSON.parse(fs.readFileSync(marker,'utf8'));assert.equal(args[args.indexOf('--max-turns')+1],'8');assert.equal(args[args.indexOf('--effort')+1],'max');
    assert.equal(args[args.indexOf('--permission-mode')+1],'plan');assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep,WebFetch,WebSearch');
    assert.equal(args[args.indexOf('--disallowedTools')+1],'Agent,Task,Workflow');
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings')+1]),{disableWorkflows:true,ultracode:false});
    assert.ok(args.includes('--strict-mcp-config'));assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
    assert.ok(response.stdout.includes('caps=repo_read+web+images'));
    assert.ok(!response.stdout.includes('caps=repo_read+shell'));
    assert.equal(fs.readFileSync(marker+'.workflow','utf8'),'1');
    await assert.rejects(exec(process.execPath,[wrapper,'claude','new','@'+f.promptFile,f.cwd],{env:{...env,AI_MODEL:'claude-fable-5-1'},windowsHide:true,timeout:15000}),error=>error.stderr.includes('additional usage credits'));
    assert.deepEqual(JSON.parse(fs.readFileSync(marker,'utf8')),args);
    await exec(process.execPath,[wrapper,'claude','new','@'+f.promptFile,f.cwd],{env:{...env,AI_RELAY_MANAGED:'0'},windowsHide:true,timeout:15000});
    assert.ok(!JSON.parse(fs.readFileSync(marker,'utf8')).includes('--settings'));assert.equal(fs.readFileSync(marker+'.workflow','utf8'),'0');
  } finally {f.cleanup();}
});
