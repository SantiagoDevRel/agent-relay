---
name: agent-relay-orchestrator
description: Orchestrate implementation tasks across local Git projects with Agent Relay, using bounded Codex or Claude subscription chats, dependencies, isolated worktrees, executable acceptance checks, and live mission status. Use when asked to coordinate several features or continue a Relay mission; ordinary single-file edits do not need a mission.
---

# Agent Relay orchestration

Write generated specifications, coordination updates and final reports in English. Preserve literal user requirements, proper names and identifiers in their original form.

Use the installed `relay` CLI from any folder. `relay help` and `relay models` expose the local server and installed provider capabilities. The app is http://127.0.0.1:4848. No new API keys are needed; never introduce paid API fallbacks.

When the user asks for implementation, carry the mission through verified integration. Do not stop at a plan or at a worker's assertion of success. Do not start a mission merely because this skill was loaded.

## Turn a request into a mission

Read the target project's AGENTS.md, its parent instructions, source files and existing tests. Resolve the actual repository path; example project names are placeholders, not permission to operate on every project. Preserve each literal feature with an ID and executable acceptance evidence. Put contracts and logs in Downloads/agent-work, outside the repository.

Plan shared schemas, interfaces and setup tasks first. Use `dependsOn` for real prerequisites. Declare exact files or directory scopes ending in `/`; overlapping scopes automatically serialize. Choose parallelism from the dependency graph, rather than opening one process for every feature. Start with three concurrent workers. Use the user's model/effort choice; use `relay models` to check installed support, and disclose unsupported choices instead of substituting silently.

For an underspecified initial request, apply `agent-relay-spec` to develop observable requirements, security boundaries and verification. `relay refine @request.json` explicitly spends one read-only turn with `{kind:"mission",goal,acceptance,project,provider,model,effort}`. Review its questions and edited specification before planning implementation. Preserve the original request; never run redundant refiners automatically. Exact Claude IDs and efforts come from its installed local catalog. Ultracode is a workflow mode and is disabled in protected sessions; managed Fable inference is blocked because headless use can spend additional credits.

Write a JSON contract file, then call `relay create @C:/absolute/contract.json --start`. Example:

```json
{
  "title": "Implement requested features",
  "goal": "Implement every feature and verify the complete user flow",
  "project": "C:/absolute/project",
  "provider": "codex",
  "model": "",
  "effort": "high",
  "limits": {"concurrency": 3, "maxSessions": 16, "maxTurns": 24, "taskMinutes": 60, "missionMinutes": 720},
  "tasks": [
    {"id": "shared-contract", "title": "Define shared interface", "prompt": "Literal request and acceptance criteria", "dependsOn": [], "files": ["src/contracts.ts", "test/contracts.test.ts"], "checks": [["npm", "run", "test", "--", "test/contracts.test.ts"]]},
    {"id": "feature", "title": "Implement the feature", "prompt": "Literal feature request, boundaries, and observable acceptance", "dependsOn": ["shared-contract"], "files": ["src/feature.ts", "test/feature.test.ts"], "checks": [["npm", "run", "test", "--", "test/feature.test.ts"]]}
  ],
  "checks": [["npm", "run", "test"], ["npm", "run", "build"]]
}
```

Use actual scripts and paths from the repository; the example is a schema, not a prescribed test command. Every task and the complete integration need meaningful checks. A version check, echo, or an assertion that a file exists does not establish feature correctness. UI work also needs rendering and inspection at narrow, medium, wide and touched breakpoints; check overflow, complete labels, typography, states and the main user journey.

`relay plan @request.json` can produce a read-only model plan from `{title,goal,project,provider,model,effort,limits}`. Review that generated contract against the literal request before creating it. Planning consumes one session; idle monitoring consumes none. Do not call another planner to repeat your own planning unnecessarily.

## Coordinate and verify

Use `relay status MISSION --json` for the dependency tree and receipts. Read every child with `relay log MISSION TASK`; the parent has access to all task logs. Open a live managed chat with `relay chat MISSION TASK`, or `relay terminal MISSION TASK` to view it in a tab. Named Windows Terminal windows keep the orchestrator and its child viewers together. Launch `relay orchestrate --provider claude --project C:/repo` for a new native orchestrator; it inherits the shared skill and window name.

The native launch prompt supplies an explicit window name and server port. Preserve them with `--window NAME --port PORT` on plan/create commands, or set `terminalWindow` and `terminalViews: true` in the contract. Environment inheritance alone is not proof that child viewers will use the same window or port. The viewers stream managed conversations; they do not duplicate native provider TUIs.

Workers are independent sessions. They work only in isolated task worktrees. Never run another provider CLI, `ai-chat fan`, recursive agents, or reviewer swarms from a worker. Do not change budgets, reset counters or create a replacement mission to bypass a limit. Native delegation is disabled in managed workers. Review code and evidence directly; a cross-model review remains subject to the user's explicit authorization.

A stopped or failed task needs diagnosis, not an automatic replay. Read its log, preserve the original deadline, and send a bounded clarification with `relay message MISSION TASK @message.txt` or explicitly `relay retry MISSION TASK`. A retry reuses its known session and consumes the original budget. Ambiguous delivery, missing session evidence, conflicts, scope violations and failed gates require attention. Never fabricate missing authority or silently drop a feature.

A reached deadline preserves work and requires attention, not abandonment or a claim of completion. Extend explicitly with `relay extend MISSION --minutes 60` and, when needed, `relay extend MISSION --minutes 60 --task TASK`, then resume/retry. Extension does not reset session/turn counters or start a process. Do not remove time limits or create a replacement mission to bypass admission controls.

If the coordinator already committed the task, retry verifies that exact candidate and retries integration without a model turn. An unresolved merge is retained for deliberate resolution and a verified commit in the integration worktree; never reset or erase it. Relay restores only original tracked npm lockfiles with lifecycle scripts disabled in isolated worktrees. Missing tooling or generated setup must be resolved as a prerequisite, not bypassed with weaker checks.

The server runs task checks, checks changed paths, blocks secret paths and deletions, commits only task-owned files, and merges approved work into an isolated integration branch. It runs integration checks before marking `ready`. Read the merged diff and validate any project-specific security or production requirements. Dirty projects are preserved through guarded isolated baseline snapshots, including allowed staged, unstaged and untracked source. Then `relay apply MISSION` requires the original branch, HEAD, index and content to match the captured baseline. A clean source fast-forwards; a dirty source receives only the verified mission delta, keeping user staging and original HEAD intact. Verified commits remain in the integration worktree. If source changed, reconcile deliberately; never force, reset, stash or erase user work.

Apply reruns task and integration checks plus the durable literal-requirements gate. It has a separate 30-minute verification deadline, so an already verified mission can be applied after its execution deadline. Stop before applying if cancellation is needed; an in-progress apply remains serialized until completion.

## Limits and completion

Hard managed limits: up to 24 tasks; 4 simultaneous turns globally; at most 24 new sessions/hour and 64/day, 48 turns/hour and 128/day. A mission additionally fixes its own session/turn/time limits. Limits persist across restarts. Native orchestrator launches are limited to three/hour. An interactive native chat's manual user turns are outside managed-worker accounting; the UI must not claim otherwise.

These controls govern Relay and native delegation tools. Trusted workers with shell access are not an OS sandbox: do not claim they cannot run arbitrary processes. Never install packages, buy services, delete user resources, deploy or push unless the existing task/project authorization covers it.

Finish only when every requested item has evidence and the integration is applied (or explicitly report a concrete block). Report the actual checks and any unverified production behavior. Preserve worktrees and logs for inspection. Do not claim “100% secure” or invent subscription token billing; session and turn counters are operational limits, not provider invoices.
