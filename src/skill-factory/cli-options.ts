import type { InstallTarget, SkillProviderName } from "./types.js";

export function parseSkillProvider(value: string | undefined): SkillProviderName | undefined {
  if (value === undefined) return undefined;
  if (value === "offline" || value === "claude-code") return value;
  throw new Error(`Unsupported provider: ${value}`);
}

export function parseInstallTarget(value: string | undefined): InstallTarget {
  const selected = value ?? "all";
  if (selected === "codex" || selected === "claude-code" || selected === "all") return selected;
  throw new Error(`Unsupported install target: ${selected}`);
}
