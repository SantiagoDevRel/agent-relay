// Numeric-only derived index. Provider paths come from authenticated server targets.
// Streamed in small, resumable passes; never modifies source files or runs models.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { tokens } from './usage.mjs';
fs.mkdirSync(path.dirname(workerData.file),{recursive:true});
const db=new DatabaseSync(workerData.file);
db.exec(`pragma journal_mode=WAL; pragma synchronous=NORMAL;
 create table if not exists usage_files (chat text primary key, file text, offset integer, meta text, parser text);
 create table if not exists usage_events (key text primary key, chat text, ts integer, day text, model text, input integer, cached integer, cacheWrite integer, output integer, reasoning integer);
 create index if not exists usage_events_chat on usage_events(chat);
 create index if not exists usage_events_ts on usage_events(ts);`);
const insert=db.prepare('insert into usage_events values(?,?,?,?,?,?,?,?,?,?) on conflict(key) do update set input=max(input,excluded.input),cached=max(cached,excluded.cached),cacheWrite=max(cacheWrite,excluded.cacheWrite),output=max(output,excluded.output),reasoning=max(reasoning,excluded.reasoning)');
const save=db.prepare('insert into usage_files values(?,?,?,?,?) on conflict(chat) do update set file=excluded.file,offset=excluded.offset,meta=excluded.meta,parser=excluded.parser');
const sources=new Map(), progress=new Map();
let active=false, state={phase:'idle',files:0,total:0,bytes:0,skipped:0,errors:0,unsupported:0};
const publish=()=>parentPort.postMessage({state});
const hash=s=>createHash('sha256').update(s).digest('hex');
const dateFormat=new Intl.DateTimeFormat('sv-SE');
const day=ts=>dateFormat.format(new Date(ts));
function ingest(source,p,e) {
 if(e.type==='turn_context'&&e.payload?.model)p.model=e.payload.model;
 if(e.type==='session_meta') {
   const meta=e.payload||{};
   if(meta.forked_from_id||meta.forkedFromId||meta.forked_from||meta.parent_thread_id||meta.source?.subagent){p.unsupported=true;}
 }
 const ts=Date.parse(e.timestamp); if(!Number.isFinite(ts))return;
 let u,identity;
 if(source.tool==='claude'&&e.type==='assistant'&&e.message?.usage) {
   if(!e.message.id){p.skipped++;return;}
   u=tokens('claude',e.message.usage); p.model=e.message.model||p.model;
   identity=`claude:${e.message.id}`;
 } else if(source.tool==='codex'&&e.type==='event_msg'&&e.payload?.type==='token_count') {
   const total=tokens('codex',e.payload.info?.total_token_usage); if(!total)return;
   if(p.unsupported){p.last=total;return;}
   const before=p.last||{input:0,cached:0,cacheWrite:0,output:0,reasoning:0};
   if(total.input<before.input||total.output<before.output){p.skipped++;p.last=total;return;}
   u=Object.fromEntries(['input','cached','cacheWrite','output','reasoning'].map(k=>[k,Math.max(0,total[k]-before[k])]));
   p.last=total;
   identity=`codex:${source.id}:${ts}:${JSON.stringify(total)}`;
 } else return;
 if(!u||!u.input&&!u.output)return;
 if(p.unsupported)return;
 insert.run(hash(identity),source.id,ts,day(ts),p.model||'No model recorded',u.input,u.cached,u.cacheWrite,u.output,u.reasoning);
}
async function index() {
 if(active)return;active=true;state={phase:'indexing',files:0,total:sources.size,bytes:0,skipped:0,errors:0,unsupported:0};publish();
 try {
  // One bounded turn per source, rotated until all indexed. No file monopolizes the worker.
  let queue=[...sources.values()].sort((a,b)=>Number(b.alive)-Number(a.alive));
  while(queue.length) {
   const source=queue.shift(), chat=source.id, started=performance.now();
   let fd;
   try {
    fd=fs.openSync(source.file,'r'); const st=fs.fstatSync(fd);
    const old=db.prepare('select file,offset,parser from usage_files where chat=?').get(chat);
    let offset=old?.offset||0,p=old?JSON.parse(old.parser):{skipped:0};
    if(old&&(old.file!==source.file||st.size<offset)){
      // Only our own numeric derivative is retired; provider data stays untouched.
      db.prepare('delete from usage_events where chat=?').run(chat);offset=0;p={skipped:0};
    }
    const limit=Math.min(st.size,offset+256*1024),buf=Buffer.alloc(limit-offset);
    fs.readSync(fd,buf,0,buf.length,offset);
    let end=buf.lastIndexOf(10)+1;
    // Long lines: scan to newline without accumulating tool payloads in memory.
    if(!end&&buf.length===256*1024){p.discard=true;p.skipped++;end=buf.length;}
    db.exec('begin');
    try {
     for(const raw of buf.subarray(0,end).toString('utf8').split('\n')) {
      if(p.discard){if(raw!==''&&buf.includes(10))p.discard=false;continue;}
      if(!raw.trim())continue;
      try{ingest(source,p,JSON.parse(raw));}catch{p.skipped++;}
     }
     offset+=end;
     const {file,...meta}=source;
     save.run(chat,source.file,offset,JSON.stringify(meta),JSON.stringify(p));db.exec('commit');
    }catch(e){db.exec('rollback');throw e;}
    state.bytes+=buf.length;progress.set(chat,{skipped:p.skipped||0,unsupported:Number(!!p.unsupported)});
    if(offset<st.size&&end)queue.push(sources.get(chat)||source);else state.files++;
   }catch{state.errors++;state.files++;}finally{if(fd!==undefined)fs.closeSync(fd);}
   state.skipped=[...progress.values()].reduce((n,p)=>n+p.skipped,0);
   state.unsupported=[...progress.values()].reduce((n,p)=>n+p.unsupported,0);
   publish();await delay(Math.max(10,(performance.now()-started)*9));
  }
  state.phase='ready';
 }finally{active=false;publish();}
}
function stats(automated=false) {
 const where=automated?'1':"coalesce(json_extract(f.meta,'$.automated'),0)=0";
 const sums='sum(e.input) input,sum(e.cached) cached,sum(e.cacheWrite) cacheWrite,sum(e.output) output,sum(e.reasoning) reasoning,sum(e.input+e.output) total';
 const base=`from usage_events e join usage_files f on f.chat=e.chat where ${where}`;
 const since=Date.now()-7*86400000;
 const totals=db.prepare(`select ${sums} ${base} and e.ts>=?`).get(since);
 return {state,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,scope:'selected-chats-7-days',totals,
  days:db.prepare(`select e.day label,${sums} ${base} and e.ts>=? group by e.day order by e.day desc`).all(since),
  projects:db.prepare(`select coalesce(json_extract(f.meta,'$.folder'),'No folder') label,${sums} ${base} and e.ts>=? group by label order by total desc`).all(since),
  models:db.prepare(`select case when e.model='Sin modelo registrado' then 'No model recorded' else e.model end label,${sums} ${base} and e.ts>=? group by label order by total desc`).all(since),
  chats:db.prepare(`select e.chat id,${sums} ${base} and e.ts>=? group by e.chat order by total desc`).all(since)};
}
parentPort.on('message',({request,action,sources:incoming=[],automated=false})=>{
 try {
  if(action==='update'){for(const source of incoming)sources.set(source.id,source);index().catch(()=>{state.phase='error';state.errors++;publish();});parentPort.postMessage({request,result:state});}
  else if(action==='stats')parentPort.postMessage({request,result:stats(automated)});
  else parentPort.postMessage({request,error:'Unknown usage action'});
 }catch{parentPort.postMessage({request,error:'Usage index unavailable'});}
});
publish();
