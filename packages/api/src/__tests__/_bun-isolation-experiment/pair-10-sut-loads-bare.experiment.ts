// Pair 10 — does the production SUT even load under --isolate WITHOUT
// any mocks? If yes: the hang is mock-related (probably a mocked module
// being a transitive dep of the SUT). If no: the SUT itself has
// something that --isolate can't handle (top-level await chain, side
// effects, etc.) and the test infrastructure isn't at fault.
import { test, expect } from "bun:test";

process.env.ATLAS_ACTIONS_ENABLED ??= "true";

console.error("[PAIR10] before await import");
const mod = await import("@atlas/api/app");
console.error("[PAIR10] after await import; mod.app=", typeof mod.app);

test("[VERDICT pair 10] @atlas/api/app loads to completion under current flags", () => {
  console.error("[PAIR10] inside test; mod.app=", typeof mod.app);
  expect(mod.app).toBeDefined();
});
