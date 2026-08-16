import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { spawnCapture } from "./process.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  details: string;
}

export async function runDoctor(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [name, executable, args] of [
    ["Git", "git", ["--version"]],
    ["Claude Code", "claude", ["--version"]]
  ] as const) {
    try {
      const result = await spawnCapture(executable, [...args], {
        cwd: root,
        timeoutMs: 10_000,
        maxOutputChars: 2_000
      });
      checks.push({ name, ok: result.exitCode === 0, details: (result.stdout || result.stderr).trim() });
    } catch (error) {
      checks.push({ name, ok: false, details: error instanceof Error ? error.message : String(error) });
    }
  }
  try {
    const sdk = await import("@openai/codex-sdk");
    checks.push({ name: "Codex SDK", ok: typeof sdk.Codex === "function", details: "module loaded" });
  } catch (error) {
    checks.push({ name: "Codex SDK", ok: false, details: error instanceof Error ? error.message : String(error) });
  }
  for (const relative of [".ai/project.json", ".ai/policy.json", "AGENTS.md", "CLAUDE.md"]) {
    try {
      await access(join(root, relative), constants.R_OK);
      checks.push({ name: relative, ok: true, details: "readable" });
    } catch {
      checks.push({ name: relative, ok: false, details: "missing" });
    }
  }
  return checks;
}
