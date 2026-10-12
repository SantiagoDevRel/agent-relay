import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, ExternalLink, RotateCw, Sparkles, Terminal, X } from 'lucide-react';
import { ApiError, chatFacts, chatSummary, summaryQueue } from '@/lib/api';
import { relativeTime } from '@/lib/chat-groups';
import type { Chat, ChatFacts, SummaryEntry } from '@/lib/types';
import { Button } from './Controls';
import { StateBadge } from './StateBadge';

const SUMMARY_ERRORS: Record<string, string> = {
  unreachable: 'Could not connect to the DGX. Check that it is on and connected to Tailscale.',
  timeout: 'The model took too long. The DGX may be busy; try again.',
  format: 'The model returned an unreadable response. Try again.',
  busy: 'Other chats are being summarized. Try again shortly.',
  empty: 'This chat has no messages to summarize yet.',
  unreadable: 'Could not read this chat transcript.',
};
const summaryError = (err: unknown) =>
  (err instanceof ApiError && SUMMARY_ERRORS[err.code]) || 'Could not generate the summary. Try again.';

// Ticks on its own so the dialog does not re-render every second while it waits.
function Elapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="elapsed">{Math.floor((now - start) / 1000)} s</span>;
}

function QueuePosition({ id }: { id: string }) {
  const [text, setText] = useState('Checking the queue…');
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const { queue } = await summaryQueue();
        const job = queue.find(j => j.id === id);
        if (!stopped) setText(job?.status === 'queued' ? `Queued, position ${job.position} of ${queue.length}.` : job ? 'The DGX is summarizing this chat.' : 'Preparing the summary…');
      } catch { if (!stopped) setText('Could not read the queue.'); }
      if (!stopped) timer = setTimeout(load, 2000);
    }
    load(); return () => { stopped = true; clearTimeout(timer); };
  }, [id]);
  return <p className="dialog-note">{text}</p>;
}

function Facts({ facts, now }: { facts: ChatFacts; now: number }) {
  const stats = [
    { value: facts.userTurns, label: facts.userTurns === 1 ? 'your message' : 'your messages' },
    { value: facts.agentReplies, label: facts.agentReplies === 1 ? 'reply' : 'replies' },
    { value: facts.commands, label: facts.commands === 1 ? 'command' : 'commands' },
    { value: facts.filesTotal, label: facts.filesTotal === 1 ? 'edited file' : 'edited files' },
  ];
  return <>
    <section className="dialog-section" aria-labelledby="facts-label">
      <h3 id="facts-label" className="dialog-label">By the numbers</h3>
      <dl className="fact-grid">{stats.map(stat => <div key={stat.label} className="fact"><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}</dl>
      <p className="dialog-note">
        {facts.startedAt > 0 && <>Started {relativeTime(facts.startedAt, now)} · latest message {relativeTime(facts.lastAt, now)}. </>}
        {facts.partial && 'Long chat: counts cover its start and final section.'}
      </p>
    </section>
    {facts.firstAsk && <section className="dialog-section" aria-labelledby="asks-label">
      <h3 id="asks-label" className="dialog-label">What you asked</h3>
      <figure className="ask"><figcaption>At the start</figcaption><blockquote>{facts.firstAsk}</blockquote></figure>
      {facts.lastAsk && <figure className="ask"><figcaption>Your latest message</figcaption><blockquote>{facts.lastAsk}</blockquote></figure>}
    </section>}
    {facts.filesTotal > 0 && <section className="dialog-section" aria-labelledby="files-label">
      <h3 id="files-label" className="dialog-label">Edited files</h3>
      <ul className="file-list">{facts.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>
      {facts.filesTotal > facts.files.length && <p className="dialog-note">And {facts.filesTotal - facts.files.length} more.</p>}
    </section>}
  </>;
}

export function SummaryDialog({ chat, now, onClose, onGo, onOpen }: {
  chat: Chat; now: number; onClose: () => void; onGo: () => void; onOpen: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [facts, setFacts] = useState<ChatFacts | null>(null);
  const [factsError, setFactsError] = useState('');
  const [model, setModel] = useState('');
  const [entry, setEntry] = useState<SummaryEntry | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const titleId = `summary-title-${chat.id}`;

  const summarize = useCallback(async (refresh: boolean) => {
    setStatus('loading');
    try {
      const next = await chatSummary(chat.id, refresh);
      if (!mounted.current) return;
      setEntry(next);
      setStatus('done');
    } catch (err) {
      if (!mounted.current) return;
      setError(summaryError(err));
      setStatus('error');
    }
  }, [chat.id]);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    chatFacts(chat.id)
      .then(result => { if (mounted.current) { setFacts(result.facts); setModel(result.model); } })
      .catch(() => { if (mounted.current) setFactsError('Could not read this chat.'); });
    summarize(false);
    return () => { mounted.current = false; };
  }, [chat.id, summarize]);

  const close = () => dialog.current?.close();
  const toolName = chat.tool === 'claude' ? 'Claude' : 'Codex';
  return createPortal(<dialog ref={dialog} className="summary-dialog" aria-labelledby={titleId} onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-body">
      <header className="dialog-head">
        <div className="dialog-heading">
          <div className="chat-meta">
            <StateBadge state={chat.state} />
            <span className={`tool-badge tool-${chat.tool}`}>{chat.tool === 'claude' ? <Sparkles size={14} aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}{toolName}</span>
            <span className="path-tag">{chat.folder || 'workspace'}</span>
          </div>
          <h2 id={titleId}>{chat.title}</h2>
        </div>
        <Button className="dialog-close" aria-label="Close summary" onClick={close}><X size={16} /></Button>
      </header>

      <section className="dialog-section summary-block" aria-labelledby="summary-label" aria-busy={status === 'loading'}>
        <h3 id="summary-label" className="dialog-label"><Sparkles size={14} aria-hidden="true" />Summary</h3>
        {status === 'loading' && <div role="status">
          <p className="dialog-note">Summarizing with {model || 'the local model'} on the DGX… <Elapsed /> <span>Usually takes 20–40 s.</span></p>
          <QueuePosition id={chat.id} />
          <div className="summary-skeleton" aria-hidden="true"><div /><div /><div /></div>
        </div>}
        {status === 'error' && <div className="card-feedback tone-error" role="alert"><p>{error}</p><Button onClick={() => summarize(true)}><RotateCw size={14} />Retry</Button></div>}
        {status === 'done' && entry && <div className="summary-text">
          <p className="summary-lead">{entry.summary.tema}</p>
          {entry.summary.hecho.length > 0 && <><h4>Work completed</h4><ul>{entry.summary.hecho.map(item => <li key={item}>{item}</li>)}</ul></>}
          {entry.summary.estado && <><h4>Where it stands</h4><p>{entry.summary.estado}</p></>}
          {entry.summary.pendiente.length > 0 && <><h4>Remaining</h4><ul className="pending-list">{entry.summary.pendiente.map(item => <li key={item}>{item}</li>)}</ul></>}
          <div className="summary-foot">
            <p className="dialog-note">Written {relativeTime(entry.at, now)} by {entry.model} on the DGX. It can be wrong: the counts below come from the chat.</p>
            <Button onClick={() => summarize(true)}><RotateCw size={14} />Refresh</Button>
          </div>
        </div>}
      </section>

      {facts ? <Facts facts={facts} now={now} /> : factsError && <p className="card-feedback tone-error" role="alert">{factsError}</p>}

      <footer className="dialog-actions">
        {chat.alive
          ? <Button className="open-button" onClick={() => { close(); onGo(); }}><ArrowUpRight size={14} />Go to chat</Button>
          : chat.canOpen && <Button className="open-button" onClick={() => { close(); onOpen(); }}><ExternalLink size={14} />Open</Button>}
        <Button onClick={close}>Done</Button>
      </footer>
    </div>
  </dialog>, document.body);
}
