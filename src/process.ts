import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function resolveSpawnCommand(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform !== "win32") return { executable, args };

  const command = executable.toLowerCase();
  if (command === "npm" || command === "npx") {
    const cli = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      command === "npm" ? "npm-cli.js" : "npx-cli.js"
    );
    if (existsSync(cli)) return { executable: process.execPath, args: [cli, ...args] };
  }

  return { executable, args };
}

export function spawnCapture(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputChars: number }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const resolved = resolveSpawnCommand(executable, args);
    const child = spawn(resolved.executable, resolved.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
