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
  anchorFailures,
  applyMutation,
  baselineProblem,
  countOccurrences,
  escapeCell,
  isWholeSuite,
  parseBunSummary,
  render,
  renderCell,
  restoreAll,
  suiteTimeoutMs,
  SUITE_TIMEOUT_FACTOR,
  SUITE_TIMEOUT_FLOOR_MS,
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

describe("⚠️ anchorFailures — a dead anchor must never become a committed byte", () => {
  const count = (fail: number): Cell => ({ kind: "count", fail });
  const anchor = (): Cell => ({ kind: "error", fail: 0, flag: "ANCHOR: 0 matches", anchorFailed: true });
  const timeout = (): Cell => ({ kind: "error", fail: 0, flag: "timed out after 30s" });

  test("POSITIVE CONTROL: a table of real counts reports nothing", () => {
    expect(anchorFailures(new Map([["m1", new Map([["t", count(3)]])]]))).toEqual([]);
  });

  test("names the mutation whose anchor rotted", () => {
    const rows = new Map([
      ["healthy", new Map([["t", count(3)]])],
      ["rotted", new Map([["t", anchor()]])],
    ]);
    expect(anchorFailures(rows)).toEqual(["rotted"]);
  });

  test("⚠️ a TIMEOUT is not an anchor failure — that is a real measurement", () => {
    // The distinction a substring match on the flag could not draw, and the
    // reason `anchorFailed` is its own field rather than prose. A hang is a
    // genuine result about a genuine mutation; a dead anchor measured nothing.
    expect(anchorFailures(new Map([["slow", new Map([["t", timeout()]])]]))).toEqual([]);
  });

  test("reports each mutation once even when several targets rotted", () => {
    const rows = new Map([["rotted", new Map([["a", anchor()], ["b", anchor()]])]]);
    expect(anchorFailures(rows)).toEqual(["rotted"]);
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
          here: { kind: "error", fail: 0, flag: "ANCHOR: 0 matches" },
          corpus: { kind: "count", fail: 5 },
        },
      }),
      "spec.ts",
    );

    expect(out).toContain("⚠️ ANCHOR: 0 matches");
    // The `fail: 0` on an error cell must not leak into the table as a `0`.
    expect(out).not.toContain("| guard deleted | 0 |");
    expect(out).toContain("## ⚠️ Flagged");
  });

  test("a whole-suite count is marked in the table, not just on the console", () => {
    const out = render(
      spec,
      spec.targets,
      spec.mutations,
      baselines,
      rowsOf({ "guard deleted": { here: { kind: "count", fail: 10, flag: "whole-suite" } } }),
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

  test("renderCell distinguishes a real zero from an error", () => {
    expect(renderCell({ kind: "count", fail: 0 })).toBe("0");
    expect(renderCell({ kind: "error", fail: 0, flag: "boom" })).toBe("⚠️ boom");
  });
});
