import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

import { resolveSpawnCommand } from "../src/process.js";

test("resolves npm through its JavaScript CLI on Windows", () => {
  const resolved = resolveSpawnCommand("npm", ["run", "check"]);
  if (process.platform !== "win32") {
    assert.deepEqual(resolved, { executable: "npm", args: ["run", "check"] });
    return;
  }

  assert.equal(resolved.executable, process.execPath);
  assert.equal(basename(resolved.args[0] ?? ""), "npm-cli.js");
  assert.deepEqual(resolved.args.slice(1), ["run", "check"]);
});
