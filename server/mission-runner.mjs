// Subscription CLI turns owned by one mission. No shell command interpolation.
import {spawn, execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {MissionBudget} from './mission-budget.mjs';

import { RUNNER_SESSIONS } from './config.mjs';
const exec = promisify(execFile);
const AI_CHAT = fileURLToPath(new URL('../tools/ai-chat.mjs', import.meta.url));
const ORCHESTRATOR_TERMINAL = fileURLToPath(new URL('./orchestrator-terminal.mjs', import.meta.url));
export const NATIVE_LAUNCH_LIMIT = 32 * 1024;
const NATIVE_PROMPT_LIMIT = 16 * 1024, NATIVE_LAUNCH_FILES = 4096;
const OUTPUT_LIMIT = 1024 * 1024, LOG_LIMIT = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HANDLE = /^(codex|claude)-[a-f0-9]{6}$/;
const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:()/-]{0,119}$/;
const EFFORTS = {codex:['low','medium','high','xhigh','max','ultra'],claude:['low','medium','high','xhigh','max']};
const CLAUDE_MODEL_DOCS = 'https://code.claude.com/docs/en/model-config';
const CLAUDE_WORKFLOW_DOCS = 'https://code.claude.com/docs/en/workflows';
const CLAUDE_GUARD_SETTINGS = JSON.stringify({disableWorkflows:true,ultracode:false});
const BLOCK_ENV = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS)|OPENAI_(?:API_KEY|BASE_URL)|CODEX_API_KEY|AZURE_OPENAI_.*|CLAUDECODE|CLAUDE_CODE_(?:ENTRYPOINT|USE_(?:BEDROCK|VERTEX|FOUNDRY))|AI_(?:SUBAGENT|OUT|IMAGE|MODEL|EFFORT|MODE|TIMEOUT|NO_AUTOMODE|NO_PARITY|RELAY_.*)|NODE_OPTIONS|CODEX_JS)$/i;
let sharedBudget;
const defaultBudget = () => sharedBudget ||= new MissionBudget();

export function subscriptionEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !BLOCK_ENV.test(key)));
}
function validateProvider(provider, model, effort) {
  if (!Object.hasOwn(EFFORTS,provider)) throw Error('Unsupported provider');
  if (model != null && model !== '' && (!MODEL.test(model) || model.includes('..'))) throw Error('Invalid model');
  if (effort != null && effort !== '' && !EFFORTS[provider].includes(effort)) throw Error('Unsupported reasoning effort');
}
function codexModels(home,env) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home,'.codex'),'models_cache.json'),'utf8'));
    return Array.isArray(cache.models) ? cache.models : [];
  } catch { return []; }
}
function boundedJson(file) {
  let fd;
  try {
    fd=fs.openSync(file,'r'); const size=fs.fstatSync(fd).size;
    if (size>2*1024*1024) return null;
    const buffer=Buffer.alloc(2*1024*1024+1); let offset=0;
    while(offset<buffer.length) { const count=fs.readSync(fd,buffer,offset,buffer.length-offset,null); if(!count)break; offset+=count; }
    if(offset>2*1024*1024)return null;
    return JSON.parse(buffer.subarray(0,offset).toString('utf8'));
  } catch { return null; } finally { if(fd!=null)fs.closeSync(fd); }
}
const safeModel = value => typeof value==='string' && MODEL.test(value) && !value.includes('..');
const fableSelection = value => value==='fable' || value==='best' || /(?:^|[.:/])claude-fable-/.test(value || '');
function claudeCache(home,env) {
  const root=path.join(env.CLAUDE_CONFIG_DIR || path.join(home,'.claude'),'cache','model-catalog');
  try {
    const files=fs.readdirSync(root).filter(file=>file.endsWith('.json')).map(file=>({file:path.join(root,file),mtime:fs.statSync(path.join(root,file)).mtimeMs}))
      .sort((a,b)=>b.mtime-a.mtime).slice(0,64);
    const candidates=files.map(({file,mtime})=>({data:boundedJson(file),mtime})).filter(({data})=>data?.catalog?.surface==='cc'&&Array.isArray(data.catalog.config?.models));
    candidates.sort((a,b)=>(Number(b.data.fetchedAt)||b.mtime)-(Number(a.data.fetchedAt)||a.mtime));
    return candidates[0]?.data || null;
  } catch { return null; }
}
function claudeSelection(home,env,cwd,cache) {
  let model=null,provenance=[],settings={};
  const root=env.CLAUDE_CONFIG_DIR || path.join(home,'.claude');
  const files=[path.join(root,'settings.json'),path.join(root,'settings.local.json')];
  if(cwd)files.push(path.join(cwd,'.claude','settings.json'),path.join(cwd,'.claude','settings.local.json'));
  for(const file of files) { const value=boundedJson(file); if(!value)continue; settings={...settings,...value,modelSettings:{...settings.modelSettings,...value.modelSettings}};
    if(safeModel(value.model)){model=value.model;provenance=[file.startsWith(root)?'user-settings':'project-settings'];} }
  if(safeModel(env.ANTHROPIC_MODEL)){model=env.ANTHROPIC_MODEL;provenance=['model-environment'];}
  else if(!model&&safeModel(env.ANTHROPIC_DEFAULT_MODEL)){model=env.ANTHROPIC_DEFAULT_MODEL;provenance=['default-model-environment'];}
  if(!model&&safeModel(cache?.catalog?.state?.model)){model=cache.catalog.state.model;provenance=['claude-model-cache'];}
  return {model,provenance,settings};
}
function claudeModels(home,env,cwd) {
  const cache=claudeCache(home,env),rows=cache?.catalog.config.models || [],selection=claudeSelection(home,env,cwd,cache);
  const models=rows.filter(row=>safeModel(row.id)).map(row=>{
    const options=Array.isArray(row.thinking?.effort_options)?row.thinking.effort_options:[];
    const efforts=[...new Set(options.map(level=>level.id).filter(level=>EFFORTS.claude.includes(level)))];
    const recommended=options.find(level=>/^(Recommended|Default)$/.test(level.badge?.message || ''))?.id;
    const fable=/^claude-fable-/.test(row.id);
    return {id:row.id,label:typeof row.name==='string'&&row.name.length<=120?row.name:row.id,efforts,
      kind:'model',dynamic:false,resolvedId:row.id,provenance:['claude-model-cache'],support:'catalog',defaultEffort:recommended || null,
      workflows:efforts.includes('xhigh')?['ultracode']:[],managedSupported:!fable,
      ...(fable?{managedReason:'Fable can use additional credits without confirmation in headless chats; it is unavailable to managed workers.',billingNote:'Depending on your plan, Fable may require additional credits.',docsUrl:CLAUDE_MODEL_DOCS}:{}),
      quickSelect:row.quick_select===true};
  });
  for(const alias of ['opus','sonnet','haiku','fable']) {
    const pin=env['ANTHROPIC_DEFAULT_'+alias.toUpperCase()+'_MODEL'];
    const candidates=models.filter(row=>row.id.startsWith('claude-'+alias+'-')&&row.quickSelect);
    const resolvedId=safeModel(pin)?pin:candidates.length===1?candidates[0].id:null;
    const resolved=models.find(row=>row.id===resolvedId);
    const fable=fableSelection(alias)||fableSelection(resolvedId);
    models.push({id:alias,label:alias+' (dynamic alias)',kind:'alias',dynamic:true,resolvedId,
      efforts:resolved?.efforts || [],defaultEffort:resolved?.defaultEffort || null,workflows:resolved?.workflows || [],
      provenance:[safeModel(pin)?'model-environment':resolved?'claude-model-cache':'installed-cli-alias'],support:resolved?'catalog':'unknown',
      managedSupported:!fable,...(fable?{managedReason:'This alias may resolve to Fable and use additional credits; it is unavailable to managed workers.',billingNote:'Depending on your plan, Fable may require additional credits.',docsUrl:CLAUDE_MODEL_DOCS}:{}),
      resolutionNote:'Alias resolution is dynamic; the local catalog does not confirm availability or included quota.'});
  }
  if(selection.model&&!models.some(row=>row.id===selection.model)){
    const dynamic=['best','default','opusplan','inherit'].includes(selection.model);
    models.push({id:selection.model,label:selection.model+(dynamic?' (dynamic alias)':''),kind:dynamic?'alias':'model',dynamic,resolvedId:dynamic?null:selection.model,
      efforts:[],defaultEffort:null,workflows:[],provenance:selection.provenance,support:'configured',managedSupported:!fableSelection(selection.model),
      ...(fableSelection(selection.model)?{managedReason:'This model may use additional credits; select another model for managed workers.',billingNote:'Depending on your plan, Fable may require additional credits.'}:{})});
  }
  const current=models.find(row=>row.id===selection.model),resolved=models.find(row=>row.id===current?.resolvedId);
  const selectedEffort=selection.settings.modelSettings?.[resolved?.id]?.effortLevel || selection.settings.effortLevel;
  const currentModel=current?{id:current.id,resolvedId:current.resolvedId,label:resolved?.label || current.label,
    provenance:[...new Set([...selection.provenance,...current.provenance])],support:current.support,managedSupported:current.managedSupported,
    effort:EFFORTS.claude.includes(selectedEffort)?selectedEffort:resolved?.defaultEffort || null}:null;
  return {models,currentModel,cache,selection};
}
function validateManagedBilling(provider,model,{home=os.homedir(),env=process.env,cwd,sessionHandle}={}) {
  if(provider!=='claude')return;
  const catalog=claudeModels(home,env,cwd),selected=model&&model!=='default'?model:catalog.selection.model;
  const resumed=HANDLE.test(sessionHandle || '')?boundedJson(path.join(env.CHATS_RUNNER_SESSIONS || (home===os.homedir()?RUNNER_SESSIONS:path.join(home,'.claude','ai-sessions')),sessionHandle+'.json'))?.model:null;
  const resolve=value=>catalog.models.find(row=>row.id===value)?.resolvedId;
  if([selected,resumed,resolve(selected),resolve(resumed)].some(fableSelection))
    throw Error('Fable may use additional usage credits in headless mode and is unavailable to managed workers; select an included model explicitly');
}
function validateModelEffort(provider,model,effort,{home = os.homedir(),env = process.env,cwd} = {}) {
  if (provider === 'claude') {
    const catalog=claudeModels(home,env,cwd),selected=model || catalog.selection.model,found=catalog.models.find(row=>row.id===selected);
    if(!found || found.support!=='catalog')return 'unknown';
    if(effort&&!found.efforts.includes(effort))throw Error('Reasoning effort '+effort+' is not supported by '+(found.resolvedId || selected));
    return 'catalog';
  }
  let selected = model;
  if (!selected) try {
    const config = fs.readFileSync(path.join(env.CODEX_HOME || path.join(home,'.codex'),'config.toml'),'utf8');
    selected = config.match(/^model\s*=\s*"([a-zA-Z0-9._:()/-]+)"/m)?.[1];
  } catch { /* An unrecorded account default remains unknown. */ }
  const found = codexModels(home,env).find(candidate=>candidate.slug===selected);
  if (!found) return 'unknown';
  const supported = (found.supported_reasoning_levels || []).map(level=>level.effort);
  if (!supported.length) return 'unknown';
  if (effort && !supported.includes(effort)) throw Error('Reasoning effort '+effort+' is not supported by '+selected);
  return 'catalog';
}
function existingPath(value, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw Error('An absolute path is required');
  const stat = fs.statSync(value);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('Path type mismatch');
  return path.resolve(value);
}
function tail(buffer, chunk, limit) {
  return Buffer.concat([buffer,Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk))]).subarray(-limit);
}

async function stopOwnedTree(child, {platform = process.platform, execImpl = exec} = {}) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (platform === 'win32') {
    try { await execImpl('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,maxBuffer:32000}); }
    catch { /* The process may have finished while cancellation was delivered. */ }
  } else {
    // The runner creates a new process group on POSIX, so this targets its children.
    try { process.kill(-child.pid,'SIGKILL'); } catch { /* Already exited. */ }
  }
  try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
}

/** Dependency injection keeps tests away from real provider sessions and windows. */
export function createMissionRunner({spawnImpl = spawn, killTree = stopOwnedTree,
  aiChatPath = AI_CHAT, env = process.env, platform = process.platform, budget, home = os.homedir(), closeLog = fs.closeSync} = {}) {
  return async function runMission({provider,model,effort,cwd,promptFile,outputFile,
    sessionHandle,timeoutMs = 900000,signal,onOutput,role = 'worker'}) {
    validateProvider(provider,model,effort);
    const modelSupport = validateModelEffort(provider,model,effort,{home,env,cwd});
    validateManagedBilling(provider,model,{home,env,cwd,sessionHandle});
    const directory = existingPath(cwd,true), prompt = existingPath(promptFile);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24*60*60*1000) throw Error('Invalid turn timeout');
    if (sessionHandle && (!HANDLE.test(sessionHandle) || !sessionHandle.startsWith(provider+'-'))) throw Error('Invalid provider session handle');
    if (outputFile != null && (typeof outputFile !== 'string' || !path.isAbsolute(outputFile) || /[\x00-\x1f]/.test(outputFile))) throw Error('Invalid output path');
    if (outputFile && path.resolve(outputFile) === prompt) throw Error('Output cannot overwrite the prompt');
    if (signal?.aborted) throw Object.assign(Error('Mission turn canceled'),{name:'AbortError'});
    const args = [aiChatPath,provider,...(sessionHandle?['say',sessionHandle,'@'+prompt]:['new','@'+prompt,directory])];
    const childEnv = {...subscriptionEnvironment(env),AI_MODE:role==='planner'?'plan':'work',
      AI_NO_AUTOMODE:'1',AI_RELAY_MANAGED:'1',AI_RELAY_MAX_TURNS:role==='planner'?'24':'60',
      AI_TIMEOUT:String(Math.ceil(timeoutMs/1000))};
    if (role === 'planner') childEnv.AI_RELAY_READ_ONLY = '1';
    if (platform !== 'win32') childEnv.AI_RELAY_OWNED_PROCESS_GROUP = '1';
    if (model) childEnv.AI_MODEL = model;
    if (effort) childEnv.AI_EFFORT = effort;
    const lease = await (budget || defaultBudget()).reserve({role,sessionHandle});
    let logFd = null, logBytes = 0, timer = null, abort = null, streamError = null;
    try {
    if (signal?.aborted) throw Object.assign(Error('Mission turn canceled'),{name:'AbortError'});
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile),{recursive:true});
      logFd = fs.openSync(outputFile,'a');
      logBytes = fs.fstatSync(logFd).size;
    }
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), discoveredHandle = sessionHandle || null;
    let nativeId = null, timedOut = false, aborted = false;
    let firstLine = '', firstLineRead = false, reportedMetadata = '';
    function reportMetadata() {
      const next = JSON.stringify({sessionHandle:discoveredHandle,nativeId});
      if (!discoveredHandle || next === reportedMetadata || typeof onOutput !== 'function') return;
      reportedMetadata = next;
      try { onOutput('', 'metadata', {sessionHandle:discoveredHandle,nativeId}); } catch { /* Observers cannot stop a turn. */ }
    }
    const child = spawnImpl(process.execPath,args,{cwd:directory,env:childEnv,windowsHide:true,
      detached:platform!=='win32',stdio:['ignore','pipe','pipe']});
    let cancelPromise = null;
    const cancel = reason => {
      if (cancelPromise || child.exitCode != null || child.signalCode != null) return;
      timedOut = reason === 'timeout'; aborted = reason === 'abort';
      cancelPromise = Promise.resolve(killTree(child,{platform})).catch(()=>{
        try { child.kill('SIGKILL'); } catch { /* An exited child requires no retry. */ }
      });
    };
    timer = setTimeout(()=>cancel('timeout'),timeoutMs);
    abort = () => cancel('abort'); signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    reportMetadata();
    function receive(chunk, channel) {
      const bytes = Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));
      if (logFd != null && logBytes < LOG_LIMIT) {
        const remaining = bytes.subarray(0,LOG_LIMIT-logBytes);
        try { fs.writeSync(logFd,remaining); logBytes += remaining.length; }
        catch (error) { streamError = error; cancel('output'); }
      }
      if (channel === 'stdout') stdout = tail(stdout,bytes,OUTPUT_LIMIT-64*1024); else stderr = tail(stderr,bytes,64*1024);
      // The managed wrapper emits this first machine line before any generated
      // answer. Later lookalike lines inside model prose cannot enroll a chat.
      if (channel === 'stdout' && !firstLineRead) {
        firstLine += bytes.toString('utf8');
        if (firstLine.length > 4096 || firstLine.includes('\n')) {
          firstLineRead = true;
          const start = firstLine.split(/\r?\n/,1)[0].match(/^AI_RELAY_SESSION (\{.*\})$/);
          if (start) try {
            const record = JSON.parse(start[1]);
            if (HANDLE.test(record.sessionHandle || '') && record.sessionHandle.startsWith(provider+'-')) discoveredHandle = record.sessionHandle;
          } catch { /* An invalid machine receipt cannot enroll the turn. */ }
          firstLine = ''; reportMetadata();
        }
      }
      if (typeof onOutput === 'function') { try { onOutput(bytes.toString('utf8'),channel); } catch { /* UI observers cannot terminate a provider turn. */ } }
    }
    child.stdout?.on('data',chunk=>receive(chunk,'stdout'));
    child.stderr?.on('data',chunk=>receive(chunk,'stderr'));
      const exitCode = await new Promise((resolve,reject)=>{
        child.once('error',reject); child.once('close',code=>resolve(Number.isInteger(code)?code:1));
      });
      if (cancelPromise) await cancelPromise;
      const marker = '<<<AI-CHAT:BEGIN>>>\n';
      const text = stdout.toString('utf8'), begin = text.lastIndexOf(marker);
      const end = text.lastIndexOf('\n<<<AI-CHAT:END');
      const answer = begin >= 0 && end > begin ? text.slice(begin+marker.length,end) : '';
      const footer = [...text.matchAll(/<<<AI-CHAT:END\b([^\r\n]+)>>>/g)].at(-1);
      if (footer) {
        const handle = footer[1].match(/\bhandle=(\S+)/)?.[1];
        const id = footer[1].match(/\bnative_id=(\S+)/)?.[1];
        if (HANDLE.test(handle || '') && handle.startsWith(provider+'-') && (!discoveredHandle || handle===discoveredHandle)) discoveredHandle = handle;
        if (UUID.test(id || '')) nativeId = id;
        reportMetadata();
      }
      const finalCode = streamError ? 1 : exitCode;
      const error = streamError ? 'Provider log could not be persisted'
        : timedOut ? `The managed turn timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
        : aborted ? 'The managed turn was canceled.'
        : finalCode !== 0 ? stderr.toString('utf8').slice(-4000) || `Provider exited with code ${finalCode}.`
        : !answer ? stderr.toString('utf8').slice(-4000) || 'No provider answer captured' : null;
      // Persist our own exit evidence even if the wrapper was killed before it
      // could emit an answer or stderr. This marker never includes prompt text.
      const diagnostic = {schema:1,provider,role,exitCode:finalCode,timeoutMs,timedOut,aborted,
        reason:streamError?'log-error':timedOut?'timeout':aborted?'canceled':finalCode!==0?'provider-exit':!answer?'empty-answer':'completed'};
      receive('\nAI_RELAY_DIAGNOSTIC '+JSON.stringify(diagnostic)+'\n','diagnostic');
      return {sessionHandle:discoveredHandle,nativeId,answer,modelSupport,exitCode:finalCode,timedOut,aborted,...(error?{error}:{})};
    } finally {
      clearTimeout(timer); if (abort) signal?.removeEventListener('abort',abort);
      try { if (logFd != null) closeLog(logFd); }
      finally { await lease.release(); }
    }
  };
}

export function providerBins(home = os.homedir(), env = process.env) {
  const codexCandidates = [path.join(path.dirname(process.execPath),'node_modules/@openai/codex/bin/codex.js'),
    path.join(env.APPDATA || home,'npm/node_modules/@openai/codex/bin/codex.js')];
  return {claude:path.join(home,'.local/bin/claude.exe'),codex:codexCandidates.find(file=>fs.existsSync(file)) || null};
}
const binaryCapabilities = new Map();
function claudeCapabilities(file) {
  try {
    const stat=fs.statSync(file),key=file+':'+stat.size+':'+stat.mtimeMs;
    if(binaryCapabilities.has(key))return binaryCapabilities.get(key);
    if(stat.size>512*1024*1024)return {maxTurns:false,workflows:false};
    const markers=['--max-turns <turns>','CLAUDE_CODE_DISABLE_WORKFLOWS','ultracode'],found=new Set();
    const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);let carry='';
    try { while(found.size<markers.length) {
      const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;
      const text=carry+buffer.subarray(0,count).toString('latin1');
      for(const marker of markers)if(text.includes(marker))found.add(marker);carry=text.slice(-64);
    } } finally {fs.closeSync(fd);}
    const value={maxTurns:found.has(markers[0]),workflows:found.has(markers[1])&&found.has(markers[2])};
    if(binaryCapabilities.size>=8)binaryCapabilities.clear();binaryCapabilities.set(key,value);return value;
  } catch {return {maxTurns:false,workflows:false};}
}
export async function providerCatalog({home = os.homedir(),env = process.env,execImpl = exec,cwd} = {}) {
  const bins = providerBins(home,env), result = {};
  await Promise.all(['codex','claude'].map(async provider=>{
    let help = '', version = '', error = '';
    try {
      if (!bins[provider] || !fs.existsSync(bins[provider])) throw Error('CLI is not installed');
      const command = provider==='codex'?process.execPath:bins[provider];
      const prefix = provider==='codex'?[bins[provider]]:[];
      const runs = await Promise.all(['--help','--version'].map(flag=>execImpl(command,[...prefix,flag],
        {windowsHide:true,timeout:10000,maxBuffer:128*1024,env:subscriptionEnvironment(env)})));
      help = String(runs[0].stdout); version = String(runs[1].stdout).trim();
    } catch (failure) { error = failure.message; }
    let models = [],currentModel=null,cacheMeta=null;
    if (provider==='codex') try {
      models = codexModels(home,env).filter(model=>MODEL.test(model.slug || '')).map(model=>({id:model.slug,label:model.display_name || model.slug,
        efforts:(model.supported_reasoning_levels || []).map(level=>level.effort).filter(level=>EFFORTS.codex.includes(level)),
        defaultEffort:EFFORTS.codex.includes(model.default_reasoning_level)?model.default_reasoning_level:null,
        kind:'model',dynamic:false,resolvedId:model.slug,provenance:['codex-model-cache'],support:'catalog',managedSupported:true,workflows:[]}));
      const configFile=path.join(env.CODEX_HOME || path.join(home,'.codex'),'config.toml');
      if(fs.statSync(configFile).size<=2*1024*1024){
        const config=fs.readFileSync(configFile,'utf8'),id=config.match(/^model\s*=\s*"([a-zA-Z0-9._:()/-]+)"/m)?.[1],row=models.find(row=>row.id===id);
        if(id)currentModel={id,resolvedId:id,label:row?.label || id,provenance:['codex-config',...(row?['codex-model-cache']:[])],support:row?'catalog':'configured',managedSupported:true,
          effort:config.match(/^model_reasoning_effort\s*=\s*"([a-z]+)"/m)?.[1] || row?.defaultEffort || null};
      }
    } catch { /* A missing cache is explicit: no model catalog is invented. */ }
    else {const data=claudeModels(home,env,cwd);models=data.models;currentModel=data.currentModel;
      cacheMeta=data.cache?{source:'claude-model-cache',fetchedAt:Number(data.cache.fetchedAt)||null,stale:!Number.isFinite(data.cache.staleAt)||data.cache.staleAt<Date.now()}:null;}
    // max-turns is intentionally hidden by this installed Claude build. Its local
    // parser is inspected without starting inference; --help alone cannot prove it.
    const capabilities=provider==='claude'&&help?claudeCapabilities(bins.claude):{maxTurns:false,workflows:false};
    result[provider] = {available:!!help,version,models,efforts:[...EFFORTS[provider]],
      currentModel,cache:cacheMeta,workflows:provider==='claude'?[{id:'ultracode',label:'Ultracode',available:capabilities.workflows,
        managedSupported:false,requiresModelEffort:'xhigh',startupEffort:'xhigh',reason:'Ultracode runs native workflows outside Relay limits. It is disabled in protected workers and orchestrators.',docsUrl:CLAUDE_WORKFLOW_DOCS}]:[],
      modelSelection:help.includes(provider==='codex'?'--model <MODEL>':'--model <model>'),
      reasoning:provider==='codex'?help.includes('--config'):help.includes('--effort'),
      nativeDelegateGuard:provider==='codex'?help.includes('--disable'):help.includes('--disallowedTools'),
      maxTurns:capabilities.maxTurns,subscriptionAuth:'Inherited API credentials and alternate providers are excluded; CLI login entitlement and included subscription usage are not inferred.',
      ...(error?{error}:{}),...(provider==='codex'&&!models.length?{catalogError:'No local Codex model catalog'}:{}),
      ...(provider==='claude'&&!cacheMeta?{catalogError:'No local Claude model catalog; exact model and effort compatibility remain unknown'}:{})};
  }));
  return {...result,effortAliases:{ultrareasoning:{codex:'ultra',claude:'max'}},
    aliasNote:'ultrareasoning is an explicit effort alias. Ultracode is a separate Claude workflow mode and is disabled in managed Relay sessions.',
    limits:{managedTurns:20,plannerTurns:8,outputMemoryBytes:OUTPUT_LIMIT,logBytes:LOG_LIMIT,
    nestedAgents:'Provider-native delegation disabled. Unrestricted worker shell is not a process isolation boundary.',
    subscriptionTokens:'Provider subscription token quotas cannot be enforced as exact billing limits by this runner.'}};
}

/** Read-only turns get Read/Glob/Grep on Claude; Codex reads only through its read-only sandbox shell. */
export function readOnlyInspection(provider) {
  return provider === 'codex'
    ? 'Your only file-reading tool is the shell inside the read-only sandbox: use it only for read-only inspection commands such as rg, ls, Get-Content, cat, git status, git diff, git log and git show. Never run builds, tests, package managers, project scripts, network commands or commands that write.'
    : 'Use only the read-only file tools; never execute processes.';
}

async function launchTerminal(args,{spawnImpl = spawn,env = process.env} = {}) {
  // Windows Terminal interprets semicolons itself, even without a shell.
  if (args.some(value=>typeof value !== 'string' || /[;\r\n]/.test(value))) throw Error('Unsafe Windows Terminal argument');
  // These are user-requested interactive chats. Hiding wt.exe also hides a newly
  // named terminal window; background provider and cleanup processes stay hidden.
  const child = spawnImpl('wt.exe',args,{env:subscriptionEnvironment(env),detached:true,windowsHide:false,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref(); return {launched:true};
}
function terminalPrefix(cwd,windowName,title) {
  existingPath(cwd,true);
  if (typeof windowName !== 'string' || !/^agent-relay-[a-zA-Z0-9_-]{1,100}$/.test(windowName)) throw Error('A stable mission window name is required');
  return ['-w',windowName,'new-tab','--inheritEnvironment','--title',title,'--suppressApplicationTitle','-d',cwd];
}
function terminalPort(value,dependencies) {
  const port = Number(value ?? (dependencies.env || process.env).CHATS_PORT ?? 4848);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid relay port');
  return port;
}
export function openMissionTerminal({missionId,taskId,cliPath,cwd,windowName,port},dependencies = {}) {
  if (!UUID.test(missionId || '') || !TASK_ID.test(taskId || '')) throw Error('Invalid mission or task ID');
  const cli = existingPath(cliPath), relayPort = terminalPort(port,dependencies);
  return launchTerminal([...terminalPrefix(cwd,windowName,'Agent Relay · '+taskId),process.execPath,cli,
    '--port',String(relayPort),'chat',missionId,taskId],dependencies);
}
export function openOrchestratorTerminal({provider,model,effort,cwd,cliPath,windowName,port},dependencies = {}) {
  if (effort === 'ultrareasoning') effort = provider==='claude'?'max':'ultra';
  validateProvider(provider,model,effort); const cli = existingPath(cliPath);
  const modelSupport = validateModelEffort(provider,model,effort,{home:dependencies.home || os.homedir(),env:dependencies.env || process.env});
  const relayPort = terminalPort(port,dependencies);
  const prompt = '# Agent Relay · Orchestrator\n<!-- agent-relay-native-orchestrator:v1 -->\n'+
    'You are the Agent Relay orchestrator. Write generated explanations and reports in English; preserve literal user requirements and identifiers. Read and apply the globally installed agent-relay-orchestrator skill before planning. '+
    'Use the bounded mission coordinator through node "'+cli+'" --port '+relayPort+'; create no native subagents, recursive CLI agents or external model calls. '+
    'Preserve the mission concurrency, turn, deadline and ownership limits. Wait for the user\'s task. '+
    'Capture every requested task literally with its own ID, plan dependencies, inspect worker logs and artifacts, '+
    'verify acceptance against the actual code and continue until all tasks are complete or an evidenced limit requires user input. '+
    'The actual named Windows Terminal window is '+windowName+'. Every mission contract you create must explicitly include '+
    JSON.stringify({terminalWindow:windowName,terminalViews:true})+'. '+
    'Pass this exact contract in mission JSON even if environment variables are missing. Use that named window for child chat views; do not silently create another orchestration tree.';
  const config = {schema:1,provider,model:model || '',effort:effort || '',cwd,cliPath:cli,windowName,port:relayPort,prompt};
  return launchNative(config,'Agent Relay · Orchestrator','orchestrator',modelSupport,dependencies);
}
function launchNative(config,title,role,modelSupport,dependencies) {
  createOrchestratorCommand(config,dependencies); // Reject unavailable CLIs before reserving a launch.
  return (async()=>{
    const lease = await (dependencies.budget || defaultBudget()).reserve({role});
    try {
      const launchFile = writeNativeLaunch(config,dependencies);
      const args = [...terminalPrefix(path.dirname(launchFile),config.windowName,title),process.execPath,ORCHESTRATOR_TERMINAL,'@'+launchFile];
      return {...await launchTerminal(args,dependencies),effort:config.effort || null,modelSupport};
    }
    finally { await lease.release(); }
  })();
}

export const EVALS_WINDOW = 'agent-relay-evals';
const EVALS_LABEL = /^# Relay Evals · ([A-Za-z0-9 '’“”-]{1,60})\n<!-- agent-relay-evals-analysis:v1 -->\n/;
/** One interactive Claude or Codex chat per click on an Evals analysis; the server builds the prompt. */
export function openEvalsAnalysisTerminal({prompt,provider = 'claude',model = '',cwd,cliPath,effort = 'high',port},dependencies = {}) {
  const label = typeof prompt === 'string' ? EVALS_LABEL.exec(prompt)?.[1] : null;
  if (!label) throw Error('Invalid Relay Evals analysis prompt');
  validateProvider(provider,model,effort);
  const modelSupport = validateModelEffort(provider,model,effort,{home:dependencies.home || os.homedir(),env:dependencies.env || process.env});
  const config = {schema:1,provider,model,effort,cwd,cliPath:existingPath(cliPath),windowName:EVALS_WINDOW,port:terminalPort(port,dependencies),prompt};
  return launchNative(config,'Relay Evals · '+label,'analysis',modelSupport,dependencies);
}

export function nativeLaunchDirectory({home = os.homedir()} = {}) {
  return path.join(home,'Downloads','agent-work','agent-relay-missions','native-launches');
}
function writeNativeLaunch(config,dependencies) {
  const root = nativeLaunchDirectory(dependencies), data = JSON.stringify(config);
  if (Buffer.byteLength(data) > NATIVE_LAUNCH_LIMIT) throw Error('Native launch configuration is too large');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if (fs.readdirSync(root).length >= NATIVE_LAUNCH_FILES) throw Error('Native launch history is full; archive its owned files before launching again');
  const file = path.join(root,crypto.randomUUID()+'.json');
  fs.writeFileSync(file,data,{flag:'wx',mode:0o600});
  return file;
}

/** Only installed provider binaries are selectable; config never supplies executable commands. */
export function createOrchestratorCommand(config,{home = os.homedir(),env = process.env} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schema !== 1 ||
      Object.keys(config).some(key=>!['schema','provider','model','effort','cwd','cliPath','windowName','port','prompt'].includes(key))) throw Error('Invalid native launch configuration');
  const {provider,model,effort,cwd,cliPath,windowName,port,prompt} = config;
  if (typeof model !== 'string' || typeof effort !== 'string' || !Number.isInteger(port)) throw Error('Invalid native model, effort or port');
  validateProvider(provider,model,effort); existingPath(cwd,true); existingPath(cliPath);
  terminalPrefix(cwd,windowName,'Agent Relay · Orchestrator'); terminalPort(port,{env:{}});
  validateModelEffort(provider,model,effort,{home,env});
  // Evals analyses have their own header; Claude also gets their chat name.
  const evalsLabel = typeof prompt === 'string' ? EVALS_LABEL.exec(prompt)?.[1] : null;
  if (typeof prompt !== 'string' || !(evalsLabel || /^# Agent Relay · (?:Orchestrator|Orquestador)\n<!-- agent-relay-native-orchestrator:v1 -->\n/.test(prompt)) ||
      prompt.includes('\0') || Buffer.byteLength(prompt) > NATIVE_PROMPT_LIMIT) throw Error('Invalid native orchestrator prompt');
  const bins = providerBins(home,env);
  if (provider === 'codex') {
    if (!bins.codex) throw Error('Codex CLI is not installed');
    return {command:process.execPath,args:[bins.codex,'--disable','multi_agent',...(model?['-m',model]:[]),
      ...(effort?['-c','model_reasoning_effort="'+effort+'"']:[]),prompt]};
  }
  if (!fs.existsSync(bins.claude)) throw Error('Claude CLI is not installed');
  return {command:bins.claude,args:['--name',evalsLabel ? 'Relay Evals · '+evalsLabel : 'Agent Relay · Orchestrator','--disallowedTools','Agent,Task,Workflow','--settings',CLAUDE_GUARD_SETTINGS,
    ...(model?['--model',model]:[]),...(effort?['--effort',effort]:[]),'--',prompt]};
}
