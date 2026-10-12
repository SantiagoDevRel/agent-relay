import { useEffect, useState } from 'react';
import { Bell, BellOff, Cpu, Search, Star } from 'lucide-react';
import { serviceStatus, setNotifications } from '@/lib/api';
import type { Notify, ServiceStatus, Snapshot } from '@/lib/types';
import { Button } from './Controls';

export function ServicesBar({ snapshot, favorites, onFavorites, onHistory, onNotify }: { snapshot: Snapshot; favorites: boolean; onFavorites: () => void; onHistory: () => void; onNotify: Notify }) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const s = await serviceStatus(); if (!stopped) { setStatus(s); setError(''); } }
      catch { if (!stopped) setError('Could not update DGX status.'); }
      if (!stopped) timer = setTimeout(load, expanded ? 3000 : 15_000);
    }
    load(); return () => { stopped = true; clearTimeout(timer); };
  }, [expanded]);
  const enabled = snapshot.notifications?.enabled ?? false;
  async function notifications(test = false) {
    setBusy(true);
    try { await setNotifications(test || !enabled, test); if (test) onNotify('Sent a test notification to Windows. If it does not appear, check Do not disturb and Agent Relay notifications.', 'info'); }
    catch { onNotify('Windows did not allow the notification. Check Settings → System → Notifications.'); }
    finally { setBusy(false); }
  }
  const dgx = status?.dgx;
  const label = !dgx ? 'DGX: checking…' : !dgx.available ? 'DGX: offline' : dgx.gpu.verdict === 'BUSY' ? 'DGX: busy' : dgx.gpu.verdict === 'FREE' ? 'DGX: free' : dgx.gpu.verdict === 'LIGHT' ? 'DGX: light load' : 'DGX: available';
  return <div className="services-bar">
    <div className="services-actions">
      <Button aria-pressed={favorites} onClick={onFavorites}><Star size={15} />Favorites ({snapshot.chats.filter(c => c.favorite).length})</Button>
      <Button onClick={onHistory}><Search size={15} />Search history</Button>
      <Button aria-pressed={enabled} disabled={busy} onClick={() => notifications()}>{enabled ? <Bell size={15} /> : <BellOff size={15} />}Notifications: {enabled ? 'on' : 'off'}</Button>
      <Button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Cpu size={15} />{error ? 'DGX: status error' : label}{status?.queue.length ? ` · ${status.queue.length} queued` : ''}</Button>
    </div>
    {snapshot.notifications?.error && <p role="alert" className="notice-warning">Could not deliver a Windows notification. Check your notification settings.</p>}
    {expanded && <section className="panel service-details" aria-label="DGX status and notifications">
      {error && <p role="alert">{error}</p>}
      {!dgx && !error && <p role="status">Checking the DGX…</p>}
      {dgx && <>
        <h2>DGX · {label.replace('DGX: ', '')}</h2>
        <dl className="dgx-metrics">
          <div className="dgx-metric"><dt>GPU</dt><dd className={dgx.gpu.percent == null ? 'is-unverified' : undefined}>{dgx.gpu.percent == null ? 'Unverified' : `${dgx.gpu.percent}%`}</dd><p>{dgx.gpu.temperature == null ? 'Temperature unverified' : `${dgx.gpu.temperature} °C · utilization`}</p></div>
          <div className="dgx-metric"><dt>CPU</dt><dd className={dgx.gpu.cpuPercent == null ? 'is-unverified' : undefined}>{dgx.gpu.cpuPercent == null ? 'Unverified' : `${dgx.gpu.cpuPercent}%`}</dd><p>Total usage · 250 ms sample</p></div>
          <div className="dgx-metric"><dt>Unified RAM</dt><dd className={!dgx.gpu.ram ? 'is-unverified' : undefined}>{dgx.gpu.ram ? `${Math.round(dgx.gpu.ram.used / dgx.gpu.ram.total * 100)}%` : 'Unverified'}</dd><p>{dgx.gpu.ram ? `${dgx.gpu.ram.used} / ${dgx.gpu.ram.total} GB used` : 'Memory unverified'}</p></div>
        </dl>
        <div className="dgx-active">
          <div><h2>Active services</h2>{dgx.gpu.services?.length ? <ul>{dgx.gpu.services.map(name => <li key={name}><span className="dgx-on">ON</span>{name}</li>)}</ul> : <p className="dialog-note">{dgx.gpu.servicesKnown ? 'No active ComfyUI or Whisper detected.' : 'Services unverified.'}</p>}</div>
          <div><h2>Loaded models</h2>{dgx.loaded.length ? <ul>{dgx.loaded.map(model => <li key={model.name}><span className="dgx-on">ON</span>{model.name}</li>)}</ul> : <p className="dialog-note">{dgx.loadedKnown ? 'None loaded in Ollama.' : 'Models unverified.'}</p>}</div>
        </div>
        <p className="dialog-note">Checked {new Date(dgx.at).toLocaleTimeString('en-US')} · checked every minute without using models.</p>
        <details className="dgx-raw"><summary>Technical details</summary><p>{dgx.available ? 'Ollama connected' : 'Ollama not responding'} · {dgx.model}: {dgx.installed ? 'installed' : 'unverified'}</p><pre>{dgx.gpu.detail}</pre></details>
      </>}
      <h2>Summary queue</h2>
      {status?.queue.length ? <ol>{status.queue.map(job => <li key={job.id}>{job.status === 'running' ? 'Summarizing' : `Queued, position ${job.position}`} · {job.title}</li>)}</ol> : <p className="dialog-note">No summaries pending.</p>}
      <Button disabled={busy} onClick={() => notifications(true)}><Bell size={15} />Test Windows notification</Button>
      <p className="dialog-note">Notifications when a turn finishes or an active chat is lost. Windows can silence them with Do not disturb.</p>
    </section>}
  </div>;
}
