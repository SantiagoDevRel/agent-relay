# Agent Relay — agent guide

Agent Relay is a local Windows control center for installed Claude Code and Codex CLI chats. Collection is read-only and runs no inference. Plans, managed workers and input to existing chats require an explicit user action. The public code must work without any private parent repository.

## HARD publication gate

**No agent may push, create a release, publish an archive/package, or change repository visibility while any private data, personal path, internal document, secret, or unreviewed file is present. STOP if a scan is incomplete or a finding is unresolved. Explicit human approval of the exact reviewed commit and destination is required before the first public publication.** Approval of development or a local commit is not approval to publish.

- Stage only individually reviewed files from `public-files.json`, using explicit paths or a validated pathspec file. **Never `git add .`, `git add -A`, or stage a directory recursively.** Every added file requires an allowlist update and review.
- Review the complete staged diff, including binary assets and Git metadata. Inspect author identity, remote URLs, all reachable history and every tag. Never copy a parent `.git`, import its commits, or reuse its history.
- Run the snapshot, staged and committed privacy checks: `node scripts/publication-check.mjs snapshot`, `node scripts/publication-check.mjs staged`, and `node scripts/publication-check.mjs commit`. Run a locally configured secret scanner over the exact snapshot and prepared index. Scan for PII, user paths, internal endpoints, private project identifiers, sessions, logs, caches and internal documents in addition to credential patterns. Keep any machine-specific denylist and detailed findings outside the repository. Reports must identify locations/categories without exposing sensitive values.
- Run `node tools/staged-secret-scan.mjs --repo . --scanner <absolute-local-scanner>` and `node tools/change-guard.mjs --repo .` before a local commit. TruffleHog must be installed separately; missing tooling blocks integration/publication. `.gitignore` alone is **not** a protection or an approval.
- Run clean installation, typecheck, build, tests and an isolated server/browser smoke. Preserve third-party notices and inspect the README, this guide, examples and assets visually. Record failures and unverified integrations honestly.
- Obtain explicit human green light for the exact commit/destination after presenting the inventory, redacted results, limitations and local migration/rollback plan. Any later content change invalidates that reviewed candidate.

## Commands

Requires Windows, Node 22.13+ with `node:sqlite`, npm, Git and Chrome/Windows Terminal for native actions. Use `npm.cmd` if PowerShell execution policy blocks `npm.ps1`.

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
node server/server.mjs              # http://127.0.0.1:4848; no window launch
npm.cmd start                      # opens the installed app or Chrome app window
node relay-cli.mjs help
node relay-cli.mjs models           # capability queries, no inference
node scripts/install-relay.mjs      # explicit install; writes per-user shims/skills
```

Existing dependency versions are pinned in the lockfile. Do not add dependencies without telling the user why. Tests use fake homes, isolated repositories, fake providers and hidden consoles; never spend subscriptions or operate real chats in regression tests. `CHATS_TEST_WAIT_MS=120000` allows longer fixture waits on a busy machine. Limit test concurrency to two on such machines.

## Private configuration and custody

See [README.md](README.md#local-configuration). Runtime state stays under the per-user application-data directory, provider homes and `~/Downloads/agent-work/`; never copy it into the checkout. `CHATS_CONFIG_FILE` selects an external `config.local.json`; individual environment variables override it. Copy `topics.example.json` to an external file and configure `CHATS_TOPICS_FILE`. Keep actual workspace paths, endpoints, owner identity and project rules private.

Ask the developer for their workspace directory, supported installed CLI login, optional Ollama URL/model, and permission before enabling Tailscale Serve or changing existing shortcuts. Never request API credentials for subscription workers. No other provider integration is implemented. New spending, deletion, external publishing and access changes require explicit authorization.

## Security and behavior invariants

- Bind **127.0.0.1 only**. Validate Host on every route, token on APIs, Origin and JSON for POST. Private Tailscale Serve uses an exact host and owner identity gate before serving any content. Never enable Funnel, public hosting or LAN access.
- Collectors never write provider sessions, transcripts or databases. Codex SQLite is read-only. No LLM in collection, polling, logs, search, usage or health. Missing evidence stays unknown; never invent mock fallback data.
- Offline cache stores only the token-free shell and assets, never authenticated APIs or the root page containing a token. Preserve strict CSP.
- Manual input requires current process/session identity, idle console, empty input and no pair lease. No uncertain replay or automatic permission approval. Close/focus actions use server-owned identity, not client paths/commands.
- Mission workers use isolated worktrees, bounded sessions/turns/deadlines, exact scopes and executable checks. They cannot commit, delete existing resources, install new packages, deploy or recursively delegate. The coordinator stages exact files and checks secrets/changes/requirements before integration. Dirty source state must retain its HEAD, index and unrelated content. Never force/reset/stash user work.
- Validate existing Git source geometry independently of declared task scopes. Next.js bracket, route-group and slot segments are literal; wildcard scopes, traversal, `.git`, symlinks and protected-path rules stay blocked. Optional task/mission `checkTimeoutsMs` arrays align with checks (`null` keeps the default); preserve explicit values through integration/apply and cap them by the existing applicable deadline without extending budgets or admission.
- Pause, cancellation, timeout, provider exit and invalid output remain distinct. Restart never spends automatically. Trusted local shell access is **not** an OS sandbox or an exact billing limit.
- Windows notifications remain opt-in and report observed interactive completion/interruption only. No Delivery toasts. Native actions need Windows and actual identity evidence.
- UI is React; preserve existing typography, dark surfaces, Projects/Chats/Delivery/Orchestrator/Missions/Evals/DGX navigation, radar ordering and accessibility. Inspect visible changes in a browser at narrow/medium/wide widths and 200% zoom.
- Relay Evals (`evals/`, `server/evals-api.mjs`, Evals page) reads provider files only and runs no background readers: no polling, watchers or SSE for reports; the server reads the newest report on request. Model labels run only in explicit `labels`/`report`/`weekly` runs through installed CLI logins without API keys (Codex default, `--labeler claude` optional); tests inject fake runners. `benchmark sample --live` spends turns, skips tasks that cannot run unattended (`liveBlocker`) and is capped at 10 tasks × 2 variants without `--allow-full`. Analysis chats open only on click, one per click, within admission limits. Evals datasets, reports, kits and label checks are private user data: never add them, real transcript text or real report numbers to this repository. Fixtures stay synthetic. See `evals/ARCHITECTURE.md`.
- Never delete resources you did not create. Never touch another checkout's or user's changes. `CLAUDE.md` imports this file only; edit instructions here.

## Source map

`server/` contains collection, authenticated APIs, persistence, mission/pair execution and native Windows helpers. `web/src/` is the React client; `web/public/` contains the offline shell metadata and attributed icons. `tools/` contains the two-provider private transport and commit guards. `scripts/` contains installation, private mobile setup, icon generators and publication checks. `evals/` contains Relay Evals (extraction, redaction, metrics, labels, report, benchmark and CLI). `test/` contains isolated regression fixtures. `skills/` contains the optional Relay planning/orchestration guides. See [NOTICE.md](NOTICE.md) for third-party attribution.
