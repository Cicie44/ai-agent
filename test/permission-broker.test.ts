import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { PermissionBroker } from "../src/permission-broker.js";
import { testPolicy, withTempWorkspace } from "./helpers.js";

test("auto-approves exact safe command prefixes", async () => {
  await withTempWorkspace(async (root) => {
    const broker = new PermissionBroker(join(root, ".ai"), testPolicy);
    const decision = await broker.authorizeCommand("TASK-TEST", {
      executable: "npm",
      args: ["test", "--", "unit"],
      label: "unit tests"
    });
    assert.equal(decision.allowed, true);
    assert.equal((await broker.list()).length, 0);
  });
});

test("queues and persists commands outside the allow list", async () => {
  await withTempWorkspace(async (root) => {
    const broker = new PermissionBroker(join(root, ".ai"), testPolicy);
    const first = await broker.authorizeCommand("TASK-TEST", {
      executable: "npm",
      args: ["install", "zod"],
      label: "install dependency"
    });
    assert.equal(first.allowed, false);
    assert.ok(first.approvalId);
    await broker.decide(first.approvalId!, "approved");
    const second = await broker.authorizeCommand("TASK-TEST", {
      executable: "npm",
      args: ["install", "zod"],
      label: "install dependency"
    });
    assert.equal(second.allowed, true);
  });
});
