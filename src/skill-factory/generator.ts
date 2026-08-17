import { mkdir, realpath, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ClaudeCodeSkillProvider, OfflineSkillProvider } from "./providers.js";
import { evaluateSkillQuality } from "./quality.js";
import type {
  CreateOptions,
  ProviderInput,
  QualityAttempt,
  SkillAuthoringProvider,
  SkillCandidate,
  SkillFactoryDependencies,
  SkillProviderName,
  SkillQualityReport,
  ValidationDiagnostic,
  ValidationResult
} from "./types.js";
import { validateSkillDir } from "./validator.js";

const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const DEFAULT_THRESHOLD = 80;
const DEFAULT_REPAIR_ROUNDS = 2;

export interface CreateResult {
  outDir: string;
  validation: ValidationResult;
  qualityReport: SkillQualityReport;
}

export async function toRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await toRealPath(parent), basename(path));
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function deriveName(brief: string): string {
  const slug = brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug.replace(/^[^a-z]+/, "") || "unnamed-skill";
}

function deriveDescription(brief: string): string {
  const trimmed = brief.trim().replace(/[\r\n]+/g, " ");
  const firstSentence = trimmed.match(/^[^.!?]+/)?.[0]?.trim() ?? "";
  return (firstSentence || trimmed).slice(0, 120).trim();
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return selected;
}

function normalizeCandidate(value: unknown): SkillCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider output must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["skillMd"] !== "string" || record["skillMd"].trim() === "") {
    throw new Error("Provider output skillMd must be a non-empty string");
  }
  if (!("evals" in record)) throw new Error("Provider output evals is required");
  try {
    JSON.stringify(record["evals"]);
  } catch {
    throw new Error("Provider output evals must be JSON-serializable");
  }
  return { skillMd: record["skillMd"], evals: record["evals"] };
}

function providerDiagnostic(message: string): ValidationDiagnostic {
  return { field: "provider", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) };
}

function safeProviderError(error: unknown): string {
  if (!(error instanceof Error)) return "Provider attempt failed";
  if (/^(Claude Code provider|Provider output)/.test(error.message)) return error.message;
  return "Provider attempt failed";
}

async function ensureDestinationAvailable(outDir: string): Promise<void> {
  try {
    const entries = await readdir(outDir);
    if (entries.length > 0) {
      throw new Error(`Destination "${outDir}" already exists and is not empty. Choose a different output path or name.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeCandidate(outDir: string, candidate: SkillCandidate): Promise<void> {
  await mkdir(join(outDir, "evals"), { recursive: true });
  await writeFile(join(outDir, "SKILL.md"), candidate.skillMd, "utf8");
  await writeFile(join(outDir, "evals", "evals.json"), `${JSON.stringify(candidate.evals, null, 2)}\n`, "utf8");
}

async function writeQualityReport(outDir: string, report: SkillQualityReport): Promise<void> {
  await mkdir(join(outDir, "evals"), { recursive: true });
  await writeFile(join(outDir, "evals", "quality-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function createSkill(
  workspace: string,
  brief: string,
  options: CreateOptions = {},
  dependencies: SkillFactoryDependencies = {}
): Promise<CreateResult> {
  if (!brief.trim()) throw new Error("Brief must be non-empty");

  const name = options.name ?? deriveName(brief);
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Skill name "${name}" is invalid. Must be lowercase letters, digits, and single hyphens (e.g. my-skill-name)`);
  }
  const requestedProvider = options.provider ?? "offline";
  if (requestedProvider !== "offline" && requestedProvider !== "claude-code") {
    throw new Error(`Unsupported provider: ${String(requestedProvider)}`);
  }
  const maxRepairRounds = boundedInteger(options.maxRepairRounds, DEFAULT_REPAIR_ROUNDS, 0, 2, "maxRepairRounds");
  const threshold = boundedInteger(options.qualityThreshold, DEFAULT_THRESHOLD, 0, 100, "qualityThreshold");
  const description = deriveDescription(brief);

  const workspaceResolved = await toRealPath(resolve(workspace));
  const requestedOut = options.out
    ? isAbsolute(options.out) ? options.out : join(workspaceResolved, options.out)
    : join(workspaceResolved, "skills", name);
  const outDir = await toRealPath(resolve(requestedOut));
  if (!isPathInside(workspaceResolved, outDir)) {
    throw new Error(`Output path "${outDir}" is outside the workspace "${workspaceResolved}"`);
  }
  await ensureDestinationAvailable(outDir);

  const offline = dependencies.providers?.offline ?? new OfflineSkillProvider();
  const claude = dependencies.providers?.["claude-code"] ?? new ClaudeCodeSkillProvider();
  const selected = requestedProvider === "offline" ? offline : claude;
  const providersAttempted: SkillProviderName[] = [];
  const attempts: QualityAttempt[] = [];
  let diagnostics: ValidationDiagnostic[] = [];
  let effectiveProvider = requestedProvider;
  let fallbackReason: string | null = null;
  let finalValidation: ValidationResult = { ok: false, diagnostics: [providerDiagnostic("No candidate was generated")] };
  let finalChecks: SkillQualityReport["checks"] = [];

  const runAttempt = async (
    provider: SkillAuthoringProvider,
    phase: QualityAttempt["phase"],
    attemptNumber: number
  ): Promise<boolean> => {
    if (!providersAttempted.includes(provider.name)) providersAttempted.push(provider.name);
    effectiveProvider = provider.name;
    const input: ProviderInput = { brief, name, description, attempt: attemptNumber, diagnostics };
    try {
      const candidate = normalizeCandidate(await provider.generate(input));
      await writeCandidate(outDir, candidate);
      finalValidation = await validateSkillDir(outDir);
      const candidateName =
        typeof candidate.evals === "object" && candidate.evals !== null && !Array.isArray(candidate.evals)
          ? (candidate.evals as Record<string, unknown>)["skill_name"]
          : undefined;
      if (candidateName !== name) {
        finalValidation = {
          ok: false,
          diagnostics: [
            ...finalValidation.diagnostics,
            {
              field: "provider.skill_name",
              message: `Generated package name must match the requested name (expected: ${name}, got: ${String(candidateName)})`
            }
          ]
        };
      }
      const quality = evaluateSkillQuality(candidate, finalValidation, threshold);
      finalChecks = quality.checks;
      diagnostics = [...finalValidation.diagnostics, ...quality.diagnostics];
      const passed = quality.passed;
      attempts.push({
        attempt: attempts.length + 1,
        provider: provider.name,
        phase,
        outcome: passed ? "passed" : "failed",
        score: quality.score,
        diagnostics
      });
      return passed;
    } catch (error) {
      diagnostics = [providerDiagnostic(safeProviderError(error))];
      finalValidation = { ok: false, diagnostics };
      finalChecks = [];
      attempts.push({
        attempt: attempts.length + 1,
        provider: provider.name,
        phase,
        outcome: "error",
        score: 0,
        diagnostics
      });
      return false;
    }
  };

  let passed = false;
  for (let round = 0; round <= maxRepairRounds; round += 1) {
    passed = await runAttempt(selected, round === 0 ? "initial" : "repair", round + 1);
    if (passed) break;
  }

  if (!passed && requestedProvider === "claude-code") {
    fallbackReason = diagnostics.map((item) => item.message).join("; ").slice(0, 400) || "Claude Code attempts did not pass";
    passed = await runAttempt(offline, "fallback", maxRepairRounds + 2);
  }

  const last = attempts.at(-1);
  const report: SkillQualityReport = {
    version: 1,
    requestedProvider,
    effectiveProvider,
    providersAttempted,
    attempts,
    checks: finalChecks,
    score: last?.score ?? 0,
    threshold,
    passed,
    diagnostics,
    fallbackReason
  };
  await writeQualityReport(outDir, report);
  return { outDir, validation: finalValidation, qualityReport: report };
}
