import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import type { Chat } from '@/lib/types';
import { chatNextStep } from '@/lib/attention';
import { chatProject, relativeTime } from '@/lib/chat-groups';
import { Button } from './Controls';
import { deliveryStage } from './DeliveryTable';
import { StateBadge } from './StateBadge';
import { ToolLogo } from './ToolLogo';

// A tap on either graph identifies the chat before any terminal or model action.
export function RadarChatPreview({ chat, now, onClose, onSelect }: { chat: Chat; now: number; onClose: () => void; onSelect: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const stage = deliveryStage(chat);
  return createPortal(<dialog ref={dialog} className="summary-dialog radar-chat-preview" aria-labelledby={`radar-chat-${chat.id}`} onCancel={onClose}>
    <div className="dialog-body">
      <header className="dialog-head"><div className="dialog-heading"><StateBadge state={chat.state} /><h2 id={`radar-chat-${chat.id}`}>{chat.title}</h2></div><Button aria-label="Close chat preview" onClick={onClose}><X size={18} /></Button></header>
      <p className="radar-preview-meta"><ToolLogo tool={chat.tool} size={18} state={chat.state} /><span>{chat.tool === 'claude' ? 'Claude' : 'Codex'} · {relativeTime(chat.lastActivity, now)}</span></p>
      <dl className="radar-preview-facts"><div><dt>Project</dt><dd>{chatProject(chat) || 'Environment'}</dd></div><div><dt>Delivery</dt><dd>{stage === 'unknown' ? 'Not verified yet' : stage}</dd></div></dl>
      {chat.delivery?.attention?.length ? <p className="dialog-note">{chat.delivery.attention.join(' · ')}</p> : null}
      <p>{chatNextStep(chat)}</p>
      <Button className="power-on" onClick={() => { onClose(); onSelect(chat.id); }}><ArrowUpRight size={16} />View chat</Button>
    </div>
  </dialog>, document.body);
}
