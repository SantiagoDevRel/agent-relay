import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, CircleCheck, CircleOff, Download, ExternalLink, Folder, GitPullRequestArrow, Layers, MessageSquare, Network, Pause, Play, Power, RefreshCw, Search, X } from 'lucide-react';
import { useSnapshot, sendControl, setWindowDays, setShowAutomated, openWindowsUpdate } from '@/lib/api';
import { TargetContext, type Target } from '@/lib/attention';
import { installApp, useCanInstall } from '@/lib/install';
import type { Chat, ChatState, Notify, Snapshot } from '@/lib/types';
import { relativeTime } from '@/lib/chat-groups';
import { Button, Segmented } from './Controls';
import { states } from './StateBadge';
import { ChatGroups } from './ChatGroups';
import { Hero, AttentionPanel } from './Hero';
import { DeliveryTable } from './DeliveryTable';
import { Logo } from './Logo';
import { ServicesBar } from './ServicesBar';
import { HistoryPanel } from './HistoryPanel';
import { InsightsPanel } from './InsightsPanel';
import { RelayPanel } from './RelayPanel';
import { MissionPanel } from './MissionPanel';

const STALE_MS = 30_000;
const TARGET_MS = 2600;
const TOAST_MS = { info: 6000, error: 10_000 };
// Registered by setup-windows.ps1: starts the server without opening another window.
const POWER_ON_URL = 'chats-dashboard:start';
type Page = 'projects' | 'chats' | 'delivery' | 'orchestrator' | 'missions';
const PAGES = [
  { id: 'projects', label: 'Projects', Icon: Folder },
  { id: 'chats', label: 'Chats', Icon: MessageSquare },
  { id: 'delivery', label: 'Delivery', Icon: GitPullRequestArrow },
  { id: 'orchestrator', label: 'Orchestrator', Icon: GitPullRequestArrow },
  { id: 'missions', label: 'Missions', Icon: Network },
] satisfies { id: Page; label: string; Icon: typeof Folder }[];
const pageFromHash = (): Page => PAGES.find(item => location.hash === `#${item.id}`)?.id ?? (location.hash.startsWith('#chat-') ? 'chats' : 'projects');

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// Ticks every second on its own so the chat list does not re-render with it.
function LiveStatus({ snapshot, connection }: { snapshot: Snapshot | null; connection: string }) {
  const now = useNow(1000);
  if (connection === 'off') return <div className="live-status stale" role="status"><span className="live-dot" />Off</div>;
  const stale = connection === 'disconnected' || (Boolean(snapshot) && now - snapshot!.generatedAt > STALE_MS);
  const liveClass = snapshot?.paused ? 'paused' : stale ? 'stale' : 'live';
  const text = !snapshot ? (connection === 'disconnected' ? 'Offline' : 'Connecting…')
    : snapshot.paused ? `Paused since ${new Date(snapshot.pausedSince ?? snapshot.generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : `${stale ? 'Stale' : 'Live · updated'} ${relativeTime(snapshot.generatedAt, now)}`;
  return <div className={`live-status ${liveClass}`} role="status"><span className="live-dot" />{text}</div>;
}

function countByState(chats: Chat[]) {
  const counts: Record<ChatState, number> = { working: 0, waiting: 0, cut: 0, closed: 0, unknown: 0 };
  for (const chat of chats) counts[chat.state] += 1;
  return counts;
}

const matches = (chat: Chat, query: string) =>
  `${chat.title} ${chat.folder} ${chat.topic} ${chat.lastLine} ${chat.worktree ?? ''} ${chat.note ?? ''}`.toLocaleLowerCase('en-US').includes(query);

function PowerOn() {
  return <a className="action-button power-on" href={POWER_ON_URL}><Power size={15} />Turn on</a>;
}

function HeroSkeleton() {
  return <div className="hero hero-skeleton" role="status" aria-label="Loading chats">
    <span className="sr-only">Loading chats…</span>
    <div className="panel skeleton-block"><div /><div /><div /></div>
    <div className="hero-side">{[0, 1].map(row => <div key={row} className="panel skeleton-block"><div /><div /><div /></div>)}</div>
  </div>;
}

export function Dashboard() {
  const { snapshot, connection } = useSnapshot();
  const now = useNow(15_000);
  const canInstall = useCanInstall();
  const [page, setPage] = useState<Page>(pageFromHash);
  const [view, setView] = useState<'folder' | 'topic'>('folder');
  const [filter, setFilter] = useState<ChatState | null>(null);
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ overflow: false, left: false, right: false });
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const measure = () => setTabScroll({ overflow: tabs.scrollWidth > tabs.clientWidth + 1, left: tabs.scrollLeft > 1, right: tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1 });
    const observer = new ResizeObserver(measure);
    observer.observe(tabs); tabs.addEventListener('scroll', measure, { passive: true }); measure();
    return () => { observer.disconnect(); tabs.removeEventListener('scroll', measure); };
  }, [connection === 'off']);
  useEffect(() => {
    const tabs = tabsRef.current, tab = document.getElementById(`tab-${page}`);
    if (!tabs || !tab) return;
    const container = tabs.getBoundingClientRect(), selected = tab.getBoundingClientRect();
    if (selected.left < container.left) tabs.scrollLeft += selected.left - container.left - 4;
    else if (selected.right > container.right) tabs.scrollLeft += selected.right - container.right + 4;
  }, [page]);
  const hashHandled = useRef('');
  const [target, setTarget] = useState<Target>(null);
  const targetSeq = useRef(0);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Results of a card's actions; fixed at the bottom so they show wherever the card is.
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error'; seq: number } | null>(null);
  const toastSeq = useRef(0);
  const notify = useCallback<Notify>((text, tone = 'error') => {
    toastSeq.current += 1;
    setToast({ text, tone, seq: toastSeq.current });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS[toast.tone]);
    return () => clearTimeout(timer);
  }, [toast]);
  const off = connection === 'off';

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); } catch { setError('Could not complete the action. Try again.'); } finally { setBusy(false); }
  }

  const days = snapshot?.windowDays ?? 3;
  const chats = snapshot?.chats ?? [];
  const counts = countByState(chats);
  const query = search.trim().toLocaleLowerCase('en-US');
  const visible = chats.filter(chat => (!favorites || chat.favorite) && (!filter || chat.state === filter) && (!query || matches(chat, query)));

  // Picking an activity row clears a filter or search that would hide its card.
  const select = useCallback((id: string) => {
    const chat = chats.find(item => item.id === id);
    if (!chat) return;
    setPage('chats');
    setFavorites(false);
    if ((filter && chat.state !== filter) || (query && !matches(chat, query))) { setFilter(null); setSearch(''); }
    targetSeq.current += 1;
    setTarget({ id, seq: targetSeq.current });
    hashHandled.current = `#chat-${id}`;
    location.hash = hashHandled.current;
  }, [chats, filter, query]);
  useEffect(() => {
    const pick = () => {
      const hash = location.hash;
      if (PAGES.some(item => hash === `#${item.id}`)) { hashHandled.current = ''; setPage(pageFromHash()); return; }
      if (hash === hashHandled.current || !hash.startsWith('#chat-')) return;
      const id = hash.slice(6);
      if (chats.some(c => c.id === id)) { hashHandled.current = hash; select(id); }
    };
    pick(); window.addEventListener('hashchange', pick);
    return () => window.removeEventListener('hashchange', pick);
  }, [chats, select]);
  useEffect(() => {
    if (!target) return;
    const timer = setTimeout(() => setTarget(null), TARGET_MS);
    return () => clearTimeout(timer);
  }, [target]);
  function navigate(next: Page) { setPage(next); location.hash = next; window.scrollTo({ top: 0 }); }
  function filterChats(next: ChatState | null) { setFilter(next); navigate('chats'); }
  function scrollTabs(direction: number) { tabsRef.current?.scrollBy({ left: direction * tabsRef.current.clientWidth * .75, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  function navigateByKeyboard(event: KeyboardEvent<HTMLButtonElement>, current: Page) {
    const index = PAGES.findIndex(item => item.id === current);
    const next = event.key === 'ArrowRight' ? PAGES[(index + 1) % PAGES.length] : event.key === 'ArrowLeft' ? PAGES[(index + PAGES.length - 1) % PAGES.length] : event.key === 'Home' ? PAGES[0] : event.key === 'End' ? PAGES[PAGES.length - 1] : null;
    if (!next) return;
    event.preventDefault(); navigate(next.id); document.getElementById(`tab-${next.id}`)?.focus();
  }

  return <TargetContext.Provider value={target}>
    <div className="dashboard">
      <header className="dashboard-header"><div className="header-inner content-width">
        <div className="brand">
          <Logo className="brand-mark" />
          <div className="brand-text"><h1>Agent Relay</h1><LiveStatus snapshot={snapshot} connection={connection} /></div>
        </div>
        {!off && <div className="header-controls">
          <Segmented<1 | 3 | 7> label="Closed chat period" options={[{ value: 1, label: '1 day' }, { value: 3, label: '3 days' }, { value: 7, label: '7 days' }]} value={days} disabled={busy || !snapshot || snapshot.paused} onChange={value => run(() => setWindowDays(value))} />
          <span className="control-divider" />
          <Button disabled={busy || !snapshot} onClick={() => run(() => sendControl(snapshot?.paused ? 'resume' : 'pause'))}>{snapshot?.paused ? <Play size={15} /> : <Pause size={15} />}{snapshot?.paused ? 'Resume' : 'Pause'}</Button>
          <Button disabled={busy || !snapshot || snapshot.paused} onClick={() => run(() => sendControl('resync'))}><RefreshCw size={15} />Resync</Button>
          <Button className="quit-button" disabled={!snapshot} onClick={() => setConfirmQuit(!confirmQuit)} aria-expanded={confirmQuit}><Power size={15} />Turn off</Button>
          {canInstall && <Button className="install-button" onClick={() => run(installApp)}><Download size={15} />Install app</Button>}
        </div>}
      </div>{!off ? <nav className={`dashboard-navigation content-width ${tabScroll.overflow ? 'has-overflow' : ''}`} aria-label="Agent Relay sections">
        {tabScroll.overflow && <Button className="navigation-scroll" aria-label="Scroll sections left" disabled={!tabScroll.left} onClick={() => scrollTabs(-1)}><ChevronLeft size={18} /></Button>}
        <div ref={tabsRef} className="dashboard-tabs" role="tablist" aria-label="Main section" aria-orientation="horizontal">{PAGES.map(item => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} aria-controls={`page-${item.id}`} aria-selected={page === item.id} tabIndex={page === item.id ? 0 : -1} onClick={() => navigate(item.id)} onKeyDown={event => navigateByKeyboard(event, item.id)}><item.Icon size={16} aria-hidden="true" /><span>{item.label}</span></button>)}</div>
        {tabScroll.overflow && <Button className="navigation-scroll" aria-label="Scroll sections right" disabled={!tabScroll.right} onClick={() => scrollTabs(1)}><ChevronRight size={18} /></Button>}
      </nav> : null}</header>

      <main className="content-width main-content">
        {error && <div className="notice notice-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><p>{error}</p><Button aria-label="Dismiss notice" onClick={() => setError('')}><X size={16} /></Button></div>}
        {off ? <div className="empty-state" role="status">
          <span className="empty-glyph"><CircleOff size={28} /></span>
          <h2>Dashboard off</h2>
          <p>Turn it on again when you need it.</p>
          <PowerOn />
        </div> : <>
          {confirmQuit && <div className="notice notice-error" role="alert"><Power size={18} aria-hidden="true" /><p>Turn off Agent Relay? You can turn it on again from this window or its icon.</p><div className="notice-actions"><Button className="danger-button" disabled={busy} onClick={() => run(async () => { await sendControl('quit'); setConfirmQuit(false); })}><Power size={15} />Turn off</Button><Button onClick={() => setConfirmQuit(false)}>Cancel</Button></div></div>}
          {snapshot?.windowsUpdate.rebootPending && <aside className="notice notice-warning"><AlertTriangle size={19} aria-hidden="true" /><p>Windows has a pending restart. <span>An automatic restart will close open chats.</span></p><Button disabled={busy} onClick={() => run(openWindowsUpdate)}>Open Windows Update<ExternalLink size={14} /></Button></aside>}
          {connection === 'disconnected' && snapshot && <div className="notice notice-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><p>Connection to the server lost. <span>The data below may be outdated.</span></p><PowerOn /></div>}
          {snapshot?.error && <div className="notice notice-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><p>{snapshot.error}</p></div>}
          {snapshot ? <>
            <section id="page-projects" className="dashboard-page" role="tabpanel" aria-labelledby="tab-projects" hidden={page !== 'projects'}>
            <Hero chats={chats} counts={counts} now={snapshot.generatedAt} windowDays={days} paused={snapshot.paused} active={page === 'projects'} filter={filter} onFilter={filterChats} onSelect={select} />
            </section>
            <section id="page-chats" className="dashboard-page chats-page" role="tabpanel" aria-labelledby="tab-chats" hidden={page !== 'chats'}>
            <AttentionPanel chats={chats} now={snapshot.generatedAt} onSelect={select} />
            <ServicesBar snapshot={snapshot} favorites={favorites} onFavorites={() => setFavorites(!favorites)} onHistory={() => setHistoryOpen(!historyOpen)} onNotify={notify} />
            <InsightsPanel snapshot={snapshot} onNotify={notify} />
            {historyOpen && <HistoryPanel automated={snapshot.showAutomated} onClose={() => setHistoryOpen(false)} onSelect={select} onNotify={notify} />}
            <div className="toolbar">
              <Segmented<'folder' | 'topic'> label="Group chats" options={[{ value: 'folder', label: <><Folder size={15} />By folder</> }, { value: 'topic', label: <><Layers size={15} />By topic</> }]} value={view} onChange={setView} />
              {filter && <Button className={`filter-pill state-${filter}`} onClick={() => setFilter(null)} aria-label={`Remove filter: ${states[filter].plural}`}>Filter: {states[filter].plural}<X size={14} /></Button>}
              <div className="search-field"><Search size={17} aria-hidden="true" /><input aria-label="Search chats or folders" placeholder="Search chats or folders" value={search} onChange={event => setSearch(event.target.value)} />{search && <Button aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></Button>}</div>
            </div>
            {visible.length ? <ChatGroups chats={visible} view={view} now={now} onNotify={notify} showClosed={favorites || filter === 'closed' || Boolean(query)} />
              : <div className="empty-state"><span className="empty-glyph"><Search size={26} /></span><p>{query || filter ? 'No chats match your search or filter.' : `No chats in the last ${days} ${days === 1 ? 'day' : 'days'}.`}</p></div>}
            </section>
            <section id="page-delivery" className="dashboard-page" role="tabpanel" aria-labelledby="tab-delivery" hidden={page !== 'delivery'}><div className="panel"><DeliveryTable chats={chats} onSelect={select} /></div></section>
            <section id="page-orchestrator" className="dashboard-page" role="tabpanel" aria-labelledby="tab-orchestrator" hidden={page !== 'orchestrator'}><RelayPanel snapshot={snapshot} onNotify={notify} connected={connection === 'live'} page active={page === 'orchestrator'} /></section>
            <section id="page-missions" className="dashboard-page" role="tabpanel" aria-labelledby="tab-missions" hidden={page !== 'missions'}><MissionPanel snapshot={snapshot} onNotify={notify} connected={connection === 'live'} page active={page === 'missions'} /></section>
          </> : connection === 'disconnected' ? <div className="empty-state" role="alert">
            <span className="empty-glyph"><AlertTriangle size={28} /></span>
            <h2>Server disconnected</h2>
            <p>The dashboard is off or not responding.</p>
            <PowerOn />
          </div> : <HeroSkeleton />}
        </>}
      </main>

      <div className="toast-region" aria-live="polite">{toast && <div key={toast.seq} className={`toast tone-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
        {toast.tone === 'error' ? <AlertTriangle size={17} aria-hidden="true" /> : <CircleCheck size={17} aria-hidden="true" />}<p>{toast.text}</p>
        <Button aria-label="Dismiss notice" onClick={() => setToast(null)}><X size={15} /></Button>
      </div>}</div>

      {!off && <footer className="dashboard-footer content-width">
        <div className="footer-connection"><p className="telemetry"><span>Local tracking · Orchestration on request</span><span className="footer-address">127.0.0.1</span><span>{snapshot ? `${snapshot.server.rssMb} MB RAM` : '…'}</span></p>{snapshot?.server.mobile?.enabled && snapshot.server.mobile.origin ? <p className="mobile-access">On your phone: <a href={snapshot.server.mobile.origin} target="_blank" rel="noreferrer">{snapshot.server.mobile.origin}</a><span>Connect Tailscale to open this private address.</span></p> : null}</div>
        {page === 'projects' || page === 'chats' || page === 'delivery' ? <label className="automated-toggle"><input type="checkbox" role="switch" checked={snapshot?.showAutomated ?? false} disabled={busy || !snapshot || snapshot.paused} onChange={event => { const show = event.target.checked; run(() => setShowAutomated(show)); }} /><span className="switch-track" aria-hidden="true" />Show automated ({snapshot?.hiddenAutomated ?? 0})</label> : null}
      </footer>}
    </div>
  </TargetContext.Provider>;
}
