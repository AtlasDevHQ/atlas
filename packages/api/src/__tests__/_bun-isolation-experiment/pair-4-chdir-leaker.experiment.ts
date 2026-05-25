// Pair 4 — chdir leaker. Control case along with pair 2 (env): we know
// OS-level state like cwd is per-process, not per-isolate. This pair
// re-confirms the contract documented in `check-test-discipline.sh`.
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";

const original = process.cwd();
process.chdir(tmpdir());

test("leaker changed cwd (sanity)", () => {
  expect(process.cwd()).toBe(tmpdir());
});

// Note: not restoring cwd intentionally — pair-4-observer should see the
// tmpdir cwd if our shared-worker assumption holds.
void original;
