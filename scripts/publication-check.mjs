#!/usr/bin/env node
// Exact allowlist plus redacted privacy-pattern checks. No network or file mutation.
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
function git(args){const result=spawnSync('git',args,{cwd:root,windowsHide:true,maxBuffer:32*1024*1024});if(result.status!==0)throw Error('Git inspection failed');return result.stdout;}
const mode=process.argv[2] || 'snapshot';
const allowed=JSON.parse(fs.readFileSync(path.join(root,'public-files.json'),'utf8'));
if(!Array.isArray(allowed)||new Set(allowed).size!==allowed.length||allowed.some(file=>typeof file!=='string'||!file||file.startsWith('/')||file.includes('..')||file.includes('\\')))throw Error('Invalid publication allowlist');
const names=mode==='staged'?git(['ls-files','-z']).toString().split('\0').filter(Boolean):mode==='commit'?git(['ls-tree','-r','--name-only','-z','HEAD']).toString().split('\0').filter(Boolean):mode==='snapshot'?allowed:null;
if(!names)throw Error('Use snapshot, staged or commit');
const findings=[];
for(const file of names){
 if(!allowed.includes(file)){findings.push({file,category:'unreviewed-file'});continue;}
 const bytes=mode==='snapshot'?fs.readFileSync(path.join(root,file)):git(['show',(mode==='commit'?'HEAD:':':')+file]);
 if(/\.(png|ico)$/.test(file))continue; // Binary metadata and visuals require separate review/scanning.
 const text=bytes.toString('utf8');
 const rules=[['private-key',/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],['credential',/\b(?:sk-[a-zA-Z0-9]{24,}|gh[pousr]_[a-zA-Z0-9]{25,}|AKIA[A-Z0-9]{16})\b/],['home-path',/(?:[A-Z]:[\\/]+Users[\\/]+|\/home\/|\/Users\/)(?!test\b|me\b|user\b|alice\b|example\b|owner\b|nobody\b)[a-zA-Z0-9_.-]+/i],['internal-address',/https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(?::\d+)?/i]];
 for(const [category,pattern] of rules)if(pattern.test(text))findings.push({file,category});
 if(/(?:^|\/)(?:\.env[^/]*|topics\.json|[^/]*\.local\.json|[^/]*\.(?:sqlite|jsonl|log|pem|key))$/i.test(file))findings.push({file,category:'private-file'});
}
if(mode!=='snapshot'&&names.length!==allowed.length)findings.push({category:'incomplete-allowlist'});
if(mode==='snapshot'){
 const inspect=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const filename=path.join(dir,entry.name),relative=path.relative(root,filename).replaceAll('\\','/');
  if(['.git','node_modules','dist'].includes(relative))continue;
  if(entry.isSymbolicLink())findings.push({file:relative,category:'linked-entry'});
  else if(entry.isDirectory())inspect(filename);else if(!allowed.includes(relative))findings.push({file:relative,category:'unreviewed-file'});
 }};inspect(root);
}
console.log(JSON.stringify({mode,files:names.length,passed:findings.length===0,findings},null,2));
process.exitCode=findings.length?1:0;
