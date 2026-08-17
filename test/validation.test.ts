import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonPayload } from "../src/validation.js";

test("parses a JSON result after a CLI notice", () => {
  const payload = parseJsonPayload('A newer version is available\n{"status":"completed"}\n');
  assert.deepEqual(payload, { status: "completed" });
});

test("ignores a quoted CLI notice after a JSON result", () => {
  const payload = parseJsonPayload('{"status":"completed"}\n"Update available"\n');
  assert.deepEqual(payload, { status: "completed" });
});

test("parses a fenced JSON result surrounded by agent prose", () => {
  const payload = parseJsonPayload('Finished the task.\n```json\n{"status":"completed"}\n```\nAll done.');
  assert.deepEqual(payload, { status: "completed" });
});

test("prefers a complete fenced report over nested one-line objects", () => {
  const payload = parseJsonPayload(
    'Finished.\n```json\n{\n  "status": "completed",\n  "tests": [\n    {"name":"check","status":"passed"}\n  ]\n}\n```'
  );
  assert.deepEqual(payload, {
    status: "completed",
    tests: [{ name: "check", status: "passed" }]
  });
});

test("rejects output without a complete JSON payload", () => {
  assert.throws(() => parseJsonPayload("finished, but not structured"), /not valid JSON/);
});
