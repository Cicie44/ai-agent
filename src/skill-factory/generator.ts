import { mkdir, writeFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";

import type { CreateOptions, ValidationResult } from "./types.js";
import { validateSkillDir } from "./validator.js";

const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface CreateResult {
  outDir: string;
  validation: ValidationResult;
}

// Resolve p to its canonical real path, walking up to the deepest existing
// ancestor so that symlinks and junctions in existing portions are resolved
// even when the leaf does not yet exist.
async function toRealPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(p);
    if (parent === p) return p; // reached filesystem root
    const realParent = await toRealPath(parent);
    return join(realParent, basename(p));
  }
}

function deriveName(brief: string): string {
  const slug = brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  const withLetter = slug.replace(/^[^a-z]+/, "");
  return withLetter || "unnamed-skill";
}

function deriveDescription(brief: string): string {
  const trimmed = brief.trim().replace(/[\r\n]+/g, " ");
  const firstSentenceMatch = trimmed.match(/^[^.!?]+/);
  const firstSentence = firstSentenceMatch?.[0]?.trim() ?? "";
  const candidate = firstSentence.length > 0 ? firstSentence : trimmed;
  return candidate.slice(0, 120).trim();
}

function escapeYamlString(s: string): string {
  const single = s.replace(/[\r\n]+/g, " ").trim();
  return `"${single.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function generateSkillMd(name: string, description: string, brief: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${escapeYamlString(description)}`,
    "---",
    "",
    "## Instructions",
    "",
    brief.trim(),
    "",
    "## Steps",
    "",
    "1. Analyze the provided request or input.",
    "2. Execute the workflow described in the instructions.",
    "3. Return a clear, complete result.",
    "",
    "## Notes",
    "",
    `- See \`evals/evals.json\` for example inputs and expected outputs.`,
    ""
  ].join("\n");
}

function generateEvalsJson(name: string, description: string, brief: string): string {
  return (
    JSON.stringify(
      {
        skill_name: name,
        evals: [
          {
            id: `${name}-eval-001`,
            prompt: `Demonstrate the core workflow: ${brief.trim()}`,
            expected_output: `A successful execution that ${description.toLowerCase()}.`,
            files: []
          },
          {
            id: `${name}-eval-002`,
            prompt: `Edge case: Provide minimal input for the skill "${name}".`,
            expected_output:
              "The skill handles the minimal case gracefully and returns a well-formed result.",
            files: []
          }
        ]
      },
      null,
      2
    ) + "\n"
  );
}

export async function createSkill(
  workspace: string,
  brief: string,
  options: CreateOptions = {}
): Promise<CreateResult> {
  if (!brief.trim()) {
    throw new Error("Brief must be non-empty");
  }

  const name = options.name ?? deriveName(brief);
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Skill name "${name}" is invalid. Must be lowercase letters, digits, and single hyphens (e.g. my-skill-name)`
    );
  }

  // Resolve workspace to its canonical real path to detect symlink/junction escapes.
  const workspaceResolved = await toRealPath(resolve(workspace));
  const rawOut = options.out;
  const outDir = rawOut
    ? isAbsolute(rawOut)
      ? rawOut
      : join(workspaceResolved, rawOut)
    : join(workspaceResolved, "skills", name);
  // Resolve the output path canonically (walks existing ancestors through realpath).
  const outResolved = await toRealPath(resolve(outDir));

  const rel = relative(workspaceResolved, outResolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Output path "${outResolved}" is outside the workspace "${workspaceResolved}"`
    );
  }

  try {
    const entries = await readdir(outResolved);
    if (entries.length > 0) {
      throw new Error(
        `Destination "${outResolved}" already exists and is not empty. Choose a different output path or name.`
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const description = deriveDescription(brief);

  await mkdir(join(outResolved, "evals"), { recursive: true });
  await writeFile(
    join(outResolved, "SKILL.md"),
    generateSkillMd(name, description, brief),
    "utf8"
  );
  await writeFile(
    join(outResolved, "evals", "evals.json"),
    generateEvalsJson(name, description, brief),
    "utf8"
  );

  const validation = await validateSkillDir(outResolved);
  return { outDir: outResolved, validation };
}
