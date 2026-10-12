import os from 'node:os';
import { execFile } from 'node:child_process';
const cpuTimes = () => os.cpus().reduce((s,c) => { s.idle += c.times.idle; s.total += Object.values(c.times).reduce((a,b)=>a+b,0); return s; },{idle:0,total:0});
export function resourceSample(rows, previous, now, cores) {
  const before = new Map((previous?.rows || []).map(p=>[p.pid,p]));
  const seconds = previous ? (now - previous.at) / 1000 : 0;
  return rows.map(p => {
    const old=before.get(p.pid);
    const same=old && old.created===p.created && old.name===p.name && Number.isFinite(old.cpuSeconds) && Number.isFinite(p.cpuSeconds);
    return { ...p, cpuPercent: same && seconds>0 ? Math.min(100,Math.max(0,(p.cpuSeconds-old.cpuSeconds)/seconds/cores*100)) : null };
  });
}
export class Resources {
  state = { at: 0, processes: [], cpuPercent: null, ram: null, error: '', scope: 'main-processes' };
  previous = null; lastCpu = cpuTimes(); checkedAt=0;
  refresh(now=Date.now()) {
    if (this.pending || now-this.checkedAt<15000) return;
    this.checkedAt=now;
    const cpu=cpuTimes(), delta=cpu.total-this.lastCpu.total;
    const cpuPercent=delta>0?100*(1-(cpu.idle-this.lastCpu.idle)/delta):null;
    this.lastCpu=cpu;
    const ram={total:os.totalmem(),available:os.freemem()};
    this.pending=new Promise(resolve=>{
      execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        "@(Get-Process -Name claude,codex -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id;name=$_.ProcessName;created=$_.StartTime.ToFileTimeUtc().ToString();cpuSeconds=$_.CPU;residentBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64} }) | ConvertTo-Json -Compress"],
      {windowsHide:true,timeout:10000,maxBuffer:1024*1024},(err,stdout)=>{
        try {
          if(err)throw err;
          const rows=JSON.parse(stdout||'[]');
          if(!Array.isArray(rows))throw Error('Invalid process sample');
          const at=Date.now(), processes=resourceSample(rows,this.previous,at,os.cpus().length);
          this.previous={at,rows};this.state={at,processes,cpuPercent,ram,error:'',scope:'main-processes'};
        } catch { this.state={...this.state,error:'Windows resources could not be refreshed.'}; }
        resolve();
      });
    }).finally(()=>{this.pending=null;});
  }
  forChat(chat) {
    if(!chat.alive || Date.now()-this.state.at>45000)return null;
    const p=this.state.processes.find(p=>p.pid===chat.pid && p.name===chat.tool);
    if(!p)return null;
    if(chat.tool==='claude'&&chat.procStart&&String(chat.procStart)!==p.created)return null;
    if(chat.tool==='codex'&&chat.pidSeenAt&&Number(BigInt(p.created)/10000n)-11644473600000>chat.pidSeenAt+1000)return null;
    return {at:this.state.at,residentBytes:p.residentBytes,privateBytes:p.privateBytes,cpuPercent:p.cpuPercent,scope:'main-process'};
  }
  publicState(){const {processes,...rest}=this.state;return {...rest,processCount:processes.length};}
}
