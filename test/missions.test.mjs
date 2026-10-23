import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MissionManager,normalizeMissionSpec,captureMissionSource,verificationTimeout} from '../server/missions.mjs';

const node=process.execPath;
const baselineCheck=[node,'-e',"const fs=require('fs');for(const f of ['a.txt','b.txt','shared.txt'])if(!fs.readFileSync(f,'utf8').trim())process.exit(1)"];
const task=(id,patch={})=>({id,title:`Implement ${id}`,prompt:`Implement the explicit ${id} change.`,files:[`${id}.txt`],dependsOn:[],checks:[[node,'-e',`if(!require('fs').readFileSync('${id}.txt','utf8').trim())process.exit(1)`]],...patch});
function git(cwd,args){const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout.trim();}
const success=(patch={})=>({answer:'Verified the actual diff and required checks.\nSTATUS: OK',exitCode:0,sessionHandle:'native-session',nativeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',...patch});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(runner,options={}){
 const downloads=path.join(os.homedir(),'Downloads','agent-work');fs.mkdirSync(downloads,{recursive:true});
 const dir=fs.mkdtempSync(path.join(downloads,'relay-mission-test-')),project=path.join(dir,'project');fs.mkdirSync(project);
 git(project,['init']);git(project,['config','user.name','Relay Tests']);git(project,['config','user.email','relay-tests@localhost']);git(project,['config','core.autocrlf','false']);
 for(const file of ['a.txt','b.txt','shared.txt'])fs.writeFileSync(path.join(project,file),'initial\n');
 git(project,['add','--','a.txt','b.txt','shared.txt']);git(project,['commit','-m','Initial test repository']);
 const calls=[],args={file:path.join(dir,'state.json'),artifacts:path.join(dir,'artifacts'),gate:async()=>{},...options,
  runner:async arg=>{calls.push(arg);return runner?runner(arg,calls.length):success();}};
 const manager=new MissionManager(args);
 const spec=(tasks=[task('a')],patch={})=>({title:'Verified local mission',goal:'Implement only the requested isolated changes.',project,provider:'codex',model:'gpt-6.1-sol',effort:'high',limits:{concurrency:3,maxSessions:16,maxTurns:24,taskMinutes:30,missionMinutes:240},tasks,checks:[baselineCheck],...patch});
 return {dir,project,calls,args,manager,spec,cleanup:async()=>{await manager.shutdown();assert.ok(path.resolve(dir).startsWith(path.resolve(downloads)+path.sep));fs.rmSync(dir,{recursive:true,force:true});}};
}
// These assertions verify dependency order, not a 15 s performance contract.
// A bounded override keeps real-Git fixtures useful on a busy Windows host.
async function until(predicate,message='condition',timeout=Math.min(120000,Math.max(15000,Number(process.env.CHATS_TEST_WAIT_MS)||15000))){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error(`Timed out: ${message}`);await new Promise(resolve=>setTimeout(resolve,15));}}
async function ready(f,id){await until(()=>{const m=f.manager.publicState().find(m=>m.id===id);if(m?.status==='attention')throw new Error(`Mission attention: ${JSON.stringify(m.tasks.map(t=>({id:t.id,status:t.status,detail:t.detail})))}`);return m?.status==='ready';},'mission ready');return f.manager.publicState().find(m=>m.id===id);}
function localNpmFixture(f,directory=''){
 const root=path.join(f.project,directory),vendor=path.join(root,'vendor','relay-fixture');fs.mkdirSync(vendor,{recursive:true});
 const manifest={name:'mission-npm-fixture',version:'1.0.0',private:true,dependencies:{'relay-fixture':'file:vendor/relay-fixture'},scripts:{postinstall:"node -e \"require('fs').writeFileSync('unsafe-script.txt','ran')\""}};
 const lock={name:manifest.name,version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:manifest.name,version:'1.0.0',dependencies:manifest.dependencies},'node_modules/relay-fixture':{resolved:'vendor/relay-fixture',link:true},'vendor/relay-fixture':{name:'relay-fixture',version:'1.0.0'}}};
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify(lock));fs.writeFileSync(path.join(vendor,'package.json'),JSON.stringify({name:'relay-fixture',version:'1.0.0',main:'index.js'}));fs.writeFileSync(path.join(vendor,'index.js'),"module.exports='local-fixture';\n");fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n');
 git(f.project,['add','--',...[ 'package.json','package-lock.json','.gitignore','vendor/relay-fixture/package.json','vendor/relay-fixture/index.js'].map(file=>directory?directory+'/'+file:file)]);git(f.project,['commit','-m','Pinned local npm fixture']);
 fs.mkdirSync(path.join(root,'node_modules'),{recursive:true});fs.writeFileSync(path.join(root,'node_modules','user-sentinel.txt'),'preserve user dependencies');
 return {root,manifest};
}

for(const dirty of [false,true])test(`Next.js source capture and delivery support literal routes (${dirty?'dirty source':'clean fast-forward'})`,async()=>{
 const route='app/[slug]/page.tsx',extra='app/[slug]/draft.tsx',group='app/(marketing)/a.tsx',slot='app/@modal/b.tsx';
 const f=await fixture(async arg=>{
  assert.notEqual(arg.cwd,f.project);
  assert.equal(fs.readFileSync(path.join(arg.cwd,route),'utf8'),dirty?'user route\n':'initial route\n');
  if(dirty)assert.equal(fs.readFileSync(path.join(arg.cwd,extra),'utf8'),'user untracked\n');
  fs.writeFileSync(path.join(arg.cwd,route),'verified route\n');return success();
 });try{
  for(const file of [route,group,slot]){fs.mkdirSync(path.dirname(path.join(f.project,file)),{recursive:true});fs.writeFileSync(path.join(f.project,file),'initial route\n');}
  git(f.project,['add','--',route,group,slot]);git(f.project,['commit','-m','Next.js route fixture']);
  if(dirty){fs.writeFileSync(path.join(f.project,route),'user route\n');fs.writeFileSync(path.join(f.project,extra),'user untracked\n');}
  const head=git(f.project,['rev-parse','HEAD']),indexPath=path.resolve(f.project,git(f.project,['rev-parse','--git-path','index'])),index=fs.readFileSync(indexPath);
  const check=[node,'-e',`if(require('fs').readFileSync(${JSON.stringify(route)},'utf8')!=='verified route\\n')process.exit(1)`];
  // An ordinary declared scope isolates the original failure in source capture.
  const draft=await f.manager.create(f.spec());assert.equal(draft.status,'draft');await f.manager.stop(draft.id);
  const m=await f.manager.create(f.spec([task('route',{files:[route,group,slot],checks:[check]})],{checks:[check]}));
  assert.equal(m.baselineDirty,dirty);assert.equal(f.calls.length,0);await f.manager.start(m.id);await ready(f,m.id);
  const internal=f.manager.jobs.find(job=>job.id===m.id),candidate=internal.tasks[0];assert.ok(candidate.commit);
  assert.equal(git(candidate.worktree,['show',`${candidate.commit}:${route}`]),'verified route');
  assert.equal(git(internal.integrationPath,['show',`HEAD:${route}`]),'verified route');
  assert.equal(fs.readFileSync(path.join(f.project,route),'utf8'),dirty?'user route\n':'initial route\n');
  await f.manager.apply(m.id);assert.equal(fs.readFileSync(path.join(f.project,route),'utf8'),'verified route\n');
  for(const file of [group,slot])assert.equal(fs.readFileSync(path.join(f.project,file),'utf8'),'initial route\n');
  if(dirty){assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(fs.readFileSync(path.join(f.project,extra),'utf8'),'user untracked\n');}
  else{assert.equal(git(f.project,['rev-parse','HEAD']),internal.verifiedHead);assert.equal(git(f.project,['status','--porcelain']),'');}
 }finally{await f.cleanup();}
});

test('Next.js scopes stay literal and retain protected-path, wildcard and containment guards',async()=>{
 const f=await fixture(async arg=>{fs.mkdirSync(path.join(arg.cwd,'app','s'),{recursive:true});fs.writeFileSync(path.join(arg.cwd,'app','s','page.tsx'),'outside literal scope');return success();});try{
  for(const file of ['app/[slug]/page.tsx','app/(group)/page.tsx','app/@slot/page.tsx'])assert.deepEqual(normalizeMissionSpec(f.spec([task('a',{files:[file]})])).tasks[0].files,[file]);
  for(const file of ['app/*/page.tsx','app/?/page.tsx','app/[slug]/../page.tsx','app/[slug]/.git/config','app/[slug]/.env.local','app/[slug]/keys.json','app/[slug]/private.key','app/[slug]/secret.txt','app/\x7f/page.tsx'])assert.throws(()=>normalizeMissionSpec(f.spec([task('a',{files:[file]})])));
  const m=await f.manager.create(f.spec([task('a',{files:['app/[slug]/page.tsx']})]));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','literal bracket scope refuses a different directory');assert.match(f.manager.publicState()[0].detail,/outside scope/);
  fs.mkdirSync(path.join(f.project,'app','[slug]'),{recursive:true});fs.writeFileSync(path.join(f.project,'app','[slug]','.env.local'),'protected fixture\n');
  await assert.rejects(f.manager.create(f.spec()),{code:'protected-source'});assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});

test('source capture accepts actual Git filenames independently of task scope syntax and refuses linked paths',async()=>{
 const f=await fixture();try{
  const files=process.platform==='win32'?['app/[...slug]/long-name.tsx']:['app/[...slug]/real:*?.tsx','a:b'];
  for(const file of files){fs.mkdirSync(path.dirname(path.join(f.project,file)),{recursive:true});fs.writeFileSync(path.join(f.project,file),'literal source\n');}
  const source=await captureMissionSource(f.project,f.args.artifacts);for(const file of files)assert.ok(source.entries.some(entry=>entry.name===file));
  const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'page.tsx'),'outside\n');fs.symlinkSync(outside,path.join(f.project,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(captureMissionSource(f.project,f.args.artifacts),{code:'symlink'});
  await assert.rejects(f.manager.create(f.spec([task('a',{files:['linked/page.tsx']})])),{code:'symlink'});assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});

test('per-check timeouts validate without changing defaults or mission budgets and retain integration overrides',async()=>{
 const f=await fixture();try{
  const spec=f.spec([task('a',{checkTimeoutsMs:[600000]})],{checkTimeoutsMs:[null]}),normalized=normalizeMissionSpec(spec);
  assert.deepEqual(normalized.tasks[0].checkTimeoutsMs,[600000]);assert.deepEqual(normalized.checkTimeoutsMs,[null]);assert.deepEqual(normalized.limits,normalizeMissionSpec(f.spec()).limits);
  for(const invalid of [[],[0],[-1],[1.5],[43200001],['1000'],[true],[1000,2000],{}]){
   assert.throws(()=>normalizeMissionSpec(f.spec([task('a',{checkTimeoutsMs:invalid})])));
   assert.throws(()=>normalizeMissionSpec(f.spec([task('a')],{checkTimeoutsMs:invalid})));
  }
  assert.equal(verificationTimeout(900000,600000,120000),600000);
  assert.equal(verificationTimeout(50000,600000,120000),50000);
  assert.equal(verificationTimeout(900000,null,120000),120000);
  assert.equal(verificationTimeout(900000,undefined,180000),180000);
  const entries=f.manager.integrationChecks({...normalized,checks:normalized.tasks[0].checks,checkTimeoutsMs:[300000]});assert.deepEqual(entries.map(entry=>entry.timeoutMs),[600000,300000]);
  const m=await f.manager.create(spec);assert.deepEqual(f.manager.jobs[0].tasks[0].checkTimeoutsMs,[600000]);assert.deepEqual(m.tasks[0].checkTimeoutsMs,[600000]);assert.deepEqual(m.checkTimeoutsMs,[null]);assert.equal(m.status,'draft');
 }finally{await f.cleanup();}
});

test('per-check timeout cancels a real task check before committing',async()=>{
 const f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'candidate\n');return success();});try{
  const m=await f.manager.create(f.spec([task('a',{checks:[[node,'-e','setInterval(()=>{},1000)']],checkTimeoutsMs:[100]})]));await f.manager.start(m.id);
  await until(()=>f.manager.publicState()[0].status==='attention','short check timeout');const t=f.manager.jobs[0].tasks[0];assert.match(t.detail,/timed out/);assert.equal(t.checksPassed,false);assert.equal(t.commit,undefined);assert.equal(git(t.worktree,['rev-parse','HEAD']),t.baseHead);
 }finally{await f.cleanup();}
});

test('per-check timeout is enforced during final integration and apply without delivering a failed check',async()=>{
 for(const phase of ['integration','apply']){
  let f;f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'candidate\n');if(phase==='integration')fs.writeFileSync(path.join(f.manager.jobs[0].integrationPath,'slow-check.marker'),'owned check control');return success();});try{
   fs.writeFileSync(path.join(f.project,'.gitignore'),'slow-check.marker\n');git(f.project,['add','--','.gitignore']);git(f.project,['commit','-m','Ignored check control fixture']);
   const head=git(f.project,['rev-parse','HEAD']),check=[node,'-e',"if(require('fs').existsSync('slow-check.marker'))setInterval(()=>{},1000)"];
   const m=await f.manager.create(f.spec([task('a')],{checks:[check],checkTimeoutsMs:[100]}));await f.manager.start(m.id);
   if(phase==='integration'){await until(()=>f.manager.publicState()[0].status==='attention','integration check timeout');assert.match(f.manager.publicState()[0].detail,/timed out/);assert.equal(f.manager.publicState()[0].finalChecksPassed,false);}
   else{await ready(f,m.id);fs.writeFileSync(path.join(f.manager.jobs[0].integrationPath,'slow-check.marker'),'owned check control');await assert.rejects(f.manager.apply(m.id),{code:'timeout'});assert.equal(f.manager.publicState()[0].status,'ready');}
   assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'initial\n');assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
 }
});

test('structural validation rejects unknown fields, circular dependencies, escaping scopes and unbounded budgets',async()=>{
 const f=await fixture();try{
  assert.equal(normalizeMissionSpec(f.spec()).limits.concurrency,3);
  assert.throws(()=>normalizeMissionSpec(f.spec([task('a'),task('A')])),'case-insensitive task identities must stay unique on Windows');
  assert.equal(normalizeMissionSpec(f.spec([task('a')],{model:'',effort:''})).model,null);
  assert.equal(normalizeMissionSpec(f.spec([task('a')],{effort:''})).effort,'');
  for(const spec of [f.spec([],{}),f.spec([task('a'),task('a')]),f.spec([task('a',{dependsOn:['missing']})]),f.spec([task('a',{dependsOn:['b']}),task('b',{dependsOn:['a']})]),f.spec([task('a',{files:['../escape']})]),f.spec([task('a',{files:['.git/config']})]),f.spec([task('a',{files:['.env.production']})]),f.spec([task('a',{files:['src\\escape']})]),f.spec([task('__proto__')]),f.spec([task('orchestrator')]),f.spec([task('integration')]),f.spec([task('a',{checks:[]})]),f.spec([task('a')],{checks:[]}),f.spec([task('a')],{limits:{concurrency:5}}),f.spec([task('a')],{effort:'ultracode'}),f.spec([task('a')],{provider:'claude',effort:'ultra'}),f.spec([task('a',{checks:[['powershell','-Command','something']]})]),f.spec([task('a',{checks:[['npm','install']]})]),f.spec([task('a')],{orchestrator:{nativeId:'forged'}})])assert.throws(()=>normalizeMissionSpec(spec));
  const plan=normalizeMissionSpec(f.spec([task('a',{provider:'claude',model:'opus',effort:'max'})],{planId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',terminalWindow:'agent-relay-test'}));assert.equal(plan.tasks[0].provider,'claude');assert.equal(plan.planId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 }finally{await f.cleanup();}
});

test('independent task finishes release slots immediately, dependencies see integrated changes, apply keeps original untouched until verified',async()=>{
 const hold=deferred(),seen=[];
 const f=await fixture(async arg=>{
  const prompt=fs.readFileSync(arg.promptFile,'utf8'),id=/Task: ([\w-]+)/.exec(prompt)[1];seen.push(id);
  if(id==='b')await hold.promise;
  if(id==='c')assert.equal(fs.readFileSync(path.join(arg.cwd,'a.txt'),'utf8'),'a verified\n');
  fs.writeFileSync(path.join(arg.cwd,`${id}.txt`),`${id} verified\n`);return success({sessionHandle:`session-${id}`});
 });try{
  const original=git(f.project,['rev-parse','HEAD']);
  const m=await f.manager.create(f.spec([task('a'),task('b'),task('c',{dependsOn:['a']})],{limits:{concurrency:2},checks:[[node,'-e',"const fs=require('fs');for(const f of ['a','b','c'])if(fs.readFileSync(f+'.txt','utf8')!==f+' verified\\n')process.exit(1)"]]}));
  await f.manager.start(m.id);await until(()=>seen.includes('c'),'dependent launches while unrelated worker remains active');
  assert.deepEqual(seen.slice(0,2),['a','b']);assert.equal(f.manager.publicState()[0].tasks[1].status,'running');assert.equal(git(f.project,['rev-parse','HEAD']),original);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'initial\n');
  hold.resolve();const done=await ready(f,m.id);assert.equal(done.progress.completed,3);assert.equal(done.turnsUsed,3);assert.equal(done.sessionsUsed,3);assert.equal(done.finalChecksPassed,true);assert.ok(done.tasks.every(t=>t.checksPassed));
  const serialized=JSON.stringify(done);assert.ok(!serialized.includes('promptFile'));assert.ok(!serialized.includes('"worktree":'));assert.ok(!serialized.includes('prompt"'));assert.ok(!serialized.includes('transcript.log'));
  await f.manager.apply(m.id);assert.equal(f.manager.publicState()[0].status,'applied');assert.equal(fs.readFileSync(path.join(f.project,'c.txt'),'utf8'),'c verified\n');assert.equal(git(f.project,['status','--porcelain']),'');assert.ok(f.manager.log(m.id,'a').includes('[Check]'));
 }finally{hold.resolve();await f.cleanup();}
});

test('overlapping scopes serialize without an artificial batch barrier',async()=>{
 const hold=deferred(),seen=[];
 const f=await fixture(async arg=>{const id=/Task: ([\w-]+)/.exec(fs.readFileSync(arg.promptFile,'utf8'))[1];seen.push(id);if(id==='first')await hold.promise;if(id==='second')assert.equal(fs.readFileSync(path.join(arg.cwd,'shared.txt'),'utf8'),'first\n');fs.writeFileSync(path.join(arg.cwd,id==='third'?'b.txt':'shared.txt'),id+'\n');return success();});try{
  const scoped=(id,patch={})=>task(id,{files:['shared.txt'],checks:[[node,'-e',"if(!require('fs').readFileSync('shared.txt','utf8').trim())process.exit(1)" ]],...patch});
  const m=await f.manager.create(f.spec([scoped('first'),scoped('second'),scoped('third',{files:['b.txt']})],{limits:{concurrency:2}}));
  await f.manager.start(m.id);await until(()=>seen.includes('third'),'independent scope starts');assert.deepEqual(seen,['first','third']);hold.resolve();await ready(f,m.id);assert.deepEqual(seen,['first','third','second']);
 }finally{hold.resolve();await f.cleanup();}
});

test('global four-process cap and two-mission cap remain hard limits',async()=>{
 const hold=deferred();let running=0,max=0;
 const f=await fixture(async()=>{running++;max=Math.max(max,running);await hold.promise;running--;return success();});try{
  const tasks=[task('a'),task('b'),task('shared')],m1=await f.manager.create(f.spec(tasks,{limits:{concurrency:3}})),m2=await f.manager.create(f.spec(tasks,{limits:{concurrency:3}})),m3=await f.manager.create(f.spec());
  await f.manager.start(m1.id);await f.manager.start(m2.id);await until(()=>f.calls.length===4,'four reserved worker processes');assert.equal(max,4);assert.equal(f.manager.active.size,4);
  await assert.rejects(f.manager.start(m3.id),{code:'mission-limit'});hold.resolve();await ready(f,m1.id);await ready(f,m2.id);assert.ok(max<=4);
 }finally{hold.resolve();await f.cleanup();}
});

test('budget reservations are durable before launch; exhausted pending work stays attention without automatic retries',async()=>{
 let durable;
 const f=await fixture(async()=>{durable=JSON.parse(fs.readFileSync(f.args.file,'utf8')).missions[0];return success();});try{
  const m=await f.manager.create(f.spec([task('a'),task('b')],{limits:{concurrency:1,maxSessions:1,maxTurns:1}}));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','budget stop');
  assert.equal(durable.turnsUsed,1);assert.equal(durable.sessionsUsed,1);assert.equal(durable.tasks[0].status,'running');assert.equal(f.calls.length,1);await f.manager.tick();assert.equal(f.calls.length,1);assert.equal(f.manager.publicState()[0].tasks[1].status,'pending');
 }finally{await f.cleanup();}
});

test('restart spends no new turn, preserves original deadline and requires an explicit retry',async()=>{
 const hold=deferred();let clock=Date.now();
 const f=await fixture(async arg=>{await Promise.race([hold.promise,new Promise((_,reject)=>arg.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))]);return success();},{now:()=>clock});try{
  const m=await f.manager.create(f.spec());await f.manager.start(m.id);await until(()=>f.calls.length===1,'worker starts');const deadline=f.manager.publicState()[0].deadline;
  const restarted=new MissionManager({...f.args,runner:async()=>success()});assert.equal(restarted.publicState()[0].status,'attention');assert.equal(restarted.publicState()[0].tasks[0].status,'attention');assert.equal(restarted.publicState()[0].turnsUsed,1);assert.equal(restarted.publicState()[0].deadline,deadline);await restarted.tick();assert.equal(restarted.publicState()[0].turnsUsed,1);await restarted.shutdown();
  await f.manager.stop(m.id);hold.resolve();await until(()=>f.manager.active.size===0,'old process stops');clock=deadline+1;await assert.rejects(restarted.resume(m.id));
 }finally{hold.resolve();await f.cleanup();}
});

test('out-of-scope files, deletions, secrets and worker commits are retained for attention and never integrated',async()=>{
 for(const mode of ['scope','deletion','secret','worker-commit']){
  const f=await fixture(async arg=>{if(mode==='scope')fs.writeFileSync(path.join(arg.cwd,'outside.txt'),'outside');else if(mode==='deletion')fs.unlinkSync(path.join(arg.cwd,'a.txt'));else if(mode==='secret')fs.writeFileSync(path.join(arg.cwd,'.env.local'),'TEST_VALUE=private');else{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'worker');git(arg.cwd,['add','--','a.txt']);git(arg.cwd,['commit','-m','Unapproved worker commit']);}return success();});try{
   const original=git(f.project,['rev-parse','HEAD']),m=await f.manager.create(f.spec([task('a',{files:mode==='secret'?['a.txt','.config/']:['a.txt']})]));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention',mode);
   assert.equal(f.manager.publicState()[0].tasks[0].status,'attention');assert.equal(git(f.project,['rev-parse','HEAD']),original);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'initial\n');assert.equal(git(f.manager.jobs[0].integrationPath,['rev-parse','HEAD']),original);assert.ok(fs.existsSync(f.manager.jobs[0].tasks[0].worktree));assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
 }
});

test('exit status and final receipt are both mandatory; check failures prevent commits',async()=>{
 for(const mode of ['exit','receipt','checks']){
  const f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'candidate\n');return mode==='exit'?success({exitCode:1}):mode==='receipt'?success({answer:'It looks complete.'}):success();});try{
   const m=await f.manager.create(f.spec([task('a',{checks:mode==='checks'?[[node,'-e','process.exit(7)']]:task('a').checks})]));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention',mode);const t=f.manager.jobs[0].tasks[0];assert.equal(t.checksPassed,false);assert.equal(git(t.worktree,['rev-parse','HEAD']),t.baseHead);assert.equal(f.calls.length,1);assert.ok(f.manager.log(m.id,'a').includes('[Final answer]'));
  }finally{await f.cleanup();}
 }
});

test('security gate failure and mutation after checks cannot create a commit',async()=>{
 for(const mutation of [false,true]){
  const f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'verified\n');return success();},{gate:async({cwd})=>{if(mutation)fs.writeFileSync(path.join(cwd,'a.txt'),'unverified mutation\n');else throw new Error('blocked gate');}});try{
   const m=await f.manager.create(f.spec());await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','gate rejection');const t=f.manager.jobs[0].tasks[0];assert.equal(git(t.worktree,['rev-parse','HEAD']),t.baseHead);assert.equal(f.manager.publicState()[0].finalChecksPassed,false);assert.match(t.detail,mutation?/modified files/:/blocked gate/);
  }finally{await f.cleanup();}
 }
});

test('follow-up retries preserve a single provider session, review the retained diff, and re-run checks',async()=>{
 const f=await fixture(async(arg,n)=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),n===1?'incomplete\n':'complete\n');if(n===2){assert.equal(arg.sessionHandle,'retained-session');assert.match(fs.readFileSync(arg.promptFile,'utf8'),/Finish the missing criterion/);}return success({sessionHandle:'retained-session',answer:n===1?'Need one clarification.\nSTATUS: BLOCKED — check details':'Required criterion passed.\nSTATUS: OK'});});try{
  const m=await f.manager.create(f.spec([task('a',{checks:[[node,'-e',"if(require('fs').readFileSync('a.txt','utf8')!=='complete\\n')process.exit(1)"] ]})]));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','initial attention');
  await f.manager.message(m.id,'a','Finish the missing criterion using the existing requirement.');const deadline=f.manager.publicState()[0].deadline;await f.manager.retry(m.id,'a');const done=await ready(f,m.id);assert.equal(done.sessionsUsed,1);assert.equal(done.turnsUsed,2);assert.equal(done.deadline,deadline);assert.equal(done.tasks[0].attempts,2);await assert.rejects(f.manager.message(m.id,'a','new task'),{code:'state'});
 }finally{await f.cleanup();}
});

test('dirty originals are captured; later source, index, HEAD and integration changes block stale apply',async()=>{
 const f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'verified\n');return success();});try{
  fs.writeFileSync(path.join(f.project,'b.txt'),'user change\n');const m=await f.manager.create(f.spec());assert.equal(m.baselineDirty,true);fs.writeFileSync(path.join(f.project,'b.txt'),'another user change\n');await assert.rejects(f.manager.start(m.id),{code:'project-changed'});git(f.project,['add','--','b.txt']);git(f.project,['commit','-m','User second baseline update']);await assert.rejects(f.manager.start(m.id),{code:'project-changed'});
  const m2=await f.manager.create(f.spec());await f.manager.start(m2.id);await ready(f,m2.id);fs.writeFileSync(path.join(f.project,'user.txt'),'preserve me');await assert.rejects(f.manager.apply(m2.id),{code:'project-changed'});assert.equal(fs.readFileSync(path.join(f.project,'user.txt'),'utf8'),'preserve me');git(f.project,['add','--','user.txt']);git(f.project,['commit','-m','User independent change']);await assert.rejects(f.manager.apply(m2.id),{code:'project-changed'});
  const m3=await f.manager.create(f.spec());await f.manager.start(m3.id);await ready(f,m3.id);const integration=f.manager.jobs.find(m=>m.id===m3.id).integrationPath;git(integration,['commit','--allow-empty','-m','Unverified candidate revision']);await assert.rejects(f.manager.apply(m3.id),{code:'integration-changed'});
 }finally{await f.cleanup();}
});

test('isolated dirty baseline includes staged, unstaged, deleted and untracked source; apply preserves original HEAD and exact index',async()=>{
 const f=await fixture(async arg=>{assert.equal(fs.readFileSync(path.join(arg.cwd,'a.txt'),'utf8'),'staged user\nunstaged user\n');assert.equal(fs.readFileSync(path.join(arg.cwd,'user.txt'),'utf8'),'untracked user\n');assert.equal(fs.existsSync(path.join(arg.cwd,'b.txt')),false);assert.equal(fs.existsSync(path.join(arg.cwd,'.env.local')),false);assert.equal(fs.existsSync(path.join(arg.cwd,'node_modules')),false);fs.appendFileSync(path.join(arg.cwd,'a.txt'),'verified mission\n');return success();});try{
  fs.writeFileSync(path.join(f.project,'a.txt'),'staged user\n');git(f.project,['add','--','a.txt']);fs.appendFileSync(path.join(f.project,'a.txt'),'unstaged user\n');fs.unlinkSync(path.join(f.project,'b.txt'));fs.writeFileSync(path.join(f.project,'user.txt'),'untracked user\n');fs.writeFileSync(path.join(f.project,'.gitignore'),'node_modules/\n.env*\n');fs.writeFileSync(path.join(f.project,'.env.local'),'PRIVATE_VALUE=never_copy\n');fs.mkdirSync(path.join(f.project,'node_modules'));fs.writeFileSync(path.join(f.project,'node_modules','user.txt'),'original dependency\n');
  const head=git(f.project,['rev-parse','HEAD']),indexPath=path.resolve(f.project,git(f.project,['rev-parse','--git-path','index'])),index=fs.readFileSync(indexPath),cached=git(f.project,['diff','--cached']);
  const check=[node,'-e',"const fs=require('fs');if(fs.readFileSync('a.txt','utf8')!=='staged user\\nunstaged user\\nverified mission\\n'||fs.readFileSync('user.txt','utf8')!=='untracked user\\n'||fs.existsSync('b.txt'))process.exit(1)"];
  const m=await f.manager.create(f.spec([task('a',{checks:[check]})],{checks:[check]}));assert.equal(m.baselineDirty,true);assert.equal(m.deliveryMode,'worktree');assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(git(f.project,['rev-parse','HEAD']),head);
  await f.manager.start(m.id);await ready(f,m.id);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'staged user\nunstaged user\n');assert.deepEqual(fs.readFileSync(indexPath),index);await f.manager.apply(m.id);
  assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(git(f.project,['diff','--cached']),cached);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'staged user\nunstaged user\nverified mission\n');assert.equal(fs.readFileSync(path.join(f.project,'user.txt'),'utf8'),'untracked user\n');assert.equal(fs.existsSync(path.join(f.project,'b.txt')),false);assert.equal(fs.readFileSync(path.join(f.project,'.env.local'),'utf8'),'PRIVATE_VALUE=never_copy\n');assert.equal(fs.readFileSync(path.join(f.project,'node_modules','user.txt'),'utf8'),'original dependency\n');assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});

test('protected dirty source and snapshot gate mutations fail before opening a worker and preserve the original',async()=>{
 for(const mode of ['protected','gate-mutation','source-race']){const f=await fixture(undefined,{gate:async({cwd,role})=>{if(mode==='gate-mutation'&&role==='baseline')fs.writeFileSync(path.join(cwd,'a.txt'),'altered by gate\n');if(mode==='source-race'&&role==='baseline')fs.writeFileSync(path.join(f.project,'b.txt'),'user changed during snapshot controls\n');}});try{
  fs.writeFileSync(path.join(f.project,'a.txt'),'user changes\n');if(mode==='protected')fs.writeFileSync(path.join(f.project,'.env.local'),'PRIVATE_VALUE=protected\n');const head=git(f.project,['rev-parse','HEAD']),indexPath=path.resolve(f.project,git(f.project,['rev-parse','--git-path','index'])),index=fs.readFileSync(indexPath);
  await assert.rejects(f.manager.create(f.spec()),{code:mode==='protected'?'protected-source':mode==='source-race'?'project-race':'gate-mutated'});assert.equal(f.calls.length,0);assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'user changes\n');if(mode==='source-race')assert.equal(fs.readFileSync(path.join(f.project,'b.txt'),'utf8'),'user changed during snapshot controls\n');
 }finally{await f.cleanup();}}
});

test('dirty apply preflights after checks and rolls back only owned writes while preserving concurrent user changes',async()=>{
 for(const phase of ['during-checks','during-write']){let f,changed=false,closureCalls=0;
  f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'mission a\n');fs.writeFileSync(path.join(arg.cwd,'b.txt'),'mission b\n');return success();},{gate:async({role})=>{if(role==='closure'&&++closureCalls===2&&phase==='during-checks'){fs.writeFileSync(path.join(f.project,'b.txt'),'concurrent user\n');changed=true;}},onChange:()=>{const transaction=f?.manager.jobs[0]?.applyTransaction;if(phase==='during-write'&&!changed&&transaction?.phase==='applying'&&transaction.files[0]?.status==='written'&&transaction.files[1]?.status==='pending'){changed=true;fs.writeFileSync(path.join(f.project,'b.txt'),'concurrent user\n');}}});try{
   fs.writeFileSync(path.join(f.project,'a.txt'),'original user a\n');fs.writeFileSync(path.join(f.project,'b.txt'),'original user b\n');git(f.project,['add','--','a.txt']);const indexPath=path.resolve(f.project,git(f.project,['rev-parse','--git-path','index'])),index=fs.readFileSync(indexPath),head=git(f.project,['rev-parse','HEAD']);
   const check=[node,'-e',"const fs=require('fs');if(fs.readFileSync('a.txt','utf8')!=='mission a\\n'||fs.readFileSync('b.txt','utf8')!=='mission b\\n')process.exit(1)"];
   const m=await f.manager.create(f.spec([task('a',{files:['a.txt','b.txt'],checks:[check]})],{checks:[check]}));await f.manager.start(m.id);await ready(f,m.id);await assert.rejects(f.manager.apply(m.id));assert.equal(changed,true);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'original user a\n');assert.equal(fs.readFileSync(path.join(f.project,'b.txt'),'utf8'),'concurrent user\n');assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.equal(f.manager.publicState()[0].status,'ready');if(phase==='during-write')assert.ok(fs.existsSync(f.manager.jobs[0].applyTransaction.files[0].backup));assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
 }
});

test('a crash after dirty writes resumes from its durable journal without spending a turn or changing the original index',async()=>{
 let f,checkpoint,restarted;
 f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'mission a\n');fs.writeFileSync(path.join(arg.cwd,'feature.txt'),'mission feature\n');return success();},{onChange:()=>{const m=f?.manager.jobs[0];if(m?.status==='ready'&&m.applyTransaction?.phase==='applying'&&m.applyTransaction.files.every(file=>file.status==='written'))checkpoint=fs.readFileSync(f.args.file);}});try{
  fs.writeFileSync(path.join(f.project,'b.txt'),'pre-existing user changes\n');const head=git(f.project,['rev-parse','HEAD']),indexPath=path.resolve(f.project,git(f.project,['rev-parse','--git-path','index'])),index=fs.readFileSync(indexPath);
  const check=[node,'-e',"const fs=require('fs');if(fs.readFileSync('a.txt','utf8')!=='mission a\\n'||fs.readFileSync('feature.txt','utf8')!=='mission feature\\n')process.exit(1)"];
  const m=await f.manager.create(f.spec([task('a',{files:['a.txt','feature.txt'],checks:[check]})],{checks:[check]}));await f.manager.start(m.id);await ready(f,m.id);await f.manager.apply(m.id);assert.ok(checkpoint);fs.writeFileSync(f.args.file,checkpoint);
  restarted=new MissionManager({...f.args,runner:async()=>{throw Error('Recovery must consume no model turn');}});assert.equal(restarted.publicState()[0].status,'ready');const applied=await restarted.apply(m.id);assert.equal(applied.status,'applied');assert.equal(applied.turnsUsed,1);assert.equal(applied.sessionsUsed,1);assert.equal(f.calls.length,1);assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.equal(fs.readFileSync(path.join(f.project,'b.txt'),'utf8'),'pre-existing user changes\n');assert.equal(fs.readFileSync(path.join(f.project,'feature.txt'),'utf8'),'mission feature\n');
 }finally{await restarted?.shutdown();await f.cleanup();}
});

test('expiry is recoverable by explicit bounded extension and retained worker validation consumes zero new turns',async()=>{
 let clock=Date.now(),f;
 f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'late verified candidate\n');clock=f.manager.jobs[0].deadline+1;return success();},{now:()=>clock});try{
  const check=[node,'-e',"if(require('fs').readFileSync('a.txt','utf8')!=='late verified candidate\\n')process.exit(1)"];
  const m=await f.manager.create(f.spec([task('a',{checks:[check]})],{limits:{taskMinutes:1,missionMinutes:5,maxSessions:1,maxTurns:1},checks:[check]}));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention'&&f.manager.active.size===0,'late candidate retained');const before=f.manager.publicState()[0];assert.equal(before.deadlineReached,true);assert.equal(before.tasks[0].deadlineReached,true);assert.equal(before.finalChecksPassed,false);assert.ok(f.manager.jobs[0].tasks[0].workerReceipt);await assert.rejects(f.manager.resume(m.id),{code:'deadline-extension-required'});await assert.rejects(f.manager.retry(m.id,'a'),{code:'deadline-extension-required'});
  for(const minutes of [0,-1,1441,1.5])await assert.rejects(f.manager.extend(m.id,{minutes}));await assert.rejects(f.manager.extend(m.id,{minutes:10,taskId:'a'}),{code:'extension-limit'});
  const extended=await f.manager.extend(m.id,{minutes:30});assert.equal(extended.status,'attention');assert.equal(extended.deadlineReached,false);assert.equal(extended.turnsUsed,1);assert.equal(extended.sessionsUsed,1);await f.manager.extend(m.id,{minutes:10,taskId:'a'});assert.equal(f.calls.length,1);
  await f.manager.retry(m.id,'a');const completed=await ready(f,m.id);assert.equal(completed.turnsUsed,1);assert.equal(completed.sessionsUsed,1);assert.equal(f.calls.length,1);assert.equal(completed.tasks[0].attempts,2);assert.equal(completed.finalChecksPassed,true);await f.manager.apply(m.id);assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'late verified candidate\n');
 }finally{await f.cleanup();}
});

test('final integration checks and original deadlines prevent false success',async()=>{
 let clock=Date.now();const f=await fixture(async()=>success(),{now:()=>clock});try{
  const m=await f.manager.create(f.spec([task('a')],{checks:[[node,'-e','process.exit(9)']]}));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','final check failure');assert.equal(f.manager.publicState()[0].tasks[0].status,'completed');assert.equal(f.manager.publicState()[0].finalChecksPassed,false);await assert.rejects(f.manager.apply(m.id),{code:'state'});
  const m2=await f.manager.create(f.spec([task('a')],{limits:{missionMinutes:5}}));await f.manager.start(m2.id);await f.manager.pause(m2.id).catch(()=>{});clock=f.manager.publicState().find(m=>m.id===m2.id).deadline+1;await f.manager.tick();assert.equal(f.manager.publicState().find(m=>m.id===m2.id).status,'attention');assert.equal(f.manager.publicState().find(m=>m.id===m2.id).deadlineReached,true);assert.equal(f.manager.publicState().find(m=>m.id===m2.id).deadline,m2.deadline??clock-1);
 }finally{await f.cleanup();}
});

test('pause and stop never launch pending turns; cancellation retains artifacts and logs are bounded plain text',async()=>{
 const hold=deferred();const f=await fixture(async arg=>{arg.onOutput('\u001b[31mvisible\u001b[0m\n'+'x'.repeat(9*1024*1024));await Promise.race([hold.promise,new Promise((_,reject)=>arg.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))]);return success();});try{
  const m=await f.manager.create(f.spec([task('a'),task('b')],{limits:{concurrency:1}}));await f.manager.start(m.id);await until(()=>f.calls.length===1,'worker start');await f.manager.pause(m.id);await f.manager.tick();assert.equal(f.calls.length,1);const log=f.manager.log(m.id,'a');assert.ok(log.length<=128*1024);assert.ok(!log.includes('\u001b'));
  await f.manager.stop(m.id);await until(()=>f.manager.active.size===0,'cancelled worker close');await f.manager.tick();assert.equal(f.calls.length,1);assert.equal(f.manager.publicState()[0].status,'stopped');assert.ok(fs.existsSync(f.manager.jobs[0].tasks[0].worktree));assert.ok(fs.existsSync(f.manager.jobs[0].tasks[0].logFile));assert.ok(fs.statSync(f.manager.jobs[0].tasks[0].logFile).size<=8*1024*1024);
 }finally{hold.resolve();await f.cleanup();}
});

test('trusted runner metadata makes a running session visible without interpreting generated output as session IDs',async()=>{
 const hold=deferred();const f=await fixture(async arg=>{arg.onOutput('AI_RELAY_SESSION {"sessionHandle":"codex-fedcba"}\n','stdout');arg.onOutput('','metadata',{sessionHandle:'codex-abcdef',nativeId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});await hold.promise;return success({sessionHandle:'codex-abcdef'});});try{
  const m=await f.manager.create(f.spec());await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].tasks[0].sessionHandle==='codex-abcdef','early trusted handle');assert.equal(f.manager.publicState()[0].tasks[0].status,'running');const saved=JSON.parse(fs.readFileSync(f.args.file,'utf8'));assert.equal(saved.missions[0].tasks[0].nativeId,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');hold.resolve();await ready(f,m.id);
 }finally{hold.resolve();await f.cleanup();}
});

test('task deadline is checked after a worker reply, preserving the larger mission deadline',async()=>{
 const hold=deferred();let clock=Date.now();const f=await fixture(async()=>{await hold.promise;return success();},{now:()=>clock});try{
  const m=await f.manager.create(f.spec([task('a')],{limits:{taskMinutes:1,missionMinutes:5}}));await f.manager.start(m.id);await until(()=>f.calls.length===1,'worker waits');const before=f.manager.publicState()[0].deadline;clock+=60001;hold.resolve();await until(()=>f.manager.publicState()[0].status==='attention','task deadline rejects late result');assert.equal(f.manager.publicState()[0].deadline,before);assert.equal(f.manager.publicState()[0].tasks[0].checksPassed,false);assert.match(f.manager.publicState()[0].tasks[0].detail,/original deadline/);
 }finally{hold.resolve();await f.cleanup();}
});

test('merge conflicts preserve both candidate and integration evidence without reset or discarded files',async()=>{
 let f;f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'candidate branch\n');const integration=f.manager.jobs[0].integrationPath;fs.writeFileSync(path.join(integration,'a.txt'),'concurrent integration\n');git(integration,['add','--','a.txt']);git(integration,['commit','-m','Concurrent integration evidence']);return success();});try{
  const original=git(f.project,['rev-parse','HEAD']),m=await f.manager.create(f.spec([task('a')],{limits:{maxTurns:1,maxSessions:1}}));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','merge conflict attention');const internal=f.manager.jobs[0],t=internal.tasks[0];assert.ok(t.commit);assert.ok(git(internal.integrationPath,['status','--porcelain']).includes('UU a.txt'));assert.ok(fs.readFileSync(path.join(internal.integrationPath,'a.txt'),'utf8').includes('<<<<<<<'));assert.equal(fs.readFileSync(path.join(t.worktree,'a.txt'),'utf8'),'candidate branch\n');assert.equal(git(f.project,['rev-parse','HEAD']),original);assert.equal(f.calls.length,1);
  await until(()=>f.manager.active.size===0,'failed merge releases its slot');const coordinatorCommit=t.commit;t.commit=null;f.manager.save();await f.manager.retry(m.id,'a');await until(()=>f.manager.publicState()[0].status==='attention','unresolved conflicts remain attention');assert.equal(t.commit,coordinatorCommit,'durable commit intent identifies a commit even when its success record was interrupted');assert.equal(f.calls.length,1);assert.match(f.manager.publicState()[0].tasks[0].detail,/conflicts or pending changes/);
  fs.writeFileSync(path.join(internal.integrationPath,'a.txt'),'candidate branch\n');git(internal.integrationPath,['add','--','a.txt']);git(internal.integrationPath,['commit','-m','Resolve owned fixture merge conflict']);await until(()=>f.manager.active.size===0,'recovery releases its slot');await f.manager.retry(m.id,'a');const done=await ready(f,m.id);assert.equal(f.calls.length,1);assert.equal(done.turnsUsed,1);assert.equal(done.sessionsUsed,1);assert.equal(git(f.project,['rev-parse','HEAD']),original);
 }finally{await f.cleanup();}
});

test('requirements preserve literal prompts and actual local secret/change guards validate closure before apply',async()=>{
 const f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'actual verified candidate\n');return success();},{gate:undefined});try{
  fs.writeFileSync(path.join(f.project,'b.txt'),'user baseline preserved by actual gates\n');
  const indexPath=path.resolve(f.project,git(f.project,['rev-parse','--git-path','index'])),index=fs.readFileSync(indexPath),head=git(f.project,['rev-parse','HEAD']);
  const literal='  Implement this exact task, preserving its literal wording.\n',goal='  Implement the specified feature with real verification.\n';
  const m=await f.manager.create(f.spec([task('a',{prompt:literal,title:'Implementar búsqueda'})],{goal}));const contractFile=f.manager.jobs[0].requirementsFile,initial=JSON.parse(fs.readFileSync(contractFile,'utf8'));assert.equal(initial.items[1].literal,literal);assert.equal(initial.items[0].literal,goal);assert.equal(initial.items[1].status,'pending');
  await f.manager.start(m.id);await ready(f,m.id);const contract=JSON.parse(fs.readFileSync(contractFile,'utf8'));assert.ok(contract.items.every(item=>item.status==='completed'&&item.evidence.length>0));assert.ok(contract.items.every(item=>item.evidence.every(file=>path.isAbsolute(file)&&fs.existsSync(file))));assert.match(f.manager.log(m.id,'a'),/secret-scan.*OK/);assert.match(f.manager.log(m.id,'integration'),/change-guard.*OK/);assert.equal(git(f.manager.jobs[0].tasks[0].worktree,['show','-s','--format=%s','HEAD']),'Implement Agent Relay task a');await f.manager.apply(m.id);assert.equal(f.manager.publicState()[0].status,'applied');assert.equal(git(f.project,['rev-parse','HEAD']),head);assert.deepEqual(fs.readFileSync(indexPath),index);assert.equal(fs.readFileSync(path.join(f.project,'b.txt'),'utf8'),'user baseline preserved by actual gates\n');assert.match(fs.readFileSync(path.join(f.args.artifacts,m.id,'baseline.log'),'utf8'),/secret-scan.*OK/);
 }finally{await f.cleanup();}
});

test('pinned npm dependencies are restored separately in task and integration worktrees without lifecycle scripts or original node_modules changes',async()=>{
 for(const directory of ['', 'packages/example']){
  let f;f=await fixture(async arg=>{const root=path.join(arg.cwd,directory);assert.equal(requireFrom(root),'local-fixture');assert.equal(fs.existsSync(path.join(root,'node_modules','user-sentinel.txt')),false);assert.equal(fs.existsSync(path.join(root,'unsafe-script.txt')),false);fs.writeFileSync(path.join(arg.cwd,'a.txt'),'verified with pinned npm package\n');return success();});try{
   const npm=localNpmFixture(f,directory),prefix=directory?directory+'/':'';
   const check=[node,'-e',`if(require('./${prefix}node_modules/relay-fixture')!=='local-fixture')process.exit(1)`],m=await f.manager.create(f.spec([task('a',{files:['a.txt',prefix+'vendor/relay-fixture/'],checks:[check]})],{checks:[baselineCheck,check]}));
   await f.manager.start(m.id);await ready(f,m.id);assert.equal(fs.readFileSync(path.join(npm.root,'node_modules','user-sentinel.txt'),'utf8'),'preserve user dependencies');assert.equal(fs.existsSync(path.join(npm.root,'unsafe-script.txt')),false);assert.match(f.manager.log(m.id,'a'),/Dependencies exit.*0/);assert.match(f.manager.log(m.id,'integration'),/Dependencies exit.*0/);assert.equal(requireFrom(path.join(f.manager.jobs[0].integrationPath,directory)),'local-fixture');await f.manager.apply(m.id);assert.equal(fs.readFileSync(path.join(npm.root,'node_modules','user-sentinel.txt'),'utf8'),'preserve user dependencies');
  }finally{await f.cleanup();}
 }
});

function requireFrom(directory){const result=spawnSync(node,['-e',"process.stdout.write(require('./node_modules/relay-fixture'))"],{cwd:directory,windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;}

test('a task changing pinned dependency inputs cannot silently download new packages during integration',async()=>{
 const f=await fixture(async arg=>{const manifest=JSON.parse(fs.readFileSync(path.join(arg.cwd,'package.json'),'utf8'));manifest.dependencies['unapproved-new-package']='1.0.0';fs.writeFileSync(path.join(arg.cwd,'package.json'),JSON.stringify(manifest));return success();});try{
  const npm=localNpmFixture(f),m=await f.manager.create(f.spec([task('a',{files:['a.txt','package.json']})]));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].status==='attention','new dependency blocks integration restore',20000);assert.match(f.manager.publicState()[0].detail,/Dependencies changed/);assert.equal(f.manager.publicState()[0].finalChecksPassed,false);assert.equal(fs.readFileSync(path.join(npm.root,'node_modules','user-sentinel.txt'),'utf8'),'preserve user dependencies');assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});

test('independent security gates keep their own queues while only approved integration merges serialize',async()=>{
 const hold=deferred(),gates=[];
 const f=await fixture(async arg=>{const id=/Task: ([\w-]+)/.exec(fs.readFileSync(arg.promptFile,'utf8'))[1];fs.writeFileSync(path.join(arg.cwd,id+'.txt'),'verified '+id+'\n');return success();},{gate:async({cwd,role})=>{if(role==='closure')return;const id=path.basename(path.dirname(cwd));gates.push(id);if(id==='a')await hold.promise;}});try{
  const m=await f.manager.create(f.spec([task('a'),task('b'),task('c')],{limits:{concurrency:2}}));await f.manager.start(m.id);await until(()=>f.manager.publicState()[0].tasks[2].status==='completed','new independent work completes while first gate is blocked');assert.deepEqual([...gates].sort(),['a','b','c']);assert.equal(f.manager.publicState()[0].tasks[0].status,'checking');hold.resolve();await ready(f,m.id);
 }finally{hold.resolve();await f.cleanup();}
});

test('repeated ticks never duplicate final checks; stopping cancels the one owned final process and its descendants',async()=>{
 const f=await fixture();let childPid;try{
  const final=[node,'-e',"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify({ownedChild:c.pid}));setInterval(()=>{},1000)"],m=await f.manager.create(f.spec([task('a')],{checks:[final]}));await f.manager.start(m.id);
  await until(()=>{const match=f.manager.log(m.id,'integration').match(/^\{"ownedChild":(\d+)\}/m);if(match)childPid=Number(match[1]);return !!childPid;},'owned final check child starts');assert.doesNotThrow(()=>process.kill(childPid,0));const active=f.manager.active.get(m.id+'/@integration');assert.ok(active);for(let i=0;i<5;i++)await f.manager.tick();assert.equal(f.manager.active.get(m.id+'/@integration'),active);assert.equal((f.manager.log(m.id,'integration').match(/^\{"ownedChild":/gm)||[]).length,1);
  await f.manager.stop(m.id);await until(()=>f.manager.active.size===0,'final process tree closes');assert.equal(f.manager.publicState()[0].status,'stopped');assert.throws(()=>process.kill(childPid,0));assert.equal(f.calls.length,1);
 }finally{await f.cleanup();if(childPid)try{process.kill(childPid,'SIGKILL');}catch{/* only this test-created child */}}
});

test('absolute local dependencies and changed local workspace dependency inputs are blocked before automatic installation',async()=>{
 const f=await fixture();try{
  const npm=localNpmFixture(f),changed={...npm.manifest,dependencies:{'relay-fixture':'file:'+path.join(f.project,'vendor','relay-fixture')}};fs.writeFileSync(path.join(f.project,'package.json'),JSON.stringify(changed));git(f.project,['add','--','package.json']);git(f.project,['commit','-m','Unsafe absolute dependency fixture']);await assert.rejects(f.manager.create(f.spec()),{code:'dependencies'});
 }finally{await f.cleanup();}
 let second;second=await fixture(async arg=>{const file=path.join(arg.cwd,'vendor','relay-fixture','package.json'),manifest=JSON.parse(fs.readFileSync(file));manifest.dependencies={'unapproved-new-package':'1.0.0'};fs.writeFileSync(file,JSON.stringify(manifest));return success();});try{
  localNpmFixture(second);const m=await second.manager.create(second.spec([task('a',{files:['a.txt','vendor/relay-fixture/package.json']})]));await second.manager.start(m.id);await until(()=>second.manager.publicState()[0].status==='attention','workspace dependencies changed',20000);assert.match(second.manager.publicState()[0].detail,/workspace or local package/);assert.equal(second.manager.publicState()[0].finalChecksPassed,false);assert.equal(second.calls.length,1);
 }finally{await second.cleanup();}
});

test('an explicit next-day apply uses its own operation deadline and can apply the verified candidate',async()=>{
 let clock=Date.now();const f=await fixture(async arg=>{fs.writeFileSync(path.join(arg.cwd,'a.txt'),'verified candidate\n');return success();},{now:()=>clock});try{
  const m=await f.manager.create(f.spec());await f.manager.start(m.id);await ready(f,m.id);clock=f.manager.publicState()[0].deadline+86400000;await f.manager.tick();assert.equal(f.manager.publicState()[0].status,'ready');const result=await f.manager.apply(m.id);assert.equal(result.status,'applied');assert.equal(fs.readFileSync(path.join(f.project,'a.txt'),'utf8'),'verified candidate\n');
 }finally{await f.cleanup();}
});

test('apply has a bounded whole-operation deadline and kills its owned check descendants without merging',async()=>{
 const f=await fixture(undefined,{applyTimeoutMs:10000});let childPid;try{
  fs.writeFileSync(path.join(f.project,'.gitignore'),'slow-apply.marker\n');git(f.project,['add','--','.gitignore']);git(f.project,['commit','-m','Ignored apply control fixture']);
  const command=[node,'-e',"if(require('fs').existsSync('slow-apply.marker')){const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify({ownedApplyChild:c.pid}));setInterval(()=>{},1000)}"],m=await f.manager.create(f.spec([task('a')],{checks:[command]}));await f.manager.start(m.id);await ready(f,m.id);const original=git(f.project,['rev-parse','HEAD']);fs.writeFileSync(path.join(f.manager.jobs[0].integrationPath,'slow-apply.marker'),'hold during apply only');
  const resultPromise=f.manager.apply(m.id).then(value=>({value}),error=>({error}));await until(()=>{const match=f.manager.log(m.id,'integration').match(/^\{"ownedApplyChild":(\d+)\}/m);if(match)childPid=Number(match[1]);return !!childPid;},'owned apply check starts');const result=await resultPromise;assert.equal(result.error?.code,'apply-timeout');assert.throws(()=>process.kill(childPid,0));assert.equal(git(f.project,['rev-parse','HEAD']),original);assert.equal(f.manager.publicState()[0].status,'ready');assert.equal(f.calls.length,1);
 }finally{await f.cleanup();if(childPid)try{process.kill(childPid,'SIGKILL');}catch{/* only the test-owned child */}}
});

test('a file deleted after a gate rejection never reaches the retried commit',async()=>{
 let gateCalls=0;
 const f=await fixture(async(arg,call)=>{
  fs.writeFileSync(path.join(arg.cwd,'a.txt'),'verified\n');
  if(call===1)fs.writeFileSync(path.join(arg.cwd,'a-temp.txt'),'rejected scratch\n');else fs.rmSync(path.join(arg.cwd,'a-temp.txt'),{force:true});
  return success();
 },{gate:async()=>{if(++gateCalls===1)throw new Error('blocked temporary artifact');}});try{
  const m=await f.manager.create(f.spec([task('a',{files:['a.txt','a-temp.txt']})]));await f.manager.start(m.id);
  await until(()=>f.manager.publicState()[0].status==='attention','gate rejection');
  await f.manager.message(m.id,'a','Remove the temporary file.');await f.manager.retry(m.id,'a');await ready(f,m.id);
  const t=f.manager.jobs[0].tasks[0];
  assert.deepEqual(git(t.worktree,['show','--name-only','--format=',t.commit]).split('\n'),['a.txt']);
  assert.equal(git(t.worktree,['status','--porcelain=v1','--untracked-files=all']),'');
 }finally{await f.cleanup();}
});
