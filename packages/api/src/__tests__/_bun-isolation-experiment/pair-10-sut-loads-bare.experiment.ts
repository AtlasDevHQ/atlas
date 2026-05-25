// Pair 10 — does the production SUT even load under --isolate WITHOUT
// any mocks? If yes: the hang is mock-related (probably a mocked module
// being a transitive dep of the SUT). If no: the SUT itself has
// something that --isolate can't handle (top-level await chain, side
// effects, etc.) and the test infrastructure isn't at fault.
//
// OBSERVED on bun 1.3.14: the test technically passes — `mod.app` IS
// defined — but stderr probes (added during the investigation in
// src/api/index.ts and routes/onboarding.ts, since reverted) revealed
// the smoking-gun interleaving:
//   [PAIR10] before await import
//   [PROBE A] before onboarding import         ← inside index.ts
//   [PROBE A1] entered try
//   [PAIR10] after await import; mod.app= object  ← await import RETURNED
//   [PAIR10] inside test; mod.app= object          ← test ran
//   [ONBOARDING] module top reached                ← SUT keeps loading
// `await import` returned BEFORE the SUT's top-level-await chain
// finished. The test passed on a half-loaded app — `actions.test.ts`
// fails because its 57 failing assertions hit routes that the SUT's
// later top-level awaits would have registered. See pair-11 for the
// zero-Atlas-dep minimal version.
import { test, expect } from "bun:test";

process.env.ATLAS_ACTIONS_ENABLED ??= "true";

console.error("[PAIR10] before await import");
const mod = await import("@atlas/api/app");
console.error("[PAIR10] after await import; mod.app=", typeof mod.app);

test("[VERDICT pair 10] @atlas/api/app loads to completion under current flags", () => {
  console.error("[PAIR10] inside test; mod.app=", typeof mod.app);
  expect(mod.app).toBeDefined();
});
