import { useEffect, useState } from 'react';
import { Bell, BellOff, Cpu, Search, Star } from 'lucide-react';
import { serviceStatus, setNotifications } from '@/lib/api';
import type { Notify, ServiceStatus, Snapshot } from '@/lib/types';
import { Button } from './Controls';
import { dgxLabel } from './DgxPanel';

export function ServicesBar({ snapshot, favorites, onFavorites, onHistory, onDgx, onNotify }: { snapshot: Snapshot; favorites: boolean; onFavorites: () => void; onHistory: () => void; onDgx: () => void; onNotify: Notify }) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const s = await serviceStatus(); if (!stopped) { setStatus(s); setError(''); } }
      catch { if (!stopped) setError('Could not update DGX status.'); }
      if (!stopped) timer = setTimeout(load, 15_000);
    }
    load(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const enabled = snapshot.notifications?.enabled ?? false;
  async function notifications(test = false) {
    setBusy(true);
    try { await setNotifications(test || !enabled, test); if (test) onNotify('Sent a test notification to Windows. If it does not appear, check Do not disturb and Agent Relay notifications.', 'info'); }
    catch { onNotify('Windows did not allow the notification. Check Settings → System → Notifications.'); }
    finally { setBusy(false); }
  }
  return <div className="services-bar">
    <div className="services-actions">
      <Button aria-pressed={favorites} onClick={onFavorites}><Star size={15} />Favorites ({snapshot.chats.filter(c => c.favorite).length})</Button>
      <Button onClick={onHistory}><Search size={15} />Search history</Button>
      <Button aria-pressed={enabled} disabled={busy} onClick={() => notifications()}>{enabled ? <Bell size={15} /> : <BellOff size={15} />}Notifications: {enabled ? 'on' : 'off'}</Button>
      <Button onClick={onDgx}><Cpu size={15} />DGX: {error ? 'status error' : dgxLabel(status?.dgx)}{status?.queue.length ? ` · ${status.queue.length} queued` : ''}</Button>
    </div>
    {enabled && <p className="dialog-note services-note">Notifications when a turn finishes or an active chat is lost. Windows can silence them with Do not disturb. <Button disabled={busy} onClick={() => notifications(true)}><Bell size={15} />Test Windows notification</Button></p>}
    {snapshot.notifications?.error && <p role="alert" className="notice-warning">Could not deliver a Windows notification. Check your notification settings.</p>}
  </div>;
}
