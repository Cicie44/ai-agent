export const TASK_STATES = [
  "BACKLOG",
  "READY",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "REPAIRING",
  "QA",
  "RELEASE_READY",
  "DONE",
  "BLOCKED"
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface CommandSpec {
  executable: string;
  args: string[];
  label: string;
  timeoutMs?: number;
}

export interface TaskSpec {
  id: string;
  goal: string;
  acceptanceCriteria: string[];
  assumptions: string[];
  nonGoals: string[];
  allowedPaths: string[];
  validationCommands: CommandSpec[];
  riskLevel: "local-safe" | "approval-required";
}

export type ApprovalKind =
  | "command"
  | "network"
  | "external_write"
  | "secret_access"
  | "destructive"
  | "filesystem"
  | "product_decision";

export interface ApprovalNeed {
  kind: Exclude<ApprovalKind, "product_decision">;
  resource: string;
  reason: string;
  risk: "low" | "medium" | "high";
  exactCommand?: string;
}

export interface ImplementationReport {
  status: "completed" | "blocked";
  summary: string;
  filesChanged: string[];
  commandsRun: Array<{ command: string; outcome: string }>;
  tests: Array<{
    name: string;
    status: "passed" | "failed" | "not-run";
    details: string;
  }>;
  needsApproval: ApprovalNeed[];
  unresolved: string[];
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number | null;
  issue: string;
  expected: string;
}

export interface ReviewReport {
  verdict: "pass" | "changes_requested" | "blocked";
  summary: string;
  findings: ReviewFinding[];
}

export interface CommandResult {
  label: string;
  command: string;
  status: "passed" | "failed" | "blocked";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  approvalId?: string;
}

export interface TestReport {
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  finishedAt: string;
  results: CommandResult[];
}

export interface TaskBlock {
  reason: string;
  resumeState: Exclude<TaskState, "BLOCKED" | "DONE">;
  approvalIds: string[];
}

export interface TaskRecord {
  id: string;
  goal: string;
  state: TaskState;
  repairCount: number;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
  sessions: {
    planner?: string;
    builder?: string;
    reviewer?: string;
  };
  block?: TaskBlock;
  lastError?: string;
}

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  resource: string;
  reason: string;
  risk: "low" | "medium" | "high";
  taskId: string;
  exactCommand?: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt?: string;
}

export interface CommandRule {
  executable: string;
  argsPrefix: string[];
}

export interface PolicyConfig {
  version: number;
  limits: {
    maxRepairCycles: number;
    maxAgentSteps: number;
    maxCommandMs: number;
    maxOutputChars: number;
    claudeMaxBudgetUsdPerRun: number;
  };
  autoApprove: {
    workspaceWrites: boolean;
    localCommit: boolean;
    commands: CommandRule[];
  };
  alwaysRequireHuman: string[];
}

export interface ProjectConfig {
  version: number;
  name: string;
  workspaceMode: "root" | "isolated";
  agents: {
    planner: { provider: "codex"; model: string | null };
    builder: {
      provider: "claude-code";
      model: string | null;
      effort: "low" | "medium" | "high" | "xhigh" | "max";
    };
    reviewer: { provider: "codex"; model: string | null };
  };
}

export interface AgentResult<T> {
  value: T;
  sessionId?: string;
}

export interface PlannerAgent {
  plan(task: TaskRecord): Promise<AgentResult<TaskSpec>>;
}

export interface BuilderAgent {
  implement(
    task: TaskRecord,
    spec: TaskSpec,
    review: ReviewReport | null
  ): Promise<AgentResult<ImplementationReport>>;
}

export interface ReviewerAgent {
  review(
    task: TaskRecord,
    spec: TaskSpec,
    implementation: ImplementationReport,
    tests: TestReport
  ): Promise<AgentResult<ReviewReport>>;
}
