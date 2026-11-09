// Ordinary input to an existing, idle console. Never resumes/closes a provider.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {processIdentity} from './system.mjs';
import {sessionOf} from './claude.mjs';
import {LinuxChats} from './linux-chats.mjs';
const linux = process.platform === 'linux' ? new LinuxChats() : null;
const run=promisify(execFile),script=fileURLToPath(new URL('./relay-input.ps1',import.meta.url));
export async function enrollChat(chat){
 if(linux)return linux.enroll(chat);
 if(!chat?.alive||!chat.pid||chat.automated||!chat.file)throw Error('chat unavailable');
 const identity=await processIdentity(chat.pid);
 if(identity?.image!==chat.tool+'.exe')throw Error('process changed');
 if(chat.tool==='claude'){
  const session=sessionOf(chat.pid);
  if(session?.sessionId!==chat.id||!session.procStart||String(session.procStart)!==identity.created)throw Error('session changed');
 }else if(!chat.pidSeenAt||identity.createdMs>chat.pidSeenAt+1000)throw Error('session identity unavailable');
 return {id:chat.id,pid:chat.pid,tool:chat.tool,created:identity.created};
}
// Windows refusals made before any key is written: certain, so callers may say "Not sent".
const NOT_SENT_REASONS=new Set(['draft','no-composer','identity','busy']);
const notSent=(reason,message)=>Object.assign(Error(`${message}; nothing was typed`),{code:'RELAY_NOT_SENT',reason});
async function submitInput(chat,enrolled,folder,handoffId,text){
 if(chat.id!==enrolled.id||chat.pid!==enrolled.pid||chat.state!=='waiting'){
  if(linux)throw notSent(chat.id===enrolled.id&&chat.pid===enrolled.pid?'busy':'identity','chat busy or changed');
  throw notSent(chat.id===enrolled.id&&chat.pid===enrolled.pid?'busy':'identity','chat busy or changed');
 }
 if(linux){
  if(text.startsWith('/'))throw Error('Terminal commands are unavailable in Linux Conversation');
  const result=linux.send(chat,enrolled,text);
  fs.writeFileSync(path.join(folder,handoffId+'-transport.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
  return result;
 }
 let current;
 try{current=await enrollChat(chat);}catch(error){throw notSent('identity',error.message);}
 if(current.created!==enrolled.created)throw notSent('identity','process changed');
 if(chat.tool==='claude'&&sessionOf(chat.pid)?.status!=='idle')throw notSent('busy','chat busy');
 const requestFile=path.join(folder,handoffId+'-input.json');
 const receipt=path.join(folder,handoffId+'-transport.json');
 const spec={pid:chat.pid,image:chat.tool,startedTicks:enrolled.created,
  text,receipt};
 fs.writeFileSync(requestFile,JSON.stringify(spec),{flag:'wx'});
 await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{
  windowsHide:true,timeout:20000,maxBuffer:64000,env:{...process.env,AGENT_RELAY_INPUT_FILE:requestFile}});
 const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
 if(result.submitted===false&&result.notSent===true&&NOT_SENT_REASONS.has(result.reason))
  throw notSent(result.reason,`Input guard refused (${result.reason})`);
 if(result.submitted!==true)throw Error('delivery uncertain');
 return result;
}
export const deliverInput=(chat,enrolled,file,id)=>submitInput(chat,enrolled,path.dirname(file),id,`AGENT-RELAY ${id}: Read and execute ${file}. Continue in this same chat.`);
export const compactInput=(chat,enrolled,folder,id)=>submitInput(chat,enrolled,folder,id,'/compact');
export const messageCommand=(file,id)=>`AGENT-RELAY MESSAGE ${id}: Read the user's message in ${file} and respond in this same chat.`;
export const messageInput=(chat,enrolled,file,id)=>submitInput(chat,enrolled,path.dirname(file),id,messageCommand(file,id));
