# Relay Evals — architecture and lane contracts

Relay Evals measures how well the user orchestrates agents (prompts, specs, models,
effort, verification habits) from his own Claude Code and Codex history, and
produces one plain-language weekly report. Everything is local, private and
read-only toward provider data.

## Hard rules for every lane

- **English** for code, comments, UI copy and generated report prose. Keep quoted
  user text in its original language.
- **No new dependencies.** Node ≥ 22.13 built-ins only (`node:sqlite`, `node:test`,
  `node:stream`, …) plus the existing React/Vite stack for the UI.
- **Provider data is read-only.** Never write, move or delete anything under
  `~/.claude` or `~/.codex`. Open files read-only; never open provider SQLite.
- **Privacy.** The dataset lives in `%LOCALAPPDATA%/chats-dashboard/evals/` (see
  `evals/store.mjs`), never in Git. Store only redacted user messages, metadata,
  classified tool events, tokens and compactions. Never store raw tool output,
  raw shell commands, file contents or provider file paths inside records.
  Reports contain aggregates and short (≤160 chars) redacted examples only.
- **Never print secret values**, not even in test failure messages or logs.
- **Tests are isolated.** Use temporary homes (`RELAY_EVALS_HOME`,
  `RELAY_EVALS_REPORTS`, fake `HOME`/`USERPROFILE`), synthetic fixtures under
  `test/fixtures/evals/`, fake git repos created in a temp dir, and injected
  fetch/exec functions. Never read the real `~/.claude`/`~/.codex`, never call the
  real DGX, a model, Relay or the network in tests. Use synthetic text in
  fixtures — never copy real transcript content.
- **Bounded work.** Streaming reads, bounded line sizes, timeouts on every
  subprocess and network call. No daemons, watchers, timers that outlive a run,
  or background polling. No LLM inside the dashboard collection loop. The only
  model calls are labels (`evals/claude-labels.mjs`: Codex by default, or Claude)
  during explicit or weekly runs; tests inject a fake runner.
- Run tests with `node --no-warnings --test test/<file>.test.mjs`.

## Shared contracts (already in the repo — do not change them)

| File | Purpose |
|---|---|
| `evals/schema/chat-record.schema.json` | E1 output: one redacted record per transcript |
| `evals/schema/chat-metrics.schema.json` | E2/E3 output: per-chat Layer 1 metrics |
| `evals/schema/task.schema.json` | E4 catalog task and frozen-suite entry |
| `evals/schema/report.schema.json` | E6 weekly report JSON, read by the E7 page |
| `evals/schema.mjs` | `validate(name, value)`, `assertValid(name, value)` |
| `evals/store.mjs` | `openStore({home})`, `evalsHome()`, `reportsDir()`; tables checkpoints, chats, metrics, tasks, meta |
| `evals/stats.mjs` | `median`, `mean`, `seededRandom`, `bootstrapDifference`, `cohenKappa`, `spearman`, `bootstrapCorrelation`, `excludesZero`, `MIN_N` (10) |
| `test/fixtures/evals/*.sample.json` | One valid example of each schema |

If a lane truly needs a contract change, stop and report it instead of editing.

## Pipeline

```
~/.claude/projects/**.jsonl ─┐
~/.codex/sessions/**.jsonl  ─┴─> L1 extract ─> store.chats ─> L2 metrics ─> store.metrics
agent-work/*/checklist.md ─────────────────────────────────┐        │
                                       L3 catalog/retro/suite <─────┤
                                       L4 judge (rubric, kit) <─────┤
                                       L5a report (JSON + HTML) <───┘ ─> reports/<date>/
                                       L5b /api/evals/latest ─> Evals page (on open only)
evals/cli.mjs + evals/weekly.mjs (orchestrator) wire the steps; one weekly scheduled run.
```

## Lane interfaces (each lane owns only its listed files)

### L1 Extraction (E1) — `evals/redact.mjs`, `evals/extract.mjs`, `evals/sources/`
- `redact(text) → { text, count }` — replaces secret-like spans (API keys/tokens of
  common providers, JWTs, bearer/basic auth, private-key blocks, password/secret
  assignments, long high-entropy strings, URLs with credentials) and personal data
  (emails, phone numbers, long digit runs) with `[REDACTED:<kind>]`.
- `discoverSources({ home }) → [{ provider, file, size, mtimeMs }]` — Claude
  `<home>/.claude/projects/**/*.jsonl` (subagent transcripts are automated with a
  parentId), Codex `<home>/.codex/sessions/**/*.jsonl` and `archived_sessions`.
- `extractFile({ provider, file, signal }) → { record | null, status, detail }` —
  streaming, bounded memory, bounded line length (skip and count oversized lines).
- `extractAll({ store, home, signal, onProgress }) → { files, processed, unchanged, partial, errors, chats }` —
  incremental by checkpoint (path, size, mtimeMs); unchanged files are skipped.

### L2 Metrics (E2, E3) — `evals/corrections.mjs`, `evals/metrics.mjs`, `evals/git-outcomes.mjs`, `evals/task-type.mjs`
- `RULES` (deterministic ES/EN correction rules with ids and categories),
  `detectCorrections(record)`, `isDoneClaim(text)`, `detectSpec(prompt)`, `classifyTaskType(prompt)`.
- `gitOutcomes(commits, { exec, timeoutMs })` — read-only git, cached per repo.
- `ownWords(text)` keeps only the user's words (no agent-authored or relay messages,
  no pasted blocks, only the answers of question replies).
- `evals/claude-labels.mjs`: `labelAll({ store, labeler, run })` sends each unlabeled
  follow-up once to headless Codex (`runCodex`, default) or Claude (`runClaude`) and caches `{correction, category, brokenDone}` in the store
  `labels` table; `chatLabels(record, store)` reads them back.
- `computeMetrics(record, { git, labels }) → chat-metrics` uses complete model labels (per `labelModel`),
  else the rules (`modelPass.status` ok / missing / skipped); `computeAll({ store, git, labels, signal })`.
- `evals/label-check.mjs`: `buildLabelCheck` writes the yes/no CSV; `readLabelCheck` feeds `report.labels.check` (with `labeledBy`).

### L3 Benchmark (E4) — `evals/benchmark/`
- `buildCatalog({ store, contractsDir, git })`, `retrospective(metrics) → modelRow[]`,
  `freezeSuite(...)`, `estimateSuite(...)`, `liveBlocker(entry)` and `sampleTasks(..., { safe })`
  (tasks that cannot run unattended are skipped), `runSample(...)` (explicit command only;
  the CLI passes `cliRelay` for `--live`).

### L4 Judge (E5) — `evals/judge.mjs`, `evals/judge/`
- `RUBRIC`, `scoreSpec(prompt)`, `buildLabelingKit(...)`, `readLabels(...)`, `judgeStatus(...) → report.judge`.

### L5a Report (E6) — `evals/report.mjs`, `evals/report-html.mjs`
- `buildReport({ metrics, tasks, retro, judge, now, run })`, `renderReportHtml(report)`, `writeReport({ report, dir })`.

### L5b Evals page (E7) — `server/evals-api.mjs`, `server/server.mjs`, `web/src/components/dashboard/EvalsPanel.tsx`, `Dashboard.tsx`, `MissionPanel.tsx`, `web/src/lib/evals.ts`, `web/src/styles.css`
- `GET /api/evals/latest` (existing token gate) → newest valid report JSON or `{ report: null, reason }`.
- Fetched only when the Evals page (or the mission launch form) is opened. No polling.
