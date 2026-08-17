# Architecture

## Components

1. `Orchestrator` is the only component that advances task state. It is deterministic and bounded by step and repair limits.
2. `CodexAgentAdapter` supplies a read-only planner and an independent reviewer through the Codex SDK.
3. `ClaudeCodeAdapter` runs Claude Code non-interactively and validates its structured implementation report.
4. `CommandRunner` executes argument arrays directly, never interpolated shell strings.
5. `PermissionBroker` converts capabilities outside the allow list into persistent, batchable approval requests.
6. `AiStore` persists task artifacts and an append-only event stream so a run can resume after interruption.

## Trust boundaries

- The repository root is the default writable boundary.
- The task specification narrows intended writes with `allowedPaths`.
- Model output never directly changes task state; it is parsed and validated first.
- The builder cannot approve its own work.
- A deterministic validation failure always creates a repair cycle.
- External side effects are not part of phase one.

## Skill Factory v0.2

Skill authoring is separated from package writes by the `SkillAuthoringProvider` interface. Providers receive only the brief, derived metadata, attempt number, and structured diagnostics; they return an untrusted candidate object and never receive filesystem tools. `OfflineSkillProvider` is the default. `ClaudeCodeSkillProvider` is opt-in, runs with argument arrays and `shell: false`, requests JSON Schema output, disables tools, bounds time and output, and exposes only classified errors.

`createSkill` is the sole package writer. It canonicalizes the workspace and destination, rejects symlink and junction escapes, validates every candidate, and permits an initial attempt plus two repairs. Claude failures or exhausted repairs receive one offline fallback attempt. The final `evals/quality-report.json` is deterministic and contains no prompt, raw provider output, environment, or authentication data.

Quality scoring is a static 100-point gate covering package validity, substantive instructions, eval coverage, and portable file references. A score of 80 is required, and structurally invalid packages can never pass.

`skill install-plan` is read-only. It canonicalizes and validates a workspace-local source, rejects links and non-regular files, and produces symbolic copy destinations for Codex and Claude Code. Actual installation remains an explicit external-write gate.

## Planned extensions

- `WorkspaceManager` for one Git worktree and branch per task
- browser/computer-use QA adapter
- scoped grants with expiration and run/project lifetimes
- release adapter for local commits and approval-gated PRs
- dashboard backed by the existing `.ai` protocol
- agent traces, cost accounting, and regression evals
