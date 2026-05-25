// Pair 5 — spy leaker. Top-level `mock(fn)` creates a spy that's exposed
// on globalThis so pair-5-observer can inspect it. If `--isolate` resets
// the global object, the observer sees `undefined`. If it doesn't, the
// observer can read `.mock.calls.length` and see leaker's call history.
import { test, expect, mock } from "bun:test";

declare global {
  var __atlasExperimentSpyPair5: ReturnType<typeof mock> | undefined;
}

const spy = mock((x: number) => x * 2);
globalThis.__atlasExperimentSpyPair5 = spy;

test("leaker invoked the spy 3 times (sanity)", () => {
  spy(1);
  spy(2);
  spy(3);
  expect(spy.mock.calls.length).toBe(3);
});
