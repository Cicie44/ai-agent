import type {
  QualityCheck,
  SkillCandidate,
  ValidationDiagnostic,
  ValidationResult
} from "./types.js";

function unsafePortablePath(value: string): boolean {
  return (
    value.trim() === "" ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.split(/[/\\]/).some((part) => part === "..")
  );
}

function instructionBody(skillMd: string): string {
  const normalized = skillMd.replace(/\r\n/g, "\n");
  const closing = normalized.indexOf("\n---\n", 4);
  return closing === -1 ? "" : normalized.slice(closing + 5).trim();
}

function evalSummary(evals: unknown): { adequate: boolean; portable: boolean; count: number } {
  if (typeof evals !== "object" || evals === null || Array.isArray(evals)) {
    return { adequate: false, portable: false, count: 0 };
  }
  const cases = (evals as Record<string, unknown>)["evals"];
  if (!Array.isArray(cases)) return { adequate: false, portable: false, count: 0 };
  let portable = true;
  const adequate = cases.length >= 2 && cases.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    const files = record["files"];
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || unsafePortablePath(file))) {
      portable = false;
    }
    return ["id", "prompt", "expected_output"].every(
      (key) => typeof record[key] === "string" && (record[key] as string).trim().length >= 3
    );
  });
  return { adequate, portable, count: cases.length };
}

export function evaluateSkillQuality(
  candidate: SkillCandidate,
  validation: ValidationResult,
  threshold: number
): { checks: QualityCheck[]; score: number; diagnostics: ValidationDiagnostic[]; passed: boolean } {
  const body = instructionBody(candidate.skillMd);
  const evals = evalSummary(candidate.evals);
  const checks: QualityCheck[] = [
    {
      id: "package-valid",
      label: "Package passes structural validation",
      weight: 50,
      earned: validation.ok ? 50 : 0,
      passed: validation.ok,
      details: validation.ok ? "No structural diagnostics" : `${validation.diagnostics.length} structural diagnostic(s)`
    },
    {
      id: "instructions-substantive",
      label: "Instructions are actionable and substantive",
      weight: 20,
      earned: body.length >= 120 && /##\s+Steps/i.test(body) ? 20 : 0,
      passed: body.length >= 120 && /##\s+Steps/i.test(body),
      details: `Instruction body length: ${body.length}`
    },
    {
      id: "eval-coverage",
      label: "At least two complete eval cases are present",
      weight: 20,
      earned: evals.adequate ? 20 : 0,
      passed: evals.adequate,
      details: `Eval case count: ${evals.count}`
    },
    {
      id: "portable-files",
      label: "Eval file references are portable",
      weight: 10,
      earned: evals.portable ? 10 : 0,
      passed: evals.portable,
      details: evals.portable ? "All file references are safe and relative" : "Unsafe or malformed file reference detected"
    }
  ];
  const score = checks.reduce((sum, check) => sum + check.earned, 0);
  const diagnostics = checks
    .filter((check) => !check.passed)
    .map((check) => ({ field: `quality.${check.id}`, message: check.details }));
  return { checks, score, diagnostics, passed: validation.ok && evals.portable && score >= threshold };
}
