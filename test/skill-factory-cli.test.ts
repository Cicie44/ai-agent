import assert from "node:assert/strict";
import { readFile, readdir, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { SpawnResult } from "../src/process.js";
import {
  ClaudeCodeSkillProvider,
  createInstallPlan,
  createSkill,
  parseInstallTarget,
  parseSkillProvider,
  type ProviderInput,
  type SkillAuthoringProvider,
  type SkillCandidate
} from "../src/skill-factory/index.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "skill-factory-v2-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validCandidate(name: string): SkillCandidate {
  return {
    skillMd: [
      "---",
      `name: ${name}`,
      'description: "A complete test workflow"',
      "---",
      "",
      "## Instructions",
      "",
      "Analyze the request carefully, preserve all constraints, produce the requested artifact, and verify it before returning the final result.",
      "",
      "## Steps",
      "",
      "1. Inspect the input and identify constraints.",
      "2. Produce the requested result.",
      "3. Verify completeness and report limitations.",
      ""
    ].join("\n"),
    evals: {
      skill_name: name,
      evals: [
        { id: "case-1", prompt: "Run the complete normal workflow", expected_output: "A complete verified result", files: [] },
        { id: "case-2", prompt: "Handle a minimal valid input", expected_output: "A valid minimal result", files: [] }
      ]
    }
  };
}

function invalidCandidate(): SkillCandidate {
  return { skillMd: "not frontmatter", evals: { skill_name: "wrong", evals: [] } };
}

test("offline creation persists a passing deterministic quality report", async () => {
  await withTempDir(async (workspace) => {
    const result = await createSkill(workspace, "Turn notes into action items", { name: "action-items" });
    assert.equal(result.qualityReport.requestedProvider, "offline");
    assert.equal(result.qualityReport.effectiveProvider, "offline");
    assert.equal(result.qualityReport.score, 100);
    assert.equal(result.qualityReport.threshold, 80);
    assert.equal(result.qualityReport.passed, true);
    const persisted = JSON.parse(await readFile(join(result.outDir, "evals", "quality-report.json"), "utf8")) as { passed: boolean };
    assert.equal(persisted.passed, true);
  });
});

test("feeds diagnostics to a provider and stops after a repaired candidate passes", async () => {
  await withTempDir(async (workspace) => {
    const inputs: ProviderInput[] = [];
    const fake: SkillAuthoringProvider = {
      name: "offline",
      async generate(input) {
        inputs.push(input);
        return inputs.length === 1 ? invalidCandidate() : validCandidate(input.name);
      }
    };
    const result = await createSkill(
      workspace,
      "Repair a generated workflow",
      { name: "repair-workflow", maxRepairRounds: 2 },
      { providers: { offline: fake } }
    );
    assert.equal(inputs.length, 2);
    assert.ok(inputs[1]!.diagnostics.length > 0);
    assert.deepEqual(result.qualityReport.attempts.map((item) => item.outcome), ["failed", "passed"]);
    assert.equal(result.qualityReport.passed, true);
  });
});

test("never exceeds the configured repair bound", async () => {
  await withTempDir(async (workspace) => {
    let calls = 0;
    const fake: SkillAuthoringProvider = {
      name: "offline",
      async generate() {
        calls += 1;
        return invalidCandidate();
      }
    };
    const result = await createSkill(
      workspace,
      "Always invalid",
      { name: "always-invalid", maxRepairRounds: 2 },
      { providers: { offline: fake } }
    );
    assert.equal(calls, 3);
    assert.equal(result.qualityReport.attempts.length, 3);
    assert.equal(result.qualityReport.passed, false);
    assert.equal(result.validation.ok, false);
  });
});

test("rejects attempts to raise the hard repair limit above two", async () => {
  await withTempDir(async (workspace) => {
    await assert.rejects(
      () => createSkill(workspace, "Too many repairs", { name: "too-many-repairs", maxRepairRounds: 3 }),
      /between 0 and 2/
    );
  });
});

test("falls back once to offline after Claude attempts fail without persisting secret text", async () => {
  await withTempDir(async (workspace) => {
    let claudeCalls = 0;
    const fakeClaude: SkillAuthoringProvider = {
      name: "claude-code",
      async generate() {
        claudeCalls += 1;
        throw new Error("provider stderr contained gho_super_secret_token");
      }
    };
    const result = await createSkill(
      workspace,
      "Fallback safely",
      { name: "fallback-safely", provider: "claude-code", maxRepairRounds: 1 },
      { providers: { "claude-code": fakeClaude } }
    );
    assert.equal(claudeCalls, 2);
    assert.deepEqual(result.qualityReport.providersAttempted, ["claude-code", "offline"]);
    assert.equal(result.qualityReport.effectiveProvider, "offline");
    assert.equal(result.qualityReport.attempts.at(-1)?.phase, "fallback");
    assert.equal(result.qualityReport.passed, true);
    assert.ok(!JSON.stringify(result.qualityReport).includes("super_secret"));
  });
});

test("portability is a hard gate even when the numeric score exceeds the threshold", async () => {
  await withTempDir(async (workspace) => {
    const fake: SkillAuthoringProvider = {
      name: "offline",
      async generate(input) {
        const candidate = validCandidate(input.name);
        const first = (candidate.evals as { evals: Array<{ files: string[] }> }).evals[0]!;
        first.files = [" "];
        return candidate;
      }
    };
    const result = await createSkill(
      workspace,
      "Reject whitespace paths",
      { name: "whitespace-paths", maxRepairRounds: 0 },
      { providers: { offline: fake } }
    );
    assert.equal(result.validation.ok, true);
    assert.equal(result.qualityReport.score, 90);
    assert.equal(result.qualityReport.passed, false);
    assert.ok(result.qualityReport.checks.some((check) => check.id === "portable-files" && !check.passed));
  });
});

test("rejects a valid provider package whose name differs from the requested name", async () => {
  await withTempDir(async (workspace) => {
    const fake: SkillAuthoringProvider = {
      name: "offline",
      async generate() {
        return validCandidate("different-name");
      }
    };
    const result = await createSkill(
      workspace,
      "Keep the requested name",
      { name: "requested-name", maxRepairRounds: 0 },
      { providers: { offline: fake } }
    );
    assert.equal(result.qualityReport.passed, false);
    assert.ok(result.validation.diagnostics.some((item) => item.field === "provider.skill_name"));
  });
});

test("Claude provider uses structured output with no tools and an injected process runner", async () => {
  await withTempDir(async (cwd) => {
    let seenExecutable = "";
    let seenArgs: string[] = [];
    const runner = async (executable: string, args: string[]): Promise<SpawnResult> => {
      seenExecutable = executable;
      seenArgs = args;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, structured_output: validCandidate("structured-skill") }),
        stderr: "",
        durationMs: 10,
        timedOut: false
      };
    };
    const provider = new ClaudeCodeSkillProvider({ cwd, runner });
    const result = await provider.generate({
      brief: "Create a structured skill",
      name: "structured-skill",
      description: "Create a structured skill",
      attempt: 1,
      diagnostics: []
    }) as SkillCandidate;
    assert.equal(seenExecutable, "claude");
    assert.ok(seenArgs.includes("--json-schema"));
    const toolsIndex = seenArgs.indexOf("--tools");
    assert.ok(toolsIndex >= 0);
    assert.equal(seenArgs[toolsIndex + 1], "");
    assert.ok(!seenArgs.some((arg) => /Bash|Write|Edit/.test(arg)));
    assert.equal((result.evals as { skill_name: string }).skill_name, "structured-skill");
  });
});

test("Claude provider reports timeouts without returning captured output", async () => {
  const provider = new ClaudeCodeSkillProvider({
    runner: async () => ({
      exitCode: null,
      stdout: "secret output",
      stderr: "secret stderr",
      durationMs: 1234,
      timedOut: true
    })
  });
  await assert.rejects(
    () => provider.generate({ brief: "b", name: "safe-name", description: "d", attempt: 1, diagnostics: [] }),
    (error: unknown) => error instanceof Error && /timed out after 1234ms/.test(error.message) && !/secret/.test(error.message)
  );
});

test("Claude provider classifies malformed output without echoing it", async () => {
  const provider = new ClaudeCodeSkillProvider({
    runner: async () => ({
      exitCode: 0,
      stdout: "malformed provider output containing private text",
      stderr: "",
      durationMs: 10,
      timedOut: false
    })
  });
  await assert.rejects(
    () => provider.generate({ brief: "b", name: "safe-name", description: "d", attempt: 1, diagnostics: [] }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Claude Code provider returned malformed structured output" &&
      !/private text/.test(error.message)
  );
});

test("Claude provider preserves sanitized error-envelope classifications", async () => {
  const provider = new ClaudeCodeSkillProvider({
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ type: "result", is_error: true, result: "You've hit your session limit; raw detail" }),
      stderr: "",
      durationMs: 10,
      timedOut: false
    })
  });
  await assert.rejects(
    () => provider.generate({ brief: "b", name: "safe-name", description: "d", attempt: 1, diagnostics: [] }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Claude Code provider failed: session limit reached" &&
      !/raw detail/.test(error.message)
  );
});

test("Claude provider classifies missing executable and other startup failures", async () => {
  const missing = new ClaudeCodeSkillProvider({
    runner: async () => {
      const error = new Error("private executable path");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }
  });
  await assert.rejects(
    () => missing.generate({ brief: "b", name: "safe-name", description: "d", attempt: 1, diagnostics: [] }),
    /executable was not found/
  );

  const failed = new ClaudeCodeSkillProvider({ runner: async () => { throw new Error("private startup data"); } });
  await assert.rejects(
    () => failed.generate({ brief: "b", name: "safe-name", description: "d", attempt: 1, diagnostics: [] }),
    (error: unknown) => error instanceof Error && error.message === "Claude Code provider process could not start"
  );
});

test("install plan is deterministic, symbolic, and read-only", async () => {
  await withTempDir(async (workspace) => {
    const created = await createSkill(workspace, "Plan an installation", { name: "installable-skill" });
    const before = await readdir(created.outDir, { recursive: true });
    const plan = await createInstallPlan(workspace, created.outDir, "all");
    const after = await readdir(created.outDir, { recursive: true });
    assert.deepEqual(after, before);
    assert.deepEqual(plan.targets, ["codex", "claude-code"]);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.operations.length, 6);
    assert.ok(plan.operations.some((item) => item.destination === "$CODEX_HOME/skills/installable-skill/SKILL.md"));
    assert.ok(plan.operations.some((item) => item.destination === "$CLAUDE_CONFIG_DIR/skills/installable-skill/evals/quality-report.json"));
  });
});

test("install plan rejects a package outside the workspace", async () => {
  await withTempDir(async (root) => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    const created = await createSkill(outside, "Outside package", { name: "outside-package" });
    await assert.rejects(() => createInstallPlan(workspace, created.outDir), /outside the workspace/);
  });
});

test("install plan refuses links inside an otherwise valid package", async () => {
  await withTempDir(async (workspace) => {
    const created = await createSkill(workspace, "No linked files", { name: "no-linked-files" });
    const external = join(workspace, "external-dir");
    await mkdir(external);
    await symlink(external, join(created.outDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => createInstallPlan(workspace, created.outDir), /symbolic link/);
  });
});

test("install plan rejects a linked required directory before reading it", async () => {
  await withTempDir(async (workspace) => {
    const created = await createSkill(workspace, "No linked eval directory", { name: "no-linked-evals" });
    const originalEvals = await readFile(join(created.outDir, "evals", "evals.json"), "utf8");
    const external = join(workspace, "external-evals");
    await mkdir(external);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(external, "evals.json"), originalEvals, "utf8"));
    await rm(join(created.outDir, "evals"), { recursive: true, force: true });
    await symlink(external, join(created.outDir, "evals"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => createInstallPlan(workspace, created.outDir), /symbolic link/);
  });
});

test("install plan rejects parent traversal even when it normalizes inside the workspace", async () => {
  await withTempDir(async (workspace) => {
    const created = await createSkill(workspace, "Traversal package", { name: "traversal-package" });
    const traversing = "skills/../skills/traversal-package";
    assert.equal(resolve(workspace, traversing), created.outDir);
    await assert.rejects(() => createInstallPlan(workspace, traversing), /parent traversal/);
  });
});

test("CLI option parsers reject unsupported provider and install targets", () => {
  assert.equal(parseSkillProvider(undefined), undefined);
  assert.equal(parseSkillProvider("claude-code"), "claude-code");
  assert.equal(parseInstallTarget(undefined), "all");
  assert.equal(parseInstallTarget("codex"), "codex");
  assert.throws(() => parseSkillProvider("unknown"), /Unsupported provider/);
  assert.throws(() => parseInstallTarget("unknown"), /Unsupported install target/);
});
