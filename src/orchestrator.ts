import type {
  BuilderAgent,
  ImplementationReport,
  PlannerAgent,
  PolicyConfig,
  ReviewerAgent,
  ReviewReport,
  TaskRecord,
  TaskSpec,
  TaskState,
  TestReport
} from "./domain.js";
import { CommandRunner } from "./command-runner.js";
import { PermissionBroker } from "./permission-broker.js";
import { AiStore } from "./store.js";

export class Orchestrator {
  constructor(
    private readonly store: AiStore,
    private readonly planner: PlannerAgent,
    private readonly builder: BuilderAgent,
    private readonly reviewer: ReviewerAgent,
    private readonly runner: CommandRunner,
    private readonly broker: PermissionBroker,
    private readonly policy: PolicyConfig
  ) {}

  private async transition(task: TaskRecord, state: TaskState, payload: unknown = {}): Promise<void> {
    const previous = task.state;
    task.state = state;
    delete task.lastError;
    await this.store.writeTask(task);
    await this.store.appendEvent(task.id, "task.transition", { from: previous, to: state, ...asObject(payload) });
  }

  private async block(
    task: TaskRecord,
    resumeState: Exclude<TaskState, "BLOCKED" | "DONE">,
    reason: string,
    approvalIds: string[]
  ): Promise<void> {
    task.block = { reason, resumeState, approvalIds };
    await this.transition(task, "BLOCKED", { reason, approvalIds });
  }

  private async maybeResume(task: TaskRecord): Promise<boolean> {
    if (task.state !== "BLOCKED" || !task.block) return false;
    if (!(await this.broker.areApproved(task.block.approvalIds))) return false;
    const resumeState = task.block.resumeState;
    delete task.block;
    await this.transition(task, resumeState, { reason: "approved" });
    return true;
  }

  private async blockForProductDecision(
    task: TaskRecord,
    resumeState: Exclude<TaskState, "BLOCKED" | "DONE">,
    resource: string,
    reason: string
  ): Promise<void> {
    const id = await this.broker.requestProductDecision(task.id, resource, reason);
    await this.block(task, resumeState, reason, [id]);
  }

  private async requestRepairs(task: TaskRecord, review: ReviewReport): Promise<void> {
    task.repairCount += 1;
    await this.store.writeArtifact(task.id, "review-report.json", review);
    if (task.repairCount > this.policy.limits.maxRepairCycles) {
      await this.blockForProductDecision(
        task,
        "REPAIRING",
        "repair-limit",
        `Repair limit reached after ${this.policy.limits.maxRepairCycles} cycles: ${review.summary}`
      );
      return;
    }
    await this.transition(task, "REPAIRING", { repairCount: task.repairCount });
  }

  async runTask(taskId: string): Promise<TaskRecord> {
    const release = await this.store.acquireTaskLock(taskId);
    try {
      return await this.runTaskLocked(taskId);
    } finally {
      await release();
    }
  }

  private async runTaskLocked(taskId: string): Promise<TaskRecord> {
    let task = await this.store.readTask(taskId);
    for (let step = 0; step < this.policy.limits.maxAgentSteps; step += 1) {
      if (task.state === "DONE") return task;
      if (task.state === "BLOCKED") {
        const resumed = await this.maybeResume(task);
        if (!resumed) return task;
      }
      try {
        if (task.state === "BACKLOG") {
          const result = await this.planner.plan(task);
          if (result.sessionId) task.sessions.planner = result.sessionId;
          await this.store.writeArtifact(task.id, "spec.json", result.value);
          await this.transition(task, "READY");
        } else if (["READY", "IMPLEMENTING", "REPAIRING"].includes(task.state)) {
          const spec = await this.store.readArtifact<TaskSpec>(task.id, "spec.json");
          let review: ReviewReport | null = null;
          if (task.state === "REPAIRING") {
            review = await this.store.readArtifact<ReviewReport>(task.id, "review-report.json");
          }
          await this.transition(task, "IMPLEMENTING");
          const result = await this.builder.implement(task, spec, review);
          if (result.sessionId) task.sessions.builder = result.sessionId;
          await this.store.writeArtifact(task.id, "implementation-report.json", result.value);
          if (result.value.status === "blocked" || result.value.needsApproval.length > 0) {
            const ids = await this.broker.requestAgentNeeds(task.id, result.value.needsApproval);
            if (ids.length === 0) {
              ids.push(
                await this.broker.requestProductDecision(
                  task.id,
                  "builder-blocked",
                  result.value.unresolved.join("; ") || result.value.summary
                )
              );
            }
            await this.block(task, "IMPLEMENTING", result.value.summary, ids);
          } else {
            await this.transition(task, "TESTING");
          }
        } else if (task.state === "TESTING") {
          const spec = await this.store.readArtifact<TaskSpec>(task.id, "spec.json");
          const report = await this.runner.runAll(task.id, task.workspacePath, spec.validationCommands);
          await this.store.writeArtifact(task.id, "test-report.json", report);
          if (report.status === "blocked") {
            const ids = report.results.flatMap((result) => (result.approvalId ? [result.approvalId] : []));
            await this.block(task, "TESTING", "A validation command requires approval", ids);
          } else if (report.status === "failed") {
            const review: ReviewReport = {
              verdict: "changes_requested",
              summary: "Deterministic validation failed",
              findings: report.results
                .filter((result) => result.status === "failed")
                .map((result) => ({
                  severity: "high",
                  file: "",
                  line: null,
                  issue: `${result.command} failed: ${result.stderr || result.stdout}`,
                  expected: `${result.label} must pass`
                }))
            };
            await this.requestRepairs(task, review);
          } else {
            await this.transition(task, "REVIEWING");
          }
        } else if (task.state === "REVIEWING") {
          const spec = await this.store.readArtifact<TaskSpec>(task.id, "spec.json");
          const implementation = await this.store.readArtifact<ImplementationReport>(
            task.id,
            "implementation-report.json"
          );
          const tests = await this.store.readArtifact<TestReport>(task.id, "test-report.json");
          const result = await this.reviewer.review(task, spec, implementation, tests);
          if (result.sessionId) task.sessions.reviewer = result.sessionId;
          await this.store.writeArtifact(task.id, "review-report.json", result.value);
          if (result.value.verdict === "pass") {
            await this.transition(task, "QA");
          } else if (result.value.verdict === "changes_requested") {
            await this.requestRepairs(task, result.value);
          } else {
            await this.blockForProductDecision(task, "REVIEWING", "reviewer-blocked", result.value.summary);
          }
        } else if (task.state === "QA") {
          // Phase one treats deterministic validation as the QA gate. Browser QA plugs in here later.
          await this.transition(task, "RELEASE_READY");
        } else if (task.state === "RELEASE_READY") {
          // External writes and commits remain policy-gated; phase one stops at a verified local result.
          await this.transition(task, "DONE");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        task.lastError = message;
        await this.store.writeTask(task);
        const resumeState = task.state === "BLOCKED" ? "IMPLEMENTING" : task.state;
        if (/\b401\b|failed to authenticate|oauth access token has expired/i.test(message)) {
          const request = await this.broker.request(task.id, {
            kind: "secret_access",
            resource: "agent-authentication",
            reason: message,
            risk: "high"
          });
          await this.block(task, resumeState, "Agent authentication requires user action", [request.id]);
        } else {
          await this.blockForProductDecision(task, resumeState, "orchestrator-error", message);
        }
      }
      task = await this.store.readTask(taskId);
    }
    task = await this.store.readTask(taskId);
    if (task.state === "DONE") return task;
    const resumeState =
      task.state === "BLOCKED" ? (task.block?.resumeState ?? "IMPLEMENTING") : task.state;
    await this.blockForProductDecision(
      task,
      resumeState,
      "step-limit",
      `Agent step limit reached (${this.policy.limits.maxAgentSteps})`
    );
    return this.store.readTask(taskId);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
