import type {
  ImplementationReport,
  ReviewReport,
  TaskRecord,
  TaskSpec,
  TestReport
} from "./domain.js";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function plannerPrompt(task: TaskRecord, schema: object): string {
  return `You are the read-only planning agent for an autonomous software workflow.

Read AGENTS.md and inspect the repository. Turn the user's goal into one bounded implementation task. Make reversible local assumptions instead of asking questions. Do not edit files or run side-effecting commands.

Task id: ${task.id}
User goal: ${task.goal}

Validation commands must be represented as executable plus an argument array, never as a shell string. Prefer existing project scripts. Do not include dependency installation, deployment, push, publication, destructive commands, or access outside the workspace.

Return only JSON matching this schema:
${json(schema)}`;
}

export function builderPrompt(
  task: TaskRecord,
  spec: TaskSpec,
  review: ReviewReport | null,
  schema: object
): string {
  return `You are the implementation agent in an autonomous software workflow.

Read CLAUDE.md and implement the task below in the current workspace. Stay within allowedPaths. Preserve unrelated changes. Do not install dependencies, access secrets, publish, deploy, push, merge, or use destructive commands unless already authorized. If permission is missing, do not ask interactively; return it in needsApproval.

Task:
${json(spec)}

${review ? `Review findings to fix:\n${json(review)}` : "This is the first implementation pass."}

Run permitted checks that help you validate the implementation. Return only structured output matching this schema. Report tests truthfully and include every unresolved issue:
${json(schema)}`;
}

export function reviewerPrompt(
  task: TaskRecord,
  spec: TaskSpec,
  implementation: ImplementationReport,
  tests: TestReport,
  schema: object
): string {
  return `You are the independent, read-only reviewer in an autonomous software workflow.

Read AGENTS.md. Inspect the current git diff and relevant files. Do not edit anything. Review only against the task specification and concrete regressions. Treat deterministic test results as authoritative. Return changes_requested only for actionable defects; avoid style-only preferences unless they violate repository rules.

Task record:
${json({ id: task.id, goal: task.goal, repairCount: task.repairCount })}

Specification:
${json(spec)}

Builder report:
${json(implementation)}

Deterministic test report:
${json(tests)}

Return only JSON matching this schema:
${json(schema)}`;
}
