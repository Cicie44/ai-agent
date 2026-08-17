export interface SkillMeta {
  name: string;
  description: string;
}

export interface EvalCase {
  id: string;
  prompt: string;
  expected_output: string;
  files: string[];
}

export interface EvalFile {
  skill_name: string;
  evals: EvalCase[];
}

export interface ValidationDiagnostic {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: ValidationDiagnostic[];
}

export type SkillProviderName = "offline" | "claude-code";

export interface SkillCandidate {
  skillMd: string;
  evals: unknown;
}

export interface ProviderInput {
  brief: string;
  name: string;
  description: string;
  attempt: number;
  diagnostics: ValidationDiagnostic[];
}

export interface SkillAuthoringProvider {
  readonly name: SkillProviderName;
  generate(input: ProviderInput): Promise<unknown>;
}

export interface QualityCheck {
  id: string;
  label: string;
  weight: number;
  earned: number;
  passed: boolean;
  details: string;
}

export interface QualityAttempt {
  attempt: number;
  provider: SkillProviderName;
  phase: "initial" | "repair" | "fallback";
  outcome: "passed" | "failed" | "error";
  score: number;
  diagnostics: ValidationDiagnostic[];
}

export interface SkillQualityReport {
  version: 1;
  requestedProvider: SkillProviderName;
  effectiveProvider: SkillProviderName;
  providersAttempted: SkillProviderName[];
  attempts: QualityAttempt[];
  checks: QualityCheck[];
  score: number;
  threshold: number;
  passed: boolean;
  diagnostics: ValidationDiagnostic[];
  fallbackReason: string | null;
}

export interface CreateOptions {
  name?: string;
  out?: string;
  provider?: SkillProviderName;
  maxRepairRounds?: number;
  qualityThreshold?: number;
}

export interface SkillFactoryDependencies {
  providers?: Partial<Record<SkillProviderName, SkillAuthoringProvider>>;
}

export type InstallTarget = "codex" | "claude-code" | "all";

export interface InstallOperation {
  target: Exclude<InstallTarget, "all">;
  source: string;
  destination: string;
}

export interface InstallPlan {
  version: 1;
  dryRun: true;
  packagePath: string;
  skillName: string;
  targets: Array<Exclude<InstallTarget, "all">>;
  operations: InstallOperation[];
}
