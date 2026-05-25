// Pair 5 — spy observer. Verdict:
//   passes  → globalThis was reset → spy reference is gone → no leak path
//             (consistent with pair 3)
//   fails   → globalThis carries the spy and its call history → tests that
//             create spies at module scope can pollute siblings
import { test, expect, type mock } from "bun:test";

declare global {
  var __atlasExperimentSpyPair5: ReturnType<typeof mock> | undefined;
}

test("[VERDICT pair 5] spy reference + call history from leaker did NOT survive", () => {
  expect(globalThis.__atlasExperimentSpyPair5).toBeUndefined();
});
