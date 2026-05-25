// Pair 1 — leaker. Top-level `mock.module()` replaces `_shared-target.truth()`
// with a fake return. If `--isolate` resets module mocks between files in the
// same worker, pair-1-observer will see the real "real" value.
import { test, expect, mock } from "bun:test";

mock.module("./_shared-target", () => ({
  truth: () => "MOCKED_BY_LEAKER",
}));

const target = await import("./_shared-target");

test("leaker sees the mocked value (sanity)", () => {
  expect(target.truth()).toBe("MOCKED_BY_LEAKER");
});
