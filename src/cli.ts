#!/usr/bin/env node
import { resolve } from "node:path";

import { CodexAgentAdapter } from "./adapters/codex.js";
import { ClaudeCodeAdapter } from "./adapters/claude.js";
import { CommandRunner } from "./command-runner.js";
import { loadPolicyConfig, loadProjectConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { Orchestrator } from "./orchestrator.js";
import { PermissionBroker } from "./permission-broker.js";
import {
  createInstallPlan,
  createSkill,
  parseInstallTarget,
  parseSkillProvider,
  validateSkillDir
} from "./skill-factory/index.js";
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
  npm run autopilot -- task unlock TASK-ID
  npm run autopilot -- approvals list
  npm run autopilot -- approvals approve APR-ID
  npm run autopilot -- approvals deny APR-ID
  npm run autopilot -- skill create "brief" [--name skill-name] [--out path] [--provider offline|claude-code]
  npm run autopilot -- skill validate <path>
  npm run autopilot -- skill install-plan <path> [--target codex|claude-code|all]`;
}

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const [group, action, ...rest] = process.argv.slice(2);
  if (!group || group === "help" || group === "--help") {
    console.log(usage());
    return;
  }
  if (group === "skill" && action === "create") {
    const { flags, positional } = parseFlags(rest);
    const brief = positional.join(" ").trim();
    if (!brief) throw new Error("Brief is required: npm run autopilot -- skill create \"brief\"");
    const skillOptions: import("./skill-factory/index.js").CreateOptions = {};
    const flagName = flags["name"];
    const flagOut = flags["out"];
    const flagProvider = flags["provider"];
    if (flagName !== undefined) skillOptions.name = flagName;
    if (flagOut !== undefined) skillOptions.out = flagOut;
    const provider = parseSkillProvider(flagProvider);
    if (provider !== undefined) skillOptions.provider = provider;
    const result = await createSkill(root, brief, skillOptions);
    if (!result.validation.ok || !result.qualityReport.passed) {
      console.error("Skill package did not pass its quality gate:");
      for (const d of result.qualityReport.diagnostics) {
        console.error(`  [${d.field}] ${d.message}`);
      }
      console.error(`Quality score: ${result.qualityReport.score}/${result.qualityReport.threshold}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Created skill package: ${result.outDir}`);
    console.log(`Quality score: ${result.qualityReport.score}/${result.qualityReport.threshold}`);
    return;
  }
  if (group === "skill" && action === "validate") {
    const dir = rest[0];
    if (!dir) throw new Error("Path is required: npm run autopilot -- skill validate <path>");
    const result = await validateSkillDir(resolve(dir));
    if (result.ok) {
      console.log("Skill package is valid.");
      return;
    }
    console.error("Skill package is invalid:");
    for (const d of result.diagnostics) {
      console.error(`  [${d.field}] ${d.message}`);
    }
    process.exitCode = 1;
    return;
  }
  if (group === "skill" && action === "install-plan") {
    const { flags, positional } = parseFlags(rest);
    if (positional.length !== 1) {
      throw new Error("Exactly one package path is required: npm run autopilot -- skill install-plan <path>");
    }
    const selectedTarget = parseInstallTarget(flags["target"]);
    const plan = await createInstallPlan(root, positional[0]!, selectedTarget);
    console.log(JSON.stringify(plan, null, 2));
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
  if (group === "task" && action === "unlock") {
    if (!rest[0]) throw new Error("Task id is required");
    await store.forceUnlockTask(rest[0]);
    console.log(`${rest[0]} unlocked`);
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
