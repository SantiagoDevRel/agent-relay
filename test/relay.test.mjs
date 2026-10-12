import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RelayCoordinator,relayResult,relayVerdict,validateRelay,hasCompaction,validClarificationAnswer} from '../server/relay.mjs';
const builderId='11111111-1111-4111-8111-111111111111',testerId='22222222-2222-4222-8222-222222222222';
const body={builderId,testerId,goal:'Implement the specified local change.',acceptance:'All named acceptance checks pass.',maxRounds:4,minutes:60};
const revision='a'.repeat(40),evidence=['actual-results.json'];
const block=id=>({id,expected:'accepted',actual:'blocked',reproducer:'node reproduce.mjs',cause:'wrong attribution'});
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-relay-')),messages=new Map(),sends=[];let clock=Date.now(),compactionDone=false;
 const targets=new Map([[builderId,{id:builderId,title:'Builder',tool:'codex',pid:100,alive:true,state:'waiting'}],[testerId,{id:testerId,title:'Tester',tool:'claude',pid:101,alive:true,state:'waiting'}]]);
 const args={file:path.join(dir,'state.json'),artifacts:path.join(dir,'artifacts'),targets:()=>targets,now:()=>clock,
  enroll:async c=>{if(!c?.alive)throw Error('closed');return {id:c.id,pid:c.pid,tool:c.tool,created:'identity'};},
  deliver:async(c,m,file,id)=>sends.push({role:c.id,id,brief:fs.readFileSync(file,'utf8')}),
  compact:async()=>sends.push({compact:true}),compacted:()=>compactionDone,conversation:c=>messages.get(c.id)||[]};
 const relay=new RelayCoordinator(args);
 const answer=(status,patch={})=>{const job=relay.jobs[0],intent=job.intent;messages.set(job.members[job.turn].id,[{role:'user',ts:intent.at,text:`AGENT-RELAY ${intent.id}: Read brief.`},{role:'agent',ts:intent.at+1,text:'AGENT_RELAY_RESULT '+JSON.stringify({handoffId:intent.id,contractHash:job.contractHash,status,revision,summary:'Actual verification result.',evidence,...patch})}]);};
 const acknowledge=()=>{const job=relay.jobs[0],intent=job.intent;messages.set(job.members[job.turn].id,[{role:'user',ts:intent.at,text:`AGENT-RELAY ${intent.id}: Read brief.`}]);};
 return {dir,args,relay,targets,sends,answer,acknowledge,advance:n=>{clock+=n;},finishCompact:()=>{compactionDone=true;}};
}
test('request scope and finite limits are validated',()=>{assert.equal(validateRelay(body),true);assert.equal(validateRelay({...body,maxRounds:10}),true);for(const patch of [{testerId:builderId},{maxRounds:11},{minutes:0},{goal:''},{acceptance:'x'},{commands:['rm']},{builderId:'__proto__'}])assert.equal(validateRelay({...body,...patch}),false);});
test('only an agent result after the exact acknowledged handoff advances',()=>{const intent={id:'fresh',at:10},hash='contract',good={handoffId:'fresh',contractHash:hash,status:'GO',summary:'verified'};assert.equal(relayResult([{role:'agent',ts:11,text:'AGENT_RELAY_RESULT '+JSON.stringify(good)}],intent,hash).ack,false);const user={role:'user',ts:10,text:'AGENT-RELAY fresh: Read brief.'};for(const patch of [{handoffId:'stale'},{contractHash:'other'}])assert.equal(relayResult([user,{role:'agent',ts:11,text:'AGENT_RELAY_RESULT '+JSON.stringify({...good,...patch})}],intent,hash).result,null);assert.equal(relayResult([user,{role:'agent',ts:11,text:'AGENT_RELAY_RESULT '+JSON.stringify(good)}],intent,hash).result.status,'GO');});
test('idle -> acknowledged builder -> exact revision review -> GO; source must finish before transfer',async()=>{const f=fixture();try{await f.relay.create(body);f.targets.get(builderId).state='working';await f.relay.tick();assert.equal(f.sends.length,0);f.targets.get(builderId).state='waiting';await f.relay.tick();assert.equal(f.sends.length,1);await f.relay.tick();assert.equal(f.sends.length,1,'no duplicate while awaiting acknowledgment');f.answer('READY');f.targets.get(builderId).state='working';await f.relay.tick();assert.equal(f.relay.jobs[0].turn,'builder','a saved receipt cannot start review while source edits');f.targets.get(builderId).state='waiting';await f.relay.tick();assert.equal(f.relay.jobs[0].turn,'tester');await f.relay.tick();assert.equal(f.sends.length,2);f.answer('GO',{criteriaPassed:true,blockers:[]});await f.relay.tick();assert.equal(f.relay.jobs[0].status,'approved');await f.relay.tick();assert.equal(f.sends.length,2);assert.ok(!JSON.stringify(f.relay.publicState()).includes('"created":"identity"'));}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('wrong revisions, optional feedback and unsupported GO cannot be approved',()=>{const job={turn:'tester',revision,round:1,maxRounds:4};for(const result of [{status:'GO',revision:'b'.repeat(40),evidence,criteriaPassed:true},{status:'GO',revision,evidence},{status:'GO',revision,criteriaPassed:true,evidence:[]},{status:'FIX',revision,blockers:[]}])assert.equal(relayVerdict(job,result).action,'attention');});
test('one recovery fits inside four reviews and does not reset progress or deadline',async()=>{const f=fixture();try{await f.relay.create(body);const deadline=f.relay.jobs[0].deadline;for(let round=1;round<=4;round++){
 await f.relay.tick();f.answer('READY');await f.relay.tick();await f.relay.tick();f.answer('FIX',{blockers:[block('same')]});await f.relay.tick();
 if(round===3){assert.equal(f.relay.jobs[0].status,'recovering');assert.equal(f.relay.jobs[0].round,4);f.finishCompact();await f.relay.tick();}
 }assert.equal(f.sends.filter(x=>x.compact).length,1);assert.equal(f.relay.jobs[0].status,'attention');assert.equal(f.relay.jobs[0].round,4);assert.equal(f.relay.jobs[0].deadline,deadline);assert.match(f.relay.jobs[0].detail,/maximum/);}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('uncertain delivery, restart, user stop and deadline never resend or close chats',async()=>{const f=fixture();try{await f.relay.create(body);await f.relay.tick();f.advance(91000);await f.relay.tick();assert.equal(f.relay.jobs[0].status,'attention');await f.relay.tick();assert.equal(f.sends.length,1);await f.relay.create(body);await f.relay.tick();const reloaded=new RelayCoordinator(f.args);assert.equal(reloaded.jobs.at(-1).status,'attention');await reloaded.tick();assert.equal(f.sends.length,2);await reloaded.create(body);reloaded.stop(reloaded.jobs.at(-1).id);await reloaded.tick();assert.equal(f.sends.length,2);await reloaded.create(body);f.advance(3600001);await reloaded.tick();assert.equal(reloaded.jobs.at(-1).status,'expired');assert.ok([...f.targets.values()].every(c=>c.alive));}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('concurrent create requests reserve one job before enrolling',async()=>{const f=fixture();try{const result=await Promise.allSettled([f.relay.create(body),f.relay.create(body)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.relay.jobs.length,1);}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('real transcript compaction markers are date bound for both providers',()=>{const f=fixture();try{const file=path.join(f.dir,'events.jsonl'),at=Date.now();for(const event of [{type:'compacted'},{type:'system',subtype:'compact_boundary'}]){fs.writeFileSync(file,JSON.stringify({...event,timestamp:new Date(at-10000).toISOString()})+'\n');assert.equal(hasCompaction({file},at),false);fs.appendFileSync(file,JSON.stringify({...event,timestamp:new Date(at+1).toISOString()})+'\n');assert.equal(hasCompaction({file},at),true);}}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('technical question -> existing peer answers -> origin resumes; no review or deadline reset',async()=>{const f=fixture();try{
 await f.relay.create(body);const job=f.relay.jobs[0],deadline=job.deadline;
 await f.relay.tick();f.answer('QUESTION',{question:{id:'scope1',prompt:'Does the explicit global policy apply to all types?',requiresUser:false}});await f.relay.tick();
 assert.equal(job.turn,'tester');assert.equal(job.round,1);await f.relay.tick();assert.match(f.sends.at(-1).brief,/Resolve one technical ambiguity/);
 f.answer('ANSWER',{questionId:'scope1',withinScope:true,answer:'Use the explicit policy from the fixed requirement.',evidence});await f.relay.tick();
 assert.equal(job.turn,'builder');assert.equal(job.question,null);await f.relay.tick();assert.match(f.sends.at(-1).brief,/Use the explicit policy/);
 f.answer('READY');await f.relay.tick();assert.equal(job.turn,'tester');assert.equal(job.round,1);assert.equal(job.deadline,deadline);assert.equal(job.questionCount,1);
}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('question loops, unsupported answers and questions requiring user authority never auto-approve',()=>{
 const question={id:'q1',prompt:'Choose a documented implementation option.',requiresUser:false};
 for(const job of [{questionCount:4},{questionIds:['q1']}])assert.equal(relayVerdict(job,{status:'QUESTION',question}).action,'attention');
 assert.equal(relayVerdict({}, {status:'QUESTION',question:{...question,requiresUser:true}}).action,'attention');
 for(const patch of [{withinScope:false},{evidence:[]},{questionId:'different'}])assert.equal(relayVerdict({question},{status:'ANSWER',questionId:'q1',withinScope:true,answer:'Decision',evidence,...patch}).action,'attention');
 assert.equal(relayVerdict({question},{status:'QUESTION',question}).action,'attention','clarification cannot recursively ask another model');
});
test('structured clarification preserves the full decision, rationale and boundaries',async()=>{
 const f=fixture();try{
  await f.relay.create(body);const job=f.relay.jobs[0],deadline=job.deadline;
  await f.relay.tick();f.answer('QUESTION',{question:{id:'R7-A2',prompt:'Does form completion also attest eligibility?',requiresUser:false}});await f.relay.tick();await f.relay.tick();
  const answer={decision:'No. Completion and eligibility are separate requirements.',rationale:['A completed answer can be no.','Canonical eligibility remains required.'],unchanged:['Keep privacy boundaries.'],acceptanceImpact:'None.'};
  f.answer('ANSWER',{questionId:'R7-A2',withinScope:true,answer});await f.relay.tick();
  assert.equal(job.turn,'builder');assert.deepEqual(job.lastDecision.answer,answer);assert.equal(job.round,1);assert.equal(job.deadline,deadline);
  await f.relay.tick();assert.match(f.sends.at(-1).brief,/Canonical eligibility remains required/);assert.match(f.sends.at(-1).brief,/Keep privacy boundaries/);
  for(const invalid of [null,[],{},' ',{decision:' '},{decision:'ok',padding:'x'.repeat(6000)}])assert.equal(validClarificationAnswer(invalid),false);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('acknowledged idle turn without a result gets one receipt repair, preserving all budgets',async()=>{
 const f=fixture();try{
  await f.relay.create(body);const job=f.relay.jobs[0],deadline=job.deadline;
  await f.relay.tick();f.acknowledge();await f.relay.tick();f.advance(61000);await f.relay.tick();assert.equal(job.status,'queued');
  await f.relay.tick();assert.equal(f.sends.length,2);assert.match(f.sends.at(-1).brief,/Repair only your completed result receipt/);
  assert.equal(job.round,1);assert.equal(job.deadline,deadline);f.acknowledge();await f.relay.tick();f.advance(61000);await f.relay.tick();
  assert.equal(job.status,'attention');await f.relay.tick();assert.equal(f.sends.length,2);assert.ok([...f.targets.values()].every(c=>c.alive));
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('a quiet busy chat is flagged without injecting a repair or interrupting its work',async()=>{
 const f=fixture();try{
  await f.relay.create(body);const job=f.relay.jobs[0];await f.relay.tick();f.acknowledge();f.targets.get(builderId).state='working';await f.relay.tick();
  f.advance(46*60000);await f.relay.tick();assert.equal(job.status,'attention');assert.equal(f.sends.length,1);assert.equal(f.targets.get(builderId).state,'working');
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
