import { spawn } from "node:child_process";

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function executableForPlatform(executable: string): string {
  if (process.platform !== "win32") return executable;
  if (["npm", "npx", "pnpm", "yarn"].includes(executable.toLowerCase())) return `${executable}.cmd`;
  return executable;
}

export function spawnCapture(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputChars: number }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executableForPlatform(executable), args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-options.maxOutputChars);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}
