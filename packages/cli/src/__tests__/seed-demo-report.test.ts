/**
 * `seedDemoPostgres` reports through its injected sink and never touches fd 1
 * directly (#5126).
 *
 * ⚠️ THIS IS THE HALF THE SPAWN TESTS STRUCTURALLY CANNOT REACH, and its
 * absence is what let the original fix ship broken. `canonical-eval` calls
 * `seedDemoPostgres` unconditionally, before any mode branch, and it used to
 * end with `console.log(DEMO_DATASET.label)` — fd 1, ahead of the `--json`
 * payload, inside the `| tee eval-mcp-llm-output.json` the workflow uploads. It
 * was the THIRD writer on that fd and the only one outside the eval driver.
 *
 * Every spawn in `bin/__tests__/eval-json-stdout.test.ts` runs with
 * `ATLAS_TEST_STUB_SEED=1`, so the preload replaces this exact function. That
 * stub now REPORTS through the sink, which makes those tests a real assertion
 * about the CALL SITE — does `runInstalledCanonicalEval` hand over the resolved
 * human writer? — but it can say nothing about the function itself. This file
 * is the other half: the real body, with `pg` mocked, asserting the label goes
 * to the sink and that nothing at all reaches fd 1 while it runs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const queries: string[] = [];
let ended = 0;
let queryError: Error | null = null;

// Mocked before importing the module under test, so `init.ts`'s
// `import { Pool } from "pg"` binds to this. Only `Pool` is used by
// `seedDemoPostgres`; the CLI's other pg consumers are not in this graph.
void mock.module("pg", () => ({
  Pool: class MockPool {
    async query(sql: string) {
      queries.push(sql);
      if (queryError) throw queryError;
      return { rows: [] };
    }
    async end() {
      ended += 1;
    }
  },
}));

const { seedDemoPostgres, DEMO_DATASET } = await import("../commands/init");

/** Every `console` method that reaches fd 1. `error`/`warn` are fd 2 and fine. */
const STDOUT_CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "table",
  "trace",
] as const;

/**
 * ⚠️ `process.stdout.write` IS SPIED TOO, AND ITS ABSENCE WAS A REAL DEFECT IN
 * THIS FILE. The first cut spied only `console` methods — which is exactly the
 * "covered the writers I happened to look at" mistake this whole issue is
 * about, reproduced inside the test written to catch it. `init.ts`'s own house
 * spelling for this very call is `(text) => process.stdout.write(text)`, so the
 * uncovered spelling was the one most likely to appear.
 *
 * Two spellings this still cannot see — `Bun.stdout` and `fs.writeSync(1, …)` —
 * are covered lexically by the function-scoped arm in
 * `bin/__tests__/eval-json-stdout.test.ts`. Neither check subsumes the other:
 * this one follows delegation into a helper, that one covers every spelling.
 */
let restoreWriters: Array<() => void> = [];
const stdoutCalls: string[] = [];

beforeEach(() => {
  queries.length = 0;
  stdoutCalls.length = 0;
  ended = 0;
  queryError = null;
  // Recorded with the writer's NAME, not into one anonymous sink, so a failure
  // says which route leaked rather than only that something did.
  restoreWriters = STDOUT_CONSOLE_METHODS.map((name) => {
    const original = console[name];
    console[name] = ((...args: unknown[]) => {
      stdoutCalls.push(`console.${name}: ${args.map(String).join(" ")}`);
    }) as typeof original;
    return () => {
      console[name] = original;
    };
  });
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdoutCalls.push(`process.stdout.write: ${String(chunk)}`);
    void rest;
    return true;
  }) as typeof process.stdout.write;
  restoreWriters.push(() => {
    process.stdout.write = originalWrite;
  });
});

afterEach(() => {
  // Restored in reverse, so `process.stdout.write` is back before anything the
  // console restores might print — a swallowed stdout would otherwise hide a
  // later test's output.
  for (const restore of restoreWriters.reverse()) restore();
  restoreWriters = [];
});

describe("seedDemoPostgres reporting", () => {
  test("the label goes to the injected sink, and nothing reaches fd 1", async () => {
    const reported: string[] = [];
    await seedDemoPostgres("postgres://unused/db", (text) => reported.push(text));

    // The exact label plus the trailing newline the sink now owns — asserting
    // "something was reported" would pass for a sink handed the empty string.
    expect(reported).toEqual([`${DEMO_DATASET.label}\n`]);
    // The falsifier for the defect itself, and it covers a write ALONGSIDE the
    // sink as well as one replacing it — `reported` alone would pass for a body
    // that reported correctly and ALSO logged, which is the historical shape.
    expect(stdoutCalls).toEqual([]);
    // Anchors the run to the success path: on the throw path below the report
    // is correctly skipped, so a test that never queried would pass vacuously.
    expect(queries).toHaveLength(1);
    expect(ended).toBe(1);
  });

  test("a failed seed reports nothing and still closes the pool", async () => {
    // The counterpart arm. Without it, a body that reported unconditionally —
    // claiming the demo loaded when the query threw — satisfies the test above.
    queryError = new Error("relation already exists");
    const reported: string[] = [];

    await expect(
      seedDemoPostgres("postgres://unused/db", (text) => reported.push(text)),
    ).rejects.toThrow("Failed to seed demo data into Postgres");

    expect(reported).toEqual([]);
    expect(stdoutCalls).toEqual([]);
    expect(ended).toBe(1);
  });
});
