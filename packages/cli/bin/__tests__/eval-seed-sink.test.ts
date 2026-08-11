/**
 * `atlas eval`'s seed-progress sink picks the right fd (#5126).
 *
 * ⚠️ THIS CALL SITE HAD NO TEST OF ANY KIND. `handleEval` is untested end to
 * end, and the sink was written inline as
 * `(csvOutput || jsonOutput ? process.stderr : process.stdout).write(text)` —
 * three plausible one-character mutations from reproducing #5126 one command
 * over, all of which survived the whole repo: drop the ternary, swap the arms,
 * or forget `csvOutput` (which would pollute the CSV body instead of the JSON
 * one). Extracting the resolver is what makes those four lines falsifiable
 * without spawning the LLM benchmark.
 *
 * The truth table is the point, so all four input classes are asserted rather
 * than the two that motivated the change.
 */
import { describe, expect, test } from "bun:test";
import { evalSeedSink } from "../eval";

/** Capture what the returned sink writes, and to which stream. */
function capture(
  options: { csvOutput: boolean; jsonOutput: boolean },
): { fd: 1 | 2; text: string } {
  const seen: Array<{ fd: 1 | 2; text: string }> = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    seen.push({ fd: 1, text: String(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    seen.push({ fd: 2, text: String(chunk) });
    return true;
  }) as typeof process.stderr.write;
  try {
    evalSeedSink(options)("demo loaded\n");
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  // Exactly one write: a sink that echoed to both streams would otherwise
  // satisfy whichever arm the caller happened to assert.
  expect(seen).toHaveLength(1);
  const only = seen[0];
  if (!only) throw new Error("unreachable — length asserted above");
  return only;
}

describe("evalSeedSink", () => {
  test("routes to fd 2 whenever a machine body owns stdout", () => {
    // Each of the three separately, so dropping either disjunct fails.
    expect(capture({ csvOutput: false, jsonOutput: true }).fd).toBe(2);
    expect(capture({ csvOutput: true, jsonOutput: false }).fd).toBe(2);
    expect(capture({ csvOutput: true, jsonOutput: true }).fd).toBe(2);
  });

  test("routes to fd 1 for the human default", () => {
    // The counterpart arm: without it, "always stderr" passes everything above
    // and silently moves the interactive command's progress line.
    expect(capture({ csvOutput: false, jsonOutput: false }).fd).toBe(1);
  });

  test("passes the text through unchanged", () => {
    // The sink must not add or trim a newline — `seedDemoPostgres` owns that
    // now, and a sink that re-added `console.log`'s implicit `\n` would produce
    // a blank line in every mode.
    expect(capture({ csvOutput: false, jsonOutput: false }).text).toBe(
      "demo loaded\n",
    );
  });
});
