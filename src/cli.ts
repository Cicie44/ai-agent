#!/usr/bin/env node
import { resolve } from "node:path";

import { CodexAgentAdapter } from "./adapters/codex.js";
import { ClaudeCodeAdapter } from "./adapters/claude.js";
import { CommandRunner } from "./command-runner.js";
import { loadPolicyConfig, loadProjectConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { Orchestrator } from "./orchestrator.js";
import { PermissionBroker } from "./permission-broker.js";
import { AiStore } from "./store.js";

const root = resolve(process.cwd());

function usage(): string {
  return `AI Dev Orchestrator

Usage:
  npm run autopilot -- doctor
  npm run autopilot -- task create "goal"
  npm run autopilot -- task list
  npm run autopilot -- task show TASK-ID
  npm run autopilot -- task run TASK-ID
  npm run autopilot -- approvals list
  npm run autopilot -- approvals approve APR-ID
  npm run autopilot -- approvals deny APR-ID`;
}

async function main(): Promise<void> {
  const [group, action, ...rest] = process.argv.slice(2);
  if (!group || group === "help" || group === "--help") {
    console.log(usage());
    return;
  }
  const store = new AiStore(root);
  await store.ensureRuntime();
  if (group === "doctor") {
    const checks = await runDoctor(root);
    for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.details}`);
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
    return;
  }
  const policy = await loadPolicyConfig(root);
  const project = await loadProjectConfig(root);
  const broker = new PermissionBroker(store.aiDir, policy);
  if (group === "task" && action === "create") {
    const goal = rest.join(" ").trim();
    if (!goal) throw new Error("Task goal is required");
    const task = await store.createTask(goal);
    console.log(`${task.id} ${task.state} ${task.goal}`);
    return;
  }
  if (group === "task" && action === "list") {
    const tasks = await store.listTasks();
    if (tasks.length === 0) console.log("No tasks");
    for (const task of tasks) console.log(`${task.id} ${task.state} repairs=${task.repairCount} ${task.goal}`);
    return;
  }
  if (group === "task" && action === "show") {
    if (!rest[0]) throw new Error("Task id is required");
    console.log(JSON.stringify(await store.readTask(rest[0]), null, 2));
    return;
  }
  if (group === "task" && action === "run") {
    if (!rest[0]) throw new Error("Task id is required");
    const codex = new CodexAgentAdapter(root, project);
    const claude = new ClaudeCodeAdapter(root, project, policy);
    const runner = new CommandRunner(broker, policy);
    const orchestrator = new Orchestrator(store, codex, claude, codex, runner, broker, policy);
    const task = await orchestrator.runTask(rest[0]);
    console.log(JSON.stringify(task, null, 2));
    if (task.state === "BLOCKED") process.exitCode = 2;
    return;
  }
  if (group === "approvals" && action === "list") {
    const approvals = await broker.list();
    if (approvals.length === 0) console.log("No approval requests");
    for (const item of approvals) {
      console.log(`${item.id} ${item.status} ${item.risk} ${item.taskId} ${item.kind}: ${item.reason}`);
    }
    return;
  }
  if (group === "approvals" && (action === "approve" || action === "deny")) {
    if (!rest[0]) throw new Error("Approval id is required");
    const request = await broker.decide(rest[0], action === "approve" ? "approved" : "denied");
    console.log(`${request.id} ${request.status}`);
    return;
  }
  throw new Error(`Unknown command\n\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
