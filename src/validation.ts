import type {
  ImplementationReport,
  ReviewFinding,
  ReviewReport,
  TaskSpec
} from "./domain.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function parseJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates = [trimmed];

  // A complete fenced payload must win over object-shaped lines nested inside it.
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const fence of fences.reverse()) {
    if (fence[1]) candidates.push(fence[1].trim());
  }

  // Some agent CLIs or shell profiles write a notice before their JSON result.
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    candidates.push(...lines.reverse().filter((line) => line.startsWith("{") || line.startsWith("[")));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next representation.
    }
  }

  throw new Error("Agent response was not valid JSON");
}

export function validateTaskSpec(value: unknown, expectedId: string): TaskSpec {
  const input = requireObject(value, "TaskSpec");
  if (input.id !== expectedId) throw new Error(`TaskSpec.id must equal ${expectedId}`);
  if (typeof input.goal !== "string" || input.goal.length === 0) throw new Error("TaskSpec.goal is required");
  if (!isStringArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) {
    throw new Error("TaskSpec.acceptanceCriteria must contain at least one item");
  }
  if (!isStringArray(input.assumptions)) throw new Error("TaskSpec.assumptions must be an array");
  if (!isStringArray(input.nonGoals)) throw new Error("TaskSpec.nonGoals must be an array");
  if (!isStringArray(input.allowedPaths) || input.allowedPaths.length === 0) {
    throw new Error("TaskSpec.allowedPaths must contain at least one path");
  }
  if (input.riskLevel !== "local-safe" && input.riskLevel !== "approval-required") {
    throw new Error("TaskSpec.riskLevel is invalid");
  }
  if (!Array.isArray(input.validationCommands)) {
    throw new Error("TaskSpec.validationCommands must be an array");
  }
  for (const command of input.validationCommands) {
    const item = requireObject(command, "validation command");
    if (typeof item.executable !== "string" || !isStringArray(item.args) || typeof item.label !== "string") {
      throw new Error("Validation command is invalid");
    }
    if (item.timeoutMs !== undefined && typeof item.timeoutMs !== "number") {
      throw new Error("Validation command timeoutMs must be a number");
    }
  }
  return input as unknown as TaskSpec;
}

export function validateImplementationReport(value: unknown): ImplementationReport {
  const input = requireObject(value, "ImplementationReport");
  if (input.status !== "completed" && input.status !== "blocked") throw new Error("ImplementationReport.status is invalid");
  if (typeof input.summary !== "string") throw new Error("ImplementationReport.summary is required");
  if (!isStringArray(input.filesChanged) || !isStringArray(input.unresolved)) {
    throw new Error("ImplementationReport file/unresolved fields are invalid");
  }
  if (!Array.isArray(input.commandsRun) || !Array.isArray(input.tests) || !Array.isArray(input.needsApproval)) {
    throw new Error("ImplementationReport array fields are invalid");
  }
  return input as unknown as ImplementationReport;
}

function isFinding(value: unknown): value is ReviewFinding {
  if (!isObject(value)) return false;
  return (
    ["critical", "high", "medium", "low"].includes(String(value.severity)) &&
    typeof value.file === "string" &&
    (typeof value.line === "number" || value.line === null) &&
    typeof value.issue === "string" &&
    typeof value.expected === "string"
  );
}

export function validateReviewReport(value: unknown): ReviewReport {
  const input = requireObject(value, "ReviewReport");
  if (!["pass", "changes_requested", "blocked"].includes(String(input.verdict))) {
    throw new Error("ReviewReport.verdict is invalid");
  }
  if (typeof input.summary !== "string" || !Array.isArray(input.findings) || !input.findings.every(isFinding)) {
    throw new Error("ReviewReport is invalid");
  }
  return input as unknown as ReviewReport;
}
