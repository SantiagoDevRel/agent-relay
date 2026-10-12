import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokens, applyUsage, publicUsage, advice } from '../server/usage.mjs';
import { resourceSample } from '../server/resources.mjs';
import { HistoryIndex } from '../server/history.mjs';
import { readRollout } from '../server/codex.mjs';
test('provider accounting distinguishes cache, reasoning, context and cumulative usage',()=>{
 assert.equal(tokens('claude',null),null);
 assert.equal(tokens('claude',{unrecognized:10}),null);
 assert.deepEqual(tokens('claude',{input_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:10,output_tokens:5}),{input:112,cached:100,cacheWrite:10,output:5,reasoning:0,total:117});
 const p={}; applyUsage(p,{type:'turn_context',payload:{model:'test-model'}},'codex');
 applyUsage(p,{timestamp:'2026-10-08T10:00:00Z',type:'event_msg',payload:{type:'token_count',info:{model_context_window:200,last_token_usage:{input_tokens:160,cached_input_tokens:150,output_tokens:10,reasoning_output_tokens:6},total_token_usage:{input_tokens:10000,output_tokens:1000}}}},'codex');
 const u=publicUsage(p);assert.equal(u.last.total,170);assert.equal(u.contextPercent,80);assert.equal(u.cumulative.total,11000);assert.equal(advice(u).length,1);
 applyUsage(p,{type:'compacted'},'codex');assert.equal(publicUsage(p).contextTokens,null);assert.equal(advice(publicUsage(p)).length,0);
});
test('process CPU is normalized over an interval and never attributed across PID reuse',()=>{
 const old={at:1000,rows:[{pid:1,name:'claude',created:'a',cpuSeconds:2}]};
 const row={pid:1,name:'claude',created:'a',cpuSeconds:4};
 assert.equal(resourceSample([row],old,11000,4)[0].cpuPercent,5);
 assert.equal(resourceSample([{...row,created:'b'}],old,11000,4)[0].cpuPercent,null);
 assert.equal(resourceSample([row],null,11000,4)[0].cpuPercent,null);
 assert.equal(resourceSample([{...row,cpuSeconds:null}],old,11000,4)[0].cpuPercent,null);
});

test('live Codex usage clears compacted context and counts observed interruptions once',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chats-live-usage-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'rollout.jsonl');
 const event=(second,type,payload)=>({timestamp:`2026-10-08T10:00:0${second}Z`,type,payload});
 const write=e=>fs.appendFileSync(file,JSON.stringify(e)+'\n');
 write(event(0,'turn_context',{model:'test'}));
 write(event(1,'event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:170,output_tokens:5},model_context_window:200}}));
 assert.equal(publicUsage(readRollout(file).usage).contextPercent,85);
 write(event(2,'compacted',{}));write(event(3,'event_msg',{type:'turn_aborted'}));
 let u=publicUsage(readRollout(file).usage);assert.equal(u.contextTokens,null);assert.equal(u.interruptions,1);assert.equal(u.compactions,1);
 write(event(4,'event_msg',{type:'task_started'}));
 u=publicUsage(readRollout(file).usage);assert.equal(u.interruptions,1);assert.equal(u.compactions,1);
 write(event(5,'event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:30,output_tokens:5},model_context_window:200}}));
 assert.equal(publicUsage(readRollout(file).usage).contextPercent,15);
});
test('numeric index deduplicates Claude responses, Codex deltas, resumes and skips inherited forks',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chats-usage-'));
 const file=path.join(dir,'claude.jsonl'), codex=path.join(dir,'codex.jsonl'), fork=path.join(dir,'fork.jsonl');
 const timestamp=new Date().toISOString();
 const a={type:'assistant',timestamp,message:{id:'unique-response',model:'claude-test',usage:{input_tokens:2,cache_read_input_tokens:100,output_tokens:5},content:[{type:'text',text:'PRIVATE NOT STORED'}]}};
 fs.writeFileSync(file,[a,a,{...a,message:{...a.message,usage:{input_tokens:2,cache_read_input_tokens:100,output_tokens:8}}}].map(JSON.stringify).join('\n')+'\n');
 const c=u=>({type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:u}}});
 fs.writeFileSync(codex,[{type:'turn_context',payload:{model:'codex-test'}},c({input_tokens:100,cached_input_tokens:90,output_tokens:10}),c({input_tokens:200,cached_input_tokens:180,output_tokens:30}),c({input_tokens:200,cached_input_tokens:180,output_tokens:30})].map(JSON.stringify).join('\n')+'\n');
 fs.writeFileSync(fork,[{type:'session_meta',payload:{forked_from_id:'parent'}},c({input_tokens:10000,output_tokens:1000})].map(JSON.stringify).join('\n')+'\n');
 const dbFile=path.join(dir,'usage.sqlite');let index=new HistoryIndex(dir,dbFile,'./usage-worker.mjs');
 t.after(async()=>{await index.worker?.terminate();fs.rmSync(dir,{recursive:true,force:true});});
 const sources=[{id:'claude-id',file,tool:'claude',folder:'Project',alive:true},{id:'codex-id',file:codex,tool:'codex',folder:'Project'},{id:'fork-id',file:fork,tool:'codex',folder:'Other'}];
 const refresh=async()=>{await index.request('update',{sources});for(let n=0;n<200;n++){const r=await index.request('stats');if(r.state.phase==='ready')return r;await new Promise(r=>setTimeout(r,10));}throw Error('Index timed out');};
 let result=await refresh();assert.equal(result.totals.input,302);assert.equal(result.totals.output,38);assert.equal(result.state.unsupported,1);assert.equal(result.models.length,2);
 assert.equal(fs.readFileSync(dbFile).includes(Buffer.from('PRIVATE NOT STORED')),false);
 await index.worker.terminate();index=new HistoryIndex(dir,dbFile,'./usage-worker.mjs');
 result=await refresh();assert.equal(result.totals.total,340);assert.equal(result.state.bytes,0);
 fs.appendFileSync(file,JSON.stringify({...a,message:{...a.message,id:'second',usage:{input_tokens:3,output_tokens:4}}})+'\n');
 result=await refresh();assert.equal(result.totals.total,347);assert.equal(result.chats.length,2);
 // A giant tool line is skipped, and the next usage record must still be indexed.
 fs.appendFileSync(file,'{"tool":"'+ 'x'.repeat(600000)+'"}\n'+JSON.stringify({...a,message:{...a.message,id:'third',usage:{input_tokens:7,output_tokens:2}}})+'\n');
 result=await refresh();assert.equal(result.totals.total,356);assert.ok(result.state.skipped>0);
});
