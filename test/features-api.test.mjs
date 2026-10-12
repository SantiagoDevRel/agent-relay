import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { notificationLink, parseNotificationLink } from '../server/notifications.mjs';

test('feature APIs guard access, persist notes/favorites, retain old favorites and expose the real summary queue', { timeout: 30_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-feature-api-'));
  const project = path.join(home, '.claude/projects/fixture'); fs.mkdirSync(project, { recursive: true });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const files = ids.map(id => path.join(project, id + '.jsonl'));
  files.forEach((file, i) => fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: home, timestamp: new Date().toISOString(), message: { content: `Consulta extraordinaria ${i}` } }) + '\n'));
  let release;
  const hold = new Promise(r => { release = r; });
  const model = http.createServer(async (req, res) => {
    req.resume();
    if (req.url === '/api/chat') await hold;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{name:'fake-model'}] } : req.url === '/api/ps' ? { models: [] }
      : { message: { content: JSON.stringify({tema:'Test',hecho:['Verificado'],estado:'Completo',pendiente:[]}) } }));
  });
  await new Promise(r => model.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:4866'; let child;
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  async function start() {
    child=spawn(process.execPath,['--no-warnings',fileURLToPath(new URL('../server/server.mjs',import.meta.url))],{
      env:{...process.env,CHATS_PORT:'4866',USERPROFILE:home,HOME:home,LOCALAPPDATA:home,CHATS_SUMMARY_URL:`http://127.0.0.1:${model.address().port}`,CHATS_SUMMARY_MODEL:'fake-model'},windowsHide:true,stdio:'ignore'});
    for(let i=0;i<100;i++) { try { const text=await(await fetch(base)).text(); const token=text.match(/name="chats-token" content="([a-f0-9]{48})"/)?.[1]; if(token) {
      for(let n=0;n<100;n++) { if((await(await fetch(`${base}/api/snapshot?t=${token}`)).json()).chats) return token; await sleep(50); }
    } }catch{} await sleep(50); }
    throw new Error('Server startup timeout');
  }
  async function stop() { if(child.exitCode!==null)return; const done=new Promise(r=>child.once('exit',r));child.kill();await done; }
  try {
    let token=await start();
    const get=async route => (await fetch(`${base}${route}${route.includes('?')?'&':'?'}t=${token}`)).json();
    const post=async (route,body) => fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Chats-Token':token},body:JSON.stringify(body)});
    for(const route of ['/api/history','/api/services','/api/queue','/api/insights']) assert.equal((await fetch(base+route)).status,403);
    for(const route of ['/api/templates','/api/assistance','/api/relay/start','/api/relay/stop']) assert.equal((await fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.deepEqual((await get('/api/snapshot')).relays,{jobs:[],error:''},'relay is inactive by default');
    assert.equal((await post('/api/relay/start',{})).status,400);
    const relayRequest={builderId:ids[0],testerId:ids[1],goal:'Implement the requested fix',acceptance:'All fixed tests must pass',maxRounds:4,minutes:120};
    assert.equal((await post('/api/relay/start',{...relayRequest,maxRounds:11})).status,400);
    assert.equal((await post('/api/relay/start',{...relayRequest,maxRounds:10})).status,409,'ten reviews pass validation; closed chats remain protected');
    assert.equal((await post('/api/relay/start',relayRequest)).status,409,'closed chats are never reopened by a relay');
    assert.equal((await post('/api/relay/stop',{id:ids[0]})).status,404);
    assert.equal((await fetch(base+'/api/relay/start',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json','X-Chats-Token':token},body:JSON.stringify(relayRequest)})).status,403);
    assert.equal((await post('/api/preferences',{id:'__proto__',note:'x'})).status,404);
    assert.equal((await post('/api/preferences',{id:ids[0],note:'a'.repeat(2001)})).status,400);
    const note='💛'.repeat(900);
    assert.equal((await post('/api/preferences',{id:ids[0],note})).status,200,'Unicode notes fit the body limit');
    assert.equal((await post('/api/preferences',{id:ids[0],favorite:true})).status,200);
    assert.equal((await post('/api/preferences',{id:ids[0],outcome:'invented'})).status,400);
    assert.equal((await post('/api/preferences',{id:ids[0],outcome:'useful'})).status,200);
    const sourceChat=(await get('/api/snapshot')).chats.find(c=>c.id===ids[0]);
    for(const projectFolder of [12,{},'x'.repeat(301),'bad\nproject']) assert.equal((await post('/api/preferences',{id:ids[0],projectFolder})).status,400);
    assert.equal((await post('/api/preferences',{id:ids[0],projectFolder:'sample-app'})).status,200);
    let associated=(await get('/api/snapshot')).chats.find(c=>c.id===ids[0]);
    assert.equal(associated.projectFolder,'sample-app');
    for(const field of ['folder','cdCommand','runCommand','resumeCommand']) assert.equal(associated[field],sourceChat[field],`visual grouping preserves ${field}`);
    assert.equal((await post('/api/preferences',{id:ids[0],projectFolder:null})).status,200);
    assert.equal((await get('/api/snapshot')).chats.find(c=>c.id===ids[0]).projectFolder,null,'automatic grouping can be restored');
    await post('/api/preferences',{id:ids[0],projectFolder:'sample-app'});
    assert.equal((await post('/api/assistance',{handoffTokens:0,handoffPercent:99})).status,400);
    assert.equal((await post('/api/assistance',{handoffTokens:250000,handoffPercent:85})).status,200);
    assert.equal((await post('/api/templates',{id:'__proto__',name:'x',text:'x'})).status,400);
    const template={id:'33333333-3333-4333-8333-333333333333',name:'Mi plantilla',text:'💛'.repeat(5000)};
    assert.equal((await post('/api/templates',template)).status,200,'maximum-length Unicode template fits its bounded body limit');
    assert.equal((await post('/api/templates',{...template,text:template.text+'x'})).status,400);
    await post('/api/control',{action:'pause'});
    assert.equal((await post('/api/relay/start',relayRequest)).status,409,'pause never starts a relay');
    assert.equal((await post('/api/assistance',{handoffTokens:260000,handoffPercent:80})).status,409);
    await post('/api/control',{action:'resume'});
    assert.equal((await get('/api/snapshot')).chats.find(c=>c.id===ids[0]).note,note);
    assert.equal((await post('/api/notifications',{enabled:'true'})).status,400);
    const click = parseNotificationLink(notificationLink(ids[0],4866,token));
    assert.equal((await post('/api/notification-click',{id:ids[0],signature:'0'.repeat(64)})).status,403);
    assert.equal((await post('/api/notification-click',click)).status,409,'a real signed notification for a closed chat never launches or focuses anything');
    const first=post('/api/summary',{id:ids[0]}),second=post('/api/summary',{id:ids[1]});
    let queue;
    for(let i=0;i<40;i++) { queue=(await get('/api/queue')).queue; if(queue.length===2)break; await sleep(50); }
    assert.deepEqual(queue.map(j=>j.status),['running','queued']);
    const services=await get('/api/services'); assert.equal(services.dgx.installed,true);assert.equal(services.queue.length,2);
    release(); assert.equal((await first).status,200);assert.equal((await second).status,200);
    assert.equal((await get('/api/queue')).queue.length,0);
    await stop();
    const old=new Date(Date.now()-30*86400_000);fs.utimesSync(files[0],old,old);
    token=await start();
    const saved=(await get('/api/snapshot')).chats.find(c=>c.id===ids[0]);
    assert.equal(saved.favorite,true,'favorite remains visible beyond the day window after restart');assert.equal(saved.note,note);
    assert.equal(saved.outcome,'useful');
    assert.equal(saved.projectFolder,'sample-app','visual project association persists after restart');
    for(const field of ['folder','cdCommand','runCommand','resumeCommand']) assert.equal(saved[field],sourceChat[field]);
    const insights=await get('/api/insights');
    assert.deepEqual(insights.assistance,{handoffTokens:250000,handoffPercent:85});
    assert.deepEqual(insights.templates,[template]);
    let history;
    for(let i=0;i<50;i++) { history=await get('/api/history?q=extraordinaria');if(history.state.phase==='ready')break;await sleep(50); }
    assert.equal(history.total,2); assert.ok(history.results.every(h=>!('file' in h)&&!('cwd' in h)));
    assert.equal((await fetch(`${base}/api/history?q=x&offset=-1&t=${token}`)).status,400);
  } finally { release();await stop();await new Promise(r=>model.close(r));fs.rmSync(home,{force:true,recursive:true}); }
});
