// Pair 3 — globalThis observer. Verdict:
//   passes  → `--isolate` did give us a fresh global object
//   fails   → globalThis is shared across files in the worker
import { test, expect } from "bun:test";

declare global {
  var __atlasExperimentLeakPair3: string | undefined;
}

test("[VERDICT pair 3] globalThis property from leaker did NOT survive", () => {
  expect(globalThis.__atlasExperimentLeakPair3).toBeUndefined();
});
