import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentResult,
  BuilderAgent,
  ImplementationReport,
  PolicyConfig,
  ProjectConfig,
  ReviewReport,
  TaskRecord,
  TaskSpec
} from "../domain.js";
import { loadSchema } from "../config.js";
import { builderPrompt } from "../prompts.js";
import { spawnCapture } from "../process.js";
import { parseJsonPayload, validateImplementationReport } from "../validation.js";

function extractStructuredOutput(stdout: string): { value: unknown; sessionId?: string } {
  const envelope = parseJsonPayload(stdout);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return { value: envelope };
  }
  const record = envelope as Record<string, unknown>;
  if (record.is_error === true) {
    throw new Error(`Claude Code failed: ${String(record.result ?? "unknown error")}`);
  }
  const structuredOutput = record.structured_output ?? record.structuredOutput;
  const candidate = structuredOutput ?? record.result ?? record;
  if (record.type === "result" && structuredOutput === undefined && (record.result === "" || record.result === null)) {
    throw new Error(`Claude Code returned no structured output (subtype: ${String(record.subtype ?? "unknown")})`);
  }
  const value = typeof candidate === "string" ? parseJsonPayload(candidate) : candidate;
  const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
  return { value, ...(sessionId ? { sessionId } : {}) };
}

export class ClaudeCodeAdapter implements BuilderAgent {
  constructor(
    private readonly root: string,
    private readonly project: ProjectConfig,
    private readonly policy: PolicyConfig
  ) {}

  async implement(
    task: TaskRecord,
    spec: TaskSpec,
    review: ReviewReport | null
  ): Promise<AgentResult<ImplementationReport>> {
    const schema = await loadSchema(this.root, "implementation-report");
    const prompt = builderPrompt(task, spec, review, schema);
    const sessionId = task.sessions.builder ?? randomUUID();
    const configured = this.project.agents.builder.model;
    const model = process.env.CLAUDE_BUILDER_MODEL || configured || undefined;
    const args = [
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      "--permission-mode",
      "dontAsk",
      "--effort",
      this.project.agents.builder.effort,
      "--max-budget-usd",
      String(this.policy.limits.claudeMaxBudgetUsdPerRun),
      "--no-chrome",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash(git status *)",
      "Bash(git diff *)",
      "Bash(npm test *)",
      "Bash(npm run lint *)",
      "Bash(npm run build *)",
      "Bash(npm run check *)",
      ...(task.sessions.builder ? ["--resume", task.sessions.builder] : ["--session-id", sessionId]),
      ...(model ? ["--model", model] : []),
      prompt
    ];
    const result = await spawnCapture("claude", args, {
      cwd: task.workspacePath,
      timeoutMs: this.policy.limits.maxCommandMs,
      maxOutputChars: this.policy.limits.maxOutputChars
    });
    const auditDir = join(task.workspacePath, ".ai", "tasks", task.id);
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "builder-last-output.json"),
      `${JSON.stringify({
        capturedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr
      }, null, 2)}\n`,
      "utf8"
    );
    if (result.timedOut) {
      throw new Error(`Claude Code timed out after ${result.durationMs}ms`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`Claude Code exited with ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
    const structured = extractStructuredOutput(result.stdout);
    return {
      value: validateImplementationReport(structured.value),
      sessionId: structured.sessionId ?? sessionId
    };
  }
}
