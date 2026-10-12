import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Chat } from '@/lib/types';
import { chatProject, relativeTime } from '@/lib/chat-groups';
import { states } from './StateBadge';
import { ToolLogo } from './ToolLogo';
import { ActivityRadar } from './ActivityRadar';
import { deliveryStage, deliveryIndicator } from './DeliveryTable';
import { RadarChatPreview } from './RadarChatPreview';

type Marker = {chat:Chat;x:number;y:number;px:number;number?:number;project?:string;role?:string};
type Project = {id:string;label:string;top:number;left:number;width:number;height:number;points:Marker[][]};

// The original radar's logos, numbers and hover details on a rectangular HUD.
// Every project owns a stable cell; rows hold one, two or three constellations.
// Activity uses the original circular time dial. Neither view caps the data.
export const Radar = memo(function Radar({ chats, now, windowDays, numbers, paused, active: pageActive, onSelect }: {
  chats: Chat[]; now: number; windowDays: number; numbers: Map<string,number>; paused: boolean; active: boolean; onSelect: (id: string) => void;
}) {
  const stage=useRef<HTMLDivElement>(null),[width,setWidth]=useState(420),[active,setActive]=useState<string|null>(null),[byProject,setByProject]=useState(true);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = chats.find(chat => chat.id === pickedId);
  useEffect(() => { if (!pageActive) setPickedId(null); }, [pageActive]);
  const canvas=useRef<HTMLDivElement>(null);
  const [headerHeights,setHeaderHeights]=useState<Record<string,number>>({});
  const [projectOrder,setProjectOrder]=useState<string[]>(()=>{try{const value:unknown=JSON.parse(localStorage.getItem('chats-project-order')||'[]');return Array.isArray(value)?value.filter((key):key is string=>typeof key==='string'&&key.length<=300).slice(0,1000):[];}catch{return[];}});
  const projectKeys=useMemo(()=>[...new Set(chats.map(chat=>(chatProject(chat)||'workspace').toLowerCase()))].sort(),[chats]);
  const projectSignature=JSON.stringify(projectKeys);
  useEffect(()=>{setProjectOrder(order=>{const added=projectKeys.filter(key=>!order.includes(key));return added.length?[...order,...added]:order;});},[projectSignature]);
  useEffect(()=>{try{localStorage.setItem('chats-project-order',JSON.stringify(projectOrder));}catch{/* Keep the same order in memory when storage is unavailable. */}},[projectOrder]);
  useEffect(()=>{const el=stage.current;if(!el)return;const observer=new ResizeObserver(([entry])=>setWidth(Math.round(entry.contentRect.width)));observer.observe(el);return()=>observer.disconnect();},[]);
  const layout=useMemo(()=>{
    // State, activity timestamps and attention numbers must never move a project.
    const sorted=[...chats].sort((a,b)=>chatProject(a).toLowerCase().localeCompare(chatProject(b).toLowerCase())||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
      const folders=new Map<string,{label:string;chats:Chat[]}>();
      for(const chat of sorted){
        const label=chatProject(chat)||'workspace',key=label.toLocaleLowerCase('en-US');
        const group=folders.get(key)||{label,chats:[]};group.chats.push(chat);folders.set(key,group);
      }
      const markers:Marker[]=[],projects:Project[]=[];
      const ordered=[...projectOrder.filter(key=>folders.has(key)),...projectKeys.filter(key=>!projectOrder.includes(key))];
      const lanes=Math.max(1,Math.min(folders.size,width>=720?3:width>=420?2:1));
      const gap=24,groupWidth=(width-84-gap*(lanes-1))/lanes;
      const columns=Math.max(1,Math.floor((groupWidth-64)/64)+1);
      let bottom=42,top=42;
      for(const [index,id] of ordered.entries()){
        const lane=index%lanes;
        if(index>0&&lane===0)top=bottom+22;
        const group=folders.get(id)!,left=66+lane*(groupWidth+gap),headerHeight=headerHeights[id]??28;
        const rowCount=Math.ceil(group.chats.length/columns),project:Project={id,label:group.label,top,left,width:groupWidth,height:headerHeight+rowCount*96+26,points:[]};
        let offset=0;
        for(let row=0;row<rowCount;row++){
          const count=Math.ceil((group.chats.length-offset)/(rowCount-row)),points:Marker[]=[];
          for(let col=0;col<count;col++){
            const chat=group.chats[offset++],number=numbers.get(chat.id),role=chat.title.match(/\b(builder|tester|reviewer|android|ios)\b/i)?.[1];
            const marker={chat,x:count===1?left+groupWidth/2:left+32+col*(groupWidth-64)/(count-1),y:top+headerHeight+30+row*96,px:26,number,project:id,role};
            markers.push(marker);points.push(marker);
          }
          project.points.push(points);
        }
        projects.push(project);bottom=Math.max(bottom,top+headerHeight+rowCount*96+26);
      }
      return{height:Math.max(408,bottom+30),markers,projects};
  },[chats,numbers,width,projectOrder,projectSignature,headerHeights]);
  useEffect(()=>{if(!byProject||!canvas.current)return;const labels=[...canvas.current.querySelectorAll<HTMLElement>('.radar-project-label')];const measure=()=>{const heights=Object.fromEntries(labels.map(label=>[label.dataset.project!,Math.max(28,Math.ceil(label.getBoundingClientRect().height))]));setHeaderHeights(previous=>Object.keys(heights).some(id=>previous[id]!==heights[id])?{...previous,...heights}:previous);};const observer=new ResizeObserver(measure);labels.forEach(label=>observer.observe(label));measure();return()=>observer.disconnect();},[byProject,projectSignature]);
  const selected=layout.markers.find(m=>m.chat.id===active);
  return <div className={`radar rectangular-radar ${paused?'is-paused':''}`}>
    <div className="radar-mode segmented" role="group" aria-label="Organize radar"><button type="button" className={`action-button ${byProject?'selected':''}`} aria-pressed={byProject} onClick={()=>setByProject(true)}>Projects</button><button type="button" className={`action-button ${!byProject?'selected':''}`} aria-pressed={!byProject} onClick={()=>setByProject(false)}>Activity</button></div>
    <p className="radar-mode-hint">{byProject?'Connected means same project. Fixed positions; live colors.':'Recent activity starts at the top, clockwise. Color shows status.'}</p>
    <div ref={stage}>
    {!byProject ? <ActivityRadar chats={chats} now={now} windowDays={windowDays} numbers={numbers} paused={paused} onSelect={setPickedId}/> : <div ref={canvas} className="radar-stage" style={{height:layout.height}}>
      <svg className="radar-svg" viewBox={`0 0 ${width} ${layout.height}`} aria-hidden="true">
        <defs><linearGradient id="rect-radar-glow" x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--gold)" stopOpacity=".08"/><stop offset="1" stopColor="var(--malachite)" stopOpacity=".02"/></linearGradient></defs>
        <rect className="radar-field" x="66" y="30" width={Math.max(1,width-84)} height={layout.height-64} rx="3"/>
        {layout.projects.map(project=><rect key={project.id} className="radar-project-cell" x={project.left+2} y={project.top-6} width={Math.max(1,project.width-4)} height={project.height} rx="5"/>)}
        {layout.projects.map(project=><g key={project.id} className="radar-project-links" data-project={project.id}>
          {project.points.map((row,i)=>row.slice(1).map((m,j)=><line key={`${i}-${j}`} x1={row[j].x+15} y1={row[j].y} x2={m.x-15} y2={m.y}/>))}
          {project.points.length>1&&<path d={`M${project.left+16} ${project.points[0][0].y} V${project.points.at(-1)![0].y}`}/>}
          {project.points.length>1&&project.points.map((row,i)=><path key={`branch${i}`} d={`M${project.left+16} ${row[0].y} H${row[0].x-15}`}/>)}
        </g>)}
        {Array.from({length:Math.floor((layout.height-64)/12)+1},(_,i)=><line key={`t${i}`} className={i%5===0?'major-tick':'minor-tick'} x1="59" x2={i%5===0?48:54} y1={30+i*12} y2={30+i*12}/>)}
        <path className="radar-corners" d={`M66 48 V30 H84 M${width-36} 30 H${width-18} V48 M66 ${layout.height-52} V${layout.height-34} H84 M${width-36} ${layout.height-34} H${width-18} V${layout.height-52}`}/>
        <line className="now-line" x1="66" y1="30" x2={width-18} y2="30"/>
      </svg>
      <span className="radar-axis-now" aria-hidden="true">Projects</span>
      <span className="radar-signal-count" aria-hidden="true">{chats.length} signals</span>
      {layout.projects.map(project=><div key={project.id} className="radar-project-label" data-project={project.id} style={{top:project.top,left:project.left+8,width:project.width-16}} title={project.label}><span>{project.label==='workspace'?'Environment':project.label.split('/').at(-1)}</span><span className="radar-project-count">{project.points.flat().length}</span></div>)}
      <span className="radar-axis-old" aria-hidden="true">Connections by project</span>
      <div className="radar-scan-window" aria-hidden="true"><div className="radar-sweep"/></div>
      <div className="radar-markers" role="group" aria-label="Chats by project: fixed positions, live status">
        {layout.markers.map(({chat,x,y,px,number,project,role})=><button key={chat.id} type="button"
          className={`marker state-${chat.state} tool-${chat.tool} ${chat.role === 'orchestrator' ? 'orchestrator-marker' : ''}`} data-chat-id={chat.id} data-project={project}
          style={{left:x,top:y,'--size':`${px}px`} as CSSProperties}
          aria-label={`${chat.role === 'orchestrator' ? 'Orchestrator · ' : ''}${number!==undefined?`${number}. `:''}${chat.title}: ${states[chat.state].label}, ${chat.tool==='claude'?'Claude':'Codex'}`}
          onClick={()=>setPickedId(chat.id)} onMouseEnter={()=>setActive(chat.id)} onMouseLeave={()=>setActive(null)} onFocus={()=>setActive(chat.id)} onBlur={()=>setActive(null)}>
          <ToolLogo tool={chat.tool} size={px} state={chat.state}/>{number!==undefined&&<span className="marker-number" aria-hidden="true">{number}</span>}
          {role&&<span className="marker-role" aria-hidden="true">{role}</span>}
          <span className={`marker-delivery ${chat.delivery?.attention?.length ? 'needs-attention' : ''}`} title={`Delivery: ${deliveryStage(chat)}`}>{deliveryIndicator(chat)}</span>
        </button>)}
      </div>
      {selected&&<div className="radar-tooltip" role="presentation" data-below={selected.y<100?'':undefined}
        style={{left:Math.max(8,Math.min(width-Math.min(270,width-16)-8,selected.x-Math.min(270,width-16)/2)),top:selected.y}}>
        <strong>{selected.chat.title}</strong><span>{states[selected.chat.state].label} · {selected.chat.tool==='claude'?'Claude':'Codex'} · {relativeTime(selected.chat.lastActivity,now)}</span><span className="tooltip-path">{chatProject(selected.chat)||'Environment'}</span>
      </div>}
      {!chats.length&&<p className="radar-empty">No activity recorded</p>}
    </div>}
    </div>
    {pageActive && picked && <RadarChatPreview chat={picked} now={now} onClose={() => setPickedId(null)} onSelect={onSelect} />}
  </div>;
});
