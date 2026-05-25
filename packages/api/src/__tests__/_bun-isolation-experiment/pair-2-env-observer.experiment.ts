// Pair 2 — env observer. Control: this SHOULD fail under `--max-workers=1`,
// proving the two files genuinely share a worker. If it passes, the harness
// is broken (files aren't actually co-resident) and the other verdicts mean
// nothing.
import { test, expect } from "bun:test";

test("[HARNESS-CHECK pair 2] env from leaker is visible (this SHOULD fail — confirms shared worker)", () => {
  // Inverted: passing this assertion means the worker was NOT shared.
  expect(process.env.ATLAS_EXPERIMENT_LEAK_PAIR_2).toBeUndefined();
});
