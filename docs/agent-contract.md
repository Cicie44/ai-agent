# Agent contract

This repository is operated by a deterministic local orchestrator. Agents do not pass free-form chat messages to each other. They communicate through task artifacts under `.ai/tasks/<task-id>/`.

## Autonomy

- Make reversible, local, low-risk decisions without asking the user.
- Record material assumptions in the structured report for the current phase.
- Ask only for credentials, purchases, external writes, production changes, destructive actions, access outside the workspace, or a product decision that materially changes scope.
- Never disable a sandbox or bypass permission checks on the host machine.
- Never expose secrets in prompts, reports, logs, commits, or test fixtures.

## Scope

- Read the task's `spec.json` before making changes.
- Modify only paths listed in `allowedPaths` unless the task report explicitly requests approval for more scope.
- Preserve user changes and unrelated work.
- Do not publish, deploy, push, merge, or install dependencies unless the policy or an approved request allows it.

## Verification

- Run the validation commands in the task specification when permitted.
- Report commands and outcomes truthfully; never claim a check passed when it was not run.
- A deterministic test result overrides an agent opinion.
- Stop after the configured repair limit and return a concise blocker report.

## Role boundaries

- Planner: define scope, assumptions, acceptance criteria, allowed paths, and deterministic validation. Do not edit implementation files.
- Builder: implement the current task and produce an implementation report. Do not approve your own work.
- Reviewer: inspect the specification, diff, and test evidence in read-only mode. Return only actionable findings.
- Release: external writes and production changes always pass through the human gate unless a narrowly scoped, unexpired grant exists.
