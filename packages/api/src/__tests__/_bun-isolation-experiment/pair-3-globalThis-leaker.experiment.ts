// Pair 3 — globalThis leaker. `--isolate` docs claim a "fresh global object"
// per file. If true, pair-3-observer should NOT see this property.
import { test, expect } from "bun:test";

declare global {
  var __atlasExperimentLeakPair3: string | undefined;
}

globalThis.__atlasExperimentLeakPair3 = "leaked-from-pair-3-leaker";

test("leaker set the global (sanity)", () => {
  expect(globalThis.__atlasExperimentLeakPair3).toBe("leaked-from-pair-3-leaker");
});
