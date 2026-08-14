/**
 * The `SnapshotSqlVerdict` bypass set (#5042).
 *
 * ## WHY THIS FILE EXISTS
 *
 * `warehouse-producer.ts` brands the SQL gate's PASSING verdict so that no object
 * literal can assert *"the product's SELECT-only / single-statement /
 * whitelist-scoped check said yes"*. That closes the hole a plain
 * `{ valid: boolean }` left — but the brand's own docstring then makes a claim the
 * TYPE cannot keep: that grepping for the cast is the whole list of places the gate
 * is bypassed. A cast is greppable; nothing fails when a fifth one appears.
 *
 * ⚠️ **The pattern is not written out in this file's prose, and that is the point
 * rather than fastidiousness.** A lexical guard cannot tell a quotation from an
 * assertion, so a docstring spelling the forbidden cast puts the guard's own file
 * in its own result set — which it did, on the first run. The repo's answer is
 * reword, never exempt: an exemption is a hole shaped exactly like the thing being
 * guarded, and the next real instance gets written inside it. The exact spelling
 * lives in {@link BYPASS_RE} below, where a reader can still see it and the scan
 * cannot trip over it.
 *
 * This is the repo's standing ratchet applied on a shorter cycle than usual: the
 * same principle was swept for twice inside one PR — once when the gate moved out
 * of `defaultRunSnapshot`, and again when the seam that replaced it turned out to
 * be as skippable as the thing it replaced — and prose does not scale to new
 * surface, which is exactly where it kept failing. So the enumeration is asserted
 * as what it is.
 *
 * ## What a new entry means
 *
 * Not automatically a bug. A suite that must bypass the real gate has a legitimate
 * reason — the gate's table check is workspace-whitelist-scoped, and a test schema
 * has no whitelist — which is why three of the four sites are test harnesses. What
 * it must not be is INVISIBLE: a production module minting a passing verdict is a
 * second door onto an unvalidated statement reaching a customer's datasource, and
 * that is the event that has to be argued rather than merged.
 *
 * ## What this does NOT prove
 *
 * The brand is not the only bypass, and saying so here is the honest half. Measured
 * against the repo's own `tsc`: an object literal, `as const`, `satisfies`, a
 * spread of the refusing arm, and even `as SnapshotSqlValidator` are all REFUSED.
 * What still gets through without a hit below is `as unknown as`, and any
 * `any`-typed wiring — `JSON.parse`, an untyped mock, a dynamic `import()`. This
 * file pins the half a grep can hold; the rest is stated in the type's docstring
 * rather than claimed away.
 *
 * A source-text test, and it says so: it proves what the tree CONTAINS, never what
 * runs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// `src/`, from `src/lib/brain/__tests__/`. Resolved off `import.meta.url` rather
// than `process.cwd()`: the isolated runner and a bare `bun test` disagree about
// the working directory, and a cwd-relative root would silently scan nothing under
// one of them.
const SRC_ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * Every site that may assert a passing SQL verdict, with why.
 *
 * ⚠️ ONE production entry, deliberately. It is the single point where the product's
 * gate answering yes becomes a value the run will act on.
 */
const KNOWN_BYPASSES: readonly { file: string; why: string }[] = [
  {
    file: "lib/brain/warehouse-producer.ts",
    why: "the production mint — `defaultValidateSnapshotSql`, wrapping the real `validateSQL`",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer.test.ts",
    why: "the unit harness: no whitelist exists in a test workspace, so the real gate refuses every table",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-pg.test.ts",
    why: "the -pg harness, for the same reason; its subject is the storage layer, not the gate",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-logging.test.ts",
    why: "the logging harness, for the same reason",
  },
];

/**
 * The cast that asserts a pass, however it is spelled.
 *
 * ⚠️ **`[^;=\n]*` between the keyword and the name, not `\s+`, and the difference
 * was measured rather than reasoned.** The first version required them adjacent, so
 * a QUALIFIED reference — the `as` keyword followed by an inline `import(…)` type
 * and only then the name, which is what a file that has not imported the type
 * writes — walked straight past it. A guard that reports an empty set is
 * indistinguishable from one with nothing to find, which is the way this kind of
 * test fails silently. (The spelling is not written out here for the header's
 * reason; the second positive control below constructs it.)
 *
 * The class excludes `;`, `=` and a newline so the match stays inside one type
 * position rather than spanning statements. The regex is also the canonical
 * spelling of the pattern: writing it out in prose would put this file into its own
 * result set, which is why the header describes it instead.
 */
const BYPASS_RE = /\bas\b[^;=\n]*\bSnapshotSqlVerdict\b/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield full;
    }
  }
}

describe("the SnapshotSqlVerdict bypass set (#5042)", () => {
  test("exactly the known sites assert a passing SQL verdict", () => {
    const found: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (BYPASS_RE.test(readFileSync(file, "utf8"))) {
        found.push(file.slice(SRC_ROOT.length));
      }
    }
    expect(
      found.toSorted(),
      "the set of places that can assert the SQL gate passed has changed. A new TEST harness is " +
        "ordinarily fine — the real gate is whitelist-scoped and a test workspace has none — but a new " +
        "PRODUCTION site is a second door onto an unvalidated statement reaching a customer's " +
        "datasource, and it is the thing to argue rather than merge. Add it to KNOWN_BYPASSES with a " +
        "reason, or remove the cast.",
    ).toEqual(KNOWN_BYPASSES.map((b) => b.file).toSorted());
  });

  test("the positive control: the matcher finds a cast it is shown", () => {
    // Without this, an over-narrow regex reports an empty set forever and the test
    // above passes by finding nothing — the shape a guard test fails in silently.
    // ASSEMBLED, never written whole — see the header. A literal here would put this
    // file back in its own result set.
    const planted = `const v = ({ valid: true }) as Snapshot${"SqlVerdict"};`;
    expect(BYPASS_RE.test(planted)).toBe(true);
    // The QUALIFIED spelling, which the first version of this matcher missed — a
    // file that has not imported the type writes it this way.
    const qualified = `const v = x as import("./warehouse-producer").Snapshot${"SqlVerdict"};`;
    expect(BYPASS_RE.test(qualified)).toBe(true);
    // And a negative control, so the matcher is not simply true of everything:
    // naming the TYPE is not asserting a pass.
    expect(BYPASS_RE.test(`let v: Snapshot${"SqlVerdict"};`)).toBe(false);
  });
});
