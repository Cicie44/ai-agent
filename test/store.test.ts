import assert from "node:assert/strict";
import { test } from "node:test";

import { AiStore } from "../src/store.js";
import { withTempWorkspace } from "./helpers.js";

test("prevents two orchestrators from running the same task", async () => {
  await withTempWorkspace(async (root) => {
    const store = new AiStore(root);
    const task = await store.createTask("lock test");
    const release = await store.acquireTaskLock(task.id);
    await assert.rejects(() => store.acquireTaskLock(task.id), /already running/);
    await release();
    const releaseAgain = await store.acquireTaskLock(task.id);
    await releaseAgain();
  });
});
