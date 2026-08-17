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

## Skill Factory

The Skill Factory converts a natural-language workflow brief into a validated, portable skill package. The default provider is deterministic and entirely offline; an explicit Claude Code provider adds AI-assisted authoring with a bounded repair loop and an automatic offline fallback.

### Create a skill

```powershell
npm run autopilot -- skill create "Summarize a document into three bullet points"
```

By default the skill name is derived from the brief (lowercase, hyphenated) and the package is written to `skills/<name>/`. Both can be overridden:

```powershell
npm run autopilot -- skill create "brief" --name my-skill-name
npm run autopilot -- skill create "brief" --out ./custom/output/path
```

AI-assisted authoring is opt-in:

```powershell
npm run autopilot -- skill create "Build a release-note workflow" --provider claude-code
```

The Claude provider runs non-interactively with a JSON Schema response and no filesystem or shell tools. Every candidate is validated and scored, with at most two repair rounds. If Claude fails or exhausts repairs, one deterministic offline fallback is attempted. Automated tests never invoke Claude or the network.

### Validate an existing skill package

```powershell
npm run autopilot -- skill validate ./skills/my-skill-name
```

### Preview installation

```powershell
npm run autopilot -- skill install-plan ./skills/my-skill-name --target all
```

Targets are `codex`, `claude-code`, or `all`. This command is a strict dry run: it validates the package and prints deterministic JSON copy operations using symbolic destinations such as `$CODEX_HOME/skills`. It never probes, creates, or writes to user-level installation directories.

### Generated directory layout

```
skills/<name>/
  SKILL.md            — YAML frontmatter (name, description) + workflow instructions
  evals/
    evals.json        — skill_name + array of at least two eval cases
    quality-report.json — provider attempts, checks, score, threshold, and final status
```

**SKILL.md** structure:

```markdown
---
name: my-skill-name
description: "What the skill does"
---

## Instructions

<brief text preserved verbatim>

## Steps

1. Analyze the provided request or input.
2. Execute the workflow described in the instructions.
3. Return a clear, complete result.
```

**evals/evals.json** structure:

```json
{
  "skill_name": "my-skill-name",
  "evals": [
    {
      "id": "my-skill-name-eval-001",
      "prompt": "Demonstrate the core workflow: ...",
      "expected_output": "...",
      "files": []
    },
    {
      "id": "my-skill-name-eval-002",
      "prompt": "Edge case: ...",
      "expected_output": "...",
      "files": []
    }
  ]
}
```

### Validation behavior

The validator (run automatically after creation and available as a standalone command) detects:

- Missing `SKILL.md` or `evals/evals.json`
- Malformed YAML frontmatter (missing `---` delimiters)
- Invalid skill name (must be `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)
- Empty `description` or empty instruction body
- Mismatched `skill_name` between the two files
- Fewer than two eval cases
- Eval cases with empty `id`, `prompt`, or `expected_output`
- Duplicate eval case identifiers
- Unsafe file references in `files` arrays (absolute paths or `..` traversal)

A non-zero exit status is returned when any diagnostic is found.

### Quality and repair loop

Each creation is scored from 0 to 100 using a deterministic rubric:

- 50 points: the package passes structural validation
- 20 points: instructions are substantive and contain actionable steps
- 20 points: at least two complete eval cases are present
- 10 points: eval file references are portable

The default pass threshold is 80, and structural validation must pass regardless of score. The versioned report at `evals/quality-report.json` records the requested and effective providers, bounded attempt summaries, checks, diagnostics, fallback reason, score, and threshold. It deliberately excludes prompts, provider stdout/stderr, environment variables, and authentication material.

### Safeguards

**Workspace boundary** — the `--out` path must resolve to a location inside the current working directory. Paths using `..`, absolute paths pointing outside the workspace, and symlink or junction escapes are rejected.

**Overwrite protection** — creation is refused if the destination directory already exists and contains files. Choose a different `--name` or `--out` to avoid collisions.

**Skill name rules** — names must start with a lowercase letter, contain only lowercase ASCII letters, digits, and hyphens, with no consecutive or trailing hyphens.

### MVP limitations

- Generation uses a deterministic local template unless `--provider claude-code` is selected explicitly.
- Generated eval prompts and expected outputs are scaffolded stubs. Edit `evals/evals.json` to add domain-specific cases.
- Quality scoring is static; the factory does not execute skills or model-judge semantic outputs.
- Installation is planning-only. The factory does not copy into a runtime or publish to a registry.

## Next milestone

Use this loop to build the Skill Factory itself, then add browser QA, isolated per-task worktrees, a compact approval dashboard, GitHub PR automation, and cost/success metrics.
