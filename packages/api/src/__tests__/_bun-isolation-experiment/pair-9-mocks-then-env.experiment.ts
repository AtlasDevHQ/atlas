// Pair 9 — actions.test.ts's actual top-level shape, condensed:
//   N × mock.module(...)
//   process.env.X ??= "ENABLED"
//   const _ = await import(Y)     // Y reads env at module-load time
//
// pair-8 proved env-before-dynamic-import works alone. This pair tests
// whether stacking mock.module() calls (10 in production) before the env
// assignment changes the picture — e.g. by causing the module loader to
// pre-resolve / freeze its env view.
//
// OBSERVED on bun 1.3.14: ✅ passed under --isolate AND --parallel.
// Stacking mock.module() before env-set didn't change anything;
// hypothesis rejected. Root cause is TLA in the imported module — see
// pair-11.
import { test, expect, mock } from "bun:test";

// Stand-in mocks against the experiment's own files; values are
// irrelevant — only that mock.module() RUNS before the env line below.
void mock.module("./_shared-target", () => ({ truth: () => "stub-1" }));
void mock.module("./pair-6-intermediate", () => ({
  truthIndirect: () => "stub-2",
}));

process.env._PAIR_9_PROBE_VAR ??= "ENABLED_BY_TEST";

const target = await import("./pair-9-env-target");

test("[VERDICT pair 9] env still propagates when mock.module calls precede the env assignment", () => {
  expect(target.envAtLoad).toBe("ENABLED_BY_TEST");
});
