import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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

  async acquireTaskLock(taskId: string): Promise<() => Promise<void>> {
    const path = join(this.taskDir(taskId), "run.lock");
    await mkdir(this.taskDir(taskId), { recursive: true });
    const attempt = async (): Promise<() => Promise<void>> => {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`, "utf8");
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const lock = JSON.parse(await readFile(path, "utf8")) as { pid?: number; createdAt?: string };
          if (typeof lock.pid === "number") {
            try {
              process.kill(lock.pid, 0);
            } catch (probeError) {
              stale = (probeError as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
          if (lock.createdAt && Date.now() - Date.parse(lock.createdAt) > 4 * 60 * 60 * 1000) stale = true;
        } catch {
          stale = true;
        }
        if (!stale) throw new Error(`Task ${taskId} is already running`);
        await unlink(path);
        return attempt();
      }
      return async () => {
        try {
          await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    };
    return attempt();
  }

  async forceUnlockTask(taskId: string): Promise<void> {
    try {
      await unlink(join(this.taskDir(taskId), "run.lock"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
