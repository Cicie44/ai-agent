# AI Dev Orchestrator

A deterministic local development loop that uses Codex for planning and independent review, Claude Code for implementation, and ordinary commands for validation. Agents exchange JSON artifacts instead of copied chat messages.

## What phase one includes

- Persistent task state under `.ai/tasks/<task-id>/`
- JSON Schema contracts for plans, implementation reports, reviews, and approvals
- Codex SDK planner/reviewer adapter in read-only mode
- Claude Code non-interactive builder adapter with structured output, a per-run budget, and an explicit tool allow list
- Deterministic validation commands with an approval broker
- Automatic review/repair loops with configurable limits
- `AGENTS.md` and `CLAUDE.md` generated from one shared contract
- A small CLI for tasks, approvals, and environment checks

Phase one stops at a verified local result. Browser QA, isolated worktree merging, commits, pushes, deployment, and publication remain later policy-gated stages.

## Setup

```powershell
npm install
npm run sync:contracts
npm run check
npm test
npm run autopilot -- doctor
```

The Codex SDK uses the local Codex authentication/runtime. Claude Code uses the existing Claude Code login. Do not place credentials in this repository.

## Run a task

```powershell
npm run autopilot -- task create "Build the first Skill Factory MVP"
npm run autopilot -- task list
npm run autopilot -- task run TASK-YYYYMMDD-XXXXXX
```

If the task stops at a permission gate:

```powershell
npm run autopilot -- approvals list
npm run autopilot -- approvals approve APR-ID
npm run autopilot -- task run TASK-YYYYMMDD-XXXXXX
```

The second `task run` resumes the same Codex and Claude sessions after all requests in the batch are approved.

Only one process may run a task at a time. If a host crash leaves a stale lock that cannot be detected automatically, clear that exact task lock with `npm run autopilot -- task unlock TASK-ID` after confirming no run is active.

## State machine

```text
BACKLOG -> READY -> IMPLEMENTING -> TESTING -> REVIEWING
                         ^              |           |
                         |              v           v
                         +-------- REPAIRING <------+ 

REVIEWING -> QA -> RELEASE_READY -> DONE
any state -> BLOCKED -> approved resume state
```

## Configuration

`.ai/project.json` selects providers and optional models. A `null` model uses the installed SDK/CLI default. Environment variables can override models without modifying the tracked file:

```text
CODEX_PLANNER_MODEL
CODEX_REVIEWER_MODEL
CLAUDE_BUILDER_MODEL
```

`.ai/policy.json` controls:

- repair and step limits
- command timeout and output limits
- Claude's maximum budget per run
- exact command prefixes that may run automatically
- operations that always require a human gate

Do not broadly allow shells such as `powershell`, `cmd`, `bash`, `node`, or `python`. Add narrow project commands instead.

## Artifact protocol

Each task may contain:

```text
status.json
spec.json
implementation-report.json
test-report.json
review-report.json
```

Runtime artifacts and approval decisions are ignored by Git. Project policy, schemas, and the shared agent contract remain versioned.

## Safety model

- Codex plans and reviews with a read-only sandbox request.
- Claude runs in `dontAsk` mode with explicitly allowed tools; missing capabilities become batched approval requests.
- Validation commands are spawned directly without a shell.
- External writes, secrets, destructive operations, production changes, and network expansion are never auto-approved by the default policy.
- `--dangerously-skip-permissions` is intentionally not used.

## Next milestone

Use this loop to build the Skill Factory itself, then add browser QA, isolated per-task worktrees, a compact approval dashboard, GitHub PR automation, and cost/success metrics.
