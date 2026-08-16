import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { CommandRunner } from "../src/command-runner.js";
import type {
  BuilderAgent,
  ImplementationReport,
  PlannerAgent,
  ReviewerAgent,
  ReviewReport,
  TaskSpec
} from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { PermissionBroker } from "../src/permission-broker.js";
import { AiStore } from "../src/store.js";
import { testPolicy, withTempWorkspace } from "./helpers.js";

const completed: ImplementationReport = {
  status: "completed",
  summary: "implemented",
  filesChanged: ["src/example.ts"],
  commandsRun: [],
  tests: [],
  needsApproval: [],
  unresolved: []
};

function specFor(id: string): TaskSpec {
  return {
    id,
    goal: "test goal",
    acceptanceCriteria: ["works"],
    assumptions: [],
    nonGoals: [],
    allowedPaths: ["src/**"],
    validationCommands: [],
    riskLevel: "local-safe"
  };
}

class FakePlanner implements PlannerAgent {
  async plan(task: { id: string }) {
    return { value: specFor(task.id), sessionId: "planner-session" };
  }
}

class AuthFailingPlanner implements PlannerAgent {
  async plan(): Promise<never> {
    throw new Error("API Error: 401 OAuth access token has expired");
  }
}

class FakeBuilder implements BuilderAgent {
  calls = 0;
  constructor(private readonly firstReport: ImplementationReport = completed) {}
  async implement() {
    this.calls += 1;
    return { value: this.calls === 1 ? this.firstReport : completed, sessionId: "builder-session" };
  }
}

class FakeReviewer implements ReviewerAgent {
  calls = 0;
  constructor(private readonly firstVerdict: ReviewReport["verdict"] = "pass") {}
  async review() {
    this.calls += 1;
    const verdict = this.calls === 1 ? this.firstVerdict : "pass";
    return {
      value: {
        verdict,
        summary: verdict === "pass" ? "approved" : "fix it",
        findings:
          verdict === "pass"
            ? []
            : [{ severity: "high" as const, file: "src/example.ts", line: 1, issue: "bug", expected: "fix" }]
      },
      sessionId: "reviewer-session"
    };
  }
}

async function fixture(root: string, builder = new FakeBuilder(), reviewer = new FakeReviewer()) {
  const store = new AiStore(root);
  const broker = new PermissionBroker(join(root, ".ai"), testPolicy);
  const runner = new CommandRunner(broker, testPolicy);
  const orchestrator = new Orchestrator(store, new FakePlanner(), builder, reviewer, runner, broker, testPolicy);
  return { store, broker, orchestrator, builder, reviewer };
}

test("runs planning, implementation, validation, review and release to completion", async () => {
  await withTempWorkspace(async (root) => {
    const { store, orchestrator } = await fixture(root);
    const task = await store.createTask("test goal");
    const result = await orchestrator.runTask(task.id);
    assert.equal(result.state, "DONE");
    assert.equal(result.sessions.planner, "planner-session");
    assert.equal(result.sessions.builder, "builder-session");
    assert.equal(result.sessions.reviewer, "reviewer-session");
  });
});

test("feeds review findings back to the builder", async () => {
  await withTempWorkspace(async (root) => {
    const builder = new FakeBuilder();
    const reviewer = new FakeReviewer("changes_requested");
    const { store, orchestrator } = await fixture(root, builder, reviewer);
    const task = await store.createTask("test goal");
    const result = await orchestrator.runTask(task.id);
    assert.equal(result.state, "DONE");
    assert.equal(result.repairCount, 1);
    assert.equal(builder.calls, 2);
    assert.equal(reviewer.calls, 2);
  });
});

test("blocks once, then resumes after a batched approval", async () => {
  await withTempWorkspace(async (root) => {
    const blocked: ImplementationReport = {
      ...completed,
      status: "blocked",
      summary: "dependency approval needed",
      needsApproval: [
        {
          kind: "command",
          resource: "npm",
          exactCommand: "npm install zod",
          reason: "schema validation",
          risk: "medium"
        }
      ]
    };
    const builder = new FakeBuilder(blocked);
    const { store, broker, orchestrator } = await fixture(root, builder);
    const task = await store.createTask("test goal");
    const first = await orchestrator.runTask(task.id);
    assert.equal(first.state, "BLOCKED");
    const approvals = await broker.list();
    assert.equal(approvals.length, 1);
    await broker.decide(approvals[0]!.id, "approved");
    const second = await orchestrator.runTask(task.id);
    assert.equal(second.state, "DONE");
    assert.equal(builder.calls, 2);
  });
});

test("classifies expired agent authentication as a secret-access gate", async () => {
  await withTempWorkspace(async (root) => {
    const store = new AiStore(root);
    const broker = new PermissionBroker(join(root, ".ai"), testPolicy);
    const runner = new CommandRunner(broker, testPolicy);
    const orchestrator = new Orchestrator(
      store,
      new AuthFailingPlanner(),
      new FakeBuilder(),
      new FakeReviewer(),
      runner,
      broker,
      testPolicy
    );
    const task = await store.createTask("auth test");
    const result = await orchestrator.runTask(task.id);
    assert.equal(result.state, "BLOCKED");
    const approvals = await broker.list();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.kind, "secret_access");
  });
});
