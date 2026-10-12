import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Send, X } from 'lucide-react';
import type { Chat } from '@/lib/types';
import { chatConversation, sendChatMessage, type Conversation } from '@/lib/chat-api';
import { Button } from './Controls';

export function NativeChatDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [sending, setSending] = useState(false);
  const [awaiting, setAwaiting] = useState<number | null>(null);
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    let timer: ReturnType<typeof setTimeout>; const controller = new AbortController();
    async function load() {
      try { const value = await chatConversation(chat.id, controller.signal); if (mounted.current) { setConversation(value); } }
      catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'Could not read the chat.'); }
      if (mounted.current) timer = setTimeout(load, 3000);
    }
    void load();
    return () => { mounted.current = false; clearTimeout(timer); controller.abort(); };
  }, [chat.id]);
  useEffect(() => {
    if (awaiting === null || !conversation) return;
    if (conversation.state !== 'waiting' || conversation.messages.some(item => item.ts >= awaiting && item.role === 'user')) setAwaiting(null);
  }, [conversation, awaiting]);
  async function send() {
    if (!message.trim() || sending || !conversation?.canSend || awaiting !== null) return;
    setSending(true); setError(''); setNotice('');
    try {
      await sendChatMessage(chat.id, message);
      if (!mounted.current) return;
      setMessage(''); setAwaiting(Date.now() - 3000); setNotice('Message sent. Waiting for the chat to record it.');
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'Could not confirm delivery. Check the chat before sending again.'); }
    finally { if (mounted.current) setSending(false); }
  }
  return createPortal(<dialog ref={dialog} className="summary-dialog native-chat-dialog" aria-labelledby={`conversation-${chat.id}`} onCancel={onClose}>
    <div className="dialog-header"><div><p className="dialog-label">Conversation · {chat.tool === 'claude' ? 'Claude' : 'Codex'}</p><h2 id={`conversation-${chat.id}`}>{chat.title}</h2></div><Button onClick={onClose} aria-label="Close conversation"><X size={20} /></Button></div>
    <p className="dialog-note">Read and write in your laptop’s chat. Each message starts a turn with that chat’s current model.</p>
    {error && <p className="error-notice" role="alert">{error}</p>}
    {!conversation && !error && <p role="status">Reading conversation…</p>}
    {conversation && <><div className="native-conversation" aria-label="Chat messages">
      {!conversation.messages.length && <p>This chat has no messages yet.</p>}
      {conversation.messages.map((item, index) => <article className={`native-message native-message-${item.role}`} key={`${item.ts}-${index}`}><p className="dialog-label">{item.role === 'user' ? 'You' : chat.tool === 'claude' ? 'Claude' : 'Codex'}{item.ts > 0 && <time dateTime={new Date(item.ts).toISOString()}> · {new Date(item.ts).toLocaleTimeString('en-US')}</time>}</p><div>{item.text}</div></article>)}
    </div>{conversation.partial && <p className="dialog-note">This is a long chat: a recent part of the conversation is shown.</p>}
      <label className="native-message-label" htmlFor={`message-${chat.id}`}>Your message<textarea id={`message-${chat.id}`} value={message} onChange={event => setMessage(event.target.value)} maxLength={12000} rows={4} placeholder="Write what you want to ask this chat" /></label>
      <p className="dialog-note">{conversation.leased ? 'This chat is in an active cycle. Use the orchestrator controls to stop the cycle before writing.' : !conversation.alive ? 'Open this chat from Projects to continue.' : !conversation.canSend ? 'Wait for its turn to finish. The terminal input must be empty.' : 'The message is sent once and saved. It is not retried automatically.'}</p>
      {notice && <p role="status">{notice}</p>}
      {awaiting !== null && <Button onClick={() => { setAwaiting(null); setNotice('Check the latest messages before sending another request.'); }}>I checked the conversation</Button>}
      <div className="dialog-actions"><Button disabled={sending || awaiting !== null || !conversation.canSend || !message.trim()} onClick={send}><Send size={16} />{sending ? 'Sending…' : 'Send to chat'}</Button><Button onClick={onClose}>Close</Button></div>
    </>}
  </dialog>, document.body);
}
