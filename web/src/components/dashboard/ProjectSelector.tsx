import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, getProjectFolders, getRelayProjects } from '@/lib/api';
import type { ProjectFolders, RelayProject } from '@/lib/types';
import { Button } from './Controls';

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const folderLabel = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const folderError = (error: unknown) => error instanceof ApiError && (error.detail || /\s/.test(error.code))
  ? error.detail || error.code : 'Could not load folders. Check the connection and try again.';

export function ProjectSelector({ value, onChange, active, connected, disabled, required = true }: {
  value: string; onChange: (path: string) => void; active: boolean; connected: boolean; disabled?: boolean; required?: boolean;
}) {
  const [projects, setProjects] = useState<RelayProject[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [frames, setFrames] = useState<ProjectFolders[]>([]), [root, setRoot] = useState<ProjectFolders['root'] | null>(null);
  const [refresh, setRefresh] = useState(0), [projectError, setProjectError] = useState('');
  const [unavailableFolders, setUnavailableFolders] = useState<string[]>([]);
  const cache = useRef(new Map<string, ProjectFolders>());
  useEffect(() => {
    if (!active || !connected) return;
    const controller = new AbortController();
    getRelayProjects(controller.signal).then(result => { if (!controller.signal.aborted) { setProjects(result.projects); setUnavailableFolders(result.errors || []); setProjectError(result.error || ''); } }).catch(cause => { if (!controller.signal.aborted) setProjectError(folderError(cause)); });
    return () => controller.abort();
  }, [active, connected, refresh]);
  useEffect(() => {
    if (!active || !connected) return;
    const controller = new AbortController(); setLoading(true); setError('');
    async function load(path?: string) {
      const key = path ? pathKey(path) : '@root';
      const cached = cache.current.get(key);
      if (cached) return cached;
      const result = await getProjectFolders(path, controller.signal);
      if (!controller.signal.aborted) { cache.current.set(key, result); cache.current.set(pathKey(result.current.path), result); }
      return result;
    }
    async function browse() {
      try {
        const first = await load();
        if (controller.signal.aborted) return;
        setRoot(first.root);
        const target = value || first.root.path;
        const rootKey = pathKey(first.root.path), selectedKey = pathKey(target);
        if (selectedKey !== rootKey && !selectedKey.startsWith(`${rootKey}/`)) { setFrames([]); setLoading(false); return; }
        const selected = selectedKey === rootKey ? first : await load(target);
        const ancestors = selected.breadcrumbs.filter(folder => pathKey(folder.path) !== pathKey(selected.current.path));
        const parents = await Promise.all(ancestors.map(folder => load(folder.path)));
        if (controller.signal.aborted) return;
        setFrames([...parents, selected]); setLoading(false);
        if (!value) onChange(first.root.path);
      } catch (cause) { if (!controller.signal.aborted) { setError(folderError(cause)); setLoading(false); } }
    }
    void browse();
    return () => controller.abort();
  }, [active, connected, value, refresh, onChange]);
  const currentFrame = frames.at(-1);
  const current = currentFrame && pathKey(currentFrame.current.path) === pathKey(value) ? currentFrame.current : undefined;
  const selected = projects.find(project => pathKey(project.path) === pathKey(value));
  const options = new Map<string, { path: string; label: string; dirty?: boolean }>();
  if (root) options.set(pathKey(root.path), root);
  for (const project of projects) options.set(pathKey(project.path), project);
  if (value && !options.has(pathKey(value))) options.set(pathKey(value), { path: value, label: folderLabel(value) });
  const labelCounts = new Map<string, number>();
  for (const option of options.values()) { const key = option.label.toLowerCase(); labelCounts.set(key, (labelCounts.get(key) || 0) + 1); }
  function optionLabel(option: { path: string; label: string }) {
    if ((labelCounts.get(option.label.toLowerCase()) || 0) < 2) return option.label;
    const normalized = option.path.replace(/\\/g, '/');
    return root && pathKey(option.path).startsWith(`${pathKey(root.path)}/`) ? normalized.slice(root.path.replace(/\\/g, '/').replace(/\/+$/, '').length + 1) : normalized;
  }
  const outside = Boolean(value && root && pathKey(value) !== pathKey(root.path) && !pathKey(value).startsWith(`${pathKey(root.path)}/`));
  const issues = [...unavailableFolders, ...frames.flatMap(frame => frame.errors || [])];
  function retry() { cache.current.clear(); setRefresh(count => count + 1); }
  return <div className="project-selector relay-fields">
    <label>Project folder<select required={required} disabled={disabled || !connected || !options.size} value={options.get(pathKey(value))?.path || ''} onChange={event => onChange(event.target.value)}>{!value ? <option value="">{!connected ? 'Offline' : loading ? 'Loading workspace…' : 'Choose a folder'}</option> : null}{[...options.values()].map(project => <option key={pathKey(project.path)} value={project.path}>{optionLabel(project)}{project.dirty ? ' · local changes' : ''}</option>)}</select></label>
    {frames.length && !outside ? <div className="project-folder-levels">{frames.map((frame, index) => <label key={frame.current.path}>Folder in {frame.current.label}<select disabled={disabled || !connected || loading} value={frames[index + 1]?.current.path || ''} onChange={event => onChange(event.target.value || frame.current.path)}><option value="">Use this folder{frame.folders.length ? '' : ' · no subfolders'}</option>{frame.folders.map(folder => <option key={folder.path} value={folder.path}>{folder.label}</option>)}</select></label>)}</div> : null}
    {value ? <p className="dialog-note project-path">Selected folder: {value}</p> : null}
    {current?.gitRoot || selected?.gitRoot ? <p className="dialog-note project-path">Repository: {current?.gitRoot || selected?.gitRoot}</p> : null}
    {outside ? <p className="dialog-note">This saved folder is outside the workspace. Choose workspace to browse its folders.</p> : null}
    {current?.dirty || selected?.dirty ? <p className="dialog-note">An isolated copy preserves your local changes. Integration keeps your HEAD and existing staged changes.</p> : null}
    {loading && connected ? <p className="dialog-note" role="status">Loading folder choices…</p> : null}
    {!connected ? <p className="dialog-note" role="status">Offline. Your selected folder is preserved.</p> : null}
    {error || projectError ? <p className="assistant-warning" role="alert">{error || projectError}</p> : null}
    <Button type="button" disabled={disabled || !connected || loading} onClick={retry}><RefreshCw size={14} />{error || projectError ? 'Retry folder lookup' : 'Refresh folders'}</Button>
    {issues.length ? <details className="mission-evidence"><summary>Folders not available ({issues.length})</summary><ul>{issues.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
  </div>;
}
