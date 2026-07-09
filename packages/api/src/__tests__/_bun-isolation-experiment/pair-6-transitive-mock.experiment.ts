// Pair 6 — within-file transitive mock probe.
//
// Recalibrates the 5a verdict. Pair 1 only proved that `mock.module()` +
// direct `await import(X)` works under `--isolate` (mock X, read X). The
// production failure in `actions.test.ts` is different: mock X, import Y
// where Y transitively imports X, then assert Y's behavior reflects the
// mock. This pair isolates that case with no Atlas dependencies.
//
//   passes under --isolate → `mock.module()` DOES propagate transitively;
//                            actions.test.ts is failing for some other
//                            reason (workspace-alias resolution? engine
//                            version? something Atlas-side).
//   fails  under --isolate → `mock.module()` does NOT propagate into the
//                            transitive import graph under --isolate;
//                            strong signal it's a bun behavior worth
//                            filing upstream.
import { test, expect, mock } from "bun:test";

void mock.module("./_shared-target", () => ({
  truth: () => "MOCKED_BY_PAIR_6",
}));

const intermediate = await import("./pair-6-intermediate");

test("[VERDICT pair 6] mock.module propagates to transitive consumer under current flags", () => {
  expect(intermediate.truthIndirect()).toBe("MOCKED_BY_PAIR_6");
});
