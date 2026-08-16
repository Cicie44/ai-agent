import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import type { TaskRecord } from "./domain.js";

function now(): string {
  return new Date().toISOString();
}

function makeTaskId(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `TASK-${stamp}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export class AiStore {
  readonly root: string;
  readonly aiDir: string;
  readonly tasksDir: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.aiDir = join(this.root, ".ai");
    this.tasksDir = join(this.aiDir, "tasks");
  }

  async ensureRuntime(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
  }

  taskDir(taskId: string): string {
    if (!/^TASK-[A-Z0-9-]+$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
    return join(this.tasksDir, taskId);
  }

  async createTask(goal: string): Promise<TaskRecord> {
    await this.ensureRuntime();
    const id = makeTaskId();
    const timestamp = now();
    const task: TaskRecord = {
      id,
      goal,
      state: "BACKLOG",
      repairCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspacePath: this.root,
      sessions: {}
    };
    await mkdir(this.taskDir(id), { recursive: true });
    await this.writeTask(task);
    await this.appendEvent(id, "task.created", { goal });
    return task;
  }

  async readTask(taskId: string): Promise<TaskRecord> {
    const raw = await readFile(join(this.taskDir(taskId), "status.json"), "utf8");
    return JSON.parse(raw) as TaskRecord;
  }

  async listTasks(): Promise<TaskRecord[]> {
    await this.ensureRuntime();
    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const tasks: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("TASK-")) continue;
      tasks.push(await this.readTask(entry.name));
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async writeTask(task: TaskRecord): Promise<void> {
    task.updatedAt = now();
    await mkdir(this.taskDir(task.id), { recursive: true });
    await atomicWriteJson(join(this.taskDir(task.id), "status.json"), task);
  }

  async writeArtifact(taskId: string, name: string, value: unknown): Promise<void> {
    if (!/^[a-z0-9-]+\.json$/i.test(name)) throw new Error(`Invalid artifact name: ${name}`);
    await mkdir(this.taskDir(taskId), { recursive: true });
    await atomicWriteJson(join(this.taskDir(taskId), name), value);
  }

  async readArtifact<T>(taskId: string, name: string): Promise<T> {
    const raw = await readFile(join(this.taskDir(taskId), name), "utf8");
    return JSON.parse(raw) as T;
  }

  async appendEvent(taskId: string, type: string, payload: unknown): Promise<void> {
    await this.ensureRuntime();
    const event = JSON.stringify({ at: now(), taskId, type, payload });
    const path = join(this.aiDir, "events.ndjson");
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(path, `${existing}${event}\n`, "utf8");
  }
}
