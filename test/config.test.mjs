import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const moduleUrl=new URL('../server/config.mjs',import.meta.url).href;
test('external private configuration preserves explicit environment and never writes source or private inputs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-config-')),file=path.join(dir,'config.local.json');
 const value={CHATS_WORKSPACE_ROOT:dir,CHATS_TOPICS_FILE:path.join(dir,'topics.local.json'),CHATS_SUMMARY_URL:'http://127.0.0.1:9'};
 fs.writeFileSync(file,JSON.stringify(value));const before=fs.readFileSync(file);
 try{
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {WORKSPACE,TOPICS_FILE} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify({WORKSPACE,TOPICS_FILE,url:process.env.CHATS_SUMMARY_URL}));`],{windowsHide:true,encoding:'utf8',env:{...process.env,CHATS_CONFIG_FILE:file,CHATS_SUMMARY_URL:'http://127.0.0.1:10'}});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{WORKSPACE:dir,TOPICS_FILE:value.CHATS_TOPICS_FILE,url:'http://127.0.0.1:10'});assert.deepEqual(fs.readFileSync(file),before);
  fs.writeFileSync(file,JSON.stringify({UNKNOWN:'reject'}));const invalid=spawnSync(process.execPath,['--input-type=module','-e',`import ${JSON.stringify(moduleUrl)}`],{windowsHide:true,env:{...process.env,CHATS_CONFIG_FILE:file}});assert.notEqual(invalid.status,0);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('external Delivery defaults preserve local production selection and repository override takes precedence',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-delivery-config-')),project=path.join(dir,'sample-app'),file=path.join(dir,'delivery.local.json');fs.mkdirSync(project);fs.writeFileSync(file,JSON.stringify({'SAMPLE-APP':'origin/production'}));
 const url=new URL('../server/delivery-git.mjs',import.meta.url).href;
 const probe=()=>spawnSync(process.execPath,['--input-type=module','-e',`import {configFor} from ${JSON.stringify(url)};console.log(configFor(${JSON.stringify(project)}).productionRef)`],{windowsHide:true,encoding:'utf8',env:{...process.env,CHATS_DELIVERY_DEFAULTS_FILE:file}});
 try{const first=probe();assert.equal(first.status,0,first.stderr);assert.equal(first.stdout.trim(),'origin/production');fs.writeFileSync(path.join(project,'.agent-relay-delivery.json'),JSON.stringify({productionRef:'origin/release'}));assert.equal(probe().stdout.trim(),'origin/release');fs.writeFileSync(file,JSON.stringify({'sample-app':'../invalid'}));assert.notEqual(probe().status,0);}finally{fs.rmSync(dir,{recursive:true});}
});
