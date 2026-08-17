import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isPathInside, toRealPath } from "./generator.js";
import type { InstallOperation, InstallPlan, InstallTarget } from "./types.js";
import { validateSkillDir } from "./validator.js";

const TARGET_ROOTS = {
  codex: "$CODEX_HOME/skills",
  "claude-code": "$CLAUDE_CONFIG_DIR/skills"
} as const;

function portableRelative(path: string): string {
  return path.split(sep).join("/");
}

async function listRegularFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(current, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Install plan refuses symbolic link: ${portableRelative(relative(root, full))}`);
    if (stat.isDirectory()) {
      files.push(...await listRegularFiles(root, full));
    } else if (stat.isFile()) {
      const rel = relative(root, full);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Unsafe package file path: ${rel}`);
      }
      files.push(rel);
    } else {
      throw new Error(`Install plan supports regular files only: ${portableRelative(relative(root, full))}`);
    }
  }
  return files;
}

export async function createInstallPlan(
  workspace: string,
  packagePath: string,
  target: InstallTarget = "all"
): Promise<InstallPlan> {
  if (!(["codex", "claude-code", "all"] as string[]).includes(target)) {
    throw new Error(`Unsupported install target: ${String(target)}`);
  }
  if (packagePath.split(/[/\\]/).some((part) => part === "..")) {
    throw new Error(`Package path must not contain parent traversal: ${packagePath}`);
  }
  const workspaceReal = await toRealPath(resolve(workspace));
  const packageReal = await toRealPath(resolve(workspaceReal, packagePath));
  if (!isPathInside(workspaceReal, packageReal)) {
    throw new Error(`Package path "${packageReal}" is outside the workspace "${workspaceReal}"`);
  }
  // Reject links and special files before validation reads any package content.
  const files = await listRegularFiles(packageReal);
  const validation = await validateSkillDir(packageReal);
  if (!validation.ok) {
    throw new Error(`Cannot plan installation for an invalid package: ${validation.diagnostics.map((item) => `${item.field}: ${item.message}`).join("; ")}`);
  }
  const evalFile = JSON.parse(await readFile(join(packageReal, "evals", "evals.json"), "utf8")) as { skill_name: string };
  const skillName = evalFile.skill_name;
  const targets: Array<"codex" | "claude-code"> = target === "all" ? ["codex", "claude-code"] : [target];
  const operations: InstallOperation[] = [];
  for (const selected of targets) {
    for (const file of files) {
      const rel = portableRelative(file);
      const destination = `${TARGET_ROOTS[selected]}/${skillName}/${rel}`;
      if (destination.includes("/../") || destination.includes("\\")) {
        throw new Error(`Unsafe destination mapping: ${destination}`);
      }
      operations.push({ target: selected, source: join(packageReal, file), destination });
    }
  }
  return { version: 1, dryRun: true, packagePath: packageReal, skillName, targets, operations };
}
