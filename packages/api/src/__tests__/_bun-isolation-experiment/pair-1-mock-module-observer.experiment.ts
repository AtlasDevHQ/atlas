// Pair 1 — observer. Does NOT call `mock.module`. Re-imports the same
// module the leaker mocked. Verdict:
//   passes  → `--isolate` reset the module mock (great, no codemod needed)
//   fails   → mock survived (5b must add `mock.restore` in `afterAll` everywhere)
import { test, expect } from "bun:test";

const target = await import("./_shared-target");

test("[VERDICT pair 1] mock.module from leaker did NOT survive into observer", () => {
  expect(target.truth()).toBe("real");
});
