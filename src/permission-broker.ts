import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ApprovalKind,
  ApprovalNeed,
  ApprovalRequest,
  CommandSpec,
  PolicyConfig
} from "./domain.js";

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export class PermissionBroker {
  private readonly path: string;

  constructor(
    aiDir: string,
    private readonly policy: PolicyConfig
  ) {
    this.path = join(aiDir, "approvals.json");
  }

  async list(): Promise<ApprovalRequest[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as ApprovalRequest[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async request(
    taskId: string,
    need: Omit<ApprovalRequest, "id" | "taskId" | "status" | "createdAt" | "decidedAt">
  ): Promise<ApprovalRequest> {
    const approvals = await this.list();
    const duplicate = approvals.find(
      (item) =>
        item.taskId === taskId &&
        item.kind === need.kind &&
        item.resource === need.resource &&
        item.exactCommand === need.exactCommand &&
        item.status !== "denied"
    );
    if (duplicate) return duplicate;
    const request: ApprovalRequest = {
      id: `APR-${randomUUID()}`,
      taskId,
      status: "pending",
      createdAt: new Date().toISOString(),
      ...need
    };
    approvals.push(request);
    await atomicWrite(this.path, approvals);
    return request;
  }

  async requestAgentNeeds(taskId: string, needs: ApprovalNeed[]): Promise<string[]> {
    const ids: string[] = [];
    for (const need of needs) {
      const request = await this.request(taskId, need);
      ids.push(request.id);
    }
    return ids;
  }

  private commandString(command: CommandSpec): string {
    return [command.executable, ...command.args].join(" ");
  }

  private matchesAutoRule(command: CommandSpec): boolean {
    return this.policy.autoApprove.commands.some((rule) => {
      if (rule.executable.toLowerCase() !== command.executable.toLowerCase()) return false;
      return rule.argsPrefix.every((part, index) => command.args[index] === part);
    });
  }

  async authorizeCommand(taskId: string, command: CommandSpec): Promise<{ allowed: boolean; approvalId?: string }> {
    if (this.matchesAutoRule(command)) return { allowed: true };
    const exactCommand = this.commandString(command);
    const approvals = await this.list();
    const approved = approvals.some(
      (item) =>
        item.taskId === taskId &&
        item.kind === "command" &&
        item.exactCommand === exactCommand &&
        item.status === "approved"
    );
    if (approved) return { allowed: true };
    const request = await this.request(taskId, {
      kind: "command",
      resource: command.executable,
      exactCommand,
      reason: `Validation requires: ${command.label}`,
      risk: "medium"
    });
    return { allowed: false, approvalId: request.id };
  }

  async decide(id: string, status: "approved" | "denied"): Promise<ApprovalRequest> {
    const approvals = await this.list();
    const request = approvals.find((item) => item.id === id);
    if (!request) throw new Error(`Approval not found: ${id}`);
    request.status = status;
    request.decidedAt = new Date().toISOString();
    await atomicWrite(this.path, approvals);
    return request;
  }

  async areApproved(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    const approvals = await this.list();
    return ids.every((id) => approvals.some((item) => item.id === id && item.status === "approved"));
  }

  async requestProductDecision(taskId: string, resource: string, reason: string): Promise<string> {
    const request = await this.request(taskId, {
      kind: "product_decision" satisfies ApprovalKind,
      resource,
      reason,
      risk: "high"
    });
    return request.id;
  }
}
