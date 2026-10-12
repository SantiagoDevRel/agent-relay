import { useEffect, useState } from 'react';
import { Search, X, Copy } from 'lucide-react';
import { searchHistory } from '@/lib/api';
import type { HistoryResult, Notify } from '@/lib/types';
import { Button } from './Controls';
import { ToolLogo } from './ToolLogo';

export function HistoryPanel({ automated, onClose, onSelect, onNotify }: { automated: boolean; onClose: () => void; onSelect: (id: string) => void; onNotify: Notify }) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError(''); setResult(null);
    async function load() {
      try {
        const value = await searchHistory(query, offset, controller.signal);
        if (controller.signal.aborted) return;
        setResult(value); setLoading(false); setError('');
        if (value.state.phase === 'indexing') timer = setTimeout(load, 2000);
      } catch {
        if (!controller.signal.aborted) { setError('Could not search the history. Try again.'); setLoading(false); }
      }
    }
    timer = setTimeout(load, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, offset, automated]);
  const state = result?.state;
  return <section className="panel history-panel" aria-labelledby="history-title">
    <div className="panel-head"><h2 id="history-title">Search history</h2><Button aria-label="Close history search" onClick={onClose}><X size={16} /></Button></div>
    <p className="panel-caption">Search your Claude and Codex messages and responses from any date. Processing stays on your laptop and uses no tokens.</p>
    <div className="search-field"><Search size={17} aria-hidden="true" /><input autoFocus aria-label="History text" placeholder="For example: dashboard notifications" value={query} maxLength={120} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></div>
    <p className="dialog-note" role="status">{loading ? 'Loading…' : state?.phase === 'indexing' ? `Preparing the index: ${state.files}/${state.total} chats · ${Math.round(state.bytes / 1048576)} MB read. Results are still incomplete.` : state?.phase === 'error' ? 'Could not complete the index.' : state ? `${state.messages.toLocaleString('en-US')} indexed messages · ${result?.total ?? 0} matches` : ''}</p>
    {Boolean(state?.skipped || state?.errors) && <p className="notice-warning">Partial coverage: {state?.errors || 0} files could not be read and {state?.skipped || 0} lines exceeded the 16 MB limit.</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && query.trim() && result?.total === 0 && <p>No matches found{state?.phase === 'indexing' ? ' in the content indexed so far' : ''}.</p>}
    <ol className="history-results">{result?.results.map(hit => <li key={hit.rowid}>
      <div className="history-result-title"><ToolLogo tool={hit.tool} /><strong>{hit.title}</strong></div>
      <p className="dialog-note">{hit.tool === 'claude' ? 'Claude' : 'Codex'} · {hit.folder || 'Root folder'} · {hit.role === 'user' ? 'You' : 'Agent'} · {hit.ts ? new Date(hit.ts).toLocaleDateString('en-US') : 'No date'}</p>
      <p className="history-excerpt">{hit.excerpt}</p>
      <div className="notice-actions">{hit.current && <Button onClick={() => { onClose(); onSelect(hit.id); }}>View chat in dashboard</Button>}
        <Button onClick={async () => { try { await navigator.clipboard.writeText(`${hit.cdCommand}\n${hit.runCommand}`); onNotify('Commands copied to resume the chat.', 'info'); } catch { onNotify('Could not copy commands.'); } }}><Copy size={14} />Copy commands</Button>
      </div>
    </li>)}</ol>
    {Boolean(result?.total) && <div className="notice-actions"><Button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button><span>{offset + 1}–{Math.min(offset + 20, result!.total)} of {result!.total}</span><Button disabled={loading || offset + 20 >= result!.total} onClick={() => setOffset(offset + 20)}>Next</Button></div>}
  </section>;
}
