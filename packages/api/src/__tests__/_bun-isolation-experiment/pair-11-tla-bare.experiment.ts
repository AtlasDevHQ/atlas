// Pair 11 — minimal repro for the actual bug behind milestone 1.5.4
// slice 6 failure. ZERO Atlas dependencies. Hypothesis from pair-10's
// trace: under bun `--isolate`, top-level `await import(X)` does NOT
// await X's top-level-await chain — the importer resumes before X has
// finished initializing.
//
// Two failure shapes observable depending on what the importer reads:
//   - Reading a `const` exported AFTER X's top-level await throws
//     `ReferenceError: Cannot access 'X' before initialization` (the
//     ESM TDZ semantics, which --isolate exposes by skipping the await).
//     This is what pair-11 hits.
//   - Reading an object that X mutates ACROSS top-level await boundaries
//     (e.g. an `app` instance that `await import("./route-N")` calls
//     into) returns the object but with the post-await mutations missing.
//     This is what pair-10 and the production `actions.test.ts` hit.
//
//   passes under --isolate → hypothesis wrong, keep digging.
//   fails  under --isolate → confirmed. The `mock.module()` and `??=`
//                            framings in #2811 were red herrings. None
//                            of the in-test workarounds save you:
//                            beforeAll, in-test `await import`, static
//                            hoisted `import` — all observed to fail
//                            the same way during the investigation
//                            (those probes deleted as redundant; the
//                            point is that --isolate breaks TLA
//                            propagation regardless of import shape).
//
// Empirical traces from this fixture:
//
//   Expected (bun 1.3.13, --isolate ✅):
//     [PAIR11] before await import
//     [TLA-TARGET] top reached
//     [TLA-TARGET] after await
//     [TLA-TARGET] export assigned
//     [PAIR11] after await import; ready= "DONE"
//     [PAIR11] inside test; ready= "DONE"
//     1 pass / 0 fail
//
//   Observed (bun 1.3.14, --isolate ❌):
//     [PAIR11] before await import
//     [TLA-TARGET] top reached
//     ReferenceError: Cannot access 'ready' before initialization.
//     0 pass / 1 fail
//
// Note the missing `[TLA-TARGET] after await` and `[TLA-TARGET] export
// assigned` lines — the importer resumed before X's top-level await
// settled. Use as the body of the upstream filing at oven-sh/bun.
import { test, expect } from "bun:test";

console.error("[PAIR11] before await import");
const mod = await import("./pair-11-tla-target");
console.error("[PAIR11] after await import; ready=", JSON.stringify(mod.ready));

test("[VERDICT pair 11] top-level await import waits for imported module's TLA chain", () => {
  console.error("[PAIR11] inside test; ready=", JSON.stringify(mod.ready));
  expect(mod.ready).toBe("DONE");
});
