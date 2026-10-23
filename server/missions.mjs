import './config.mjs';
// Durable, bounded mission scheduling. Workers are trusted local code, not a security sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const SLUG=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const MODEL=/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
const EFFORTS={codex:['low','medium','high','xhigh','max','ultra'],claude:['low','medium','high','xhigh','max']};
const ACTIVE=new Set(['running','checking']);
const TERMINAL=new Set(['stopped','ready','applied']);
const SECRET=/(?:^|\/)(?:\.env[^/]*|[^/]*(?:secret|wallet)[^/]*|keys\.json|[^/]*\.(?:pem|key))$/i;
const BLOCKED_COMMAND=/^(?:bash|sh|zsh|fish|cmd|powershell|pwsh|wscript|cscript|rm|rmdir|del|erase|mv|remove-item|move-item|codex|claude|ai-chat|ai-loop|relay)(?:\.exe|\.cmd|\.bat)?$/i;
const DEFAULT_LIMITS={concurrency:3,maxSessions:16,maxTurns:24,taskMinutes:60,missionMinutes:720};
const TOOLING=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools');
const LOG_LIMIT=128*1024;
const DISK_LOG_LIMIT=8*1024*1024;
const exec=promisify(execFile);
const GLOBAL_PROCESSES=4;
const GLOBAL_MISSIONS=2;
const fail=(message,code='invalid',status=400)=>Object.assign(new Error(message),{code,status});
const within=(root,target)=>{const r=path.relative(root,target);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const canonical=p=>process.platform==='win32'?p.toLowerCase():p;
const stripAnsi=text=>String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const dependencyFields=value=>Object.fromEntries(['dependencies','devDependencies','optionalDependencies','peerDependencies','overrides','workspaces','packageManager'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
function localDependencies(root,directory,manifest){
 const visit=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))visit(child);return;}if(typeof value!=='string'||! /^(?:file|link):/i.test(value))return;let relative;try{relative=decodeURIComponent(value.slice(value.indexOf(':')+1));}catch{throw fail('Invalid local dependency reference.','dependencies',409);}if(path.isAbsolute(relative)||relative.startsWith('//')||!within(root,path.resolve(directory,relative)))throw fail('A local dependency points outside the worktree or uses an absolute path. Original source will not be linked.','dependencies',409);};
 visit(dependencyFields(manifest));
}

function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw fail(`${label} must be an object.`);}
function keys(value,allowed,label){if(Object.keys(value).some(k=>!allowed.includes(k)))throw fail(`${label} contains unknown fields.`);}
function text(value,label,min,max,trim=true){if(typeof value!=='string'||value.trim().length<min||value.length>max||value.includes('\0'))throw fail(`${label} is invalid.`);return trim?value.trim():value;}
function providerOptions(spec,defaults={}){
 const provider=spec.provider??defaults.provider??'codex';
 if(!Object.hasOwn(EFFORTS,provider))throw fail('Invalid provider.');
 const inherited=provider===defaults.provider?defaults:{};
 const model=(spec.model??inherited.model)||null;
 if(model!==null&&(typeof model!=='string'||!MODEL.test(model)||model.includes('..')))throw fail('The model must be a safe identifier.');
 const effort=spec.effort??inherited.effort??'high';
 if(effort!==''&&!EFFORTS[provider].includes(effort))throw fail(`Reasoning effort is not supported by ${provider}.`);
 return {provider,model,effort};
}
function scope(value){
 if(typeof value!=='string'||!value||value.length>300||/[\\\u0000-\u001f\u007f:*?]/.test(value)||value.startsWith('/')||value.startsWith('-')||path.isAbsolute(value))throw fail('Scope must be a relative path without wildcards.');
 const parts=value.replace(/\/$/,'').split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git')||SECRET.test(value))throw fail('Scope contains a protected path or escapes the project.');
 return value;
}
function checks(value,label){
 if(!Array.isArray(value)||value.length<1||value.length>12)throw fail(`${label} needs between 1 and 12 verification commands.`);
 return value.map(command=>{
  if(!Array.isArray(command)||command.length<1||command.length>24||command.some(a=>typeof a!=='string'||!a||a.length>2000||/[\u0000-\u001f]/.test(a)))throw fail('Each verification must be an argument array, without a shell.');
  const exe=path.basename(command[0]);
  if(BLOCKED_COMMAND.test(exe)||/\.(?:bat|ps1)$/i.test(exe)||command[0].startsWith('-'))throw fail('Verification cannot invoke shells, providers or destructive operations.');
  if(/^(?:npm|pnpm|yarn|npx)(?:\.cmd)?$/i.test(exe)&&command.slice(1).some(a=>/^(?:install|i|add|remove|uninstall|publish|exec|dlx)$/i.test(a)))throw fail('Verification cannot install, publish or download executables.');
  if(/^npx(?:\.cmd)?$/i.test(exe)&&!command.includes('--no-install'))throw fail('npx requires --no-install.');
  if(/^git(?:\.exe)?$/i.test(exe)&&!['diff','status','ls-files','show','rev-parse','log'].includes(command[1]))throw fail('Git verification must be read-only.');
  return [...command];
 });
}
function checkTimeouts(value,count){
 if(value===undefined)return {};
 if(!Array.isArray(value)||value.length!==count||Array.from(value).some(ms=>ms!==null&&(!Number.isInteger(ms)||ms<1||ms>43200000)))throw fail('checkTimeoutsMs must match checks, with null or integer milliseconds within 1–43200000.');
 return {checkTimeoutsMs:[...value]};
}
export function verificationTimeout(remaining,requested,fallback){return Math.min(requested??fallback,Math.max(1,remaining));}

export function normalizeMissionSpec(spec){
 object(spec,'The mission');keys(spec,['title','goal','project','provider','model','effort','limits','tasks','checks','checkTimeoutsMs','planId','terminalWindow','terminalViews'],'The mission');
 const title=text(spec.title,'The title',1,160),goal=text(spec.goal,'The goal',10,20000,false);
 if(typeof spec.project!=='string'||!path.isAbsolute(spec.project)||spec.project.length>1000||/[\u0000-\u001f]/.test(spec.project))throw fail('The project must be an absolute path.');
 const options=providerOptions(spec),limits={...DEFAULT_LIMITS};
 if(spec.limits!==undefined){object(spec.limits,'The limits');keys(spec.limits,Object.keys(limits),'The limits');Object.assign(limits,spec.limits);}
 const bounds={concurrency:[1,4],maxSessions:[1,32],maxTurns:[1,64],taskMinutes:[1,720],missionMinutes:[5,10080]};
 for(const [k,[min,max]] of Object.entries(bounds))if(!Number.isInteger(limits[k])||limits[k]<min||limits[k]>max)throw fail(`Limit ${k} is outside ${min}–${max}.`);
 if(!Array.isArray(spec.tasks)||spec.tasks.length<1||spec.tasks.length>24)throw fail('A mission needs between 1 and 24 tasks.');
 const ids=new Set(),identityKeys=new Set();
 const tasks=spec.tasks.map(t=>{
  object(t,'The task');keys(t,['id','title','prompt','dependsOn','files','checks','checkTimeoutsMs','provider','model','effort'],'The task');
  if(typeof t.id!=='string'||!SLUG.test(t.id)||['__proto__','constructor','prototype','orchestrator','integration'].includes(t.id.toLowerCase())||identityKeys.has(t.id.toLowerCase()))throw fail('Task IDs are invalid, reserved or repeated (case-insensitive).');ids.add(t.id);identityKeys.add(t.id.toLowerCase());
  const dependsOn=t.dependsOn??[];
  if(!Array.isArray(dependsOn)||dependsOn.length>24||dependsOn.some(d=>typeof d!=='string'||!SLUG.test(d))||new Set(dependsOn).size!==dependsOn.length)throw fail('Invalid dependencies.');
  if(!Array.isArray(t.files)||t.files.length<1||t.files.length>100)throw fail('Each task needs between 1 and 100 file scopes.');
  return {id:t.id,title:text(t.title,'The task title',1,160),prompt:text(t.prompt,'The instruction',5,20000,false),dependsOn:[...dependsOn],files:[...new Set(t.files.map(scope))],checks:checks(t.checks,'The task'),...checkTimeouts(t.checkTimeoutsMs,t.checks.length),...providerOptions(t,options)};
 });
 const byId=new Map(tasks.map(t=>[t.id,t])),visiting=new Set(),visited=new Set();
 function visit(id){if(visiting.has(id))throw fail('The plan contains circular dependencies.');if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id).dependsOn){if(!ids.has(dep))throw fail(`Unknown dependency: ${dep}.`);visit(dep);}visiting.delete(id);visited.add(id);}
 for(const t of tasks)visit(t.id);
 if(spec.planId!==undefined&&(typeof spec.planId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(spec.planId)))throw fail('Invalid plan ID.');
 if(spec.terminalWindow!==undefined&&(typeof spec.terminalWindow!=='string'||!/^agent-relay-[a-zA-Z0-9-]{1,64}$/.test(spec.terminalWindow)))throw fail('Invalid terminal window.');
 if(spec.terminalViews!==undefined&&typeof spec.terminalViews!=='boolean')throw fail('Terminal views must be a boolean.');
 return {title,goal,project:path.resolve(spec.project),...options,limits,tasks,checks:checks(spec.checks,'The mission'),...checkTimeouts(spec.checkTimeoutsMs,spec.checks.length),terminalViews:spec.terminalViews===true,...(spec.planId?{planId:spec.planId}:{}),...(spec.terminalWindow?{terminalWindow:spec.terminalWindow}:{})};
}

function overlapping(a,b){
 return a.some(x=>b.some(y=>{x=canonical(x);y=canonical(y);return x===y||x.endsWith('/')&&y.startsWith(x)||y.endsWith('/')&&x.startsWith(y);}));
}
function allowed(file,scopes){const p=canonical(file);return scopes.some(s=>p===canonical(s)||s.endsWith('/')&&p.startsWith(canonical(s)));}
function npmCommand(command){
 if(process.platform!=='win32'||!/^(?:npm|npx)(?:\.cmd)?$/i.test(path.basename(command[0])))return command;
 const cli=/^npx/i.test(path.basename(command[0]))?'npx-cli.js':'npm-cli.js';
 const dirs=[path.dirname(process.execPath),...(process.env.PATH??'').split(path.delimiter).map(p=>p.replace(/^"|"$/g,''))];
 for(const dir of dirs){const file=path.join(dir,'node_modules','npm','bin',cli);if(fs.existsSync(file))return [process.execPath,file,...command.slice(1)];}
 throw fail('The installed npm CLI was not found; use node with an explicit script path.','command',409);
}

// argv only. Timeout/abort settles after the process closes, so slots never release early.
async function run(command,{cwd,timeoutMs=30000,signal,onOutput,maxBytes=4*1024*1024}={}){
 command=npmCommand(command);
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(fail('Operation canceled.','aborted',409));return;}
  let child,output='',stdout='',stderr='',bytes=0,timedOut=false,aborted=false,error=null,timer,cancelPromise;
  try{child=spawn(command[0],command.slice(1),{cwd,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}});}catch(e){reject(e);return;}
  const terminate=()=>{if(cancelPromise||!child.pid)return;cancelPromise=(async()=>{if(process.platform==='win32'){if(child.exitCode===null)try{await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,maxBuffer:32000});}catch{/* the owned process may already have exited */}}else try{process.kill(-child.pid,'SIGKILL');}catch{/* the owned process group may already have exited */}try{child.kill('SIGKILL');}catch{/* close/error completes the operation */}})();};
  const abort=()=>{aborted=true;terminate();};
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>{timedOut=true;terminate();},Math.max(1,timeoutMs));timer.unref();
  for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']]){stream.setEncoding('utf8');stream.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>maxBytes){error=fail('Verification output exceeded the limit.','output-limit',409);terminate();return;}output+=s;if(name==='stdout')stdout+=s;else stderr+=s;onOutput?.(s);});}
  child.on('error',e=>{error=e;});
  child.on('close',async code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(cancelPromise)await cancelPromise;if(error)reject(error);else if(timedOut)reject(fail('The operation timed out.','timeout',409));else if(aborted)reject(fail('Operation canceled.','aborted',409));else resolve({exitCode:code??1,output,stdout,stderr});});
 });
}

function atomic(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);
}

async function baselineGit(artifacts,cwd,args,options={}){
 const r=await run(['git','-c','core.hooksPath='+path.join(artifacts,'empty-hooks'),'-c','core.longpaths=true',...args],{cwd,timeoutMs:30000,...options});
 if(r.exitCode!==0)throw fail('Git: '+stripAnsi(r.output).slice(-2000),'git',409);return r.stdout;
}
function regularSource(root,file,missing=false){
 // Validate geometry independently of the broad secret-name policy: existing clean
 // source such as secret-scan.mjs is safe to retain; changed protected paths are refused.
 if(typeof file!=='string'||!file||/[\u0000-\u001f\u007f]/.test(file)||path.isAbsolute(file)||process.platform==='win32'&&(/^[a-z]:/i.test(file)||file.includes('\\'))||file.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'))throw fail('Source path must be relative and stay inside the project.','scope',409);
 if(SECRET.test(file.replace(/(?:secret|wallet)/ig,'protected')))throw fail('Source contains a protected path.','scope',409);
 let current=root;
 for(const part of file.split('/')){current=path.join(current,part);if(!within(root,current))throw fail('Path is outside the project.','scope',409);try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw fail('The isolated copy does not support symbolic links.','symlink',409);}catch(error){if(missing&&error.code==='ENOENT')return false;throw error;}}
 if(!fs.lstatSync(current).isFile())throw fail('The copy supports only regular files.','file-type',409);return true;
}
const fileHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// A manifest includes HEAD, the exact index bytes, missing tracked files and ordinary
// untracked source. Ignored build/dependency/private files are never exposed to workers.
export async function captureMissionSource(project,artifacts,options={}){
 const git=(args)=>baselineGit(artifacts,project,args,options);
 const real=fs.realpathSync(project),root=fs.realpathSync((await git(['rev-parse','--show-toplevel'])).trim());
 if(canonical(real)!==canonical(root))throw fail('Select the Git repository root.','project',409);
 const branch=(await git(['symbolic-ref','--short','HEAD'])).trim(),head=(await git(['rev-parse','HEAD'])).trim();
 const status=await git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=all']);
 for(const entry of status.split('\0').filter(Boolean))if(SECRET.test(entry.slice(3)))throw fail('A protected file has changes. They remain in the original and will not be exposed to chats.','protected-source',409);
 const names=[...new Set((await git(['ls-tree','-r','--name-only','-z',head])).split('\0').concat((await git(['ls-files','--cached','-z'])).split('\0'),(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0')).filter(Boolean))].sort();
 const identities=new Set(),entries=[];
 for(const name of names){const key=canonical(name);if(identities.has(key))throw fail('The project contains colliding paths.','scope',409);identities.add(key);const exists=regularSource(real,name,true);entries.push({name,hash:exists?fileHash(path.join(real,name)):null,mode:exists?fs.statSync(path.join(real,name)).mode&0o777:null});}
 const indexPath=(await git(['rev-parse','--git-path','index'])).trim(),index=path.resolve(real,indexPath),indexHash=fs.existsSync(index)?fileHash(index):null;
 if((await git(['rev-parse','HEAD'])).trim()!==head||(await git(['symbolic-ref','--short','HEAD'])).trim()!==branch||await git(['status','--porcelain=v1','-z','--no-renames','--untracked-files=all'])!==status)throw fail('The project changed while preparing the copy. Your work was not modified.','project-race',409);
 return {project:real,branch,head,indexHash,dirty:!!status,entries,digest:digest({branch,head,indexHash,entries})};
}
export async function prepareMissionBaseline({project,artifacts,id=crypto.randomUUID(),gate,signal}){
 artifacts=path.resolve(artifacts);if(!/^[a-f0-9-]{36}$/i.test(id))throw fail('Invalid baseline ID.');
 const source=await captureMissionSource(project,artifacts,{signal});if(within(source.project,artifacts))throw fail('The isolated copy must live outside the project.');
 const directory=path.join(artifacts,id),worktree=path.join(directory,'baseline'),branch=`relay/${id}/baseline`,logFile=path.join(directory,'baseline.log');
 fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(path.join(artifacts,'empty-hooks'),{recursive:true});
 await baselineGit(artifacts,source.project,['worktree','add','-b',branch,worktree,source.head],{signal});
 for(const entry of source.entries){const destination=path.join(worktree,entry.name);if(!within(worktree,destination))throw fail('Path is outside the copy.','scope',409);
  if(entry.hash===null){if(fs.existsSync(destination)){regularSource(worktree,entry.name);fs.unlinkSync(destination);}continue;}
  regularSource(source.project,entry.name);if(fileHash(path.join(source.project,entry.name))!==entry.hash)throw fail('A file changed during the copy.','project-race',409);
  regularSource(worktree,entry.name,true);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(source.project,entry.name),destination);if(process.platform!=='win32')fs.chmodSync(destination,entry.mode);
  if(fileHash(destination)!==entry.hash)throw fail('The copy does not match the captured source.','project-race',409);
 }
 const final=await captureMissionSource(source.project,artifacts,{signal});if(final.digest!==source.digest)throw fail('The project changed during the copy. Evidence was preserved and no chats were opened.','project-race',409);
 const changed=(await baselineGit(artifacts,worktree,['status','--porcelain=v1','--untracked-files=all'],{signal})).trim();
 if(changed){await baselineGit(artifacts,worktree,['add','-A','--',...source.entries.map(entry=>entry.name)],{signal});
  if(gate)await gate({cwd:worktree,signal,role:'baseline'});else{
   const scanner=(process.env.CHATS_SECRET_SCANNER || path.join(TOOLING,'trufflehog-bin',process.platform==='win32'?'trufflehog.exe':'trufflehog'));
   const commands=[[process.execPath,path.join(TOOLING,'staged-secret-scan.mjs'),'--repo',worktree,'--scanner',scanner],[process.execPath,path.join(TOOLING,'change-guard.mjs'),'--repo',worktree]];
   if(![commands[0][1],commands[1][1],scanner].every(file=>fs.existsSync(file)))throw fail('Required guards for saving a safe copy are missing.','gate-missing',409);
   for(const command of commands){const result=await run(command,{cwd:worktree,signal,timeoutMs:180000,onOutput:chunk=>{if(!fs.existsSync(logFile)||fs.statSync(logFile).size<DISK_LOG_LIMIT)fs.appendFileSync(logFile,stripAnsi(chunk));}});if(result.exitCode!==0)throw fail('The guards rejected the isolated copy. Your project remains intact.','gate-failed',409);}
  }
  for(const entry of source.entries){if(entry.hash===null){if(fs.existsSync(path.join(worktree,entry.name)))throw fail('A guard modified the copy.','gate-mutated',409);}else if(!regularSource(worktree,entry.name)||fileHash(path.join(worktree,entry.name))!==entry.hash)throw fail('A guard modified the copy.','gate-mutated',409);}
  if((await baselineGit(artifacts,worktree,['diff','--name-only','--'],{signal})).trim())throw fail('A guard modified the copy index.','gate-mutated',409);
  if((await baselineGit(artifacts,worktree,['diff','--cached','--name-only','--'],{signal})).trim())await baselineGit(artifacts,worktree,['-c','user.name=Agent Relay','-c','user.email=agent-relay@localhost','commit','-m','Capture isolated Agent Relay baseline'],{signal});
 }
 const head=(await baselineGit(artifacts,worktree,['rev-parse','HEAD'],{signal})).trim();
 if((await baselineGit(artifacts,worktree,['status','--porcelain=v1','--untracked-files=all'],{signal})).trim())throw fail('The copy was modified during its guards.','baseline-changed',409);
 if((await captureMissionSource(source.project,artifacts,{signal})).digest!==source.digest)throw fail('Your project changed during the baseline guards. No chats will start from an outdated source.','project-race',409);
 const baseline={id,path:worktree,branch,head,source,createdAt:Date.now()};atomic(path.join(directory,'baseline.json'),baseline);return baseline;
}

export class MissionManager{
 constructor({file,artifacts,runner,onChange,now=Date.now,gate,resolveBaseline,applyTimeoutMs=30*60000}={}){
  if(!file||!artifacts)throw new Error('MissionManager needs file and artifacts.');
  if(!Number.isInteger(applyTimeoutMs)||applyTimeoutMs<1||applyTimeoutMs>30*60000)throw new Error('Apply deadline must be within 30 minutes.');
  Object.assign(this,{file:path.resolve(file),artifacts:path.resolve(artifacts),runner,onChange,now,gate,resolveBaseline,applyTimeoutMs});
  this.jobs=[];this.queue=Promise.resolve();this.active=new Map();this.closed=false;this.roundRobin=0;
  if(fs.existsSync(this.file)){
   const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(saved.version!==1||!Array.isArray(saved.missions))throw new Error('Unsupported mission state. Preserve the file and inspect it.');
   this.jobs=saved.missions;
   for(const m of this.jobs){if(m.status==='expired'){m.status='attention';m.deadlineReached=true;}if(m.status==='running'||m.tasks.some(t=>ACTIVE.has(t.status))){m.status='attention';for(const t of m.tasks)if(ACTIVE.has(t.status)){t.status='attention';t.detail='The server restarted during this task. Review the evidence before resuming.';}this.event(m,'The server restarted. Turns are not repeated automatically.');}}
   this.save();
  }
 }
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 save(){
  for(const m of this.jobs)this.writeContract(m,m.finalChecksPassed===true);
  atomic(this.file,{version:1,missions:this.jobs});
  try{this.onChange?.(this.publicState());}catch{/* observers cannot roll back committed state */}
 }
 writeContract(m,goalComplete=false){
  m.requirementsFile??=path.join(this.artifacts,m.id,'requirements.json');
  const evidence=files=>files.filter(file=>file&&fs.existsSync(file)&&fs.statSync(file).isFile());
  atomic(m.requirementsFile,{version:1,items:[{id:'mission.goal',literal:m.goal,status:goalComplete?'completed':'pending',evidence:evidence([m.integrationLog])},...m.tasks.map(t=>({id:t.id,literal:t.prompt,status:t.status==='completed'&&t.checksPassed?'completed':'pending',evidence:evidence([t.logFile,t.promptFile])}))]});
 }
 event(m,message,t){const at=this.now();m.detail=stripAnsi(message).slice(0,2000);m.updatedAt=at;m.events.push({at,text:m.detail});if(m.events.length>200)m.events.splice(0,m.events.length-200);if(t)t.detail=m.detail;}
 mission(id){const m=this.jobs.find(j=>j.id===id);if(!m)throw fail('Mission not found.','not-found',404);return m;}
 task(m,id){const t=m.tasks.find(t=>t.id===id);if(!t)throw fail('Task not found.','not-found',404);return t;}
 view(m){
  const counts=Object.fromEntries(['pending','running','checking','completed','attention'].map(s=>[s,m.tasks.filter(t=>t.status===s).length]));
  const tasks=m.tasks.map(({id,title,dependsOn,files,checks,checkTimeoutsMs,provider,model,effort,status,detail,sessionHandle,nativeId,turnsUsed,sessionsUsed,startedAt,completedAt,checksPassed,attempts,commit,deadline,deadlineReached})=>({id,title,dependsOn,files,checks,checkTimeoutsMs,provider,model,effort,status,detail,sessionHandle,nativeId,turnsUsed,sessionsUsed,startedAt,completedAt,checksPassed,attempts,commit,deadline,deadlineReached:deadlineReached===true}));
  return {id:m.id,title:m.title,goal:m.goal,project:m.project,planId:m.planId,terminalWindow:m.terminalWindow,terminalViews:m.terminalViews===true,provider:m.provider,model:m.model,effort:m.effort,status:m.status,detail:m.detail,createdAt:m.createdAt,updatedAt:m.updatedAt,deadline:m.deadline,deadlineReached:m.deadlineReached===true,baselineDirty:m.baseline?.source.dirty===true,deliveryMode:m.baseline?.source.dirty?'worktree':'fast-forward',limits:m.limits,sessionsUsed:m.sessionsUsed,turnsUsed:m.turnsUsed,events:m.events,integrationBranch:m.integrationBranch,verifiedHead:m.verifiedHead,counts,progress:{completed:counts.completed,total:tasks.length,percent:Math.round(counts.completed/tasks.length*100)},tasks,checks:m.checks,checkTimeoutsMs:m.checkTimeoutsMs,finalChecksPassed:m.finalChecksPassed===true};
 }
 publicState(){return this.jobs.map(m=>this.view(m));}
 async git(cwd,args,options={}){return baselineGit(this.artifacts,cwd,args,options);}
 async repository(project,options={}){
  let real;try{real=fs.realpathSync(project);}catch{throw fail('The project does not exist.');}
  const root=fs.realpathSync((await this.git(real,['rev-parse','--show-toplevel'],options)).trim());
  if(canonical(real)!==canonical(root))throw fail('Select the Git repository root.');
  const branch=(await this.git(real,['symbolic-ref','--short','HEAD'],options)).trim(),head=(await this.git(real,['rev-parse','HEAD'],options)).trim();
  return {project:real,branch,head};
 }
 async assertOriginal(m,options={}){
  const repo=await this.repository(m.project,options);if(repo.branch!==m.originalBranch||repo.head!==m.originalHead)throw fail('The original branch or revision changed. Your work was not modified.','project-changed',409);
  if(m.baseline){const source=await captureMissionSource(m.project,this.artifacts,options);let comparable=source;
   if(m.applyTransaction?.phase==='applying'){
    const original=new Map(m.baseline.source.entries.map(entry=>[entry.name,entry])),entries=new Map(source.entries.map(entry=>[entry.name,entry]));
    for(const file of m.applyTransaction.files){const current=entries.get(file.name),hash=current?.hash??null;if(hash!==file.beforeHash&&hash!==file.afterHash)throw fail('An interrupted delivery has additional changes. The backup was preserved and that file will not be overwritten.','project-changed',409);if(original.has(file.name))entries.set(file.name,original.get(file.name));else entries.delete(file.name);}
    const adjusted=[...entries.values()].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);comparable={...source,digest:digest({branch:source.branch,head:source.head,indexHash:source.indexHash,entries:adjusted})};
   }
   if(comparable.digest!==m.baseline.source.digest)throw fail('Your project or index changed since the initial copy. The mission preserves its result without overwriting your changes.','project-changed',409);return source;}
  if((await this.git(m.project,['status','--porcelain=v1','--untracked-files=all'],options)).trim())throw fail('The project changed since the original mission.','project-changed',409);return repo;
 }
 async create(spec){return this.serial(async()=>{
  if(this.closed)throw fail('The coordinator is closed.','closed',409);
  const normalized=normalizeMissionSpec(spec),repo=await this.repository(normalized.project);
  if(within(repo.project,this.artifacts))throw fail('Artifacts must live outside the project.');
  for(const t of normalized.tasks)for(const s of t.files)this.checkPath(repo.project,s.replace(/\/$/,''),true);
  const id=crypto.randomUUID(),at=this.now();
  let baseline=normalized.planId&&this.resolveBaseline?await this.resolveBaseline(normalized.planId):null;
  if(normalized.planId&&this.resolveBaseline&&!baseline)throw fail('The plan baseline was not found.','baseline',409);
  baseline??=await prepareMissionBaseline({project:repo.project,artifacts:this.artifacts,id,gate:this.gate});
  if(canonical(baseline.source.project)!==canonical(repo.project)||(await captureMissionSource(repo.project,this.artifacts)).digest!==baseline.source.digest)throw fail('The project changed after preparing the plan. Work was preserved; prepare a plan from the current state.','project-changed',409);
  if((await this.git(baseline.path,['rev-parse','HEAD'])).trim()!==baseline.head||(await this.git(baseline.path,['status','--porcelain=v1','--untracked-files=all'])).trim())throw fail('The plan baseline changed.','baseline-changed',409);
  const m={...normalized,baseline,project:repo.project,id,originalBranch:repo.branch,originalHead:repo.head,status:'draft',createdAt:at,updatedAt:at,deadline:null,events:[],detail:'Plan validated. No chat was opened.',turnsUsed:0,sessionsUsed:0,integrationBranch:`relay/${id}/integration`,integrationPath:path.join(this.artifacts,id,'integration'),finalChecksPassed:false,tasks:normalized.tasks.map(t=>({...t,status:'pending',detail:'Queued',attempts:0,turnsUsed:0,sessionsUsed:0,sessionHandle:null,nativeId:null,checksPassed:false}))};
  m.dependencyBaselines=await this.captureDependencies(m);
  this.jobs.push(m);this.event(m,'Plan validated. Shared scopes will run sequentially.');this.save();return this.view(m);
 });}
 async start(id){const result=await this.serial(async()=>{
  const m=this.mission(id);if(m.status!=='draft')throw fail('Only a new plan can be started; use Resume for an existing mission.','state',409);
  this.capacity(m);await this.assertOriginal(m);
  fs.mkdirSync(path.dirname(m.integrationPath),{recursive:true});fs.mkdirSync(path.join(this.artifacts,'empty-hooks'),{recursive:true});
  await this.git(m.project,['worktree','add','-b',m.integrationBranch,m.integrationPath,m.baseline?.head??m.originalHead]);
  m.status='running';m.deadline=this.now()+m.limits.missionMinutes*60000;m.initialDeadline=m.deadline;this.event(m,'Mission started in isolated worktrees. The original project remains intact.');this.save();return this.view(m);
 });await this.tick();return result;}
 capacity(m){if(this.closed)throw fail('The coordinator is closed.','closed',409);if(this.jobs.filter(j=>j.id!==m.id&&(j.status==='running'||j.tasks.some(t=>ACTIVE.has(t.status))||[...this.active.values()].some(a=>a.mission===j.id))).length>=GLOBAL_MISSIONS)throw fail('Two missions are already active.','mission-limit',409);}
 async pause(id){return this.serial(()=>{const m=this.mission(id);if(m.status!=='running')throw fail('This mission is not running.','state',409);m.status='paused';this.event(m,'Queue paused. Started tasks retain their turn and deadline.');this.save();return this.view(m);});}
 async extend(id,{minutes,taskId}={}){return this.serial(()=>{
  const m=this.mission(id);if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw fail('The extension must be between 1 and 1440 minutes.');
  if(TERMINAL.has(m.status)||!m.deadline)throw fail('Only a started mission with pending work can be extended.','state',409);
  const at=this.now();
  if(taskId!==undefined){const t=this.task(m,taskId);if(this.active.has(`${id}/${taskId}`)||t.status!=='attention')throw fail('Extend an idle task needing attention; an active turn keeps its operation limit.','state',409);
   const deadline=Math.max(at,t.deadline??at)+minutes*60000;if(deadline>at+720*60000||deadline>m.deadline)throw fail('Extend the mission first; each task permits up to 12 hours from now.','extension-limit',409);
   t.deadline=deadline;t.nextDeadline=deadline;t.deadlineReached=false;this.event(m,`Deadline extended by ${minutes} minutes for ${t.title}. Retry after reviewing its evidence.`,t);
  }else{const deadline=Math.max(at,m.deadline)+minutes*60000;if(deadline>at+10080*60000)throw fail('The deadline must be within the next seven days.','extension-limit',409);m.deadline=deadline;m.deadlineReached=false;if(m.status==='expired')m.status='attention';this.event(m,`Mission deadline extended by ${minutes} minutes. The budget is preserved; resume or retry explicitly.`);}
  m.extensions??=[];m.extensions.push({at,minutes,...(taskId?{taskId}:{} )});if(m.extensions.length>100)m.extensions.splice(0,m.extensions.length-100);this.save();return this.view(m);
 });}
 async resume(id){const result=await this.serial(()=>{
  const m=this.mission(id);if(!['paused','attention'].includes(m.status))throw fail('The mission cannot be resumed in this state.','state',409);this.capacity(m);
  if(this.now()>=m.deadline){this.expire(m);this.save();throw fail('Extend the deadline before continuing. Work and budget were preserved.','deadline-extension-required',409);}
  if(!m.integrationPath||!fs.existsSync(m.integrationPath))throw fail('The integration worktree was not found.','worktree',409);
  // Attention tasks require explicit retry; resume only releases unaffected queued work.
  m.status='running';this.event(m,'Mission resumed with its original budget and deadline. Tasks needing attention require Retry.');this.save();return this.view(m);
 });await this.tick();return result;}
 async stop(id){return this.serial(()=>{const m=this.mission(id);if(m.status==='applied')throw fail('The mission has already been applied.','state',409);m.status='stopped';for(const a of this.active.values())if(a.mission===id){a.controller.abort();if(a.task!=='@integration'){const t=this.task(m,a.task);if(ACTIVE.has(t.status)){t.status='attention';t.detail='Stopped by you. The worktree and its evidence are preserved.';}}}this.event(m,'Mission stopped. Branches, worktrees and evidence are preserved.');this.save();return this.view(m);});}
 async retry(id,taskId){const result=await this.serial(()=>{
  const m=this.mission(id),t=this.task(m,taskId);if(!['attention'].includes(t.status)||this.active.has(`${id}/${taskId}`)||TERMINAL.has(m.status))throw fail('Only an idle task needing attention can be retried.','state',409);
  if(this.now()>=m.deadline)throw fail('Extend the mission deadline before retrying.','deadline-extension-required',409);
  if(!t.commit&&!t.commitIntent&&!t.workerReceipt&&(m.turnsUsed>=m.limits.maxTurns||!t.sessionHandle&&m.sessionsUsed>=m.limits.maxSessions))throw fail('The turn or session budget is exhausted.','budget',409);
  this.capacity(m);t.status='pending';t.checksPassed=false;m.status='running';m.finalChecksPassed=false;this.event(m,`Explicit retry of ${t.title}. Previous state is preserved.`,t);this.save();return this.view(m);
 });await this.tick();return result;}
 async message(id,taskId,message){return this.serial(()=>{
  const m=this.mission(id),t=this.task(m,taskId);if(t.status!=='attention'||this.active.has(`${id}/${taskId}`)||TERMINAL.has(m.status))throw fail('You can add instructions only to a task needing attention. Then use Retry.','state',409);
  if(t.commit||t.commitIntent)throw fail('This candidate was already verified for commit. Retry will only verify and integrate it; create a new task to change its scope.','committed-candidate',409);
  const followup=text(message,'The additional instruction',1,10000);t.followup=followup;delete t.workerReceipt;this.event(m,`Instruction saved for the next turn of ${t.title}.`,t);this.save();return this.view(m);
 });}
 log(id,taskId){const m=this.mission(id),t=m.tasks.find(t=>t.id===taskId)??(['integration','@integration'].includes(taskId)?{logFile:m.integrationLog}:this.task(m,taskId));if(!t.logFile||!fs.existsSync(t.logFile))return '';const fd=fs.openSync(t.logFile,'r');try{const size=fs.fstatSync(fd).size,buf=Buffer.alloc(Math.min(size,LOG_LIMIT));fs.readSync(fd,buf,0,buf.length,size-buf.length);return stripAnsi(buf.toString('utf8'));}finally{fs.closeSync(fd);}}
 append(t,chunk){if(!t.logFile)return;const size=fs.existsSync(t.logFile)?fs.statSync(t.logFile).size:0;if(size>=DISK_LOG_LIMIT)return;const bytes=Buffer.from(stripAnsi(chunk));fs.appendFileSync(t.logFile,bytes.subarray(0,DISK_LOG_LIMIT-size));}
 checkPath(root,file,allowMissing=false){
  if(!allowed(file,[scope(file)])||SECRET.test(file))throw fail('Protected file.','scope',409);
  let current=root;
  for(const segment of file.split('/')){current=path.join(current,segment);if(!within(root,current))throw fail('Path is outside the worktree.','scope',409);try{const st=fs.lstatSync(current);if(st.isSymbolicLink())throw fail('Scopes and changes cannot cross symbolic links.','symlink',409);}catch(e){if(e.code==='ENOENT'&&allowMissing)break;throw e;}}
 }
 async tick(){return this.serial(async()=>{
  if(this.closed)return;
  for(const m of this.jobs)if(['running','paused','attention'].includes(m.status)&&!m.deadlineReached&&m.deadline&&this.now()>=m.deadline){this.expire(m);this.save();}
  const missions=this.jobs.filter(m=>m.status==='running');if(!missions.length)return;
  // Rotate missions between launches; no batch barrier waits for the slowest worker.
  const ordered=missions.slice(this.roundRobin%missions.length).concat(missions.slice(0,this.roundRobin%missions.length));this.roundRobin++;
  for(const m of ordered){
   if(m.tasks.every(t=>t.status==='completed')){if(!this.active.has(`${m.id}/@integration`))this.launchFinal(m);continue;}
   while(this.active.size<GLOBAL_PROCESSES&&[...this.active.values()].filter(a=>a.mission===m.id).length<m.limits.concurrency){
    const running=m.tasks.filter(t=>ACTIVE.has(t.status));
    const candidate=m.tasks.find(t=>t.status==='pending'&&t.dependsOn.every(id=>this.task(m,id).status==='completed')&&!running.some(r=>overlapping(t.files,r.files)));
    if(!candidate)break;
    if(!candidate.commit&&!candidate.commitIntent&&!candidate.workerReceipt&&(m.turnsUsed>=m.limits.maxTurns||!candidate.sessionHandle&&m.sessionsUsed>=m.limits.maxSessions)){m.status='attention';this.event(m,'The budget is exhausted. No more turns or sessions will be opened.');this.save();break;}
    await this.launch(m,candidate);
   }
   if(m.status==='running'&&!m.tasks.some(t=>ACTIVE.has(t.status))&&m.tasks.some(t=>t.status==='attention')){m.status='attention';this.event(m,'Some tasks need attention. Review the evidence and retry explicitly.');this.save();}
  }
 });}
 expire(m){m.status='attention';m.deadlineReached=true;for(const a of this.active.values())if(a.mission===m.id)a.controller.abort();this.event(m,'The deadline was reached. Work is preserved; extend the deadline to continue without resetting the budget.');}
 async launch(m,t){
  if(t.commit||t.commitIntent||t.workerReceipt){this.launchRecovery(m,t);return;}
  const key=`${m.id}/${t.id}`,controller=new AbortController(),folder=path.join(this.artifacts,m.id,'tasks',t.id);
  // Persist reservations before any launch. A crash spends the reservation once.
  m.turnsUsed++;t.turnsUsed++;t.attempts++;if(!t.sessionHandle){m.sessionsUsed++;t.sessionsUsed++;}
  t.status='running';t.startedAt=this.now();t.checksPassed=false;t.deadline=Math.min(m.deadline,t.nextDeadline??t.startedAt+m.limits.taskMinutes*60000);delete t.nextDeadline;t.deadlineReached=false;
  t.worktree??=path.join(folder,'worktree');t.branch??=`relay/${m.id}/${t.id}`;t.logFile=path.join(folder,'transcript.log');fs.mkdirSync(folder,{recursive:true});
  this.active.set(key,{mission:m.id,task:t.id,controller});this.event(m,`Turn ${t.turnsUsed}: ${t.title} (${t.provider}, ${t.effort}).`,t);this.save();
  try{
   if(!fs.existsSync(t.worktree))await this.git(m.project,['worktree','add','-b',t.branch,t.worktree,(await this.git(m.integrationPath,['rev-parse','HEAD'])).trim()],{signal:controller.signal});
   t.baseHead??=(await this.git(t.worktree,['rev-parse','HEAD'])).trim();
   // A worker cannot commit behind the coordinator or hide earlier changes in a retry.
   if((await this.git(t.worktree,['rev-parse','HEAD'])).trim()!==t.baseHead)throw fail('The worker modified Git history. Review the worktree before continuing.','worker-commit',409);
   const promptFile=path.join(folder,`turn-${t.turnsUsed}.md`),outputFile=path.join(folder,`turn-${t.turnsUsed}.output.jsonl`);
   t.promptFile=promptFile;
   fs.writeFileSync(promptFile,this.brief(m,t),{flag:'wx',mode:0o600});this.save();
   const promise=this.execute(m,t,{controller,promptFile,outputFile});this.active.get(key).promise=promise;
   promise.finally(()=>{this.active.delete(key);if(!this.closed)this.tick().catch(()=>{});}).catch(()=>{});
  }catch(e){this.active.delete(key);t.status='attention';this.event(m,`${t.title} was not launched: ${e.message}`,t);this.save();}
 }
 brief(m,t){return `# Agent Relay mission worker\n\nMission: ${m.id}\nTask: ${t.id} — ${t.title}\nOriginal project: ${m.project}\nYour isolated worktree: ${t.worktree}\nDeadline: ${new Date(t.deadline).toISOString()}\n\nWrite generated reports and explanations in English. Preserve literal user requirements and identifiers in their original form. Read applicable AGENTS.md and existing code before edits. Treat these mission boundaries as the user's explicit instructions for this turn. Work ONLY in your isolated worktree and ONLY in these declared file scopes: ${JSON.stringify(t.files)}. A trailing / permits that directory's descendants. Never change the original project or another task's worktree. Never delete existing files/resources, install dependencies, change secrets or external settings, publish/deploy, or make Git commits/merges/checkout/reset/clean. The coordinator stages exact approved files and commits after checks.\n\nNO delegation: no subagents, Task/Agent/spawn_agent/followup_task tools, other providers, model CLIs, ai-chat/ai-loop, relay plan/create/start, or worker orchestration. No external spending. Provider/tool recursion is forbidden, including launching it from Bash, scripts, or wrappers. If new authority, credentials, deletion, spending or inaccessible dependencies are required, return STATUS: BLOCKED with the reason. Make routine technical decisions autonomously within the fixed scope. Do not wait for native question tools.\n\n## Fixed mission goal\n${m.goal}\n\n## Your assignment\n${t.prompt}\n\n## Dependencies already integrated\n${t.dependsOn.map(id=>`${id}: ${this.task(m,id).detail}`).join('\n')||'None.'}\n\n## Required verification commands (argument arrays)\n${JSON.stringify(t.checks,null,2)}\n\n${t.followup?`## User follow-up for this retry\n${t.followup}\n\n`:''}Implement, run the required checks, and inspect the actual diff. Do not claim universal correctness. Explain changed files, verification evidence and remaining limitations. Finish with exactly one last line: STATUS: OK, or STATUS: BLOCKED — reason. A reported success is independently checked by the coordinator before integration.\n`;}
 async execute(m,t,{controller,promptFile,outputFile}){
  const timer=setTimeout(()=>controller.abort(),Math.max(1,t.deadline-this.now()));timer.unref();
  try{
   await this.prepareDependencies(m,t.worktree,t,controller.signal,t.deadline,t.files);
   if(!this.runner){const module=await import('./mission-runner.mjs');this.runner=module.createMissionRunner();}
   const result=await this.runner({provider:t.provider,model:t.model,effort:t.effort,cwd:t.worktree,promptFile,outputFile,sessionHandle:t.sessionHandle||undefined,timeoutMs:Math.max(1,t.deadline-this.now()),signal:controller.signal,onOutput:(chunk,channel,metadata)=>{if(channel==='metadata'&&metadata){this.serial(()=>{if(/^(codex|claude)-[a-f0-9]{6}$/.test(metadata.sessionHandle??'')&&metadata.sessionHandle.startsWith(t.provider+'-'))t.sessionHandle=metadata.sessionHandle;if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(metadata.nativeId??''))t.nativeId=metadata.nativeId;this.save();}).catch(()=>{});}else this.append(t,chunk);},role:'worker'});
   await this.serial(()=>{if(result.sessionHandle)t.sessionHandle=result.sessionHandle;if(result.nativeId)t.nativeId=result.nativeId;this.append(t,`\n\n[Final answer]\n${result.answer??''}\n`);if(result.exitCode===0&&String(result.answer??'').trim().split(/\r?\n/).at(-1)==='STATUS: OK'){t.workerReceipt={at:this.now(),answerHash:digest(result.answer)};this.save();}if(controller.signal.aborted||['stopped','expired'].includes(m.status))throw fail('Task stopped.','aborted',409);this.assertDeadline(m,t);if(!t.workerReceipt)throw fail('The worker did not finish with exit code 0 and STATUS: OK. Review its response.','worker-result',409);t.status='checking';this.event(m,`Verifying ${t.title}: scope, deletions and tests.`,t);this.save();});
   await this.verifyTask(m,t,controller.signal);
   if(controller.signal.aborted||['stopped','expired'].includes(m.status))throw fail('Task stopped before checking the index.','aborted',409);
   this.assertDeadline(m,t);
   await this.commitCandidate(m,t,controller);
   await this.serial(async()=>{
    if(controller.signal.aborted||['stopped','expired'].includes(m.status))throw fail('Task stopped before integration.','aborted',409);
    this.assertDeadline(m,t);
    if(t.commit)await this.git(m.integrationPath,['merge','--no-edit',t.branch],{signal:controller.signal});
    t.status='completed';t.checksPassed=true;t.completedAt=this.now();this.event(m,`${t.title}: checks passed and integrated.`,t);this.save();
   });
  }catch(e){await this.serial(()=>{t.status='attention';t.checksPassed=false;t.deadlineReached=this.now()>=t.deadline;if(this.now()>=m.deadline&&m.status!=='stopped')this.expire(m);this.event(m,`${t.title}: ${e.message}`,t);if(!['stopped','paused'].includes(m.status)&&!m.tasks.some(other=>other.id!==t.id&&(ACTIVE.has(other.status)||other.status==='pending'&&other.dependsOn.every(id=>this.task(m,id).status==='completed'))))m.status='attention';this.save();});}finally{clearTimeout(timer);}
 }
 async commitCandidate(m,t,controller){
  const files=await this.changed(t);if(!files.length)return;
  // A rejected earlier attempt may have left files staged that the retry deleted; restage from the base.
  await this.git(t.worktree,['reset','-q','--mixed',t.baseHead],{signal:controller.signal});
  await this.git(t.worktree,['add','--',...files],{signal:controller.signal});
  const approvedTree=(await this.git(t.worktree,['write-tree'])).trim();await this.runGates(t,controller.signal);this.assertDeadline(m,t);await this.changed(t);
  if((await this.git(t.worktree,['write-tree'])).trim()!==approvedTree||(await this.git(t.worktree,['diff','--name-only','--'])).trim())throw fail('A guard modified files after verification. No commit was created.','gate-mutated',409);
  await this.serial(()=>{if(controller.signal.aborted||['stopped','expired'].includes(m.status))throw fail('Task stopped before commit.','aborted',409);t.commitIntent={tree:approvedTree,base:t.baseHead,at:this.now()};this.save();});
  await this.git(t.worktree,['-c','user.name=Agent Relay','-c','user.email=agent-relay@localhost','commit','-m',`Implement Agent Relay task ${t.id}`],{signal:controller.signal,timeoutMs:120000});
  const commit=(await this.git(t.worktree,['rev-parse','HEAD'])).trim();await this.serial(()=>{t.commit=commit;this.save();});
 }
 launchRecovery(m,t){
  const key=`${m.id}/${t.id}`,controller=new AbortController();this.active.set(key,{mission:m.id,task:t.id,controller});t.status='checking';t.attempts++;t.startedAt=this.now();t.deadline=Math.min(m.deadline,t.nextDeadline??t.startedAt+m.limits.taskMinutes*60000);delete t.nextDeadline;t.deadlineReached=false;this.event(m,`Revalidating the retained candidate for ${t.title}. No new chat or turn is opened.`,t);this.save();
  const promise=this.recoverCandidate(m,t,controller);this.active.get(key).promise=promise;promise.finally(()=>{this.active.delete(key);if(!this.closed)this.tick().catch(()=>{});}).catch(()=>{});
 }
 async recoverCandidate(m,t,controller){
  const timer=setTimeout(()=>controller.abort(),Math.max(1,t.deadline-this.now()));timer.unref();
  try{
   const head=(await this.git(t.worktree,['rev-parse','HEAD'])).trim();
   if(t.commit&&head!==t.commit)throw fail('The candidate revision changed. An unknown version will not be integrated.','candidate-changed',409);
   if(head!==t.baseHead){
    if(!t.commit&&!t.commitIntent)throw fail('The worker created an unauthorized commit. It will not be recovered as a coordinator commit.','worker-commit',409);
    const tree=(await this.git(t.worktree,['rev-parse','HEAD^{tree}'])).trim(),parents=(await this.git(t.worktree,['rev-list','--parents','-n','1','HEAD'])).trim().split(' ');
    if(t.commitIntent&&(tree!==t.commitIntent.tree||parents.length!==2||parents[1]!==t.commitIntent.base))throw fail('The commit does not match the coordinator durable intent.','candidate-changed',409);
    if((await this.git(t.worktree,['status','--porcelain=v1','--untracked-files=all'])).trim())throw fail('The committed candidate has additional changes. They are preserved for review.','dirty-candidate',409);
    await this.serial(()=>{t.commit=head;this.save();});await this.verifyTask(m,t,controller.signal,head);
    if((await this.git(t.worktree,['status','--porcelain=v1','--untracked-files=all'])).trim())throw fail('Verification modified the committed candidate.','dirty-candidate',409);
   }else{await this.verifyTask(m,t,controller.signal);await this.commitCandidate(m,t,controller);}
   await this.serial(async()=>{
    if(controller.signal.aborted||['stopped','expired'].includes(m.status))throw fail('Recovery stopped.','aborted',409);this.assertDeadline(m,t);
    if((await this.git(m.integrationPath,['status','--porcelain=v1','--untracked-files=all'])).trim())throw fail('Integration retains conflicts or pending changes. Resolve them and confirm the merge before retrying; nothing was discarded.','dirty-integration',409);
    if(t.commit)await this.git(m.integrationPath,['merge','--no-edit',t.branch],{signal:controller.signal});
    t.status='completed';t.checksPassed=true;t.completedAt=this.now();this.event(m,`${t.title}: candidate revalidated and integrated without spending another turn.`,t);this.save();
   });
  }catch(e){await this.serial(()=>{t.status='attention';t.checksPassed=false;t.deadlineReached=this.now()>=t.deadline;if(this.now()>=m.deadline&&m.status!=='stopped')this.expire(m);if(!['stopped','paused'].includes(m.status)&&!m.tasks.some(other=>other.id!==t.id&&(ACTIVE.has(other.status)||other.status==='pending'&&other.dependsOn.every(id=>this.task(m,id).status==='completed'))))m.status='attention';this.event(m,`${t.title}: ${e.message}`,t);this.save();});}finally{clearTimeout(timer);}
 }
 assertDeadline(m,t){if(this.now()>=Math.min(m.deadline,t?.deadline??m.deadline))throw fail('The original deadline was reached before verification completed.','timeout',409);}
 async captureDependencies(m){
  const root=m.baseline?.path??m.project,head=m.baseline?.head??m.originalHead;
  const names=(await this.git(root,['ls-files','-z','--','package-lock.json',':(glob)**/package-lock.json'])).split('\0').filter(Boolean),baselines=[];
  for(const lock of names){
   const directory=path.posix.dirname(lock)==='.'?'':path.posix.dirname(lock),prefix=directory?directory+'/':'';
   if(directory&&!m.tasks.some(t=>overlapping(t.files,[prefix])))continue;
   const manifest=prefix+'package.json';
   try{
    const lockValue=JSON.parse(await this.git(root,['show',`${head}:${lock}`],{maxBytes:16*1024*1024}));
    const manifestValue=JSON.parse(await this.git(root,['show',`${head}:${manifest}`]));
    localDependencies(m.project,path.join(m.project,directory),manifestValue);
    const sources=Object.keys(lockValue.packages??{}).filter(key=>key&&!key.split('/').includes('node_modules'));
    if(sources.length>256)throw fail('The lockfile exceeds the limit of 256 local manifests.','dependencies',409);
    const localManifests=[];
    for(const source of sources){
     if(path.isAbsolute(source)||source.split('/').some(p=>!p||p==='.'||p==='..'))throw fail('Invalid local lockfile path.','dependencies',409);
     const file=prefix+source+'/package.json',value=JSON.parse(await this.git(root,['show',`${head}:${file}`]));
     localDependencies(m.project,path.dirname(path.join(m.project,file)),value);localManifests.push({file,hash:digest(dependencyFields(value))});
    }
    baselines.push({directory,lockHash:digest(lockValue),manifestHash:digest(dependencyFields(manifestValue)),localManifests});
   }catch(e){if(e.code==='dependencies')throw e;throw fail(`The tracked npm manifest and lockfile could not be verified in ${directory||'the root'}.`,'dependencies',409);}
  }
  if(baselines.length>12)throw fail('The plan spans more than 12 npm packages. Split its scopes to keep preparation bounded.','dependencies',409);
  return baselines;
 }
 async prepareDependencies(m,worktree,target,signal,deadline,scopes){
  const baselines=(m.dependencyBaselines??[]).filter(b=>!b.directory||overlapping(scopes,[b.directory+'/']));
  target.provisionedDirectories??=[];
  if(!baselines.length){if(fs.existsSync(path.join(worktree,'package.json')))this.append(target,'\n[Dependencies] No tracked npm lockfile is available. Automatic restore is skipped; checks must use existing project tooling.\n');return;}
  for(const baseline of baselines){
   if(signal?.aborted)throw fail('Preparation canceled.','aborted',409);
   if(this.now()>=deadline)throw fail('Preparation reached the original deadline.','timeout',409);
   const cwd=path.join(worktree,baseline.directory),lock=path.join(cwd,'package-lock.json'),manifest=path.join(cwd,'package.json');
   this.checkPath(worktree,(baseline.directory?baseline.directory+'/':'')+'package.json');this.checkPath(worktree,(baseline.directory?baseline.directory+'/':'')+'package-lock.json');
   let currentLock,currentManifest;try{currentLock=JSON.parse(fs.readFileSync(lock,'utf8'));currentManifest=JSON.parse(fs.readFileSync(manifest,'utf8'));}catch{throw fail('A valid npm manifest or lockfile is missing from the worktree.','dependencies',409);}
   if(digest(currentLock)!==baseline.lockHash||digest(dependencyFields(currentManifest))!==baseline.manifestHash)throw fail('Dependencies changed from the initial lockfile. New packages will not be installed automatically.','dependency-change',409);
   for(const source of baseline.localManifests??[]){this.checkPath(worktree,source.file);let value;try{value=JSON.parse(fs.readFileSync(path.join(worktree,source.file),'utf8'));}catch{throw fail('A local manifest is no longer available.','dependencies',409);}if(digest(dependencyFields(value))!==source.hash)throw fail('A workspace or local package dependencies changed from the initial plan.','dependency-change',409);localDependencies(worktree,path.dirname(path.join(worktree,source.file)),value);}
   localDependencies(worktree,cwd,currentManifest);
   if(target.provisionedDirectories.includes(baseline.directory)&&fs.existsSync(path.join(cwd,'node_modules')))continue;
   if(fs.existsSync(path.join(cwd,'node_modules')))throw fail('node_modules already exists without confirmed preparation. Review the worktree; it will not be deleted for a retry.','dependencies',409);
   this.append(target,`\n[Dependencies] Restoring original pinned npm dependencies in ${baseline.directory||'.'} with lifecycle scripts disabled.\n`);
   const command=['npm','ci','--ignore-scripts','--no-audit','--no-fund','--prefer-offline'];
   const result=await run(command,{cwd,signal,timeoutMs:Math.min(180000,Math.max(1,deadline-this.now())),onOutput:chunk=>this.append(target,chunk)});
   this.append(target,`\n[Dependencies exit] ${result.exitCode}\n`);
   if(result.exitCode!==0)throw fail('Isolated npm ci failed. Original project node_modules was not modified.','dependencies',409);
   if(digest(JSON.parse(fs.readFileSync(lock,'utf8')))!==baseline.lockHash||digest(dependencyFields(JSON.parse(fs.readFileSync(manifest,'utf8'))))!==baseline.manifestHash)throw fail('Preparation modified the lockfile or manifest.','dependency-change',409);
   target.provisionedDirectories.push(baseline.directory);await this.serial(()=>this.save());
  }
 }
 async changed(t,expectedHead=t.baseHead){
  if((await this.git(t.worktree,['rev-parse','HEAD'])).trim()!==expectedHead)throw fail('The worker created commits without coordinator authorization.','worker-commit',409);
  const changed=(await this.git(t.worktree,['diff','--name-status','-z','--no-renames',t.baseHead,'--'])).split('\0'),files=[];
  if(changed.at(-1)==='')changed.pop();
  for(let i=0;i<changed.length;i+=2){const status=changed[i],file=changed[i+1];if(!file||!/^[AMT]$/.test(status))throw fail('Deletions, renames and special Git changes are not allowed.','deletion',409);files.push(file);}
  const untracked=(await this.git(t.worktree,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);files.push(...untracked);
  for(const file of files){if(!allowed(file,t.files)||SECRET.test(file))throw fail(`Change outside scope or protected file: ${file}.`,'scope',409);this.checkPath(t.worktree,file);if(!fs.lstatSync(path.join(t.worktree,file)).isFile())throw fail('Only regular files can be integrated.','file-type',409);}
  return [...new Set(files)];
 }
 async verifyTask(m,t,signal,expectedHead=t.baseHead){
  await this.changed(t,expectedHead);
  for(const [index,command] of t.checks.entries()){
   this.assertDeadline(m,t);
   this.append(t,`\n[Check] ${JSON.stringify(command)}\n`);
   const result=await run(command,{cwd:t.worktree,signal,timeoutMs:verificationTimeout(Math.min(t.deadline,m.deadline)-this.now(),t.checkTimeoutsMs?.[index],120000),onOutput:chunk=>this.append(t,chunk)});
   this.append(t,`\n[Check exit] ${result.exitCode}\n`);
   if(result.exitCode!==0)throw fail(`A check failed (exit ${result.exitCode}): ${JSON.stringify(command)}.`,'check-failed',409);
  }
  await this.changed(t,expectedHead);
 }
 async runGates(t,signal){
  if(this.gate){await this.gate({cwd:t.worktree,signal});return;}
  const scan=path.join(TOOLING,'staged-secret-scan.mjs'),guard=path.join(TOOLING,'change-guard.mjs'),scanner=process.env.CHATS_SECRET_SCANNER || path.join(TOOLING,'trufflehog-bin',process.platform==='win32'?'trufflehog.exe':'trufflehog');
  const commands=[];
  if(![scan,guard,scanner].every(file=>fs.existsSync(file)))throw fail('The secret scanner or change-guard is missing. No commit will be created without both guards.','gate-missing',409);
  commands.push([process.execPath,scan,'--repo',t.worktree,'--scanner',scanner],[process.execPath,guard,'--repo',t.worktree]);
  for(const command of commands){const result=await run(command,{cwd:t.worktree,signal,timeoutMs:180000,onOutput:chunk=>this.append(t,chunk)});if(result.exitCode!==0)throw fail('The secret scanner or change-guard rejected the index. No commit was created.','gate-failed',409);}
 }
 async runClosureGate(m,signal){
  this.writeContract(m,true);
  if(this.gate){await this.gate({cwd:m.integrationPath,signal,requirements:m.requirementsFile,role:'closure'});return;}
  const guard=path.join(TOOLING,'change-guard.mjs');if(!fs.existsSync(guard))throw fail('change-guard is missing; closure cannot be verified.','gate-missing',409);
  const r=await run([process.execPath,guard,'--repo',m.integrationPath,'--requirements',m.requirementsFile],{cwd:m.integrationPath,signal,timeoutMs:120000,onOutput:chunk=>this.append({logFile:m.integrationLog},chunk)});
  if(r.exitCode!==0)throw fail('change-guard rejected the requirements contract. The mission is not ready.','closure-gate',409);
 }
 launchFinal(m){
  if(this.active.size>=GLOBAL_PROCESSES)return;
  const key=`${m.id}/@integration`,controller=new AbortController();this.active.set(key,{mission:m.id,task:'@integration',controller});
  const timer=setTimeout(()=>controller.abort(),Math.max(1,m.deadline-this.now()));timer.unref();
  m.integrationLog??=path.join(this.artifacts,m.id,'integration-checks.log');
  this.event(m,'All tasks are integrated. Running final checks.');this.save();
  const promise=(async()=>{try{
   await this.prepareDependencies(m,m.integrationPath,{get provisionedDirectories(){return m.provisionedDirectories;},set provisionedDirectories(value){m.provisionedDirectories=value;},logFile:m.integrationLog},controller.signal,m.deadline,m.tasks.flatMap(t=>t.files));
   for(const {command,timeoutMs} of this.integrationChecks(m)){this.assertDeadline(m);this.append({logFile:m.integrationLog},`\n[Integration check] ${JSON.stringify(command)}\n`);const r=await run(command,{cwd:m.integrationPath,signal:controller.signal,timeoutMs:verificationTimeout(m.deadline-this.now(),timeoutMs,180000),onOutput:chunk=>this.append({logFile:m.integrationLog},chunk)});this.append({logFile:m.integrationLog},`\n[Check exit] ${r.exitCode}\n`);if(r.exitCode!==0)throw fail(`Final verification failed: ${JSON.stringify(command)}.`,'check-failed',409);}
   await this.serial(async()=>{if(controller.signal.aborted||['stopped','expired'].includes(m.status))return;this.assertDeadline(m);if((await this.git(m.integrationPath,['status','--porcelain=v1','--untracked-files=all'])).trim())throw fail('Final verification left integration changes. Review the worktree.','dirty-integration',409);const head=(await this.git(m.integrationPath,['rev-parse','HEAD'])).trim();await this.runClosureGate(m,controller.signal);this.assertDeadline(m);if((await this.git(m.integrationPath,['rev-parse','HEAD'])).trim()!==head||(await this.git(m.integrationPath,['status','--porcelain=v1','--untracked-files=all'])).trim())throw fail('The closure guard modified the candidate.','gate-mutated',409);m.verifiedHead=head;m.status='ready';m.finalChecksPassed=true;this.event(m,'Mission verified. Ready to apply to the original branch.');this.save();});
  }catch(e){await this.serial(()=>{if(m.status!=='stopped'){if(this.now()>=m.deadline)this.expire(m);else m.status='attention';}m.finalChecksPassed=false;this.event(m,`Integration: ${e.message}`);this.save();});}finally{clearTimeout(timer);}})();
  this.active.get(key).promise=promise;promise.finally(()=>{this.active.delete(key);if(!this.closed)this.tick().catch(()=>{});}).catch(()=>{});
 }
 integrationChecks(m){const entries=[...m.tasks,m].flatMap(owner=>owner.checks.map((command,index)=>({command,timeoutMs:owner.checkTimeoutsMs?.[index]??null})));return [...new Map(entries.map(check=>[JSON.stringify(check),check])).values()];}
 async missionDelta(m,options={}){
  const fields=(await this.git(m.integrationPath,['diff','--name-status','-z','--no-renames',m.baseline?.head??m.originalHead,'HEAD','--'],options)).split('\0').filter(Boolean),files=[];
  for(let i=0;i<fields.length;i+=2){const status=fields[i],name=fields[i+1];if(!name||!/^[AMT]$/.test(status))throw fail('Delivery does not permit deleting, renaming or modifying special Git files.','deletion',409);
   if(!allowed(name,m.tasks.flatMap(t=>t.files)))throw fail('Integration contains a change outside the contract.','scope',409);this.checkPath(m.integrationPath,name);if(!fs.statSync(path.join(m.integrationPath,name)).isFile())throw fail('Delivery supports only regular files.','file-type',409);
   files.push({name,afterHash:fileHash(path.join(m.integrationPath,name)),mode:fs.statSync(path.join(m.integrationPath,name)).mode&0o777});
  }return files;
 }
 async applyOwnedDelta(m,files,remaining,options){
  const original=new Map(m.baseline.source.entries.map(entry=>[entry.name,entry]));
  let transaction=m.applyTransaction;
  if(!transaction||transaction.phase!=='applying'){
   const directory=path.join(this.artifacts,m.id,'apply',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
   transaction={phase:'applying',at:this.now(),directory,files:files.map((file,index)=>({...file,beforeHash:original.get(file.name)?.hash??null,beforeMode:original.get(file.name)?.mode??null,backup:path.join(directory,index+'.before'),status:'pending'}))};
   // Check every target and save private copies before the first write.
   for(const file of transaction.files){regularSource(m.project,file.name,true);const target=path.join(m.project,file.name),hash=fs.existsSync(target)?fileHash(target):null;if(hash!==file.beforeHash)throw fail('A file changed before applying. Nothing was written.','project-changed',409);if(hash!==null){fs.copyFileSync(target,file.backup);if(process.platform!=='win32')fs.chmodSync(file.backup,0o600);}}
   m.applyTransaction=transaction;atomic(path.join(directory,'transaction.json'),transaction);this.save();
  }else if(digest(transaction.files.map(({name,afterHash,mode})=>({name,afterHash,mode})))!==digest(files))throw fail('The candidate changed after an interrupted delivery.','integration-changed',409);
  try{
   await this.assertOriginal(m,options);
   for(const file of transaction.files){remaining();regularSource(m.project,file.name,true);const target=path.join(m.project,file.name),hash=fs.existsSync(target)?fileHash(target):null;
    if(hash===file.afterHash){file.status='written';continue;}if(hash!==file.beforeHash)throw fail('A file changed during delivery. The copy and backup were preserved.','project-race',409);
    const source=path.join(m.integrationPath,file.name);regularSource(m.integrationPath,file.name);if(fileHash(source)!==file.afterHash)throw fail('The candidate changed during delivery.','integration-changed',409);
    fs.mkdirSync(path.dirname(target),{recursive:true});regularSource(m.project,file.name,true);
    if(file.beforeHash===null){const fd=fs.openSync(target,'wx',file.mode);try{fs.writeFileSync(fd,fs.readFileSync(source));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    else{const temp=target+'.relay-'+crypto.randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',file.beforeMode);try{fs.writeFileSync(fd,fs.readFileSync(source));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(fileHash(target)!==file.beforeHash)throw fail('A file changed before replacement. The temporary file was preserved.','project-race',409);fs.renameSync(temp,target);}
    file.status='written';atomic(path.join(transaction.directory,'transaction.json'),transaction);this.save();
   }
   const final=await this.assertOriginal(m,options);for(const file of transaction.files)if(fileHash(path.join(m.project,file.name))!==file.afterHash)throw fail('Delivery does not match the verified version.','apply',409);
   if(final.indexHash!==m.baseline.source.indexHash)throw fail('The original index changed during delivery.','project-race',409);
   // The mission status and applied transaction are saved together by apply(). A
   // crash here leaves the durable state as "applying", which can verify/resume.
   transaction.phase='applied';atomic(path.join(transaction.directory,'transaction.json'),transaction);
  }catch(error){
   // Restore only files still matching our exact write. Concurrent user edits are kept.
   let restored=true;for(const file of transaction.files){const target=path.join(m.project,file.name);try{regularSource(m.project,file.name,true);const hash=fs.existsSync(target)?fileHash(target):null;if(hash===file.beforeHash)continue;if(hash!==file.afterHash){restored=false;continue;}if(file.beforeHash===null)fs.unlinkSync(target);else{if(!fs.existsSync(file.backup)||fileHash(file.backup)!==file.beforeHash){restored=false;continue;}fs.copyFileSync(file.backup,target);if(process.platform!=='win32')fs.chmodSync(target,file.beforeMode);}file.status='restored';}catch{restored=false;}}
   transaction.phase=restored?'rolled-back':'applying';transaction.detail=error.message;atomic(path.join(transaction.directory,'transaction.json'),transaction);this.save();throw error;
  }
 }
 async apply(id){return this.serial(async()=>{
  const m=this.mission(id);if(m.status!=='ready'||!m.finalChecksPassed||m.tasks.some(t=>t.status!=='completed'||!t.checksPassed))throw fail('Only a mission with all checks passed can be applied.','state',409);
  this.capacity(m);if(this.active.size>=GLOBAL_PROCESSES)throw fail('All four processes are occupied. Apply when a slot is available.','process-limit',409);
  // Applying is a separate explicit operation, including next-day applications.
  const controller=new AbortController(),deadline=this.now()+this.applyTimeoutMs,timer=setTimeout(()=>controller.abort(),this.applyTimeoutMs);timer.unref();
  const options={signal:controller.signal},remaining=()=>{if(controller.signal.aborted||this.now()>=deadline)throw fail('The apply operation reached its total deadline.','apply-timeout',409);return deadline-this.now();};
  let integrationHead,mergeAttempted=false;
  try{
  await this.assertOriginal(m,options);
  integrationHead=(await this.git(m.integrationPath,['rev-parse','HEAD'],options)).trim();
  if(integrationHead!==m.verifiedHead)throw fail('The integration revision changed after verification.','integration-changed',409);
  if((await this.git(m.integrationPath,['status','--porcelain=v1','--untracked-files=all'],options)).trim())throw fail('The integration worktree has changes after testing.','dirty-integration',409);
  // Re-run final checks immediately before applying. No merge if the candidate changed.
  for(const {command,timeoutMs} of this.integrationChecks(m)){this.append({logFile:m.integrationLog},`\n[Apply check] ${JSON.stringify(command)}\n`);const r=await run(command,{cwd:m.integrationPath,signal:controller.signal,timeoutMs:verificationTimeout(remaining(),timeoutMs,180000),onOutput:chunk=>this.append({logFile:m.integrationLog},chunk)});this.append({logFile:m.integrationLog},`\n[Check exit] ${r.exitCode}\n`);if(r.exitCode!==0)throw fail('Final verification before applying failed.','check-failed',409);}
  if((await this.git(m.integrationPath,['rev-parse','HEAD'],options)).trim()!==integrationHead||(await this.git(m.integrationPath,['status','--porcelain=v1','--untracked-files=all'],options)).trim())throw fail('Verification modified the candidate.','dirty-integration',409);
  remaining();await this.runClosureGate(m,controller.signal);
  if((await this.git(m.integrationPath,['rev-parse','HEAD'],options)).trim()!==integrationHead||(await this.git(m.integrationPath,['status','--porcelain=v1','--untracked-files=all'],options)).trim())throw fail('The closure guard modified the candidate.','gate-mutated',409);
  await this.assertOriginal(m,options);const files=await this.missionDelta(m,options);
  remaining();if(m.baseline?.source.dirty)await this.applyOwnedDelta(m,files,remaining,options);else{mergeAttempted=true;await this.git(m.project,['merge','--ff-only',m.integrationBranch],options);
   if((await this.git(m.project,['rev-parse','HEAD'],options)).trim()!==integrationHead)throw fail('The applied revision was not confirmed.','apply',409);}
  m.status='applied';m.appliedAt=this.now();this.event(m,m.baseline?.source.dirty?'Verified changes applied to your files. Your branch, HEAD and index were preserved; previous work remains uncommitted.':'Integration applied and original revision verified. Worktrees are preserved.');this.save();return this.view(m);
  }catch(e){
   // A timeout never proves a Git write failed. Confirm before reporting it as unapplied.
   if(mergeAttempted&&integrationHead)try{const head=(await this.git(m.project,['rev-parse','HEAD'],{timeoutMs:10000})).trim(),branch=(await this.git(m.project,['symbolic-ref','--short','HEAD'],{timeoutMs:10000})).trim();if(head===integrationHead&&branch===m.originalBranch){m.status='applied';m.appliedAt=this.now();this.event(m,'Delivery was interrupted after the merge; the applied revision was verified.');this.save();return this.view(m);}}catch{/* Preserve evidence; do not retry or roll back an uncertain merge. */}
   this.event(m,'Apply not completed: '+e.message);this.save();if(controller.signal.aborted)throw fail('The apply operation reached its total deadline. Review the state before repeating.','apply-timeout',409);throw e;
  }finally{clearTimeout(timer);}
 });}
 async shutdown(){
  await this.serial(()=>{this.closed=true;for(const m of this.jobs)if(m.status==='running'||m.tasks.some(t=>ACTIVE.has(t.status))){m.status='attention';for(const t of m.tasks)if(ACTIVE.has(t.status)){t.status='attention';t.detail='The server closed. Review the evidence before resuming.';}this.event(m,'Coordinator closed. Explicit resume is required.');}for(const a of this.active.values())a.controller.abort();this.save();});
  await Promise.allSettled([...this.active.values()].map(a=>a.promise).filter(Boolean));
 }
}
