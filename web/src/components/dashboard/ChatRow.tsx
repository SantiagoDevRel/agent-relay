import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clock, Copy, ExternalLink, GitBranch, MessageCircleQuestion, Network, Power, ScrollText, Star, NotebookPen, WandSparkles } from 'lucide-react';
import type { Chat, Notify } from '@/lib/types';
import { ApiError, closeChat, focusChat, openChat, savePreference } from '@/lib/api';
import { chatNextStep, useTarget } from '@/lib/attention';
import { chatProject, relativeTime } from '@/lib/chat-groups';
import { Button } from './Controls';
import { StateBadge } from './StateBadge';
import { SummaryDialog } from './SummaryDialog';
import { ToolLogo } from './ToolLogo';
import { AssistDialog } from './AssistDialog';
import { NativeChatDialog } from './NativeChatDialog';
import { tokenNumber } from './InsightsPanel';
import { deliveryStage } from './DeliveryTable';

// The list supplies one shared set of projects, independent of each card's group.
export const ProjectOptions = createContext<string[]>([]);

// One copyable command: the folder (`cd "..."`) or the resume line.
function CommandLine({ label, command, onNotify }: { label: string; command: string; onNotify: Notify }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { onNotify('Could not copy the command. Try again.'); }
  }
  return <div className="command-line">
    <span className="prompt" aria-hidden="true">❯</span>
    <code>{command}</code>
    <Button onClick={copy} aria-label={`${copied ? 'Copied' : 'Copy'}: ${label}`} className={`copy-button ${copied ? 'copy-success' : ''}`}>{copied ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span></Button>
  </div>;
}

export function ChatRow({ chat, now, showFolder, onNotify }: { chat: Chat; now: number; showFolder?: boolean; onNotify: Notify }) {
  const projects = useContext(ProjectOptions);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'open' | 'focus' | 'close' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [assistMode,setAssistMode] = useState<'task' | 'handoff' | null>(null);
  const [note, setNote] = useState(chat.note || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!noteOpen) setNote(chat.note || ''); }, [chat.note, noteOpen]);
  async function save(patch: { favorite?: boolean; note?: string; outcome?: Chat['outcome']; projectFolder?: string | null }) {
    setSaving(true);
    try { await savePreference(chat.id, patch); if (patch.note !== undefined) setNoteOpen(false); }
    catch { onNotify('Could not save the change. Try again.'); }
    finally { setSaving(false); }
  }
  const lineRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const target = useTarget();
  const isTarget = target?.id === chat.id;
  useEffect(() => {
    const line = lineRef.current;
    if (!line || expanded) return;
    const measure = () => setCanExpand(line.scrollHeight > line.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, [chat.lastLine, expanded]);
  useEffect(() => {
    if (!isTarget) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cardRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }, [isTarget, target?.seq]);
  // A chat that closed on its own has nothing left to confirm.
  useEffect(() => { if (!chat.alive) setConfirmClose(false); }, [chat.alive]);

  async function act(kind: 'open' | 'focus' | 'close', action: () => Promise<void>) {
    setBusy(kind);
    try { await action(); } finally { setBusy(null); }
  }
  const open = () => act('open', async () => {
    try { await openChat(chat.id); }
    catch { onNotify('Could not open the chat. Try again.'); }
  });
  // Selects the chat's Windows Terminal tab and brings its window forward.
  const goTo = () => act('focus', async () => {
    try {
      const result = await focusChat(chat.id);
      if (!result.found) onNotify(`Could not find its Windows Terminal tab. Look for «${chat.title}».`);
      else if (!result.focused) onNotify('Selected its tab, but Windows did not allow bringing the window forward. Find it in the taskbar.', 'info');
      else if (result.matches > 1) onNotify(`${result.matches} tabs have this title; opened the first one.`, 'info');
    } catch (err) {
      onNotify(err instanceof ApiError && err.code === 'not open' ? 'This chat is no longer open.' : 'Could not focus the chat. Try again.');
    }
  });
  const close = () => act('close', async () => {
    if (chat.pid === undefined) return;
    try {
      const { how } = await closeChat(chat.id, chat.pid);
      onNotify(how === 'forced'
        ? `«${chat.title}» did not respond to Ctrl+C and was force-closed. Resume it with Open.`
        : `Closed “${chat.title}”. Resume it with Open.`, 'info');
    } catch (err) {
      onNotify(err instanceof ApiError && err.status === 409
        ? 'Nothing was closed: that chat has already closed or the process has changed.'
        : 'Could not close the chat. Try again.');
    }
    setConfirmClose(false);
  });

  const toolName = chat.tool === 'claude' ? 'Claude' : 'Codex';
  return <article ref={cardRef} id={`chat-${chat.id}`} className={`chat-card state-${chat.state} ${chat.role === 'orchestrator' ? 'orchestrator-chat' : ''} ${isTarget ? 'is-target' : ''}`}>
    <div className="card-top">
      <StateBadge state={chat.state} />
      <Button className="favorite-button" aria-label={`${chat.favorite ? 'Remove from' : 'Add to'} favorites: ${chat.title}`} aria-pressed={Boolean(chat.favorite)} disabled={saving} onClick={() => save({ favorite: !chat.favorite })}><Star size={16} fill={chat.favorite ? 'currentColor' : 'none'} /></Button>
      {chat.alive
        ? <Button className="open-button" onClick={goTo} disabled={busy !== null} aria-label={`Go to chat ${chat.title} in Windows Terminal`}><ArrowUpRight size={14} />{busy === 'focus' ? 'Finding…' : 'Go to chat'}</Button>
        : chat.canOpen && <Button className="open-button" onClick={open} disabled={busy !== null} aria-label={`Open ${chat.title} in Windows Terminal`}><ExternalLink size={14} />{busy === 'open' ? 'Opening…' : 'Open'}</Button>}
    </div>
    <h3>{chat.title}</h3>
    <div className="chat-next-step"><p>{chatNextStep(chat)}</p>{chat.delivery && <p className="dialog-note">Delivery: {deliveryStage(chat) === 'unknown' ? 'Not verified yet' : deliveryStage(chat)} · <a href="#delivery">View evidence</a></p>}</div>
    <div className="chat-meta">
      {chat.role === 'orchestrator' ? <span className="orchestrator-chat-badge"><Network size={14} aria-hidden="true" />Orchestrator</span> : null}
      <span className={`tool-badge state-${chat.state}`}><ToolLogo tool={chat.tool} size={18} state={chat.state} />{toolName}</span>
      {showFolder && <span className="path-tag">{chatProject(chat) || 'Environment'}</span>}
      {chat.worktree && <span className="worktree-tag"><GitBranch size={12} aria-hidden="true" />{chat.worktree}</span>}
      {chat.automated && <span className="path-tag">Automated</span>}
      <time className="meta-time" dateTime={new Date(chat.lastActivity).toISOString()}><Clock size={13} aria-hidden="true" />{relativeTime(chat.lastActivity, now)}</time>
      {chat.endsWithQuestion && <span className="question-marker"><MessageCircleQuestion size={14} aria-hidden="true" />Question</span>}
    </div>
    <div className="chat-usage">
      <span>{chat.usage ? `${tokenNumber(chat.usage.last.total)} tokens in the latest request` : 'Tokens: no record available'}</span>
      {chat.usage?.model && <span>{chat.usage.model}</span>}
      {chat.resources && <span>{Math.round(chat.resources.residentBytes/1048576)} MiB RAM · CPU {chat.resources.cpuPercent == null ? 'measuring…' : `${chat.resources.cpuPercent.toLocaleString('en-US',{maximumFractionDigits:1})} %`}</span>}
    </div>
    {chat.delivery?.attention?.length ? <div className="chat-advice delivery-chat-attention">{chat.delivery.attention.map(reason => <p key={reason}>{reason}</p>)}</div> : null}
    {chat.delivery?.lanes.some(lane => lane.collisions.length) && <div className="delivery-project-collisions"><strong>Code collisions</strong><ul>{[...new Set(chat.delivery.lanes.flatMap(lane => lane.collisions))].map(file => <li key={file}><code>{file}</code></li>)}</ul></div>}
    {chat.usage?.contextTokens != null && <div className="context-meter">
      <span>Latest request context: {tokenNumber(chat.usage.contextTokens)}{chat.usage.contextWindow ? ` / ${tokenNumber(chat.usage.contextWindow)} (${chat.usage.contextPercent} %)` : ' · window unknown'}</span>
      {chat.usage.contextPercent != null && <progress max={100} value={Math.min(100,chat.usage.contextPercent)} aria-label={`Context for ${chat.title}`} />}
      <time className="dialog-note" dateTime={new Date(chat.usage.at).toISOString()}>Measured {relativeTime(chat.usage.at,now)}</time>
    </div>}
    {chat.advice?.length ? <div className="chat-advice">{chat.advice.map(a=><p key={a.kind}>{a.text}</p>)}<Button onClick={()=>setAssistMode('handoff')}>Prepare handoff</Button></div> : null}
    {chat.lastLine && <div className="last-line-block">
      <p ref={lineRef} id={`line-${chat.id}`} className={`last-line ${expanded ? 'expanded' : ''}`}>{chat.lastLine}</p>
      {(canExpand || expanded) && <Button className="expand-button" aria-expanded={expanded} aria-controls={`line-${chat.id}`} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</Button>}
    </div>}
    <div className="terminal" role="group" aria-label={`Commands to resume ${chat.title}`}>
      <CommandLine label={`folder for ${chat.title}`} command={chat.cdCommand} onNotify={onNotify} />
      <CommandLine label={`command for ${toolName} for ${chat.title}`} command={chat.runCommand} onNotify={onNotify} />
    </div>
    <div className="card-actions">
      <Button aria-haspopup="dialog" onClick={() => setConversationOpen(true)}><ScrollText size={14} />Conversation</Button>
      <Button aria-haspopup="dialog" onClick={() => setSummaryOpen(true)} aria-label={`Summary for ${chat.title}`}><ScrollText size={14} />Summary</Button>
      <Button aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}><NotebookPen size={14} />{chat.note ? 'Edit note' : 'Note'}</Button>
      <Button aria-haspopup="dialog" onClick={()=>setAssistMode('task')}><WandSparkles size={14}/>Prompts and handoff</Button>
      {chat.alive && chat.pid !== undefined && <Button className="close-chat-button" aria-expanded={confirmClose} aria-controls={`close-${chat.id}`} disabled={busy === 'close'} onClick={() => setConfirmClose(!confirmClose)} aria-label={`Close ${chat.title}`}><Power size={14} />Close chat</Button>}
    </div>
    <label className="chat-outcome">Grouping project<select aria-label={`Project for ${chat.title}`} value={chat.projectFolder == null ? 'auto' : `project:${chat.projectFolder}`} disabled={saving} onChange={e=>save({projectFolder:e.target.value === 'auto' ? null : e.target.value.slice(8)})}><option value="auto">Automatic: {chat.folder || 'Environment'}</option>{projects.map(folder=><option key={folder} value={`project:${folder}`}>{folder || 'Environment'}</option>)}</select></label>
    <label className="chat-outcome">Chat outcome<select value={chat.outcome || 'none'} disabled={saving} onChange={e=>save({outcome:e.target.value as Chat['outcome']})}><option value="none">Not evaluated</option><option value="useful">Useful</option><option value="corrected">Needed corrections</option><option value="abandoned">Abandoned</option></select></label>
    {chat.note && !noteOpen && <p className="saved-note"><NotebookPen size={14} aria-hidden="true" />{chat.note}</p>}
    {noteOpen && <div className="note-editor">
      <label htmlFor={`note-${chat.id}`}>Your note for this chat</label>
      <textarea id={`note-${chat.id}`} value={note} onChange={e => setNote(e.target.value)} maxLength={2000} rows={3} />
      <div className="notice-actions"><Button disabled={saving} onClick={() => save({ note })}>{saving ? 'Saving…' : 'Save note'}</Button><Button disabled={saving} onClick={() => { setNote(chat.note || ''); setNoteOpen(false); }}>Cancel</Button><span className="dialog-note">{note.length}/2000</span></div>
    </div>}
    {confirmClose && chat.pid !== undefined && <div id={`close-${chat.id}`} className="card-confirm" role="alert">
      <p>Close this chat? Send Ctrl+C to {toolName} in its tab; if it does not respond, force-close it (PID {chat.pid}). The conversation is saved: resume it with Open.{chat.state === 'working' && <strong> It is working: the current turn will be interrupted.</strong>}</p>
      <div className="notice-actions">
        <Button className="danger-button" disabled={busy === 'close'} onClick={close}><Power size={14} />{busy === 'close' ? 'Closing…' : 'Close chat'}</Button>
        <Button disabled={busy === 'close'} onClick={() => setConfirmClose(false)}>Cancel</Button>
      </div>
    </div>}
    {summaryOpen && <SummaryDialog chat={chat} now={now} onClose={() => setSummaryOpen(false)} onGo={goTo} onOpen={open} />}
    {conversationOpen && <NativeChatDialog chat={chat} onClose={() => setConversationOpen(false)} />}
    {assistMode && <AssistDialog chat={chat} initialMode={assistMode} onClose={()=>setAssistMode(null)} onNotify={onNotify} />}
  </article>;
}
