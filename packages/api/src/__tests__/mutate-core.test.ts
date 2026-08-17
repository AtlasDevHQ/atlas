/**
 * The mutation runner's guardrails (#5060).
 *
 * ## What this file is actually for
 *
 * Not "does the runner produce a table". The load-bearing half is the three
 * ways it must REFUSE to produce one, because a runner that silently measures
 * nothing is strictly worse than measuring by hand: it emits a number under a
 * generated-file header that vouches for it, and the header is exactly what
 * stops a reviewer looking closer.
 *
 * So every guardrail test below is written as a NEGATIVE — the thing that must
 * not happen — with a positive control beside it proving the same shape is
 * accepted once the defect is removed. A refusal test alone is satisfied by a
 * function that refuses everything.
 */

import { describe, expect, test } from "bun:test";
import {
  AnchorError,
  applyMutation,
  baselineProblem,
  cellFlag,
  countOccurrences,
  deflationProblem,
  escapeCell,
  importCandidates,
  importSpecifiers,
  isWholeSuite,
  parseBunSummary,
  render,
  renderCell,
  restoreAll,
  suiteTimeoutMs,
  SUITE_TIMEOUT_FACTOR,
  SUITE_TIMEOUT_FLOOR_MS,
  unmeasuredRows,
  validateSpec,
  WHOLE_SUITE_WARN_RATIO,
  type Cell,
  type FileStore,
} from "../../scripts/mutation-core";
import type { Mutation, MutationSpec } from "../../scripts/mutation-spec";

/** An in-memory {@link FileStore}, so the restore path is provable rather than
 * inspected on disk afterwards. */
function memoryStore(initial: Record<string, string>): FileStore & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    write(path, content) {
      files.set(path, content);
    },
  };
}

const ROOT = "/repo";

function mutation(edits: Mutation["edits"], label = "m"): Mutation {
  return { label, edits };
}

describe("countOccurrences", () => {
  test("counts non-overlapping occurrences and treats the needle literally", () => {
    expect(countOccurrences("a.b.c", ".")).toBe(2);
    // A regex-flavoured needle must match as bytes, not as a pattern — every
    // anchor in a real spec is source code full of `(`, `$`, `.` and `*`.
    expect(countOccurrences("a.b.c", "a.b")).toBe(1);
    expect(countOccurrences("aXbXc", "a.b")).toBe(0);
    expect(countOccurrences("${a} and ${a}", "${a}")).toBe(2);
  });

  test("aaa contains two non-overlapping aa, not three overlapping ones", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
  });

  test("an empty needle counts zero rather than infinity", () => {
    // The alternative — indexOf('') returning 0 forever — is an unbounded loop.
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("applyMutation — the anchor must match exactly once", () => {
  test("POSITIVE CONTROL: a unique anchor is applied", () => {
    const store = memoryStore({ "/repo/a.ts": "const x = 1;\nconst y = 2;\n" });
    const backups = new Map<string, string>();

    applyMutation(mutation([{ file: "a.ts", oldString: "const x = 1;", newString: "const x = 9;" }]), ROOT, store, backups);

    expect(store.files.get("/repo/a.ts")).toBe("const x = 9;\nconst y = 2;\n");
  });

  test("a 0-match anchor throws instead of measuring the unmutated tree", () => {
    const store = memoryStore({ "/repo/a.ts": "const x = 1;\n" });
    const backups = new Map<string, string>();

    // The failure this closes: silently applying nothing, running the suite,
    // and reporting a confident `0` that reads as "the tests do not catch this".
    expect(() =>
      applyMutation(mutation([{ file: "a.ts", oldString: "const gone = 1;", newString: "x" }]), ROOT, store, backups),
    ).toThrow(AnchorError);
    expect(store.files.get("/repo/a.ts")).toBe("const x = 1;\n");
  });

  test("a 2-match anchor throws instead of mutating whichever site came first", () => {
    const store = memoryStore({ "/repo/a.ts": "foo();\nbar();\nfoo();\n" });
    const backups = new Map<string, string>();

    expect(() =>
      applyMutation(mutation([{ file: "a.ts", oldString: "foo();", newString: "baz();" }]), ROOT, store, backups),
    ).toThrow(/matched 2 times/);
    expect(store.files.get("/repo/a.ts")).toBe("foo();\nbar();\nfoo();\n");
  });

  test("AnchorError carries the match count, so the table can say which failure it was", () => {
    // A row rendered `⚠️ ANCHOR: 0 matches` and one rendered `⚠️ ANCHOR: 2
    // matches` need different fixes; collapsing them to "ANCHOR" loses that.
    const store = memoryStore({ "/repo/a.ts": "x\nx\nx\n" });
    try {
      applyMutation(mutation([{ file: "a.ts", oldString: "x", newString: "y" }]), ROOT, store, new Map());
      throw new Error("expected AnchorError");
    } catch (err) {
      expect(err).toBeInstanceOf(AnchorError);
      expect((err as AnchorError).matches).toBe(3);
      expect((err as AnchorError).file).toBe("a.ts");
    }
  });

  test("a second edit's anchor is checked against the first edit's RESULT", () => {
    // Two edits touching one file: if the second were checked against the
    // pre-mutation snapshot it would pass here and then fail to apply.
    const store = memoryStore({ "/repo/a.ts": "alpha\nbeta\n" });
    const backups = new Map<string, string>();

    applyMutation(
      mutation([
        { file: "a.ts", oldString: "alpha", newString: "beta" },
        { file: "a.ts", oldString: "beta\nbeta", newString: "gamma" },
      ]),
      ROOT,
      store,
      backups,
    );

    expect(store.files.get("/repo/a.ts")).toBe("gamma\n");
  });
});

describe("restore", () => {
  test("restores every touched file to its original bytes", () => {
    const store = memoryStore({ "/repo/a.ts": "one\n", "/repo/b.ts": "two\n" });
    const backups = new Map<string, string>();

    applyMutation(
      mutation([
        { file: "a.ts", oldString: "one", newString: "ONE" },
        { file: "b.ts", oldString: "two", newString: "TWO" },
      ]),
      ROOT,
      store,
      backups,
    );
    expect(store.files.get("/repo/a.ts")).toBe("ONE\n");

    restoreAll(store, backups);

    expect(store.files.get("/repo/a.ts")).toBe("one\n");
    expect(store.files.get("/repo/b.ts")).toBe("two\n");
    expect(backups.size).toBe(0);
  });

  test("a mutation that throws PART WAY through is still fully restorable", () => {
    // The real hazard: edit 1 lands, edit 2's anchor is missing, and the file
    // is left mutated. The next suite run then blames the author's own tree.
    const store = memoryStore({ "/repo/a.ts": "one\n", "/repo/b.ts": "two\n" });
    const backups = new Map<string, string>();

    expect(() =>
      applyMutation(
        mutation([
          { file: "a.ts", oldString: "one", newString: "ONE" },
          { file: "b.ts", oldString: "MISSING", newString: "x" },
        ]),
        ROOT,
        store,
        backups,
      ),
    ).toThrow(AnchorError);

    expect(store.files.get("/repo/a.ts")).toBe("ONE\n"); // edit 1 did land
    restoreAll(store, backups);
    expect(store.files.get("/repo/a.ts")).toBe("one\n"); // …and is recoverable
    expect(store.files.get("/repo/b.ts")).toBe("two\n");
  });

  test("restoring twice is a no-op rather than re-writing stale bytes", () => {
    const store = memoryStore({ "/repo/a.ts": "one\n" });
    const backups = new Map<string, string>();
    applyMutation(mutation([{ file: "a.ts", oldString: "one", newString: "ONE" }]), ROOT, store, backups);
    restoreAll(store, backups);

    store.write("/repo/a.ts", "edited by the developer\n");
    restoreAll(store, backups);

    // The second restore must not resurrect the backup over real work — this
    // is the `git checkout --` failure mode reproduced in miniature.
    expect(store.files.get("/repo/a.ts")).toBe("edited by the developer\n");
  });
});

describe("parseBunSummary", () => {
  test("reads the summary block", () => {
    expect(parseBunSummary("\n 58 pass\n 0 fail\n 200 expect() calls\n")).toEqual({ pass: 58, fail: 0, skip: 0, todo: 0, ran: null });
    expect(parseBunSummary("\n 55 pass\n 3 fail\n")).toEqual({ pass: 55, fail: 3, skip: 0, todo: 0, ran: null });
  });

  test("a count EARLIER in the output cannot be mistaken for the summary", () => {
    // The fixture has to contain a decoy the unanchored regex would prefer,
    // or it passes against both spellings and proves nothing. A test whose
    // NAME contains `3 fail` is the decoy: `/(\d+)\s+fail\b/` matches it,
    // `/^\s*(\d+)\s+fail\b/m` does not, because it is mid-line.
    const output = [
      "(fail) mutate > reports 3 fail rows when the anchor is missing",
      "(fail) mutate > folds -0",
      " 56 pass",
      " 2 fail",
    ].join("\n");
    expect(parseBunSummary(output)).toEqual({ pass: 56, fail: 2, skip: 0, todo: 0, ran: null });
  });

  test("a pass count mid-line is likewise not mistaken for the summary", () => {
    const output = ["(fail) mutate > reports 9 pass rows", " 56 pass", " 2 fail"].join("\n");
    expect(parseBunSummary(output)).toEqual({ pass: 56, fail: 2, skip: 0, todo: 0, ran: null });
  });

  test("a suite that never ran reports an ERROR, not `0 fail`", () => {
    // `0 fail` would render as "the tests do not catch this mutation" — the
    // single most misleading cell the table can contain.
    const outcome = parseBunSummary("error: Expected ';' but found 'const'\nSyntaxError\n");
    expect(outcome.error).toBeDefined();
    expect(outcome.error).toContain("error:");
    expect(outcome.fail).toBe(0);
  });

  test("empty output reports an error rather than silently passing", () => {
    expect(parseBunSummary("").error).toBeDefined();
  });

  // ⚠️ The skip count is the signal behind `mutate.ts`'s guardrail 4 (#5077).
  // Without it the runner accepted a self-skipped `-pg` suite as a green
  // baseline and regenerated a whole column as zeros over real numbers.
  test("reads the SKIP count — a skipped test cannot be killed by a mutation", () => {
    // bun's real summary for `identity-consumers-pg.test.ts` with no
    // TEST_DATABASE_URL: the exact shape that caused #5077.
    expect(parseBunSummary("\n 6 pass\n 72 skip\n 0 fail\n 49 expect() calls\n")).toEqual({
      pass: 6,
      fail: 0,
      skip: 72,
      todo: 0,
      ran: null,
    });
  });

  test("⚠️ the deflated baseline is 6 pass, NOT 0 — `pass > 0` would not catch it", () => {
    // The correction to #5077's own diagnosis, and the reason the guard reads
    // `skip` rather than `pass`. That file carries six non-`-pg` tests, so a
    // suite whose 72 real tests all vanished still reports a positive pass count
    // and a zero fail count — indistinguishable from health by every signal the
    // runner had before this.
    const deflated = parseBunSummary("\n 6 pass\n 72 skip\n 0 fail\n");
    expect(deflated.pass).toBeGreaterThan(0);
    expect(deflated.fail).toBe(0);
    // …so the ONLY thing separating it from a healthy run is this:
    expect(deflated.skip).toBeGreaterThan(0);
  });

  test("a healthy run reports skip 0 — an absent line is not an absent verdict", () => {
    // bun omits the skip line entirely when nothing skipped, so it must default
    // rather than fail the parse the way a missing pass/fail line does. Without
    // this the guard would refuse every healthy suite and get reverted within a
    // day.
    expect(parseBunSummary("\n 64 pass\n 0 fail\n").skip).toBe(0);
  });

  test("⚠️ the VERBATIM bun footer is pinned, or `ran` silently reverts to null", () => {
    // `ran: null` is FAIL-OPEN: it disables `deflationProblem`'s accounting arm
    // and is indistinguishable from "we failed to parse `Ran N`". Nothing
    // pinned the footer's wording, so a bun release that reworded it would
    // quietly demote the guard back to bucket-chasing — the exact regression
    // the accounting arm exists to make impossible.
    //
    // ⚠️ CAPTURED VERBATIM from `bun test v1.3.13 (bf2e2cec)` over a two-file
    // tree carrying 2+1 passing tests, one `.skip` and two `.todo`. Do not
    // hand-edit it: re-take it by running such a tree. The four buckets are
    // deliberately all DIFFERENT numbers — with `skip` and `todo` both 1,
    // swapping the two regexes passes this test.
    const footer = [
      "bun test v1.3.13 (bf2e2cec)",
      "",
      " 3 pass",
      " 1 skip",
      " 2 todo",
      " 0 fail",
      " 3 expect() calls",
      "Ran 6 tests across 2 files. [13.00ms]",
    ].join("\n");
    expect(parseBunSummary(footer)).toEqual({ pass: 3, fail: 0, skip: 1, todo: 2, ran: 6 });
    // …and the SINGULAR spelling, which is a different string and the common
    // case: `Ran 59 tests across 1 file.` The `tests?` in the pattern is what
    // covers a one-test file; `file` vs `files` is outside the capture, but a
    // pattern tightened to `files` would break every single-file target.
    expect(parseBunSummary("\n 59 pass\n 0 fail\n\nRan 59 tests across 1 file. [94.00ms]\n").ran).toBe(
      59,
    );
  });

  test("a skip count mid-line is not mistaken for the summary either", () => {
    // The anchoring the pass/fail arms already have, extended to the new one: a
    // test whose NAME contains `12 skip` must not become the summary.
    const output = ["(fail) mutate > reports 12 skip rows", " 56 pass", " 3 skip", " 2 fail"].join(
      "\n",
    );
    expect(parseBunSummary(output)).toEqual({ pass: 56, fail: 2, skip: 3, todo: 0, ran: null });
  });
});

describe("⚠️ baselineProblem — every way a baseline can lie (#5077)", () => {
  const ok = { pass: 64, fail: 0, skip: 0, todo: 0, ran: 64 };

  test("POSITIVE CONTROL: a clean baseline has no problem", () => {
    // A refusal test alone is satisfied by a function that refuses everything.
    expect(baselineProblem(ok)).toBeNull();
    // …and a suite with no `Ran N` line at all is still acceptable: the
    // accounting arm is a cross-check, not a requirement.
    expect(baselineProblem({ ...ok, ran: null })).toBeNull();
  });

  test("RED — the inflation case, which was the only one guarded before", () => {
    expect(baselineProblem({ ...ok, fail: 3, ran: 67 })).toMatchObject({ kind: "red" });
  });

  test("⚠️ a -pg suite with NO non-pg tests is DEFLATED, not EMPTY", () => {
    // The falsifier that was missing, and the reason the defect survived: the
    // EMPTY test below uses `ran: 0`, the single input where arm order cannot
    // matter. THREE OF FIVE `-pg` targets look like this with Postgres down —
    // `cardinality-pg` reports 0 pass / 29 skip — and while `pass === 0` was
    // checked first they were told to "check the target's path" instead of to
    // start Postgres. Only the deflation kinds carry that hint.
    expect(baselineProblem({ pass: 0, fail: 0, skip: 29, todo: 0, ran: 29 })?.kind).toBe("deflated");
    // …and a suite claiming zero pass while `Ran N` proves 78 were discovered
    // is UNACCOUNTED: the message must not say "ran ZERO tests" over data that
    // contradicts it.
    expect(baselineProblem({ pass: 0, fail: 0, skip: 0, todo: 0, ran: 78 })?.kind).toBe("unaccounted");
  });

  test("EMPTY — zero tests is not a baseline", () => {
    // Reachable by renaming or emptying a target file, or by a rotted
    // `target.file` path. Every cell would then render an honest-looking 0
    // meaning "the suite does not catch this".
    expect(baselineProblem({ ...ok, pass: 0, ran: 0 })).toMatchObject({ kind: "empty" });
  });

  test("SKIPPED — #5077's own case", () => {
    const problem = baselineProblem({ pass: 6, fail: 0, skip: 72, todo: 0, ran: 78 });
    expect(problem?.kind).toBe("deflated");
    expect(problem?.message).toContain("SKIPPED 72");
  });

  test("⚠️ TODO — bun does not fold it into skip, and the first cut missed it", () => {
    // A `test.todo` does not run even WITH a body, so it deflates the
    // denominator exactly like a `.skip`. Measured: a 2-test file with one
    // todo published as 1 test, every cell deflated, guard silent — while the
    // guard's own comment claimed `.todo` was covered.
    const problem = baselineProblem({ pass: 1, fail: 0, skip: 0, todo: 1, ran: 2 });
    expect(problem?.kind).toBe("deflated");
    expect(problem?.message).toContain("TODO");
  });

  test("UNACCOUNTED — a bucket bun invents tomorrow is caught without naming it", () => {
    // The general form, and the reason the guard cross-checks the SUM against
    // `Ran N` rather than enumerating buckets. `filtered out` is a fourth one
    // that already exists; this arm closes it and every future sibling.
    const problem = baselineProblem({ pass: 5, fail: 0, skip: 0, todo: 0, ran: 9 });
    expect(problem?.kind).toBe("unaccounted");
    expect(problem?.message).toContain("4 unclassified");
  });

  test("⚠️ RED and DEFLATED are different KINDS, so only one gets the -pg hint", () => {
    // The caller prints "find the .skip/.todo in the target" for a deflated
    // baseline. Appended to a RED one it sends an operator hunting a skip that
    // does not exist — measured when a dead Postgres made two suites RED and
    // the runner blamed a skip. The kind is what keeps the two apart.
    expect(baselineProblem({ pass: 0, fail: 2, skip: 0, todo: 0, ran: 2 })?.kind).toBe("red");
    expect(baselineProblem({ pass: 1, fail: 0, skip: 1, todo: 0, ran: 2 })?.kind).toBe("deflated");
    // …and an unreadable suite is neither.
    expect(baselineProblem({ pass: 0, fail: 0, skip: 0, todo: 0, ran: null, error: "boom" })?.kind).toBe(
      "errored",
    );
  });

  test("the accounting arm fires BEFORE the skip arm, so the message names the real gap", () => {
    // Both are true here. The unaccounted one is the more general statement and
    // must win, or an operator reads "SKIPPED 1" and misses the other three.
    expect(baselineProblem({ pass: 1, fail: 0, skip: 1, todo: 0, ran: 5 })?.kind).toBe("unaccounted");
  });
});

describe("⚠️ deflationProblem — the ONE copy both the baseline and the mutation read (#5097)", () => {
  test("POSITIVE CONTROL: a fully accounted run has no problem", () => {
    expect(deflationProblem({ pass: 64, fail: 0, skip: 0, todo: 0, ran: 64 })).toBeNull();
    // …and a run with no `Ran N` line is still acceptable: the accounting arm is
    // a cross-check, not a requirement.
    expect(deflationProblem({ pass: 64, fail: 0, skip: 0, todo: 0, ran: null })).toBeNull();
  });

  test("⚠️ a FAILING run is not deflated — under a mutation, failing is the point", () => {
    // The reason RED lives in `baselineProblem` and not here. `deflationProblem`
    // is asked about mutated runs too, where a high fail count is the
    // measurement; refusing it would refuse every strong result in the repo.
    expect(deflationProblem({ pass: 2, fail: 61, skip: 0, todo: 0, ran: 63 })).toBeNull();
    // A whole-suite kill reports `0 pass`, which is EMPTY for a baseline and
    // legitimate for a mutation — likewise not this function's business.
    expect(deflationProblem({ pass: 0, fail: 63, skip: 0, todo: 0, ran: 63 })).toBeNull();
  });

  test("the message and the CELL describe the same arm", () => {
    // Both strings come from here rather than being assembled by the two
    // callers, so a cell can never name a different arm from the prose beside
    // it. The two must be different TEXT — the cell is one table cell wide —
    // while agreeing on the arm.
    const skipped = deflationProblem({ pass: 1, fail: 0, skip: 2, todo: 0, ran: 3 });
    expect(skipped?.kind).toBe("deflated");
    expect(skipped?.message).toContain("SKIPPED 2 of 3 tests");
    expect(skipped?.cell).toBe("SKIPPED 2 — count would be deflated");
    expect(skipped?.cell).not.toBe(skipped?.message);

    const unaccounted = deflationProblem({ pass: 5, fail: 0, skip: 0, todo: 0, ran: 9 });
    expect(unaccounted?.kind).toBe("unaccounted");
    expect(unaccounted?.message).toContain("4 unclassified");
    expect(unaccounted?.cell).toBe("4 UNACCOUNTED — count would be deflated");
  });

  test("⚠️ baselineProblem DELEGATES here rather than carrying a second copy", () => {
    // The falsifier for the sharing itself: two independent copies of these arms
    // are one edit away from disagreeing, and #5077's mutated-run detection was
    // exactly such a copy. If `baselineProblem` grows its own arms again, these
    // messages diverge and this test goes red.
    for (const outcome of [
      { pass: 1, fail: 0, skip: 2, todo: 0, ran: 3 },
      { pass: 1, fail: 0, skip: 0, todo: 3, ran: 4 },
      { pass: 5, fail: 0, skip: 0, todo: 0, ran: 9 },
    ]) {
      const shared = deflationProblem(outcome);
      expect(shared).not.toBeNull();
      expect(baselineProblem(outcome)).toEqual(shared);
    }
  });
});

describe("⚠️ unmeasuredRows — ONE refusal for the whole measured-nothing class (#5097)", () => {
  const count = (fail: number): Cell => ({ kind: "count", fail });
  const wholeSuite = (fail: number): Cell => ({ kind: "count", fail, wholeSuite: true });
  const anchor = (): Cell => ({ kind: "unmeasured", reason: "ANCHOR: 0 matches" });
  const deflated = (): Cell => ({ kind: "unmeasured", reason: "SKIPPED 2 — count would be deflated" });
  const timeout = (): Cell => ({ kind: "error", flag: "timed out after 30s" });

  test("POSITIVE CONTROL: a table of real counts reports nothing", () => {
    expect(unmeasuredRows(new Map([["m1", new Map([["t", count(3)]])]]))).toEqual([]);
  });

  test("names the mutation AND why it measured nothing", () => {
    const rows = new Map([
      ["healthy", new Map([["t", count(3)]])],
      ["rotted", new Map([["t", anchor()]])],
    ]);
    expect(unmeasuredRows(rows)).toEqual([{ label: "rotted", reason: "ANCHOR: 0 matches" }]);
  });

  test("⚠️ THE CLASS, not the instance: a dead anchor and a deflated run come back TOGETHER", () => {
    // #5077 refused exactly one member of this class with an `anchorFailed`
    // boolean, and FLAGGED the other — so a mutated run that skipped tests
    // rendered a deflated count as an honest number and `--check` blessed it
    // forever. The whole point of keying on the discriminant is that a second
    // cause needs no second refusal.
    //
    // The two reasons are deliberately DIFFERENT strings: with one shared
    // reason, an implementation that only ever reported the anchor case would
    // satisfy this assertion.
    const rows = new Map([
      ["rotted", new Map([["t", anchor()]])],
      ["skipped", new Map([["t", deflated()]])],
    ]);
    expect(unmeasuredRows(rows)).toEqual([
      { label: "rotted", reason: "ANCHOR: 0 matches" },
      { label: "skipped", reason: "SKIPPED 2 — count would be deflated" },
    ]);
  });

  test("⚠️ a TIMEOUT is not unmeasured — that is a real measurement of a real hang", () => {
    // The one carve-out, and the reason the discriminant is a `kind` rather
    // than prose: a hang is a genuine result about a genuine mutation, and
    // `mutation-core.md` publishes exactly such a cell for the empty-needle
    // row. A substring match over the flag text could not draw this line.
    expect(unmeasuredRows(new Map([["slow", new Map([["t", timeout()]])]]))).toEqual([]);
  });

  test("a whole-suite count is a caveat on a real number, not an absence of one", () => {
    expect(unmeasuredRows(new Map([["broad", new Map([["t", wholeSuite(29)]])]]))).toEqual([]);
  });

  test("reports each mutation once even when several targets measured nothing", () => {
    const rows = new Map([["rotted", new Map([["a", anchor()], ["b", anchor()]])]]);
    expect(unmeasuredRows(rows)).toEqual([{ label: "rotted", reason: "ANCHOR: 0 matches" }]);
  });

  test("⚠️ a no-count cell carries NO `fail`, so a phantom `0` is unrepresentable", () => {
    // #5077's shape was one interface with `fail: number` always present, so
    // every error cell carried a `fail: 0` that only `renderCell`'s early
    // return kept out of the table — a renderer edit away from publishing "the
    // suite does not catch this" over a mutation that never ran. `render`'s own
    // test asserts that leak cannot happen; the union is why it cannot.
    //
    // Behaviourally: neither no-count variant renders as anything a reader
    // could mistake for a measurement, and the reason travels WITH the state.
    expect(renderCell(anchor())).toBe("⚠️ ANCHOR: 0 matches");
    expect(renderCell(deflated())).toBe("⚠️ SKIPPED 2 — count would be deflated");
    expect(renderCell(timeout())).toBe("⚠️ timed out after 30s");
    for (const cell of [anchor(), deflated(), timeout()]) {
      expect(renderCell(cell)).not.toMatch(/^\d/);
      // …and the flag a reader meets in the `## ⚠️ Flagged` section is DERIVED
      // from the same variant rather than stored beside it, so the two cannot
      // disagree about what happened.
      expect(cellFlag(cell)).toBeDefined();
    }
    // A real count, by contrast, has no flag at all unless the ratio tripped.
    expect(cellFlag(count(3))).toBeUndefined();
    expect(cellFlag(wholeSuite(29))).toBe("whole-suite");
  });
});

describe("⚠️ importSpecifiers / importCandidates — the corpus files `--files` used to miss (#5097)", () => {
  test("finds a MULTI-LINE import, which is the common shape in this repo", () => {
    // A statement-shaped regex (`import[^;\n]*from`) matches none of these, and
    // that is how every `__tests__/*-corpus.ts` stayed invisible to `--files`.
    const source = [
      'import { describe, expect, test } from "bun:test";',
      "import {",
      "  AGREEMENT_CORPUS,",
      "  SAME_CLAIM,",
      '} from "./__tests__/identity-corpus";',
      'import type { Fact } from "@atlas/api/lib/brain/types";',
      'export { helper } from "../shared/helper";',
      'import "./side-effect";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([
      "bun:test",
      "./__tests__/identity-corpus",
      "@atlas/api/lib/brain/types",
      "../shared/helper",
      "./side-effect",
    ]);
  });

  test("a relative specifier resolves against the IMPORTING file's directory", () => {
    const candidates = importCandidates(
      "src/lib/brain/__tests__/object-cmp.test.ts",
      "./object-cmp-corpus",
    );
    expect(candidates).toContain("src/lib/brain/__tests__/object-cmp-corpus.ts");
    // `/index.ts` is tried too, and AFTER the bare file — a directory named
    // like the module must not shadow a sibling `.ts`.
    expect(candidates.indexOf("src/lib/brain/__tests__/object-cmp-corpus.ts")).toBeLessThan(
      candidates.indexOf("src/lib/brain/__tests__/object-cmp-corpus/index.ts"),
    );
  });

  test("⚠️ a specifier can leave packages/api entirely, and must normalise", () => {
    // `bundle-identity` mutates `../types/src/migration.ts`, so its seeds sit
    // outside the package. Naive prefixing produced
    // `packages/api/../types/src/…`, which git never emits — the same defect
    // `check-mutation-tables.sh` normalises for one layer up.
    expect(importCandidates("../types/src/migration.ts", "./conversation")).toContain(
      "../types/src/conversation.ts",
    );
    // …and from inside `src/`, four levels up lands on the sibling package —
    // one fewer and it would resolve INSIDE packages/api, which is the silent
    // half of this bug: a path that exists nowhere selects nothing.
    expect(
      importCandidates("src/lib/brain/identity.ts", "../../../../types/src/conversation"),
    ).toContain("../types/src/conversation.ts");
  });

  test("the package's own `@atlas/api/*` alias maps to `src/*`", () => {
    expect(importCandidates("src/lib/x.ts", "@atlas/api/lib/brain/types")).toContain(
      "src/lib/brain/types.ts",
    );
  });

  test("⚠️ a bare package specifier is NOT followed — the cost bound", () => {
    // Not timidity: following `@atlas/mcp` or `pg` by package name reaches half
    // the monorepo from any target, and the sweep this selector feeds costs
    // minutes per spec. Selecting every spec on every PR is how the gate gets
    // disabled, and a disabled gate catches nothing.
    expect(importCandidates("src/lib/x.ts", "bun:test")).toEqual([]);
    expect(importCandidates("src/lib/x.ts", "@atlas/mcp")).toEqual([]);
    expect(importCandidates("src/lib/x.ts", "node:fs")).toEqual([]);
  });

  test("a `.js` specifier is TypeScript's NodeNext spelling for a `.ts` file", () => {
    expect(importCandidates("src/lib/x.ts", "./sibling.js")).toContain("src/lib/sibling.ts");
  });
});

describe("isWholeSuite — the `could not determine data type` trap", () => {
  test("flags a count that takes the whole suite", () => {
    // The measured instance: an untyped param substitution made Postgres refuse
    // every statement, and an honest count of 1 was recorded as 51.
    expect(isWholeSuite(51, 51)).toBe(true);
  });

  test("flags a near-total, not just an exact total", () => {
    // A setup break that spares one trivially-green test is the same defect.
    expect(isWholeSuite(50, 51)).toBe(true);
  });

  test("does not flag a strong but honest count", () => {
    expect(isWholeSuite(22, 58)).toBe(false);
    expect(isWholeSuite(0, 58)).toBe(false);
  });

  test("does not flag when the suite size is unknown", () => {
    // total 0 means the baseline never reported — flagging there would be a
    // guess dressed as a measurement.
    expect(isWholeSuite(5, 0)).toBe(false);
  });

  test("the ratio is below 1, or the near-total case above cannot fire", () => {
    expect(WHOLE_SUITE_WARN_RATIO).toBeLessThan(1);
  });
});

describe("suiteTimeoutMs — a mutation can HANG the suite rather than fail it", () => {
  test("scales off the baseline so a slow -pg suite is not called hung", () => {
    // A `-pg` suite legitimately takes orders of magnitude longer than a
    // pure-TS one; one fixed constant cannot serve both.
    expect(suiteTimeoutMs(60_000)).toBe(600_000);
  });

  test("floors a fast suite, so a scheduling hiccup does not read as a hang", () => {
    // object-cmp.test.ts runs in ~120ms; 10x that is 1.2s.
    expect(suiteTimeoutMs(120)).toBe(SUITE_TIMEOUT_FLOOR_MS);
  });

  test("the factor is greater than 1, or every clean run would time out", () => {
    expect(SUITE_TIMEOUT_FACTOR).toBeGreaterThan(1);
  });

  test("a zero-duration baseline still yields a usable bound", () => {
    expect(suiteTimeoutMs(0)).toBe(SUITE_TIMEOUT_FLOOR_MS);
  });
});

describe("validateSpec", () => {
  function spec(overrides: Partial<MutationSpec>): MutationSpec {
    return {
      title: "t",
      out: "out.md",
      targets: [{ name: "here", file: "a.test.ts" }],
      mutations: [mutation([{ file: "a.ts", oldString: "x", newString: "y" }])],
      ...overrides,
    };
  }

  test("POSITIVE CONTROL: a well-formed spec has no problems", () => {
    expect(validateSpec(spec({}))).toEqual([]);
  });

  test("rejects an empty oldString, which would match everywhere", () => {
    const problems = validateSpec(
      spec({ mutations: [mutation([{ file: "a.ts", oldString: "", newString: "y" }])] }),
    );
    expect(problems.join()).toContain("empty oldString");
  });

  test("rejects a no-op edit, which measures the baseline under a label claiming otherwise", () => {
    const problems = validateSpec(
      spec({ mutations: [mutation([{ file: "a.ts", oldString: "x", newString: "x" }])] }),
    );
    expect(problems.join()).toContain("no-op");
  });

  test("rejects duplicate labels, which make the table ambiguous about what was measured", () => {
    const problems = validateSpec(
      spec({
        mutations: [
          mutation([{ file: "a.ts", oldString: "x", newString: "y" }], "same"),
          mutation([{ file: "a.ts", oldString: "p", newString: "q" }], "same"),
        ],
      }),
    );
    expect(problems.join()).toContain("duplicate mutation label");
  });

  test("rejects duplicate target names, which would collide in the cell map", () => {
    const problems = validateSpec(
      spec({
        targets: [
          { name: "here", file: "a.test.ts" },
          { name: "here", file: "b.test.ts" },
        ],
      }),
    );
    expect(problems.join()).toContain("duplicate target name");
  });

  test("rejects an empty spec on both axes", () => {
    expect(validateSpec(spec({ targets: [] })).join()).toContain("no targets");
    expect(validateSpec(spec({ mutations: [] })).join()).toContain("no mutations");
  });

  test("reports EVERY problem, so one run fixes the spec", () => {
    const problems = validateSpec(
      spec({
        targets: [],
        mutations: [mutation([{ file: "a.ts", oldString: "", newString: "" }])],
      }),
    );
    expect(problems.length).toBeGreaterThan(2);
  });
});

describe("render", () => {
  const spec: MutationSpec = {
    title: "T",
    out: "out.md",
    targets: [
      { name: "here", file: "a.test.ts" },
      { name: "corpus", file: "b.test.ts" },
    ],
    mutations: [
      { label: "guard deleted", edits: [{ file: "s.ts", oldString: "a", newString: "b" }] },
      { label: "guard narrowed", edits: [{ file: "s.ts", oldString: "c", newString: "d" }], note: "honest zero" },
    ],
  };
  const baselines = new Map([
    ["here", 10],
    ["corpus", 20],
  ]);

  function rowsOf(cells: Record<string, Record<string, Cell>>): Map<string, Map<string, Cell>> {
    return new Map(Object.entries(cells).map(([k, v]) => [k, new Map(Object.entries(v))]));
  }

  test("renders one column per target and one row per mutation", () => {
    const out = render(
      spec,
      spec.targets,
      spec.mutations,
      baselines,
      rowsOf({
        "guard deleted": { here: { kind: "count", fail: 3 }, corpus: { kind: "count", fail: 5 } },
        "guard narrowed": { here: { kind: "count", fail: 0 }, corpus: { kind: "count", fail: 2 } },
      }),
      "spec.ts",
    );

    expect(out).toContain("| Mutation | here | corpus |");
    expect(out).toContain("| guard deleted | 3 | 5 |");
    expect(out).toContain("| guard narrowed | 0 | 2 |");
    expect(out).toContain("- **guard narrowed** — honest zero");
  });

  test("output is deterministic, so `--check` can be a CI gate", () => {
    // A timestamp or SHA here would make every regeneration diff, and a diff
    // that always appears is a diff nobody reads.
    const rows = rowsOf({
      "guard deleted": { here: { kind: "count", fail: 3 }, corpus: { kind: "count", fail: 5 } },
      "guard narrowed": { here: { kind: "count", fail: 0 }, corpus: { kind: "count", fail: 2 } },
    });
    const first = render(spec, spec.targets, spec.mutations, baselines, rows, "spec.ts");
    const second = render(spec, spec.targets, spec.mutations, baselines, rows, "spec.ts");
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("carries the DO-NOT-EDIT header and the regenerate command", () => {
    const out = render(spec, spec.targets, spec.mutations, baselines, rowsOf({}), "scripts/mutations/x.ts");
    expect(out).toContain("DO NOT EDIT BY HAND");
    expect(out).toContain("bun run scripts/mutate.ts scripts/mutations/x.ts");
  });

  test("an errored cell renders as a warning, never as a number", () => {
    const out = render(
      spec,
      spec.targets,
      spec.mutations,
      baselines,
      rowsOf({
        "guard deleted": {
          here: { kind: "unmeasured", reason: "ANCHOR: 0 matches" },
          corpus: { kind: "count", fail: 5 },
        },
      }),
      "spec.ts",
    );

    expect(out).toContain("⚠️ ANCHOR: 0 matches");
    // A no-count cell must never leak into the table as a `0` reading "the
    // suite does not catch this". Under the union it CANNOT carry a `fail` at
    // all, so this is now a regression test on the renderer rather than on a
    // field that has to be remembered.
    expect(out).not.toContain("| guard deleted | 0 |");
    expect(out).toContain("## ⚠️ Flagged");
  });

  test("a TIMEOUT cell is committable and lands in the Flagged section", () => {
    // The one no-count cell that is a real measurement — `mutation-core.md`
    // publishes exactly this for the empty-needle row.
    const out = render(
      spec,
      spec.targets,
      spec.mutations,
      baselines,
      rowsOf({ "guard deleted": { here: { kind: "error", flag: "timed out after 30s" } } }),
      "spec.ts",
    );
    expect(out).toContain("⚠️ timed out after 30s");
    expect(out).toContain("- **guard deleted** — here: timed out after 30s");
  });

  test("a whole-suite count is marked in the table, not just on the console", () => {
    const out = render(
      spec,
      spec.targets,
      spec.mutations,
      baselines,
      rowsOf({ "guard deleted": { here: { kind: "count", fail: 10, wholeSuite: true } } }),
      "spec.ts",
    );
    expect(out).toContain("10 ⚠️");
    expect(out).toContain("whole-suite");
  });

  test("an unmeasured cell renders as a dash rather than defaulting to zero", () => {
    const out = render(spec, spec.targets, spec.mutations, baselines, rowsOf({}), "spec.ts");
    expect(out).toContain("| guard deleted | — | — |");
  });

  test("suite sizes are published beside the table", () => {
    // Without the denominator a reader cannot tell 3-of-5 from 3-of-500.
    const out = render(spec, spec.targets, spec.mutations, baselines, rowsOf({}), "spec.ts");
    expect(out).toContain("**here** 10 tests");
    expect(out).toContain("**corpus** 20 tests");
  });
});

describe("cell and label escaping", () => {
  test("a pipe in a label cannot split its row into extra cells", () => {
    expect(escapeCell("a | b")).toBe("a \\| b");
  });

  test("a backslash cannot smuggle a live delimiter past the pipe escape", () => {
    // `a\|b` is the one input the pipe escape exists for that it used to get
    // WRONG: escaping `|` alone yields `a\\|b`, which reads as a literal
    // backslash followed by a live cell delimiter. So the fixture has to carry
    // a backslash immediately before the pipe — `a | b` is satisfied by an
    // implementation that never touches backslashes at all.
    expect(escapeCell("a\\|b")).toBe("a\\\\\\|b");

    // The single pass exists so there is no ordering to get wrong, and this
    // pins the failure it rules out: two sequential replaces in the wrong
    // order re-escape the backslash the pipe escape just wrote, yielding four
    // backslashes and a live `|`. Kept as a negative because the two-pass
    // shape is the one a future edit is most likely to reach for.
    expect(escapeCell("a\\|b")).not.toBe("a\\\\\\\\|b");

    // ...and the converse, which is why the pattern requires a pipe at all: a
    // backslash that splits nothing is left alone. `MONEY_RE back to `\s+``
    // is a real label in object-cmp.mutations.ts, and its backslash sits in a
    // code span, where markdown escapes do not apply — doubling it would put a
    // literal `\\s+` in front of the reader to fix a row that was never at
    // risk. This assertion is what pins the fix to the structural case.
    expect(escapeCell("`\\s+`")).toBe("`\\s+`");
  });

  test("renderCell distinguishes a real zero from a cell that measured nothing", () => {
    expect(renderCell({ kind: "count", fail: 0 })).toBe("0");
    expect(renderCell({ kind: "error", flag: "boom" })).toBe("⚠️ boom");
    expect(renderCell({ kind: "unmeasured", reason: "boom" })).toBe("⚠️ boom");
  });
});
