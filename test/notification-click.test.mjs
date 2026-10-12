import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { notificationLink, parseNotificationLink, verifyNotificationLink } from '../server/notifications.mjs';
import { activateNotification } from '../server/notification-click.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const secret = 'a'.repeat(48);
const uri = notificationLink(id, 4848, secret);
test('toast links bind the chat and server run and reject shell/protocol input', () => {
  const target = parseNotificationLink(uri);
  assert.equal(target.id, id);
  assert.equal(verifyNotificationLink(id, target.signature, 4848, secret), true);
  assert.equal(verifyNotificationLink(id, target.signature, 4849, secret), false);
  assert.equal(verifyNotificationLink(id, target.signature, 4848, 'new-run'), false);
  assert.equal(verifyNotificationLink('22222222-2222-4222-8222-222222222222', target.signature, 4848, secret), false);
  for (const value of [uri+'" & calc', 'https://evil.test', uri+'?command=close', uri.replace('4848','99999'), null]) assert.equal(parseNotificationLink(value), null);
});
test('toast activation focuses its chat without opening the dashboard or resuming it', async () => {
  const requests = [], opened = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/ping')) return Response.json({ app:'chats-dashboard' });
    if (url.endsWith('/api/notification-click')) return Response.json({ found:true, focused:true });
    return new Response(`<meta name="chats-token" content="${secret}">`);
  };
  assert.deepEqual(await activateNotification(uri, { request, open: async url => opened.push(url) }), { focused:true, fallback:false });
  assert.equal(opened.length, 0);
  assert.equal(requests.length, 3);
  const activation = requests[2];
  assert.equal(activation.options.method, 'POST');
  assert.equal(activation.options.headers.Origin, 'http://127.0.0.1:4848');
  assert.equal(activation.options.headers['X-Chats-Token'], secret);
  assert.equal(JSON.parse(activation.options.body).id, id);
  assert.ok(requests.every(r => !/\/api\/(open|close|control)/.test(r.url)));
});
test('closed, missing, expired and unreachable toast targets fall back to their own card', async () => {
  for (const outcome of ['closed','missing','expired','offline','unfocused']) {
    const opened = [];
    const request = async url => {
      if (outcome === 'offline') throw new Error('offline');
      if (url.endsWith('/api/ping')) return Response.json({ app:'chats-dashboard' });
      if (url.endsWith('/api/notification-click')) return Response.json({ focused:false }, {status:{closed:409,missing:404,expired:403,unfocused:200}[outcome]});
      return new Response(`<meta name="chats-token" content="${secret}">`);
    };
    assert.deepEqual(await activateNotification(uri,{request,open:async url=>opened.push(url)}),{focused:false,fallback:true});
    assert.deepEqual(opened,[`http://127.0.0.1:4848/#chat-${id}`]);
  }
  let contacted = false;
  await assert.rejects(activateNotification('chats-dashboard-toast:bad',{request:async()=>{contacted=true;},open:async()=>{contacted=true;}}));
  assert.equal(contacted,false,'invalid URI has no effect');
});

test('Windows hidden toast launcher reaches the authenticated focus endpoint', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  let accept;
  const activation = new Promise(resolve => { accept = resolve; });
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(req.url);
      if (req.url === '/') { res.end(`<meta name="chats-token" content="${secret}">`); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/ping') { res.end(JSON.stringify({app:'chats-dashboard'})); return; }
      res.end(JSON.stringify({found:true,focused:true}));
      accept({headers:req.headers,method:req.method,body:JSON.parse(body)});
    });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  let deadline;
  try {
    const launch=fileURLToPath(new URL('../notification-click.vbs',import.meta.url));
    await promisify(execFile)('cscript.exe',['//nologo',launch,notificationLink(id,port,secret)],{windowsHide:true,timeout:5000});
    const result=await Promise.race([activation,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Hidden launcher did not activate')),8000);})]);
    assert.deepEqual(requests,['/api/ping','/','/api/notification-click']);
    assert.equal(result.method,'POST');assert.equal(result.headers.origin,`http://127.0.0.1:${port}`);
    assert.equal(result.headers['x-chats-token'],secret);assert.equal(result.body.id,id);
    assert.equal(verifyNotificationLink(id,result.body.signature,port,secret),true);
  } finally { clearTimeout(deadline);server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});
