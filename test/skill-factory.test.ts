import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSkill, validateSkillDir } from "../src/skill-factory/index.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "skill-factory-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSkillPackage(
  dir: string,
  skillMd: string,
  evalsJson: string
): Promise<void> {
  await mkdir(join(dir, "evals"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");
  await writeFile(join(dir, "evals", "evals.json"), evalsJson, "utf8");
}

// ── Successful generation ─────────────────────────────────────────────────────

test("creates a valid skill package from a brief", async () => {
  await withTempDir(async (workspace) => {
    const brief = "Summarize a given document into three concise bullet points";
    const result = await createSkill(workspace, brief);

    assert.ok(result.validation.ok, `Expected valid package, got: ${JSON.stringify(result.validation.diagnostics)}`);
    assert.ok(result.outDir.startsWith(workspace));
  });
});

test("generated SKILL.md has valid frontmatter name and description", async () => {
  await withTempDir(async (workspace) => {
    const { outDir, validation } = await createSkill(workspace, "Convert markdown to HTML safely");
    assert.ok(validation.ok);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(outDir, "SKILL.md"), "utf8");
    assert.ok(content.startsWith("---\n"), "SKILL.md must start with frontmatter");
    assert.match(content, /name: convert-markdown-to-html-safely/);
    assert.match(content, /description:/);
    assert.ok(content.includes("## Instructions"), "Body must contain instructions");
  });
});

test("generated evals/evals.json has matching skill_name and two eval cases", async () => {
  await withTempDir(async (workspace) => {
    const { outDir, validation } = await createSkill(workspace, "Extract named entities from text");
    assert.ok(validation.ok);

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(outDir, "evals", "evals.json"), "utf8");
    const parsed = JSON.parse(raw) as { skill_name: string; evals: unknown[] };
    assert.equal(parsed.skill_name, "extract-named-entities-from-text");
    assert.ok(Array.isArray(parsed.evals));
    assert.ok(parsed.evals.length >= 2, "Must have at least two eval cases");
  });
});

test("respects explicit --name override", async () => {
  await withTempDir(async (workspace) => {
    const result = await createSkill(workspace, "Some long brief here", { name: "my-custom-skill" });
    assert.ok(result.validation.ok);
    assert.ok(result.outDir.endsWith("my-custom-skill"));
  });
});

test("respects explicit --out override within workspace", async () => {
  await withTempDir(async (workspace) => {
    const out = join(workspace, "custom-output");
    const result = await createSkill(workspace, "Translate text between languages", { out });
    assert.ok(result.validation.ok);
    assert.equal(result.outDir, out);
  });
});

test("rejects output through a symlink or junction outside the workspace", async () => {
  await withTempDir(async (root) => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const linked = join(workspace, "linked");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      () => createSkill(workspace, "Keep generated files local", { out: join("linked", "escaped") }),
      /outside the workspace/
    );
  });
});

// ── Standalone validation of a manually crafted package ───────────────────────

test("validates a manually created valid skill package", async () => {
  await withTempDir(async (dir) => {
    const skillMd = [
      "---",
      "name: my-valid-skill",
      'description: "Does something useful"',
      "---",
      "",
      "## Instructions",
      "",
      "Follow these steps to complete the task.",
      ""
    ].join("\n");

    const evalsJson = JSON.stringify({
      skill_name: "my-valid-skill",
      evals: [
        { id: "my-valid-skill-eval-001", prompt: "Do the thing", expected_output: "Done.", files: [] },
        { id: "my-valid-skill-eval-002", prompt: "Edge case", expected_output: "Handled.", files: [] }
      ]
    });

    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(result.ok, `Expected valid, got: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.diagnostics.length, 0);
  });
});

// ── Malformed packages ────────────────────────────────────────────────────────

test("reports missing SKILL.md", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "evals"), { recursive: true });
    await writeFile(
      join(dir, "evals", "evals.json"),
      JSON.stringify({ skill_name: "foo", evals: [] }),
      "utf8"
    );
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.field === "SKILL.md" && d.message.includes("does not exist")));
  });
});

test("reports missing evals/evals.json", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: foo\ndescription: bar\n---\n\n## Instructions\n\nSome text.\n",
      "utf8"
    );
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.field === "evals/evals.json"));
  });
});

test("reports missing frontmatter delimiters", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "name: foo\ndescription: bar\n\n## Instructions\n\nSome text.\n";
    const evalsJson = JSON.stringify({ skill_name: "foo", evals: [] });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("frontmatter")));
  });
});

test("reports invalid skill name (uppercase)", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: MySkill\ndescription: does something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "MySkill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: [] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.field.includes("name")));
  });
});

test("reports mismatched skill_name between SKILL.md and evals", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: skill-a\ndescription: does something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "skill-b",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: [] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("match")));
  });
});

test("reports empty instructions body", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: empty-body\ndescription: Something\n---\n";
    const evalsJson = JSON.stringify({
      skill_name: "empty-body",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: [] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.field === "SKILL.md body"));
  });
});

test("reports malformed JSON in evals", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    await writeSkillPackage(dir, skillMd, "{ not valid json }");
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Invalid JSON")));
  });
});

test("reports eval case with empty prompt", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "", expected_output: "o", files: [] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.field.includes("prompt")));
  });
});

// ── Duplicate eval identifiers ────────────────────────────────────────────────

test("reports duplicate eval case identifiers", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: dup-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "dup-skill",
      evals: [
        { id: "same-id", prompt: "p1", expected_output: "o1", files: [] },
        { id: "same-id", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Duplicate identifier")));
  });
});

// ── Unsafe paths ──────────────────────────────────────────────────────────────

test("rejects --out path outside workspace", async () => {
  await withTempDir(async (workspace) => {
    await withTempDir(async (outside) => {
      await assert.rejects(
        () => createSkill(workspace, "Brief text here", { out: outside }),
        /outside the workspace/
      );
    });
  });
});

test("rejects --out path using parent traversal", async () => {
  await withTempDir(async (workspace) => {
    await assert.rejects(
      () => createSkill(workspace, "Brief text here", { out: join(workspace, "..", "escaped") }),
      /outside the workspace/
    );
  });
});

test("reports unsafe absolute file reference in eval case", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: ["/etc/passwd"] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Unsafe path")));
  });
});

test("reports parent-traversing file reference in eval case", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: ["../../secret.txt"] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Unsafe path")));
  });
});

// ── Destination-collision behavior ────────────────────────────────────────────

test("rejects creation when destination is a non-empty directory", async () => {
  await withTempDir(async (workspace) => {
    const out = join(workspace, "existing-skill");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "existing-file.txt"), "content", "utf8");

    await assert.rejects(
      () => createSkill(workspace, "Some brief", { out }),
      /already exists and is not empty/
    );
  });
});

test("allows creation when destination is an empty directory", async () => {
  await withTempDir(async (workspace) => {
    const out = join(workspace, "empty-dir");
    await mkdir(out, { recursive: true });
    const result = await createSkill(workspace, "Classify support tickets by urgency", { out });
    assert.ok(result.validation.ok);
  });
});

// ── Invalid explicit name ─────────────────────────────────────────────────────

test("rejects an invalid explicit --name", async () => {
  await withTempDir(async (workspace) => {
    await assert.rejects(
      () => createSkill(workspace, "Some brief", { name: "InvalidName" }),
      /invalid/
    );
  });
});

test("rejects empty brief", async () => {
  await withTempDir(async (workspace) => {
    await assert.rejects(
      () => createSkill(workspace, "   "),
      /Brief must be non-empty/
    );
  });
});

// ── Fewer than two evals ──────────────────────────────────────────────────────

test("reports fewer than two eval cases", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [{ id: "e1", prompt: "p", expected_output: "o", files: [] }]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("at least two")));
  });
});

// ── JSON null evals sentinel (HIGH finding) ───────────────────────────────────

test("reports JSON null as evals.json root", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    await writeSkillPackage(dir, skillMd, "null");
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("JSON object")));
  });
});

// ── File-path validation edge cases (MEDIUM finding) ─────────────────────────

test("reports empty string file reference in eval case", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: [""] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Unsafe path")));
  });
});

test("reports Windows drive-relative file reference in eval case", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: ["C:secret.txt"] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Unsafe path")));
  });
});

test("reports Windows rooted-backslash file reference in eval case", async () => {
  await withTempDir(async (dir) => {
    const skillMd = "---\nname: my-skill\ndescription: Something\n---\n\n## Instructions\n\nText.\n";
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: ["\\secret\\file.txt"] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Unsafe path")));
  });
});

// ── Frontmatter closing-delimiter precision (MEDIUM finding) ──────────────────

test("reports malformed frontmatter when closing delimiter has trailing text", async () => {
  await withTempDir(async (dir) => {
    const skillMd =
      "---\nname: foo\ndescription: bar\n---garbage\n\n## Instructions\n\nSome text.\n";
    const evalsJson = JSON.stringify({ skill_name: "foo", evals: [] });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.message.includes("frontmatter")));
  });
});

// ── Escape-aware quoted YAML value parsing (MEDIUM finding) ──────────────────

test("reports escaped-closing-quote as malformed frontmatter value", async () => {
  // description: "foo\" — the \" consumes the apparent closing quote; no real close exists.
  await withTempDir(async (dir) => {
    const skillMd = '---\nname: my-skill\ndescription: "foo\\"\n---\n\n## Instructions\n\nText.\n';
    const evalsJson = JSON.stringify({ skill_name: "my-skill", evals: [] });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(
      result.diagnostics.some(
        (d) => d.field === "SKILL.md frontmatter" && d.message.includes("unterminated")
      )
    );
  });
});

test("reports unsupported escape sequence in frontmatter value", async () => {
  // description: "foo\qbar" — \q is not a valid YAML double-quoted escape.
  await withTempDir(async (dir) => {
    const skillMd = '---\nname: my-skill\ndescription: "foo\\qbar"\n---\n\n## Instructions\n\nText.\n';
    const evalsJson = JSON.stringify({ skill_name: "my-skill", evals: [] });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(!result.ok);
    assert.ok(
      result.diagnostics.some(
        (d) => d.field === "SKILL.md frontmatter" && d.message.includes("unsupported escape")
      )
    );
  });
});

test("accepts properly escaped backslash in frontmatter value", async () => {
  // description: "foo\\" — \\ is a valid escape for a literal backslash.
  await withTempDir(async (dir) => {
    const skillMd = '---\nname: my-skill\ndescription: "foo\\\\"\n---\n\n## Instructions\n\nText.\n';
    const evalsJson = JSON.stringify({
      skill_name: "my-skill",
      evals: [
        { id: "e1", prompt: "p", expected_output: "o", files: [] },
        { id: "e2", prompt: "p2", expected_output: "o2", files: [] }
      ]
    });
    await writeSkillPackage(dir, skillMd, evalsJson);
    const result = await validateSkillDir(dir);
    assert.ok(result.ok, `Expected valid, got: ${JSON.stringify(result.diagnostics)}`);
  });
});
