import type { CommandResult, CommandSpec, PolicyConfig, TestReport } from "./domain.js";
import { PermissionBroker } from "./permission-broker.js";
import { spawnCapture } from "./process.js";

export class CommandRunner {
  constructor(
    private readonly broker: PermissionBroker,
    private readonly policy: PolicyConfig
  ) {}

  async run(taskId: string, cwd: string, command: CommandSpec): Promise<CommandResult> {
    const authorization = await this.broker.authorizeCommand(taskId, command);
    const commandText = [command.executable, ...command.args].join(" ");
    if (!authorization.allowed) {
      return {
        label: command.label,
        command: commandText,
        status: "blocked",
        exitCode: null,
        stdout: "",
        stderr: "Command requires approval",
        durationMs: 0,
        ...(authorization.approvalId ? { approvalId: authorization.approvalId } : {})
      };
    }
    const result = await spawnCapture(command.executable, command.args, {
      cwd,
      timeoutMs: command.timeoutMs ?? this.policy.limits.maxCommandMs,
      maxOutputChars: this.policy.limits.maxOutputChars
    });
    return {
      label: command.label,
      command: commandText,
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.timedOut ? `${result.stderr}\nTimed out` : result.stderr,
      durationMs: result.durationMs
    };
  }

  async runAll(taskId: string, cwd: string, commands: CommandSpec[]): Promise<TestReport> {
    const startedAt = new Date().toISOString();
    const results: CommandResult[] = [];
    for (const command of commands) {
      const result = await this.run(taskId, cwd, command);
      results.push(result);
      if (result.status !== "passed") break;
    }
    const status = results.some((result) => result.status === "blocked")
      ? "blocked"
      : results.some((result) => result.status === "failed")
        ? "failed"
        : "passed";
    return { status, startedAt, finishedAt: new Date().toISOString(), results };
  }
}
