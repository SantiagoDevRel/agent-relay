/** Shows a short message in the dashboard's toast. */
export type Notify = (message: string, tone?: 'info' | 'error') => void;
// Mirrors the snapshot built by server/server.mjs.
export type ChatState = 'working' | 'waiting' | 'cut' | 'closed' | 'unknown';
export type Tool = 'claude' | 'codex';
export interface TokenCounts { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; total: number }
export interface ChatUsage { at: number; model: string | null; last: TokenCounts; cumulative: TokenCounts | null; contextTokens: number | null; contextWindow: number | null; contextPercent: number | null; toolErrors: number; interruptions: number; compactions: number; coverage: string }
export interface ProcessResources { at: number; residentBytes: number; privateBytes: number; cpuPercent: number | null; scope: string }
export interface LaptopResources { at: number; cpuPercent: number | null; ram: { total: number; available: number } | null; processCount: number; error: string; scope: string }
export interface PromptTemplate { id: string; name: string; text: string }
export interface Assistance { handoffTokens: number; handoffPercent: number }
export interface Insights {
  state: {phase: string; files: number; total: number; bytes: number; skipped: number; errors: number; unsupported: number};
  totals: TokenCounts; days: (TokenCounts & {label: string})[]; projects: (TokenCounts & {label: string})[]; models: (TokenCounts & {label: string})[];
  chats: (TokenCounts & {id: string})[]; timezone: string; scope: string; resources: LaptopResources; templates: PromptTemplate[]; assistance: Assistance;
}
export interface Chat {
  id: string;
  tool: Tool;
  title: string;
  state: ChatState;
  alive: boolean;
  folder: string;
  /** App-local grouping override; never changes the provider's cwd or resume commands. */
  projectFolder?: string | null;
  worktree?: string;
  topic: string;
  lastActivity: number;
  stateSince: number;
  lastLine: string;
  endsWithQuestion: boolean;
  cdCommand: string;
  runCommand: string;
  resumeCommand: string;
  canOpen: boolean;
  /** Process of an open chat; "Close chat" sends it back so the server can check it. */
  pid?: number;
  branch?: string;
  automated?: boolean;
  role?: 'orchestrator' | 'worker';
  missionId?: string;
  favorite?: boolean;
  note?: string;
  outcome?: 'none' | 'useful' | 'corrected' | 'abandoned';
  usage?: ChatUsage | null;
  resources?: ProcessResources | null;
  advice?: {kind: string; text: string}[];
  delivery?: ChatDelivery;
}
export interface DeliveryLane {
  worktree: string; branch: string; head?: string; local?: number; localFiles?: string[];
  committed?: number | null; onMain?: boolean | null; mainCommit?: string | null; mainRef?: string | null; method?: string;
  production?: boolean | null; productionRef?: string | null; productionSha?: string | null;
  ci: { state: 'success' | 'failure' | 'pending' | 'unknown'; runs: { databaseId: number; url: string; workflowName: string; conclusion: string; headSha: string }[]; error?: string };
  verification: { state: string; text: string; sha?: string; ci?: string; prod?: string; rejected?: string };
  collisions: string[]; error?: string;
}
export interface ChatDelivery {
  state: 'unknown' | 'no-code' | 'attributed'; lanes: DeliveryLane[]; project?: string; checkedAt?: number;
  coverage?: string; stale?: boolean; error?: string; attention: string[];
  collisions?: { file: string; chats: string[] }[];
}
/** Read from the transcript by server/summary.mjs, no LLM. */
export interface ChatFacts {
  partial: boolean;
  startedAt: number;
  lastAt: number;
  userTurns: number;
  agentReplies: number;
  commands: number;
  filesTotal: number;
  files: string[];
  firstAsk: string;
  lastAsk: string;
}
/** Written by the local model on the DGX. */
export interface ChatSummary {
  tema: string;
  hecho: string[];
  estado: string;
  pendiente: string[];
}
export interface SummaryEntry {
  at: number;
  model: string;
  summary: ChatSummary;
  cached?: boolean;
}
export interface Snapshot {
  generatedAt: number;
  paused: boolean;
  pausedSince?: number;
  windowDays: 1 | 3 | 7;
  showAutomated: boolean;
  notifications?: { enabled: boolean; error: string; setting: string };
  chats: Chat[];
  hiddenAutomated: number;
  windowsUpdate: { rebootPending: boolean };
  server: { rssMb: number; mobile?: { ready: boolean; enabled: boolean; origin: string; auth: string } };
  error?: string;
  resources?: LaptopResources;
  assistance?: Assistance;
  relays?: { jobs: RelayJob[]; error: string };
  missions?: { jobs: Mission[]; error: string; planning?: boolean };
}
export interface MissionLimits {
  concurrency: number; maxSessions: number; maxTurns: number; taskMinutes: number; missionMinutes: number;
}
export type MissionCheck = string[];
export interface MissionTaskSpec {
  id: string; title: string; prompt: string; dependsOn: string[]; files: string[]; checks: MissionCheck[];
  provider?: Tool; model?: string; effort?: string;
}
export interface MissionOrchestrator {
  sessionHandle: string; nativeId?: string; provider: Tool; model: string; effort: string;
}
export interface MissionSpec {
  project: string; title: string; goal: string; provider: Tool; model: string; effort: string;
  limits: MissionLimits; tasks: MissionTaskSpec[]; checks?: MissionCheck[]; planId?: string; terminalWindow?: string; terminalViews?: boolean;
}
export type MissionStatus = 'draft' | 'running' | 'paused' | 'attention' | 'stopped' | 'expired' | 'ready' | 'applied';
export type MissionTaskStatus = 'pending' | 'running' | 'checking' | 'completed' | 'attention';
export interface MissionTask extends Omit<MissionTaskSpec, 'prompt'> {
  status: MissionTaskStatus; detail: string; sessionHandle?: string; nativeId?: string;
  turnsUsed: number; sessionsUsed: number; startedAt?: number; completedAt?: number;
  checksPassed?: boolean; attempts: number; deadline?: number; deadlineReached?: boolean;
}
export interface Mission {
  id: string; title: string; goal: string; project: string; provider: Tool; model: string; effort: string;
  status: MissionStatus; detail: string; createdAt: number; updatedAt: number; deadline: number;
  limits: MissionLimits; sessionsUsed: number; turnsUsed: number; integrationBranch?: string;
  terminalViews?: boolean; deadlineReached?: boolean; baselineDirty?: boolean; deliveryMode?: string;
  progress: { completed: number; total: number; percent: number }; counts: Partial<Record<MissionTaskStatus, number>>;
  tasks: MissionTask[]; checks: MissionCheck[]; finalChecksPassed?: boolean; orchestrator?: MissionOrchestrator;
  events: { at: number; text: string }[];
}
export interface MissionProviderCatalog {
  available: boolean; models: { id: string; label: string; efforts?: string[]; kind?: 'model' | 'alias'; dynamic?: boolean; resolvedId?: string | null; provenance?: string[]; support?: string; defaultEffort?: string; workflows?: string[]; managedSupported?: boolean; managedReason?: string; billingNote?: string }[];
  efforts: string[]; detail?: string; error?: string; catalogError?: string;
  currentModel?: { id: string; resolvedId?: string | null; label?: string; provenance?: string[]; support?: string; managedSupported?: boolean; managedReason?: string; billingNote?: string } | null;
  workflows?: { id: string; label: string; available: boolean; managedSupported: boolean; reason: string; docsUrl?: string }[];
}
export interface MissionCatalog {
  codex: MissionProviderCatalog; claude: MissionProviderCatalog;
  limits?: Partial<MissionLimits>;
}
export interface ModelSelection { provider: Tool; model: string; effort: string }
export interface RelayProject { id?: string; path: string; label: string; gitRoot?: string; dirty?: boolean; error?: string }
export interface RelayProjects { projects: RelayProject[]; error?: string; errors?: string[] }
export interface ProjectFolder { path: string; label: string }
export interface ProjectFolders {
  root: ProjectFolder; current: ProjectFolder & { gitRoot?: string; dirty?: boolean };
  breadcrumbs: ProjectFolder[]; folders: ProjectFolder[]; errors: string[];
}
/** 'lab' is the standalone Prompt Lab page; 'mission' and 'relay' prepare their own forms. */
export type PromptKind = 'mission' | 'relay' | 'lab';
export interface PromptRefinementSpec {
  goal: string; acceptance: string; requirements: { id: string; literal: string; criterion: string }[];
  assumptions: string[]; questions: string[]; verification: string[];
}
export interface PromptRefinementResult {
  id: string; status: 'ready' | 'needs_input'; spec: PromptRefinementSpec; provider: Tool; model: string; effort: string;
}
export interface PromptRefinementDiagnostic {
  exitCode?: number | null; reason?: string; timedOut?: boolean; aborted?: boolean; timeoutMs?: number;
}
export interface PromptRefinementAttempt {
  id: string; kind: PromptKind; status: 'refining' | 'ready' | 'needs_input' | 'attention';
  provider: Tool; model: string; effort: string; createdAt: number; detail?: string;
  diagnostic?: PromptRefinementDiagnostic;
}
export interface PromptRefinementHistory { attempts: PromptRefinementAttempt[]; total: number }
export interface PromptRefinementLog {
  text: string; truncated: boolean; diagnostic?: PromptRefinementDiagnostic;
  original?: { goal: string; acceptance: string }; context?: string;
}
export type RelayStatus = 'queued' | 'sending' | 'submitted' | 'working' | 'recovering' | 'approved' | 'stopped' | 'attention' | 'expired';
export interface RelayJob {
  id: string; goal: string; acceptance: string; maxRounds: number; round: number;
  status: RelayStatus; turn: 'builder' | 'tester'; detail: string; deadline: number;
  createdAt: number; updatedAt: number; recoveryUsed?: boolean; revision?: string;
  question?: { id: string; prompt: string; origin: 'builder' | 'tester' } | null; questionCount?: number;
  members: Record<'builder' | 'tester', { id: string; title: string; tool: Tool }>;
  events: { at: number; text: string }[];
}
export interface HistoryState { phase: 'idle' | 'indexing' | 'ready' | 'error'; files: number; total: number; bytes: number; messages: number; skipped?: number; errors?: number; elapsedMs?: number; error?: string }
export interface HistoryHit { id: string; tool: Tool; title: string; folder: string; excerpt: string; ts: number; rowid: number; role: string; cdCommand: string; runCommand: string; current?: Chat }
export interface HistoryResult { results: HistoryHit[]; total: number; state: HistoryState }
export interface ServiceStatus {
  dgx: { at: number; available: boolean; installed: boolean; model: string; loadedKnown: boolean; loaded: { name: string; sizeVram: number }[];
    gpu: { verdict: 'FREE' | 'LIGHT' | 'BUSY' | 'UNKNOWN'; detail: string; percent: number | null; temperature: number | null;
      cpuPercent: number | null; ram: { used: number; total: number } | null; services: string[]; servicesKnown: boolean } };
  queue: { id: string; title: string; status: 'running' | 'queued'; position: number }[];
  history: HistoryState;
}
