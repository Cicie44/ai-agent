import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PolicyConfig, ProjectConfig } from "./domain.js";

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  return readJson<ProjectConfig>(join(root, ".ai", "project.json"));
}

export async function loadPolicyConfig(root: string): Promise<PolicyConfig> {
  return readJson<PolicyConfig>(join(root, ".ai", "policy.json"));
}

export async function loadSchema(root: string, name: string): Promise<object> {
  return readJson<object>(join(root, "schemas", `${name}.schema.json`));
}
