import { useSyncExternalStore } from 'react';
import type { ChatFacts, Snapshot, SummaryEntry, ServiceStatus, HistoryResult, Insights, PromptTemplate, Assistance, Chat, MissionCatalog, MissionSpec, Mission, MissionLimits, MissionOrchestrator, Tool, RelayProjects, ProjectFolders, PromptRefinementResult, PromptRefinementHistory, PromptRefinementLog, ModelSelection, PromptKind } from './types';

export type Connection = 'loading' | 'live' | 'disconnected' | 'off';
type Store = { snapshot: Snapshot | null; connection: Connection };

// One EventSource for the whole app. It reconnects on its own after a drop; we
// only surface the state. There is no mock fallback: a dashboard that cannot
// reach its server says so instead of showing invented chats.
const token = document.querySelector<HTMLMetaElement>('meta[name="chats-token"]')?.content ?? '';
let store: Store = { snapshot: null, connection: 'loading' };
const listeners = new Set<() => void>();
let stream: EventSource | null = null;

function emit(next: Store) {
  store = next;
  listeners.forEach(listener => listener());
}

function isSnapshot(value: unknown): value is Snapshot {
  const s = value as Snapshot;
  return Boolean(s) && Array.isArray(s.chats) && typeof s.generatedAt === 'number';
}

function connect() {
  stream = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  stream.onmessage = event => {
    try {
      const snapshot: unknown = JSON.parse(event.data);
      if (isSnapshot(snapshot)) emit({ snapshot, connection: 'live' });
    } catch {
      // Ignore a malformed frame; the next one replaces it.
    }
  };
  stream.onerror = () => {
    if (store.connection !== 'off') emit({ ...store, connection: 'disconnected' });
    // A restarted server has a new token: the stream gets 403 and stays closed.
    if (stream?.readyState === EventSource.CLOSED) reloadWhenServerIsBack();
  };
}

// Polls the token-free ping and reloads, picking up the new token and build.
let restartWatch: ReturnType<typeof setInterval> | undefined;
function reloadWhenServerIsBack() {
  if (restartWatch) return;
  restartWatch = setInterval(async () => {
    try {
      const response = await fetch('/api/ping', { cache: 'no-store' });
      if (response.ok) location.reload();
    } catch {
      // Still down.
    }
  }, 3000);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stream && store.connection !== 'off') connect();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stream?.close();
      stream = null;
    }
  };
}

export function useSnapshot() {
  return useSyncExternalStore(subscribe, () => store);
}

/** A refused or failed request; `code` is the server's `error` field. */
export class ApiError extends Error {
  status: number;
  code: string;
  detail: string;
  refinementId?: string;
  constructor(status: number, code: string, detail = '', refinementId?: unknown) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    if (typeof refinementId === 'string' && /^[0-9a-f-]{36}$/i.test(refinementId)) this.refinementId = refinementId;
  }
}

async function post<T = unknown>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chats-Token': token },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data as { error?: unknown; detail?: unknown; refinementId?: unknown };
    throw new ApiError(response.status, String(error.error ?? ''), typeof error.detail === 'string' ? error.detail : '', error.refinementId);
  }
  return data as T;
}

export async function sendControl(action: 'pause' | 'resume' | 'resync' | 'quit') {
  await post('/api/control', { action });
  if (action === 'quit') {
    stream?.close();
    stream = null;
    emit({ ...store, connection: 'off' });
    // If you start it again from the shortcut, this window comes back by itself.
    setTimeout(reloadWhenServerIsBack, 2000);
  }
}
export const setWindowDays = (days: 1 | 3 | 7) => post('/api/window', { days });
export const setShowAutomated = (show: boolean) => post('/api/automated', { show });
export const openChat = (id: string) => post('/api/open', { id });
export const openWindowsUpdate = () => post('/api/windows-update');
export interface FocusResult { found: boolean; matches: number; focused: boolean }
export const focusChat = (id: string) => post<FocusResult>('/api/focus', { id });
/** `forced`: it ignored Ctrl+C and the server ended the process. */
export const closeChat = (id: string, pid: number) => post<{ how: 'clean' | 'forced' }>('/api/close', { id, pid });
export const chatFacts = (id: string) => post<{ facts: ChatFacts; model: string }>('/api/facts', { id });
export const chatSummary = (id: string, refresh = false) => post<SummaryEntry>('/api/summary', { id, refresh });
export const savePreference = (id: string, patch: { favorite?: boolean; note?: string; outcome?: Chat['outcome']; projectFolder?: string | null }) => post('/api/preferences', { id, ...patch });
export const setNotifications = (enabled: boolean, test = false) => post('/api/notifications', { enabled, test });
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, { cache: 'no-store', signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
    throw new ApiError(response.status, String(error.error ?? 'failed'), typeof error.detail === 'string' ? error.detail : '');
  }
  return response.json() as Promise<T>;
}
export const serviceStatus = () => get<ServiceStatus>('/api/services');
export const summaryQueue = () => get<Pick<ServiceStatus, 'queue'>>('/api/queue');
export const searchHistory = (query: string, offset = 0, signal?: AbortSignal) => get<HistoryResult>(`/api/history?q=${encodeURIComponent(query)}&offset=${offset}`, signal);
export const getInsights = (signal?: AbortSignal) => get<Insights>('/api/insights', signal);
export const saveTemplate = (template: PromptTemplate) => post<{templates: PromptTemplate[]}>('/api/templates',template);
export const saveAssistance = (value: Assistance) => post('/api/assistance',value);
export const startRelay = (value: { builderId: string; testerId: string; goal: string; acceptance: string; maxRounds: number; minutes: number }) => post<{ id: string }>('/api/relay/start', value);
export const stopRelay = (id: string) => post('/api/relay/stop', { id });
export const getMissionCatalog = (signal?: AbortSignal) => get<MissionCatalog>('/api/missions/catalog', signal);
export const getRelayProjects = (signal?: AbortSignal) => get<RelayProjects>('/api/projects', signal);
export const getProjectFolders = (path?: string, signal?: AbortSignal) => get<ProjectFolders>(`/api/projects/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`, signal);
export const refinePrompt = (value: ModelSelection & { kind: PromptKind; project?: string; goal: string; acceptance?: string }) => post<PromptRefinementResult>('/api/prompts/refine', value, AbortSignal.timeout(960000));
export const getPromptHistory = (kind: PromptKind, signal?: AbortSignal) => get<PromptRefinementHistory>(`/api/prompts/history?kind=${kind}`, signal);
export const getPromptLog = (id: string, signal?: AbortSignal) => get<PromptRefinementLog>(`/api/prompts/log?id=${encodeURIComponent(id)}`, signal);
export const extendMission = (id: string, value: { minutes: number; taskId?: string }) => post('/api/missions/extend', { id, ...value });
export const planMission = (value: { project: string; title: string; goal: string; provider: Tool; model: string; effort: string; limits: MissionLimits; terminalViews: boolean }) => post<{ spec: MissionSpec; orchestrator?: MissionOrchestrator }>('/api/missions/plan', value);
export const createMission = (spec: MissionSpec) => post<{ id: string; job?: Mission }>('/api/missions/create', spec);
export const missionAction = (id: string, action: 'start' | 'pause' | 'resume' | 'stop' | 'apply') => post(`/api/missions/${action}`, { id });
export const retryMissionTask = (id: string, taskId: string) => post('/api/missions/retry', { id, taskId });
export const messageMissionTask = (id: string, taskId: string, text: string) => post('/api/missions/message', { id, taskId, text });
export const openMissionTerminal = (id: string, taskId: string) => post('/api/missions/terminal', { id, taskId });
/** Opens one interactive Claude or Codex chat for a fixed Relay Evals analysis; the server builds the prompt and picks the model. */
export const openEvalsAnalysis = (id: string, provider: string) => post<{ opened: boolean; id: string; provider: string; model: string; date: string }>('/api/evals/analyze', { id, provider });
export const getMissionLog = (id: string, taskId: string, signal?: AbortSignal) => get<{ text: string }>(`/api/missions/log?id=${encodeURIComponent(id)}&taskId=${encodeURIComponent(taskId)}`, signal);
