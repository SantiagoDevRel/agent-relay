import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Save, X } from 'lucide-react';
import { chatFacts, getInsights, saveTemplate } from '@/lib/api';
import type { Chat, ChatFacts, Notify, PromptTemplate } from '@/lib/types';
import { Button } from './Controls';
const BUILTINS=[{id:'task',name:'Task with acceptance criteria',text:'Goal:\n[What you want to achieve]\n\nContext and relevant files:\n{{contexto}}\n\nConstraints:\n[What must be respected]\n\nExpected deliverable:\n[What must be completed]\n\nHow to verify it:\n[Test, command, or verifiable result]'},
 {id:'debug',name:'Fix an error',text:'Observed problem:\n[Current and expected results]\n\nContext:\n{{contexto}}\n\nFind the root cause before editing. Reproduce the error, fix it, and verify the same case. Preserve my changes outside this task.\n\nCompletion evidence:\n[Test that must pass]'},
 {id:'research',name:'Research before building',text:'Decision I need to make:\n[Specific question]\n\nContext:\n{{contexto}}\n\nCompare options using current primary sources. Separate facts, inferences, and uncertainties. Include costs, limits, and what remains unverified. Recommend an option; do not install or build yet.'}];
function handoff(chat:Chat,facts:ChatFacts|null) {
 return `Continue this task from this handoff. Read AGENTS.md before acting.\n\nSource chat: ${chat.title}\nProject: ${chat.folder || 'workspace'}\nObserved branch: ${chat.branch || 'Unknown'}\n\nLatest recorded request (excerpt; confirm the full requirements):\n${facts?.lastAsk || facts?.firstAsk || '[Complete the pending request]'}\n\nLatest available response (excerpt; not completion evidence):\n${chat.lastLine || '[No response available]'}\n\nMy notes:\n${chat.note || '[Add confirmed decisions and constraints]'}\n\nFiles mentioned as edited:\n${facts?.files?.join('\n') || '[Confirm the files]'}\n${facts?.partial ? '\nHistory was read partially.\n' : ''}\nWhat is verified:\n[Add actual tests and results]\n\nRemaining work and next concrete step:\n[Complete before sending]\n\nDo not close or pause the source chat. Do not treat its latest response alone as proof of completion.\n\nCommand to resume the source if it is closed:\n${chat.cdCommand}\n${chat.resumeCommand || chat.runCommand}`;
}
export function AssistDialog({chat,initialMode,onClose,onNotify}:{chat:Chat;initialMode:'task'|'handoff';onClose:()=>void;onNotify:Notify}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [facts,setFacts]=useState<ChatFacts|null>(null),[templates,setTemplates]=useState<PromptTemplate[]>([]),[mode,setMode]=useState<string>(initialMode),[text,setText]=useState(''),[name,setName]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const available=[...BUILTINS,...templates];
 const render=(id:string,f:ChatFacts|null=facts)=>id==='handoff'?handoff(chat,f):(available.find(t=>t.id===id)?.text||'').replaceAll('{{contexto}}',`${chat.folder}${chat.branch?` · branch ${chat.branch}`:''}\n${chat.note||'[Add relevant files and context]'}`);
 useEffect(()=>{
  const el=dialog.current;el?.showModal();let active=true;
  Promise.allSettled([chatFacts(chat.id),getInsights()]).then(([f,i])=>{
   if(!active)return;
   const next=f.status==='fulfilled'?f.value.facts:null;setFacts(next);
   if(i.status==='fulfilled')setTemplates(i.value.templates);
   if(f.status==='rejected')setError('Could not read chat facts. Complete the context manually.');
   if(i.status==='rejected')setError('Could not load your library. Built-in templates remain available.');
   setText(initialMode==='handoff'?handoff(chat,next):BUILTINS[0].text.replaceAll('{{contexto}}',`${chat.folder}\n${chat.note||'[Add relevant files and context]'}`));setLoading(false);
  });
  return()=>{active=false;el?.close();};
 },[chat.id]);
 function choose(id:string){setMode(id);setText(render(id));setName(templates.find(t=>t.id===id)?.name||'');}
 async function copy(){try{await navigator.clipboard.writeText(text);onNotify('Text copied. Review it and paste it into your chosen chat.','info');}catch{setError('Could not copy. You can select and copy the text.');}}
 async function save(){setSaving(true);try{const id=templates.some(t=>t.id===mode)?mode:crypto.randomUUID();const result=await saveTemplate({id,name,text});setTemplates(result.templates);setMode(id);onNotify('Template saved in your local library.','info');}catch{setError('Could not save the template. Your text is still here. Use a name up to 80 characters and text up to 10,000 characters.');}finally{setSaving(false);}}
 return createPortal(<dialog ref={dialog} className="summary-dialog assist-dialog" aria-labelledby={`assist-${chat.id}`} onCancel={onClose}>
  <div className="dialog-body"><div className="dialog-head"><div><h2 id={`assist-${chat.id}`}>Prompts and handoff</h2><p className="dialog-note">{chat.title}</p></div><Button aria-label="Close prompts and handoff" onClick={onClose}><X size={18}/></Button></div>
  <p className="dialog-note">Prepare text locally without using models. Review fields in brackets before sending it.</p>
  {loading && <p role="status">Preparing local chat context…</p>}
  {error && <p role="alert" className="assistant-warning">{error}</p>}
  <label className="assistant-field">What you want to prepare<select value={mode} disabled={loading} onChange={e=>choose(e.target.value)}>{available.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}<option value="handoff">Handoff to continue in another chat</option></select></label>
  {chat.advice?.map(a=><p className="assistant-warning" key={a.kind}>{a.text}</p>)}
  <label className="assistant-field">Text to review and copy<textarea rows={16} value={text} maxLength={10000} onChange={e=>setText(e.target.value)} disabled={loading}/></label>
  <div className="notice-actions"><Button onClick={copy} disabled={loading||!text}><Copy size={15}/>Copy text</Button><span className="dialog-note">{text.length}/10,000 characters</span></div>
  <label className="assistant-field">Template name<input maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="For example: review an API"/></label>
  <Button onClick={save} disabled={saving||loading||!name.trim()||!text.trim()}><Save size={15}/>{saving?'Saving…':templates.some(t=>t.id===mode)?'Update my template':'Save to library'}</Button>
  </div>
 </dialog>,document.body);
}
