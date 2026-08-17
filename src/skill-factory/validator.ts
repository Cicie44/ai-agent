import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ValidationDiagnostic, ValidationResult } from "./types.js";

const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Supported escape sequences for double-quoted YAML scalars (MVP restricted subset).
const DQUOTE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  r: "\r",
  t: "\t",
};

type QuoteResult = { ok: true; value: string } | { ok: false; problem: string };

function parseDoubleQuoted(s: string): QuoteResult {
  // s is already trimmed and starts with '"'
  let value = "";
  let i = 1; // skip the opening "
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      const escChar = s[i];
      if (escChar === undefined) {
        return { ok: false, problem: "unterminated string literal (trailing backslash)" };
      }
      const resolved = DQUOTE_ESCAPES[escChar];
      if (resolved === undefined) {
        return { ok: false, problem: `unsupported escape sequence: \\${escChar}` };
      }
      value += resolved;
      i++;
    } else if (ch === '"') {
      if (i !== s.length - 1) {
        return { ok: false, problem: "unexpected content after closing quote" };
      }
      return { ok: true, value };
    } else {
      value += ch;
      i++;
    }
  }
  return { ok: false, problem: "unterminated string literal (no closing quote)" };
}

function parseSingleQuoted(s: string): QuoteResult {
  // s is already trimmed and starts with "'"
  // In YAML single-quoted scalars, '' is the only escape (literal single quote).
  // Backslash has no special meaning.
  let value = "";
  let i = 1; // skip the opening '
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      if (i + 1 < s.length && s[i + 1] === "'") {
        value += "'"; // '' → literal '
        i += 2;
      } else {
        if (i !== s.length - 1) {
          return { ok: false, problem: "unexpected content after closing quote" };
        }
        return { ok: true, value };
      }
    } else {
      value += ch;
      i++;
    }
  }
  return { ok: false, problem: "unterminated string literal (no closing quote)" };
}

function parseFrontmatter(
  content: string
): { meta: Record<string, string>; body: string; problems: string[] } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;

  // Find an exact closing delimiter line: "---" followed by "\n" or end of string.
  // A line like "---garbage" must NOT match.
  let closeIdx = -1;
  let searchFrom = 4;
  while (searchFrom < normalized.length) {
    const idx = normalized.indexOf("\n---", searchFrom);
    if (idx === -1) break;
    const charAfter = normalized[idx + 4]; // char right after the three dashes
    if (charAfter === undefined || charAfter === "\n") {
      closeIdx = idx;
      break;
    }
    searchFrom = idx + 1;
  }
  if (closeIdx === -1) return null;

  const yamlSection = normalized.slice(4, closeIdx);
  const rest = normalized.slice(closeIdx + 4);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;

  const meta: Record<string, string> = {};
  const problems: string[] = [];

  for (const line of yamlSection.split("\n")) {
    if (line.trim() === "") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      problems.push(
        `Malformed YAML line (expected key: value): ${line.trim().slice(0, 60)}`
      );
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    const rawVal = line.slice(colonIdx + 1).trim();
    if (rawVal.startsWith('"')) {
      const result = parseDoubleQuoted(rawVal);
      if (!result.ok) {
        problems.push(`Malformed YAML value for key "${key}": ${result.problem}`);
        meta[key] = rawVal; // store raw so subsequent field checks still run
      } else {
        meta[key] = result.value;
      }
    } else if (rawVal.startsWith("'")) {
      const result = parseSingleQuoted(rawVal);
      if (!result.ok) {
        problems.push(`Malformed YAML value for key "${key}": ${result.problem}`);
        meta[key] = rawVal;
      } else {
        meta[key] = result.value;
      }
    } else {
      meta[key] = rawVal;
    }
  }

  return { meta, body, problems };
}

function isUnsafePath(filePath: string): boolean {
  // Empty strings are not valid portable relative paths.
  if (filePath === "") return true;
  // Windows drive-qualified (absolute C:\... or drive-relative C:secret).
  if (/^[A-Za-z]:/.test(filePath)) return true;
  // Unix absolute root or Windows rooted backslash (including UNC \\server\share).
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return true;
  // Parent traversal.
  return filePath.split(/[/\\]/).some((p) => p === "..");
}

export async function validateSkillDir(dir: string): Promise<ValidationResult> {
  const diagnostics: ValidationDiagnostic[] = [];
  const push = (field: string, message: string): void => {
    diagnostics.push({ field, message });
  };

  let skillMdContent: string | null = null;
  let evalsContent: string | null = null;

  try {
    skillMdContent = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    push("SKILL.md", "File does not exist");
  }

  try {
    evalsContent = await readFile(join(dir, "evals", "evals.json"), "utf8");
  } catch {
    push("evals/evals.json", "File does not exist");
  }

  let skillName: string | null = null;

  if (skillMdContent !== null) {
    const parsed = parseFrontmatter(skillMdContent);
    if (!parsed) {
      push("SKILL.md", "Missing or malformed YAML frontmatter (expected --- delimiters)");
    } else {
      const { meta, body, problems } = parsed;

      for (const prob of problems) {
        push("SKILL.md frontmatter", prob);
      }

      const rawName = meta["name"];
      if (!rawName || rawName.trim() === "") {
        push("SKILL.md frontmatter.name", "Field is required");
      } else if (!SKILL_NAME_RE.test(rawName)) {
        push(
          "SKILL.md frontmatter.name",
          `Must be lowercase letters, digits, and single hyphens (got: ${rawName})`
        );
      } else {
        skillName = rawName;
      }

      const rawDesc = meta["description"];
      if (!rawDesc || rawDesc.trim() === "") {
        push("SKILL.md frontmatter.description", "Field is required and must be non-empty");
      }

      if (body.trim() === "") {
        push("SKILL.md body", "Workflow instructions must not be empty");
      }
    }
  }

  if (evalsContent !== null) {
    // Use a wrapper to distinguish parse failure (null sentinel) from a JSON null value.
    let parseResult: { value: unknown } | null = null;
    try {
      parseResult = { value: JSON.parse(evalsContent) as unknown };
    } catch (e) {
      push(
        "evals/evals.json",
        `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (parseResult !== null) {
      const evalFile = parseResult.value;
      if (evalFile === null || typeof evalFile !== "object" || Array.isArray(evalFile)) {
        push("evals/evals.json", "Must be a JSON object");
      } else {
        const obj = evalFile as Record<string, unknown>;

        const rawSkillName = obj["skill_name"];
        if (typeof rawSkillName !== "string" || rawSkillName.trim() === "") {
          push(
            "evals/evals.json skill_name",
            "Field is required and must be a non-empty string"
          );
        } else if (!SKILL_NAME_RE.test(rawSkillName)) {
          push(
            "evals/evals.json skill_name",
            `Must match name format (got: ${rawSkillName})`
          );
        } else if (skillName !== null && rawSkillName !== skillName) {
          push(
            "evals/evals.json skill_name",
            `Must match SKILL.md frontmatter name (expected: ${skillName}, got: ${rawSkillName})`
          );
        }

        const evalsArr = obj["evals"];
        if (!Array.isArray(evalsArr)) {
          push("evals/evals.json evals", "Must be an array");
        } else {
          if (evalsArr.length < 2) {
            push("evals/evals.json evals", "Must contain at least two eval cases");
          }

          const seenIds = new Set<string>();
          for (let i = 0; i < evalsArr.length; i++) {
            const evalCase = evalsArr[i];
            const prefix = `evals/evals.json evals[${i}]`;

            if (evalCase === null || typeof evalCase !== "object" || Array.isArray(evalCase)) {
              push(prefix, "Must be an object");
              continue;
            }

            const ec = evalCase as Record<string, unknown>;

            const rawId = ec["id"];
            if (typeof rawId !== "string" || rawId.trim() === "") {
              push(`${prefix}.id`, "Must be a non-empty string");
            } else if (seenIds.has(rawId)) {
              push(`${prefix}.id`, `Duplicate identifier: ${rawId}`);
            } else {
              seenIds.add(rawId);
            }

            const rawPrompt = ec["prompt"];
            if (typeof rawPrompt !== "string" || rawPrompt.trim() === "") {
              push(`${prefix}.prompt`, "Must be a non-empty string");
            }

            const rawExpected = ec["expected_output"];
            if (typeof rawExpected !== "string" || rawExpected.trim() === "") {
              push(`${prefix}.expected_output`, "Must be a non-empty string");
            }

            const rawFiles = ec["files"];
            if (!Array.isArray(rawFiles)) {
              push(`${prefix}.files`, "Must be an array");
            } else {
              for (let j = 0; j < rawFiles.length; j++) {
                const fp = rawFiles[j];
                if (typeof fp !== "string") {
                  push(`${prefix}.files[${j}]`, "Must be a string");
                } else if (isUnsafePath(fp)) {
                  push(
                    `${prefix}.files[${j}]`,
                    `Unsafe path (absolute or parent-traversing): ${fp}`
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}
