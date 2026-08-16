import type {
  AgentResult,
  ImplementationReport,
  PlannerAgent,
  ProjectConfig,
  ReviewerAgent,
  ReviewReport,
  TaskRecord,
  TaskSpec,
  TestReport
} from "../domain.js";
import { loadSchema } from "../config.js";
import { plannerPrompt, reviewerPrompt } from "../prompts.js";
import { parseJsonPayload, validateReviewReport, validateTaskSpec } from "../validation.js";

interface CodexThreadLike {
  id?: string;
  run(prompt: string): Promise<{ finalResponse: string }>;
}

interface CodexLike {
  startThread(options?: Record<string, unknown>): CodexThreadLike;
  resumeThread(id: string, options?: Record<string, unknown>): CodexThreadLike;
}

export class CodexAgentAdapter implements PlannerAgent, ReviewerAgent {
  constructor(
    private readonly root: string,
    private readonly project: ProjectConfig
  ) {}

  private async createClient(): Promise<CodexLike> {
    const sdk = await import("@openai/codex-sdk");
    return new sdk.Codex() as unknown as CodexLike;
  }

  private async run(
    task: TaskRecord,
    role: "planner" | "reviewer",
    prompt: string
  ): Promise<{ raw: string; sessionId?: string }> {
    const client = await this.createClient();
    const existing = task.sessions[role];
    const configured = this.project.agents[role].model;
    const envModel = role === "planner" ? process.env.CODEX_PLANNER_MODEL : process.env.CODEX_REVIEWER_MODEL;
    const model = envModel || configured || undefined;
    const options: Record<string, unknown> = {
      workingDirectory: task.workspacePath,
      sandboxMode: "read-only",
      approvalPolicy: "never"
    };
    if (model) options.model = model;
    const thread = existing ? client.resumeThread(existing, options) : client.startThread(options);
    const result = await thread.run(prompt);
    return {
      raw: result.finalResponse,
      ...(thread.id ? { sessionId: thread.id } : {})
    };
  }

  async plan(task: TaskRecord): Promise<AgentResult<TaskSpec>> {
    const schema = await loadSchema(this.root, "task-spec");
    const result = await this.run(task, "planner", plannerPrompt(task, schema));
    return {
      value: validateTaskSpec(parseJsonPayload(result.raw), task.id),
      ...(result.sessionId ? { sessionId: result.sessionId } : {})
    };
  }

  async review(
    task: TaskRecord,
    spec: TaskSpec,
    implementation: ImplementationReport,
    tests: TestReport
  ): Promise<AgentResult<ReviewReport>> {
    const schema = await loadSchema(this.root, "review-report");
    const prompt = reviewerPrompt(task, spec, implementation, tests, schema);
    const result = await this.run(task, "reviewer", prompt);
    return {
      value: validateReviewReport(parseJsonPayload(result.raw)),
      ...(result.sessionId ? { sessionId: result.sessionId } : {})
    };
  }
}
