# Agent Relay

A local Windows control center for Claude Code and Codex CLI chats. Project and activity radars show work in progress; Chats provides attention, search, transcripts and explicit chat actions. Delivery shows observed Git and GitHub Actions evidence. Orchestrator coordinates an existing builder/tester pair. Missions prepares and runs bounded work in isolated Git worktrees.

The live collection loop runs no models and never modifies provider data. Planning, summaries, implementation and chat input occur only after an explicit user action. Relay is a private desktop application, not a hosted service.

## Clean installation

This repository has a new independent history and contains the reviewed product source. Clone it into a separate directory. Keep private configuration and runtime data outside the checkout.

Prerequisites: Windows, Node.js 22.13 or newer with built-in `node:sqlite`, npm and Git. Chrome and Windows Terminal are needed for the app window and native chat actions. Install Claude Code or Codex separately and log in with an existing supported account if you want collection or managed execution. No provider API key is required by Relay.

```powershell
git clone https://github.com/SantiagoDevRel/agent-relay.git
cd agent-relay
npm.cmd ci --no-audit --no-fund
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
node server/server.mjs
```

Open `http://127.0.0.1:4848`. Use `npm.cmd start` to also open the app window. `npm` works in other shells; `npm.cmd` avoids PowerShell script-policy issues. `npm ci` restores only the existing pinned dependencies. The server serves `dist/`, so rebuild after frontend changes. `npm.cmd run dev` starts Vite for frontend development; production behavior must be checked through the built server.

## Local configuration

Public defaults use `~/Projects`, generic topic examples and Ollama on `http://127.0.0.1:11434`. They contain no owner's paths, project names or internal endpoints. Configure your own workspace before using project selectors.

Private application state is stored in `%LOCALAPPDATA%/chats-dashboard/` (home fallback if unavailable), including settings, favorites, notes, indexes, mobile identity, missions and planning metadata. Native provider history stays in `~/.claude` and `~/.codex`. Prompts, logs, requirements and worktrees stay under `~/Downloads/agent-work/`. Browser preferences stay in browser storage. None of these belong in the checkout or a public snapshot.

Create `%LOCALAPPDATA%/chats-dashboard/config.local.json` outside the checkout, or select another external file with `CHATS_CONFIG_FILE`. It accepts only these string keys:

| Key | Purpose |
| --- | --- |
| `CHATS_WORKSPACE_ROOT` | Absolute directory used for project dropdowns and grouping |
| `CHATS_TOPICS_FILE` | Absolute external topics file copied from `topics.example.json` |
| `CHATS_SUMMARY_URL` | Optional trusted Ollama URL; summaries send conversation text there |
| `CHATS_SUMMARY_MODEL` | Model already installed on that Ollama server; default `gpt-oss:20b` |
| `CHATS_DGX_PROBE` | Optional absolute local Node probe script; not included or required |
| `CHATS_SECRET_SCANNER` | Absolute TruffleHog executable for mandatory mission commit gates |
| `CHATS_RUNNER_SESSIONS` | External transport-session metadata directory; normally app data |
| `CHATS_NOTIFICATION_APP_ID` | Optional existing Windows notification identity during migration |
| `CHATS_DELIVERY_DEFAULTS_FILE` | External JSON mapping folder basenames to `origin/` production refs; repository config takes precedence |

Individual environment variables override the file. Unknown keys, malformed JSON and oversized config fail closed. Keep real values out of issues, screenshots, commits and public reports. See [the example](examples/config.example.json); its paths and project names are illustrative. `CHATS_PORT` changes the server port through an environment variable. It is intentionally not a private-config field.

```powershell
$env:CHATS_WORKSPACE_ROOT = Join-Path $HOME 'Projects'
$env:CHATS_TOPICS_FILE = Join-Path $env:LOCALAPPDATA 'chats-dashboard/topics.local.json'
Copy-Item -LiteralPath topics.example.json -Destination $env:CHATS_TOPICS_FILE
node server/server.mjs
```

Create the destination directory first and do not overwrite an existing private topics file. Topic rules reload when the file changes. Restart the server after changing the private config. An absent workspace is not automatically created. No private configuration is served as a static asset.

## Commands and optional integrations

```powershell
node cli.mjs
node relay-cli.mjs help
node relay-cli.mjs models
node scripts/install-relay.mjs
node scripts/enable-mobile.mjs --check
```

The Relay installer creates marked shims in `~/.local/bin` and the two Relay skills in the installed Claude/Codex skill directories. It refuses unmarked files. Installing changes local entry points: inspect the destination first. Windows shortcuts and the `chats-dashboard:` protocol are created by `setup-windows.ps1`; run it only after testing the desired checkout and retaining a rollback target. The app can be installed through Chrome and pinned manually. Programs cannot pin it to the taskbar for you.

| Integration | Implemented state and limits |
| --- | --- |
| Claude Code / Codex | Collectors, native transcript viewing, guarded input and managed CLI transport exist. Models/efforts are read from installed capability metadata. Login, entitlement and model availability are not inferred. New portable transport is verified with fake providers; no live subscription turn is part of regression testing. |
| Existing-chat Orchestrator | Explicitly started pair cycles only; coordinator performs no inference. Requires actual native Windows console identity. |
| Missions / request preparation | Implemented with isolated worktrees, scopes, executable checks and persistent budgets. Integration requires both bundled guards and an externally installed TruffleHog executable. Missing scanner blocks commits; no automatic installation. |
| Ollama summary | Optional, click only; conversation text goes to the configured server. Installed model required. Default endpoint is local. Health uses tags/process APIs without inference. |
| DGX GPU telemetry | Optional adapter to a user-supplied probe script. No bundled hardware integration or private host. Unconfigured/unavailable telemetry remains unknown. |
| Relay Evals | Local transcript/Git metrics and a weekly report. Labels use your Codex or Claude CLI login (no API keys); the benchmark spends turns only with `--live`. Data stays in the per-user app-data directory. |
| GitHub Actions | Read-only `gh` queries with existing login and exact commit evidence. No publishing or workflow creation. |
| Tailscale Serve | Optional private owner-only HTTPS gate. `--check` is read-only; `--enable` changes local Serve configuration and needs explicit owner authorization. No Funnel or public hosting. |
| Kimi, Grok and other providers | **Not integrated in Relay.** No worker, collector or login setup is supplied for them. |

Fable selections are blocked for managed Claude execution because headless use may spend additional credits. Native Claude workflows/delegation are disabled in protected turns. Capability/catalog support does not prove included quota or a successful live model call.

## Security boundaries

- Server binds loopback only and checks Host on every request. APIs use a per-run token; POST also requires exact Origin and JSON. No CORS or LAN listener.
- Remote access is blocked before HTML/assets/API/SSE unless the exact configured private HTTPS host and owner identity match. Mobile setup never replaces unrelated Serve configuration.
- Collectors open provider data read-only. Search/usage are private derived indexes; unknown or partial evidence is shown honestly. No model in polling, history, usage, logs or health.
- Service worker caches only the token-free offline shell and static assets. Authenticated API responses and the token-bearing root page are never cached.
- User input requires a verified idle session, empty console and no pair lease. Uncertain input is never replayed automatically. Focus/close use server-owned process identity.
- Missions have bounded parallelism, sessions, turns and deadlines. Worker checks are trusted project commands, not an OS sandbox. Shell access and subscription accounting cannot be described as exact spending isolation. Workers cannot recursively delegate, commit, delete existing resources or deploy.
- Private prompts/transcripts and your selected projects can contain sensitive information. Do not publish the app-data directories, generated logs, screenshots of real chats or worktrees. A Git ignore rule alone does not protect an upload.

## Missions on Next.js repositories

Source snapshots and task scopes support literal App Router paths such as
`app/[slug]/page.tsx`, `app/[...slug]/page.tsx`, `app/(marketing)/page.tsx` and
`app/@modal/page.tsx`. Scopes match literal paths; `*`, `?`, traversal, `.git`,
symlinks and protected files remain refused. Clean sources use fast-forward
delivery; dirty sources retain their original HEAD, index and unrelated edits.
The CLI waits up to six minutes for draft creation, including source preparation,
without starting workers or extending mission budgets.

Tasks and the mission may set an optional `checkTimeoutsMs` array aligned with
their argument-array `checks`. For example, `"checks": [["npm", "run", "build"]],
"checkTimeoutsMs": [900000]` allows fifteen minutes for the project's build.
Each entry is `null` (use the default) or integer milliseconds from 1 to 43,200,000.
Omitted arrays preserve the 120-second task and 180-second integration/apply defaults.
Explicit timeouts follow their checks into integration and apply. Task checks are
capped by the remaining task and mission deadlines; final checks by the mission
deadline, and apply checks by its separate 30-minute operation deadline. Session,
turn and admission budgets stay unchanged. Use meaningful checks from the target
project; these commands run without a shell and cannot install dependencies.

## Relay Evals

Relay Evals measures how well you orchestrate coding agents (prompts, specs,
models, effort) from your local Claude Code and Codex transcripts and Git history.
Nothing runs in the background: run it by hand or schedule one weekly task. The
**Evals** page reads the newest report only when opened or reloaded.

| Measure | Definition |
| --- | --- |
| Corrections | Your follow-up messages that say something was wrong, missing, redone or not what you asked, per 10 messages you sent. A model labels each follow-up with the agent's previous reply as context: Codex (GPT-6.1 Sol, low effort) by default, or Claude (Sonnet 5.5, low effort). Asking to change something just delivered is a correction; questions, status checks, new information and extra work are not. Unlabeled chats fall back to fixed Spanish/English text rules. |
| Broken "done" | The agent said the work was finished or verified, and your next message reported a failure, wrong data, a missing part or a visible defect. A change of taste is not broken "done". |
| Verified commits | Commits made after a test, build, lint or typecheck that did not fail earlier in the same turn. |
| Fixed or reverted within 72 h | A later commit from another chat within three days that reverted the commit, or looks like a fix and touches the same file. |
| Predictors | Chat traits (spec, effort, prompt length, compaction, provider, model, task type, tool errors) compared within similar chat lengths, with seeded bootstrap 95% intervals and a Holm correction. Only validated predictors appear as a non-blocking note before a mission starts. |
| Label check | A yes/no CSV sample of the model's labels. The report shows confirmed shares with Wilson intervals, the labeling model (`labeled_by`) and the reviewer (`checked_by`); a model review is labeled as such. |
| Spec judge | A fixed four-criterion rubric. It stays **not calibrated** until at least 80 of your labels agree with it (weighted kappa ≥ 0.6) and its score predicts fewer problems. |
| Benchmark | A catalog of past tasks, a frozen reproducible suite (dev/holdout split) and a Relay runner. |

```powershell
node evals/cli.mjs weekly                    # full report now (--no-notify skips the toast)
node evals/cli.mjs extract | labels | metrics | catalog | report
node evals/cli.mjs label-check               # yes/no CSV to check the model's labels
node evals/cli.mjs judge kit                 # spec labeling kit
node evals/cli.mjs benchmark freeze | estimate | sample
node evals/cli.mjs benchmark sample --live   # spends subscription turns
powershell -ExecutionPolicy Bypass -File evals/schedule-weekly.ps1 install   # optional Sunday 20:00 task
```

- `weekly`, `report` and `labels` call the labeling model through your existing CLI login.
  Codex runs headless `codex exec` with a read-only sandbox, ephemeral session, no user
  config, no subagents, a JSON output schema and no API keys. `--labeler claude` or
  `RELAY_EVALS_LABELER=claude` uses headless `claude -p` with no tools, MCP servers,
  hooks, session file or API keys. Labels are cached per message and model. Runs are
  bounded (4,000 messages, 2 parallel calls, 5 minutes per call, 90 minutes in total,
  stop after 3 failures). `--no-labels` keeps the text rules only.
- `benchmark sample --live` is capped at 10 tasks × 2 variants without `--allow-full`.
  It only takes dev tasks a scratch clone can run unattended: no sending, publishing,
  deploying, paying or deleting; no outside files or services; a code change and a
  visible check; not the whole `CHATS_WORKSPACE_ROOT`. The output counts each skip reason.
- **Ask an agent about this report** opens one interactive Claude (Opus 5.5, default) or
  Codex (GPT-6.1 Sol) chat per click, with a fixed analysis prompt and read-only access
  to the report and dataset. Each click counts against the mission admission limits.

| Data | Default location (override) |
| --- | --- |
| Private dataset, run log and frozen suites | `%LOCALAPPDATA%\chats-dashboard\evals\` (`RELAY_EVALS_HOME`) |
| Weekly reports (`report.json`, `report.html`) | `<evals home>\reports\<date>\` (`RELAY_EVALS_REPORTS`) |
| Labeling kits and label checks | `labeling\` and `label-check\` next to the reports folder |
| Task contracts (`<folder>/checklist.md` or `requirements.json`) | `~/Downloads/agent-work/` (`RELAY_EVALS_CONTRACTS`) |
| Optional secret checker (`<script> check <file>`) | none (`RELAY_EVALS_SECRET_CHECK`) |

Provider files are only read. Text is redacted on extraction; a configured secret
checker scrubs flagged texts again. The dataset and reports contain your prompts:
keep them private and never commit or publish them.

## Verification and publication

`public-files.json` is the exact reviewed staging allowlist. It excludes local config, dependency trees, generated builds, screenshots, provider records and runtime caches. All source and assets must be reviewed before the allowlist changes.

```powershell
node scripts/publication-check.mjs snapshot
node scripts/publication-check.mjs staged
node tools/staged-secret-scan.mjs --repo . --scanner C:/Tools/trufflehog.exe
node tools/change-guard.mjs --repo .
node scripts/publication-check.mjs commit
```

The built-in privacy check is a conservative pattern/allowlist gate, not a guarantee that no personal information exists. Also review the full diff and binary visuals, scan with an external secret detector and a private machine/project denylist, and inspect committed metadata and complete history. Do not print secrets in reports. See [AGENTS.md](AGENTS.md) for the **HARD** first-publication human approval gate and [local migration](docs/local-migration.md) for reversible adoption.

```powershell
$env:CHATS_TEST_WAIT_MS = '120000'
node --no-warnings --test --test-concurrency=2 "test/*.test.mjs"
```

Tests use isolated homes, fake providers, hidden consoles and independent Git fixtures. They do not certify live provider inference, actual Windows toast visibility, mobile connectivity, installed app pinning or a GitHub production deployment. The desktop Windows features are not certified on Linux/macOS.

## License and attribution

Agent Relay is available under the [MIT License](LICENSE). Anyone may use, modify and redistribute it, including commercially, provided the copyright and permission notice are retained.

The software is provided **as is, without warranty**. The maintainers do not guarantee security, absence of vulnerabilities, suitability for a particular purpose, availability or continued support. Security checks and passing tests do not certify that the software is vulnerability-free. See [LICENSE](LICENSE) for the complete warranty and liability terms.

Third-party assets and dependencies retain their own licenses. Included LobeHub brand icons retain their MIT attribution and complete license in [NOTICE.md](NOTICE.md). Dependency licenses are retained by `npm ci`; inspect the pinned dependency license inventory before redistribution. Brand assets do not imply provider endorsement.
