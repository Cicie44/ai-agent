import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const source = await readFile(join(root, "docs", "agent-contract.md"), "utf8");
const banner = "<!-- Generated from docs/agent-contract.md. Do not edit directly. -->\n\n";

await Promise.all([
  writeFile(join(root, "AGENTS.md"), banner + source, "utf8"),
  writeFile(join(root, "CLAUDE.md"), banner + source, "utf8")
]);

console.log("Synchronized AGENTS.md and CLAUDE.md");
