import { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { serviceStatus } from '@/lib/api';
import type { ServiceStatus } from '@/lib/types';

export function dgxLabel(dgx: ServiceStatus['dgx'] | undefined) {
  return !dgx ? 'checking…' : !dgx.available ? 'offline' : dgx.gpu.verdict === 'BUSY' ? 'busy' : dgx.gpu.verdict === 'FREE' ? 'free' : dgx.gpu.verdict === 'LIGHT' ? 'light load' : 'available';
}

// The DGX page: reads the server's cached, inference-free probe every 3 s while the
// page is open and stops when another page is selected.
export function DgxPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const s = await serviceStatus(); if (!stopped) { setStatus(s); setError(''); } }
      catch { if (!stopped) setError('Could not update DGX status.'); }
      if (!stopped) timer = setTimeout(load, 3000);
    }
    load(); return () => { stopped = true; clearTimeout(timer); };
  }, [active]);
  const dgx = status?.dgx;
  return <section className="panel dgx-page" aria-label="DGX status">
    <h2 className="dgx-title"><Cpu size={18} aria-hidden="true" />DGX · {error ? 'status error' : dgxLabel(dgx)}</h2>
    {error && <p role="alert">{error}</p>}
    {!dgx && !error && <p role="status">Checking the DGX…</p>}
    {dgx && <>
      <dl className="dgx-metrics">
        <div className="dgx-metric"><dt>GPU</dt><dd className={dgx.gpu.percent == null ? 'is-unverified' : undefined}>{dgx.gpu.percent == null ? 'Unverified' : `${dgx.gpu.percent}%`}</dd><p>{dgx.gpu.temperature == null ? 'Temperature unverified' : `${dgx.gpu.temperature} °C · utilization`}</p></div>
        <div className="dgx-metric"><dt>CPU</dt><dd className={dgx.gpu.cpuPercent == null ? 'is-unverified' : undefined}>{dgx.gpu.cpuPercent == null ? 'Unverified' : `${dgx.gpu.cpuPercent}%`}</dd><p>Total usage · 250 ms sample</p></div>
        <div className="dgx-metric"><dt>Unified RAM</dt><dd className={!dgx.gpu.ram ? 'is-unverified' : undefined}>{dgx.gpu.ram ? `${Math.round(dgx.gpu.ram.used / dgx.gpu.ram.total * 100)}%` : 'Unverified'}</dd><p>{dgx.gpu.ram ? `${dgx.gpu.ram.used} / ${dgx.gpu.ram.total} GB used` : 'Memory unverified'}</p></div>
      </dl>
      <div className="dgx-active">
        <div><h2>Active services</h2>{dgx.gpu.services?.length ? <ul>{dgx.gpu.services.map(name => <li key={name}><span className="dgx-on">ON</span>{name}</li>)}</ul> : <p className="dialog-note">{dgx.gpu.servicesKnown ? 'No active ComfyUI or Whisper detected.' : 'Services unverified.'}</p>}</div>
        <div><h2>Loaded models</h2>{dgx.loaded.length ? <ul>{dgx.loaded.map(model => <li key={model.name}><span className="dgx-on">ON</span>{model.name}</li>)}</ul> : <p className="dialog-note">{dgx.loadedKnown ? 'None loaded in Ollama.' : 'Models unverified.'}</p>}</div>
      </div>
      <p className="dialog-note">Checked {new Date(dgx.at).toLocaleTimeString('en-US')} · the server checks every minute without using models.</p>
      <details className="dgx-raw"><summary>Technical details</summary><p>{dgx.available ? 'Ollama connected' : 'Ollama not responding'} · {dgx.model}: {dgx.installed ? 'installed' : 'unverified'}</p><pre>{dgx.gpu.detail}</pre></details>
    </>}
    <h2>Summary queue</h2>
    {status?.queue.length ? <ol>{status.queue.map(job => <li key={job.id}>{job.status === 'running' ? 'Summarizing' : `Queued, position ${job.position}`} · {job.title}</li>)}</ol> : <p className="dialog-note">No summaries pending.</p>}
  </section>;
}
