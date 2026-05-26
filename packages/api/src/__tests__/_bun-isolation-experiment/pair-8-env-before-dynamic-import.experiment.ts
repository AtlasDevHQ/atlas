// Pair 8 — top-level `process.env.X ??= ...` followed by top-level
// `await import(Y)` where Y reads env at module-load time.
//
// This is the actual production pattern in actions.test.ts:186–189 that
// breaks under bun 1.3.14 --isolate (62/0 bare → 5/57 isolate). pair-6
// already proved the mock.module() side propagates fine; the suspect is
// the conditional-mount: `src/api/index.ts:251` checks the env at top
// level and only mounts the actions route when set. The question is
// whether the env set on the line above survives to the dynamically-
// imported child module under --isolate.
//
//   passes under --isolate → not the trigger; keep digging.
//   fails  under --isolate → confirmed. The `??=` slice-1 exception
//                            pattern doesn't survive --isolate, and the
//                            real fix is to set env inside beforeAll +
//                            move the SUT import behind a per-test hook
//                            (or refactor the conditional mount).
//
// OBSERVED on bun 1.3.14: ✅ passed under --isolate AND --parallel.
// Env-before-dynamic-import works fine; this hypothesis rejected.
// Root cause turned out to be TLA in the imported module — see pair-11.
import { test, expect } from "bun:test";

process.env._PAIR_8_PROBE_VAR ??= "ENABLED_BY_TEST";

const target = await import("./pair-8-env-target");

test("[VERDICT pair 8] env set before top-level await import is visible to the loaded module", () => {
  expect(target.envAtLoad).toBe("ENABLED_BY_TEST");
});
