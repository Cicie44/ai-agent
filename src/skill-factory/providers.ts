import { parseJsonPayload } from "../validation.js";
import { spawnCapture, type SpawnResult } from "../process.js";
import type { EvalFile, ProviderInput, SkillAuthoringProvider, SkillCandidate } from "./types.js";

const CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skillMd", "evals"],
  properties: {
    skillMd: { type: "string", minLength: 1 },
    evals: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "evals"],
      properties: {
        skill_name: { type: "string", minLength: 1 },
        evals: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "prompt", "expected_output", "files"],
            properties: {
              id: { type: "string", minLength: 1 },
              prompt: { type: "string", minLength: 1 },
              expected_output: { type: "string", minLength: 1 },
              files: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  }
} as const;

function escapeYamlString(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function offlineCandidate(input: ProviderInput): SkillCandidate {
  const skillMd = [
    "---",
    `name: ${input.name}`,
    `description: ${escapeYamlString(input.description)}`,
    "---",
    "",
    "## Instructions",
    "",
    input.brief.trim(),
    "",
    "## Steps",
    "",
    "1. Analyze the provided request, inputs, and constraints.",
    "2. Execute the workflow described in the instructions and verify the result.",
    "3. Return a clear, complete result and surface any unresolved limitations.",
    "",
    "## Notes",
    "",
    "- Use `evals/evals.json` as the acceptance examples for this workflow.",
    ""
  ].join("\n");
  const evals: EvalFile = {
    skill_name: input.name,
    evals: [
      {
        id: `${input.name}-eval-001`,
        prompt: `Demonstrate the core workflow: ${input.brief.trim()}`,
        expected_output: `A successful execution that ${input.description.toLowerCase()}.`,
        files: []
      },
      {
        id: `${input.name}-eval-002`,
        prompt: `Handle a minimal valid input for the skill "${input.name}".`,
        expected_output: "A well-formed result that handles the minimal case and states any limitations.",
        files: []
      }
    ]
  };
  return { skillMd, evals };
}

export class OfflineSkillProvider implements SkillAuthoringProvider {
  readonly name = "offline" as const;

  async generate(input: ProviderInput): Promise<SkillCandidate> {
    return offlineCandidate(input);
  }
}

export type SkillProviderProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputChars: number }
) => Promise<SpawnResult>;

export interface ClaudeCodeProviderOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  runner?: SkillProviderProcessRunner;
}

function safeResultMessage(stdout: string): string | null {
  try {
    const value = parseJsonPayload(stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const result = (value as Record<string, unknown>)["result"];
    if (typeof result !== "string" || result.trim() === "") return null;
    if (/session limit/i.test(result)) return "session limit reached";
    if (/authenticate|oauth|\b401\b/i.test(result)) return "authentication failed";
    if (/rate limit|\b429\b/i.test(result)) return "rate limit reached";
    return null;
  } catch {
    return null;
  }
}

function extractCandidate(stdout: string): unknown {
  const envelope = parseJsonPayload(stdout);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return envelope;
  const record = envelope as Record<string, unknown>;
  if (record["is_error"] === true) {
    throw new Error(`Claude Code provider failed: ${safeResultMessage(stdout) ?? "provider returned an error"}`);
  }
  const candidate = record["structured_output"] ?? record["structuredOutput"] ?? record["result"] ?? record;
  return typeof candidate === "string" ? parseJsonPayload(candidate) : candidate;
}

export class ClaudeCodeSkillProvider implements SkillAuthoringProvider {
  readonly name = "claude-code" as const;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly runner: SkillProviderProcessRunner;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.maxOutputChars = options.maxOutputChars ?? 100_000;
    this.runner = options.runner ?? spawnCapture;
  }

  async generate(input: ProviderInput): Promise<unknown> {
    const prompt = [
      "Create a portable skill package as structured JSON.",
      `Skill name: ${input.name}`,
      `Description: ${input.description}`,
      `Workflow brief: ${input.brief}`,
      input.diagnostics.length > 0
        ? `Repair these validation diagnostics: ${JSON.stringify(input.diagnostics)}`
        : "This is the initial authoring attempt.",
      "SKILL.md must contain exact YAML frontmatter delimiters, the supplied lowercase name, a non-empty description, and actionable instructions.",
      "Provide at least two distinct eval cases with safe relative file references. Return structured output only."
    ].join("\n\n");
    const args = [
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(CANDIDATE_SCHEMA),
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--max-budget-usd",
      "1",
      "--no-chrome",
      prompt
    ];
    let result: SpawnResult;
    try {
      result = await this.runner("claude", args, {
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        maxOutputChars: this.maxOutputChars
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Claude Code provider executable was not found");
      }
      throw new Error("Claude Code provider process could not start");
    }
    if (result.timedOut) throw new Error(`Claude Code provider timed out after ${result.durationMs}ms`);
    if (result.exitCode !== 0) {
      const detail = safeResultMessage(result.stdout);
      throw new Error(`Claude Code provider failed with exit code ${String(result.exitCode)}${detail ? `: ${detail}` : ""}`);
    }
    try {
      return extractCandidate(result.stdout);
    } catch (error) {
      if (error instanceof Error && /^Claude Code provider/.test(error.message)) throw error;
      throw new Error("Claude Code provider returned malformed structured output");
    }
  }
}

export { CANDIDATE_SCHEMA };
