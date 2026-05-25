// Pair 11 — minimal repro for the actual bug behind milestone 1.5.4
// slice 6 failure. ZERO Atlas dependencies. The hypothesis from
// pair-10's trace: under bun `--isolate`, top-level `await import(X)`
// does NOT await X's top-level-await chain — it returns a partially-
// initialized exports object, the importer continues immediately, and
// X finishes loading asynchronously in the background.
//
//   passes under --isolate → hypothesis wrong, keep digging.
//   fails  under --isolate → confirmed. The `mock.module()` and `??=`
//                            framings in #2811 were red herrings. The
//                            actual fix candidates are: (a) make
//                            `--isolate` honor TLA in dynamic imports
//                            (upstream); (b) restructure SUTs to avoid
//                            top-level await; (c) move SUT imports
//                            into a `beforeAll(async () => { ... })`
//                            so the await semantics are well-defined.
import { test, expect } from "bun:test";

console.error("[PAIR11] before await import");
const mod = await import("./pair-11-tla-target");
console.error("[PAIR11] after await import; ready=", JSON.stringify(mod.ready));

test("[VERDICT pair 11] top-level await import waits for imported module's TLA chain", () => {
  console.error("[PAIR11] inside test; ready=", JSON.stringify(mod.ready));
  expect(mod.ready).toBe("DONE");
});
