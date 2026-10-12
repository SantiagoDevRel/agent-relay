// Real HTTP -> collector -> guarded Win32 console input -> transcript -> review.
// Only isolated fake provider processes and files are used, never real chats.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {processIdentity} from '../server/system.mjs';
import {projectKey} from '../server/claude.mjs';
const run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fakeSource=String.raw`
import fs from 'node:fs';
const [marker,session,transcript,role]=process.argv.slice(2);
fs.writeFileSync(marker,String(process.pid));process.stdin.setRawMode(true);process.stdin.resume();
let input='',turn=0;
process.stdout.write('\u276f ');
process.stdin.on('data',bytes=>{for(const byte of bytes){
 if(byte!==13){input+=String.fromCharCode(byte);continue;}
 const text=input;input='';
 try{
  if(text.startsWith('AGENT-RELAY MESSAGE ')){
   const file=text.match(/Read the user's message in (.+) and respond in this same chat\.$/)[1];
   const message=fs.readFileSync(file,'utf8').replace(/^# Message from the user\n\n/,'').trim();
   fs.appendFileSync(transcript,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{content:text}})+'\n');
   fs.appendFileSync(transcript,JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{content:[{type:'text',text:'Received user message: '+message}]}})+'\n');
   process.stdout.write('\r\n\u276f ');continue;
  }
  turn++;
  const file=text.match(/Read and execute (.+)\. Continue in this same chat\.$/)[1];
  const brief=fs.readFileSync(file,'utf8'),schema=JSON.parse(brief.split('\n').find(line=>line.startsWith('{"handoffId"')));
  const clarification=brief.includes('## Resolve one technical ambiguity, then finish');
  const revision=role==='builder'?String(turn).repeat(40):clarification?undefined:brief.match(/Independently verify exactly revision ([a-f0-9]{40})\./)[1];
  const status=role==='builder'?(turn===1?'QUESTION':'READY'):clarification?'ANSWER':turn===2?'FIX':'GO';
  const result={...schema,status,revision,summary:'Isolated native fixture verified.',criteriaPassed:status==='GO',evidence:[transcript],blockers:status==='FIX'?[{id:'F1',expected:'accepted',actual:'blocked',reproducer:'native fixture case one',cause:'first fixture revision'}]:[]};
  if(status==='QUESTION')result.question={id:'Q1',prompt:'Which policy does the fixed native fixture require?',requiresUser:false};
  if(status==='ANSWER'){result.questionId='Q1';result.withinScope=true;result.answer={decision:'Apply the fixed fixture policy without changing acceptance.',rationale:['The fixed contract governs.'],unchanged:['Preserve the review and time budgets.']};}
  fs.appendFileSync(transcript,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{content:text}})+'\n');
  fs.appendFileSync(transcript,JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{content:[{type:'text',text:'AGENT_RELAY_RESULT '+JSON.stringify(result)}]}})+'\n');
  const s=JSON.parse(fs.readFileSync(session));fs.writeFileSync(session,JSON.stringify({...s,status:'idle',updatedAt:Date.now()}));
  process.stdout.write('\r\n\u276f ');
 }catch(error){fs.writeFileSync(marker+'.error',error.stack);}
}});setInterval(()=>{},60000);
`;
const nativeWaitMs=Math.min(180000,Math.max(65000,Number(process.env.CHATS_TEST_WAIT_MS)||65000));
async function until(check,what,ms=nativeWaitMs){const deadline=Date.now()+ms;while(Date.now()<deadline){const result=await check();if(result)return result;await sleep(100);}throw Error('Timed out: '+what);}
test('on-demand relay resolves a technical question and completes native FIX -> correction -> GO', {skip:process.platform!=='win32',timeout:nativeWaitMs+45000},async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'relay-native-')),work=path.join(home,'work'),sessions=path.join(home,'.claude/sessions'),project=path.join(home,'.claude/projects',projectKey(work));
 for(const dir of [work,sessions,project])fs.mkdirSync(dir,{recursive:true});
 const fake=path.join(home,'claude.exe'),script=path.join(home,'fake.mjs'),pids=[];
 try{fs.linkSync(process.execPath,fake);}catch{fs.copyFileSync(process.execPath,fake);}fs.writeFileSync(script,fakeSource);
 const lease=net.createServer();await new Promise(r=>lease.listen(0,'127.0.0.1',r));const port=lease.address().port;await new Promise(r=>lease.close(r));
 const base='http://127.0.0.1:'+port;let server;
 try{
  const ids=[];
  for(const role of ['builder','tester']){
   const id=crypto.randomUUID(),marker=path.join(home,role+'.pid'),file=path.join(project,id+'.jsonl');ids.push(id);
   fs.writeFileSync(file,JSON.stringify({type:'user',cwd:work,timestamp:new Date().toISOString(),message:{content:'Native fixture '+role}})+'\n');
   // Session path is known only after startup; pass a stable fixture path, then link it.
   const session=path.join(home,role+'-session.json');
   await run('powershell.exe',['-NoProfile','-Command',`Start-Process conhost.exe -WindowStyle Hidden -ArgumentList '"${fake}" "${script}" "${marker}" "${session}" "${file}" "${role}"'`],{windowsHide:true});
   const pid=await until(()=>fs.existsSync(marker)&&Number(fs.readFileSync(marker,'utf8')),role+' process',15000);pids.push(pid);
   const identity=await processIdentity(pid),data={pid,sessionId:id,cwd:work,startedAt:identity.createdMs,procStart:identity.created,kind:'interactive',entrypoint:'cli',status:'idle',updatedAt:Date.now()};
   fs.writeFileSync(session,JSON.stringify(data));fs.linkSync(session,path.join(sessions,pid+'.json'));
  }
  server=spawn(process.execPath,['--no-warnings',fileURLToPath(new URL('../server/server.mjs',import.meta.url))],{env:{...process.env,USERPROFILE:home,HOME:home,LOCALAPPDATA:home,CHATS_PORT:String(port),CHATS_SUMMARY_URL:'http://127.0.0.1:1'},windowsHide:true,stdio:'ignore'});
  const token=await until(async()=>{try{return (await(await fetch(base)).text()).match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1];}catch{return false;}},'server',15000);
  const snapshot=async()=> (await(await fetch(base+'/api/snapshot?t='+token)).json());
  const post=(route,body)=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Chats-Token':token},body:JSON.stringify(body)});
  await until(async()=> (await snapshot()).chats?.filter(c=>ids.includes(c.id)&&c.alive).length===2,'both fixture chats');
  assert.deepEqual((await snapshot()).relays.jobs,[]);
  const userMessage='Añade una función\ny conserva mi configuración.';
  const sent=await post('/api/chat/message',{id:ids[0],text:userMessage});assert.equal(sent.status,200);assert.equal((await sent.json()).status,'submitted');
  const conversation=await until(async()=>{const value=await(await fetch(`${base}/api/chat/conversation?id=${ids[0]}&t=${token}`)).json();return value.messages?.some(message=>message.text.includes(userMessage))&&value;},'native Unicode message response');
  assert.equal(conversation.canSend,true);assert.ok(conversation.messages.some(message=>message.role==='agent'&&message.text==='Received user message: '+userMessage));
  assert.ok(conversation.messages.some(message=>message.role==='user'&&message.text===userMessage),'the app shows the actual user text rather than the transport file command');
  const response=await post('/api/relay/start',{builderId:ids[0],testerId:ids[1],goal:'Implement only the native fixture change.',acceptance:'The isolated tester must approve revision two.',maxRounds:4,minutes:10});
  assert.equal(response.status,200);
  assert.equal((await post('/api/chat/message',{id:ids[0],text:'Do not send to a leased chat.'})).status,409);
  let lastJob;
  const approved=await until(async()=>{for(const role of ['builder','tester']){const error=path.join(home,role+'.pid.error');if(fs.existsSync(error))throw Error(fs.readFileSync(error,'utf8'));}const job=(await snapshot()).relays.jobs[0];lastJob=job;if(job?.status==='attention')throw Error(job.detail);return job?.status==='approved'&&job;},'native independent GO').catch(error=>{throw Error(error.message+'; last fixture job: '+JSON.stringify(lastJob));});
  assert.equal(approved.round,2);assert.equal(approved.revision,'3'.repeat(40));assert.equal(approved.questionCount,1);
  assert.equal(approved.lastDecision.answer.decision,'Apply the fixed fixture policy without changing acceptance.');
  assert.deepEqual(approved.lastDecision.answer.unchanged,['Preserve the review and time budgets.']);
  assert.equal(approved.events.filter(e=>e.text.startsWith('Sending to ')).length,6);
  assert.ok(!JSON.stringify(approved).includes('"created":'),'process creation identities are private');
  for(const pid of pids)assert.doesNotThrow(()=>process.kill(pid,0),'fixture chats remain alive after GO');
  for(const id of ids){const transcript=fs.readFileSync(path.join(project,id+'.jsonl'),'utf8');assert.equal((transcript.match(/AGENT-RELAY [a-f0-9-]{36}:/g)||[]).length,3,'exactly three pair deliveries per chat including clarification');}
 }finally{
  if(server&&server.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}
  for(const pid of pids)try{process.kill(pid);}catch{/* Only our fixture PIDs. */}
  await sleep(100);fs.rmSync(home,{recursive:true,force:true});
 }
});
