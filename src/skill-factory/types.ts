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

export interface CreateOptions {
  name?: string;
  out?: string;
}
