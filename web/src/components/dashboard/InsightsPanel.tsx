import { useEffect, useState } from 'react';
import { Activity, ExternalLink } from 'lucide-react';
import { getInsights, saveAssistance } from '@/lib/api';
import type { Insights, Notify, Snapshot, TokenCounts } from '@/lib/types';
import { Button } from './Controls';
export const tokenNumber = (n: number | null | undefined) => n == null ? 'Unknown' : new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(n);
export const memoryNumber = (n: number) => `${(n / 1073741824).toLocaleString('en-US',{maximumFractionDigits:1})} GiB`;
function UsageTable({rows,label}:{rows:(TokenCounts & {label:string})[];label:string}) {
 return <section className="usage-table-section"><h3>{label}</h3>{rows.length ? <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th scope="col">{label}</th><th scope="col">Input</th><th scope="col">Cache read</th><th scope="col">Output</th></tr></thead><tbody>{rows.map(row=><tr key={row.label}><th scope="row">{row.label}</th><td>{tokenNumber(row.input)}</td><td>{tokenNumber(row.cached)}</td><td>{tokenNumber(row.output)}</td></tr>)}</tbody></table></div> : <p className="dialog-note">No tokens recorded in this period yet.</p>}</section>;
}
export function InsightsPanel({snapshot,onNotify}:{snapshot:Snapshot;onNotify:Notify}) {
 const [open,setOpen]=useState(false),[data,setData]=useState<Insights|null>(null),[error,setError]=useState('');
 const [tokens,setTokens]=useState(snapshot.assistance?.handoffTokens || 300000),[percent,setPercent]=useState(snapshot.assistance?.handoffPercent || 80),[saving,setSaving]=useState(false);
 useEffect(()=>{
  if(!open)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const next=await getInsights(controller.signal);if(!controller.signal.aborted){setData(next);setError('');}}catch{if(!controller.signal.aborted)setError('Could not update metrics. Close and reopen this panel to retry.');}if(!controller.signal.aborted)timer=setTimeout(load,15000);};
  load();return()=>{controller.abort();clearTimeout(timer);};
 },[open]);
 const resources=snapshot.resources,ram=resources?.ram;
 const stale=Boolean(resources?.at && Date.now()-resources.at>45000);
 async function save(){setSaving(true);try{await saveAssistance({handoffTokens:tokens,handoffPercent:percent});onNotify('Handoff thresholds saved.','info');}catch{onNotify('Could not save thresholds. Use 10,000–2,000,000 tokens and 50–95%.');}finally{setSaving(false);}}
 return <section className="panel insights-panel">
  <button type="button" className="insights-toggle" aria-expanded={open} aria-controls="insights-body" onClick={()=>setOpen(!open)}><span><Activity size={18} aria-hidden="true" /><strong>Usage and laptop</strong></span><span>{ram ? `${memoryNumber(ram.available)} free` : 'Reading RAM…'} · CPU {resources?.cpuPercent == null ? 'unknown' : `${Math.round(resources.cpuPercent)} %`}{stale?' · Stale sample':''} · {open?'Hide':'View details'}</span></button>
  {open && <div id="insights-body" className="insights-body">
    {error && <p role="alert" className="assistant-warning">{error}</p>}
    {resources?.error && <p role="alert">{resources.error}</p>}
    {stale && <p role="status" className="assistant-warning">The resource sample is over 45 seconds old and may be outdated.</p>}
    <p className="dialog-note">{ram && <>Usable RAM: {memoryNumber(ram.total)}. </>}{resources?.processCount ?? 0} main chat processes. Cards show resident RAM and CPU; child tools and the browser are separate.{resources?.at ? ` Sample: ${new Date(resources.at).toLocaleTimeString('en-US')}.` : ''}</p>
    {data ? <>
      <div className="usage-summary"><strong>{tokenNumber(data.totals.total)} recorded tokens</strong><span>Last 7 days · observed chats · {data.timezone}</span></div>
      <p className="dialog-note" role="status">{data.state.phase==='indexing'?`Preparing history: ${data.state.files}/${data.state.total} files. Totals are partial.`:data.state.phase==='error'?'The index encountered an error; totals are partial.':`${data.state.files}/${data.state.total} files checked.`} {data.state.skipped} segments skipped · {data.state.errors} errors · {data.state.unsupported} inherited histories excluded.</p>
      <p className="dialog-note">Input includes cache; cache read is part of that input. Reasoning is part of output. Local records may omit auxiliary usage. These tokens do not represent your bill or remaining plan allowance.</p>
      <div className="usage-tables"><UsageTable rows={data.days} label="By day"/><UsageTable rows={data.models} label="By model"/><UsageTable rows={data.projects.map(p=>({...p,label:p.label||'No folder'}))} label="By project"/><UsageTable rows={data.chats.map(c=>({...c,label:`${snapshot.chats.find(chat=>chat.id===c.id)?.title || 'Chat outside this view'} · ${c.id.slice(0,8)}`}))} label="By chat"/></div>
    </> : <p role="status">Preparing local metrics…</p>}
    <fieldset className="handoff-settings" disabled={saving || snapshot.paused}><legend>When to suggest a handoff</legend><p className="dialog-note">Notify when the latest request reaches either threshold. You decide when to switch chats.</p><label>Context tokens<input type="number" min={10000} max={2000000} step={10000} value={tokens} onChange={e=>setTokens(Number(e.target.value))}/></label><label>Window percentage, when known<input type="number" min={50} max={95} value={percent} onChange={e=>setPercent(Number(e.target.value))}/></label><Button onClick={save}>{saving?'Saving…':'Save thresholds'}</Button></fieldset>
    <details className="useful-tools"><summary>Useful tools</summary><ul><li><a href="https://repomix.com/guide/" target="_blank" rel="noreferrer">Repomix <ExternalLink size={12}/></a>: prepares code context and counts tokens. Select relevant files before sharing it.</li><li><a href="https://ccusage.com/guide/json-output" target="_blank" rel="noreferrer">ccusage <ExternalLink size={12}/></a>: exportable local usage reports. It is not running from Agent Relay.</li><li><a href="https://code.claude.com/docs/en/costs" target="_blank" rel="noreferrer">Claude /insights <ExternalLink size={12}/></a>: analyzes your habits and friction. It uses tokens; run it only when you want that analysis.</li></ul><p className="dialog-note">Links open documentation. Agent Relay does not install or run these tools.</p></details>
  </div>}
 </section>;
}
