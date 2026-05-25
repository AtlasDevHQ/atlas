// Pair 4 — chdir observer. Verdict:
//   passes  → cwd was reset (surprising; would mean bun resets OS state too)
//   fails   → cwd survived (expected; confirms the OS-state rule in
//             check-test-discipline.sh is real)
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";

test("[VERDICT pair 4] chdir from leaker did NOT survive (expected to FAIL — confirms OS-state rule)", () => {
  // If pair-4-leaker ran in the same worker, cwd is tmpdir() and this fails.
  expect(process.cwd()).not.toBe(tmpdir());
});
