// Pair 2 — env leaker. Control case: we already know env leaks across files
// in the same worker (the whole reason slice 1 / #2797 existed). This pair
// confirms the experiment harness is correctly putting both files in the
// same worker — if pair-2-observer doesn't see ATLAS_EXPERIMENT_LEAK_PAIR_2,
// then `--max-workers=1` isn't actually putting them together and every
// other verdict in this run is suspect.
import { test, expect } from "bun:test";

process.env.ATLAS_EXPERIMENT_LEAK_PAIR_2 = "leaked";

test("leaker set the env var (sanity)", () => {
  expect(process.env.ATLAS_EXPERIMENT_LEAK_PAIR_2).toBe("leaked");
});
