import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PolicyConfig } from "../src/domain.js";

export const testPolicy: PolicyConfig = {
  version: 1,
  limits: {
    maxRepairCycles: 3,
    maxAgentSteps: 20,
    maxCommandMs: 10_000,
    maxOutputChars: 10_000,
    claudeMaxBudgetUsdPerRun: 1
  },
  autoApprove: {
    workspaceWrites: true,
    localCommit: false,
    commands: [{ executable: "npm", argsPrefix: ["test"] }]
  },
  alwaysRequireHuman: ["external_write", "destructive"]
};

export async function withTempWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ai-orchestrator-test-"));
  await mkdir(join(root, ".ai", "tasks"), { recursive: true });
  await writeFile(join(root, ".ai", "policy.json"), `${JSON.stringify(testPolicy)}\n`, "utf8");
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
