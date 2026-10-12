// Ordinary input to an existing, idle console. Never resumes/closes a provider.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {processIdentity} from './system.mjs';
import {sessionOf} from './claude.mjs';
const run=promisify(execFile),script=fileURLToPath(new URL('./relay-input.ps1',import.meta.url));
export async function enrollChat(chat){
 if(!chat?.alive||!chat.pid||chat.automated||!chat.file)throw Error('chat unavailable');
 const identity=await processIdentity(chat.pid);
 if(identity?.image!==chat.tool+'.exe')throw Error('process changed');
 if(chat.tool==='claude'){
  const session=sessionOf(chat.pid);
  if(session?.sessionId!==chat.id||!session.procStart||String(session.procStart)!==identity.created)throw Error('session changed');
 }else if(!chat.pidSeenAt||identity.createdMs>chat.pidSeenAt+1000)throw Error('session identity unavailable');
 return {id:chat.id,pid:chat.pid,tool:chat.tool,created:identity.created};
}
async function submitInput(chat,enrolled,folder,handoffId,text){
 if(chat.id!==enrolled.id||chat.pid!==enrolled.pid||chat.state!=='waiting')throw Error('chat busy or changed');
 const current=await enrollChat(chat);
 if(current.created!==enrolled.created)throw Error('process changed');
 if(chat.tool==='claude'&&sessionOf(chat.pid)?.status!=='idle')throw Error('chat busy');
 const requestFile=path.join(folder,handoffId+'-input.json');
 const receipt=path.join(folder,handoffId+'-transport.json');
 const spec={pid:chat.pid,image:chat.tool,startedTicks:enrolled.created,
  text,receipt};
 fs.writeFileSync(requestFile,JSON.stringify(spec),{flag:'wx'});
 await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{
  windowsHide:true,timeout:20000,maxBuffer:64000,env:{...process.env,AGENT_RELAY_INPUT_FILE:requestFile}});
 const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
 if(result.submitted!==true)throw Error('delivery uncertain');
 return result;
}
export const deliverInput=(chat,enrolled,file,id)=>submitInput(chat,enrolled,path.dirname(file),id,`AGENT-RELAY ${id}: Read and execute ${file}. Continue in this same chat.`);
export const compactInput=(chat,enrolled,folder,id)=>submitInput(chat,enrolled,folder,id,'/compact');
export const messageCommand=(file,id)=>`AGENT-RELAY MESSAGE ${id}: Read the user's message in ${file} and respond in this same chat.`;
export const messageInput=(chat,enrolled,file,id)=>submitInput(chat,enrolled,path.dirname(file),id,messageCommand(file,id));
