/**
 * The mutation runner's logic, minus the process.
 *
 * Split out on `signal-retry.ts`'s precedent so the three guardrails can be
 * unit-tested without spawning a suite or writing to the working tree. The
 * guardrails are the whole value of the tool — a runner that silently measures
 * nothing is strictly worse than measuring by hand, because it produces a
 * number with a generated-file header vouching for it.
 *
 * File access goes through {@link FileStore} for the same reason: the restore
 * path is the one that can destroy a developer's uncommitted work, and it must
 * be provable against an in-memory store rather than by inspecting a tree
 * afterwards.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import type { Mutation, MutationSpec, MutationTarget } from "./mutation-spec";

/**
 * A mutation whose fail count reaches this fraction of the suite is flagged.
 * Below 1 deliberately — a setup break that spares one trivially-green test is
 * the same defect, and an exact-equality test would let it through.
 */
export const WHOLE_SUITE_WARN_RATIO = 0.9;

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

export interface FileStore {
  read(path: string): string;
  write(path: string, content: string): void;
}

export const diskStore: FileStore = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, content) => writeFileSync(path, content),
};

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** Non-overlapping occurrences. A plain scan — `oldString` is code, not a regex. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export class AnchorError extends Error {
  constructor(
    readonly file: string,
    readonly matches: number,
  ) {
    super(
      matches === 0
        ? `anchor not found in ${file} — the source moved out from under the spec`
        : `anchor matched ${matches} times in ${file} — extend it until it is unique`,
    );
    this.name = "AnchorError";
  }
}

/**
 * Apply one mutation, recording originals into `backups` first.
 *
 * Every touched file is snapshotted BEFORE any write, so an
 * {@link AnchorError} thrown by the second edit still leaves the first
 * restorable. Each edit re-reads rather than reusing its snapshot, because two
 * edits may touch one file and the second's anchor has to be checked against
 * the first's result.
 *
 * @throws AnchorError when an anchor matches anything other than exactly once.
 */
export function applyMutation(
  mutation: Mutation,
  root: string,
  store: FileStore,
  backups: Map<string, string>,
): void {
  for (const edit of mutation.edits) {
    const abs = resolve(root, edit.file);
    if (!backups.has(abs)) backups.set(abs, store.read(abs));
  }
  for (const edit of mutation.edits) {
    const abs = resolve(root, edit.file);
    const current = store.read(abs);
    const matches = countOccurrences(current, edit.oldString);
    if (matches !== 1) throw new AnchorError(edit.file, matches);
    store.write(abs, current.replace(edit.oldString, edit.newString));
  }
}

/** Write every backed-up file back and clear the map. Idempotent. */
export function restoreAll(store: FileStore, backups: Map<string, string>): void {
  for (const [abs, original] of backups) {
    store.write(abs, original);
  }
  backups.clear();
}

// ---------------------------------------------------------------------------
// Suite output
// ---------------------------------------------------------------------------

export interface SuiteOutcome {
  readonly pass: number;
  readonly fail: number;
  /**
   * Tests bun reported as SKIPPED.
   *
   * ⚠️ **Parsed because its absence was this runner's worst silent failure.** A
   * skipped test cannot be killed by a mutation, so every skip deflates the
   * cell it would have contributed to — and the baseline guard only ever
   * rejected `fail !== 0`, which a mostly-skipped suite passes with room to
   * spare. Measured: `identity-consumers-pg.test.ts` without
   * `TEST_DATABASE_URL` reports **6 pass, 72 skip, 0 fail**, so the baseline
   * records a denominator of 6 instead of 78 and the `-pg` column regenerates
   * as zeros over real numbers.
   *
   * ⚠️ Note it is 6 and not 0 — that file carries six non-`-pg` tests. A guard
   * spelled `pass > 0` therefore does NOT catch this, which is why the signal
   * has to be the skip count itself. That is a correction to #5077's own
   * diagnosis, which reads the failure as a zeroed suite.
   */
  readonly skip: number;
  /**
   * Tests bun reported as TODO.
   *
   * ⚠️ **Its own bucket, because bun does not fold it into `skip` and the first
   * cut of the guard therefore missed it entirely** — with a comment claiming
   * `.todo` was covered, which is worse than no comment. A `test.todo` does not
   * run even when it HAS a body, so it deflates the denominator exactly like a
   * `.skip`. Measured: a 2-test file with one `test.todo` published as *1 test*
   * with every cell deflated, and the guard silent.
   */
  readonly todo: number;
  /**
   * What bun's `Ran N tests` line said, or `null` when it printed none.
   *
   * The ACCOUNTING check behind {@link baselineProblem}'s third arm, and the
   * reason that function does not enumerate buckets: `filtered out` is a fourth
   * one, and there is no reason to believe it is the last. Comparing the sum
   * against the total closes every bucket at once, now and later.
   */
  readonly ran: number | null;
  /** Set when bun printed no summary at all — a compile or import error. */
  readonly error?: string;
}

/**
 * Read bun's summary block.
 *
 * Anchored to the start of a line so the per-test failure lines — which begin
 * `(fail)` — cannot be mistaken for the summary. A missing summary means the
 * file never ran, and that must surface as an error rather than as `0 fail`,
 * which would read as "the suite does not catch this".
 *
 * ⚠️ `skip` DEFAULTS TO 0 when the line is absent, and that asymmetry with
 * `pass`/`fail` is deliberate: bun omits the skip line entirely when nothing
 * skipped, so treating its absence as a parse failure would make every healthy
 * run an error. `pass`/`fail` are always printed, so THEIR absence still means
 * no run happened.
 */
export function parseBunSummary(output: string): SuiteOutcome {
  const pass = /^\s*(\d+)\s+pass\b/m.exec(output);
  const fails = /^\s*(\d+)\s+fail\b/m.exec(output);
  const skips = /^\s*(\d+)\s+skip\b/m.exec(output);
  const todos = /^\s*(\d+)\s+todo\b/m.exec(output);
  const ran = /^Ran (\d+) tests?\b/m.exec(output);
  if (pass === null || fails === null) {
    const firstError = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("error:") || line.startsWith("SyntaxError"));
    return {
      pass: 0,
      fail: 0,
      skip: 0,
      todo: 0,
      ran: null,
      error: firstError ?? "bun printed no pass/fail summary (compile or import error)",
    };
  }
  return {
    pass: Number(pass[1]),
    fail: Number(fails[1]),
    skip: skips === null ? 0 : Number(skips[1]),
    todo: todos === null ? 0 : Number(todos[1]),
    ran: ran === null ? null : Number(ran[1]),
  };
}

/**
 * Whether a fail count is high enough to be suspected of breaking suite SETUP
 * rather than the behaviour under test.
 *
 * The measured instance: substituting an untyped parameter (`AND ($2 IS NOT
 * NULL)`) makes Postgres refuse the statement with "could not determine data
 * type", every test in the file dies, and an honest count of 1 gets recorded
 * as 51.
 */
export function isWholeSuite(fail: number, total: number): boolean {
  return total > 0 && fail >= Math.ceil(total * WHOLE_SUITE_WARN_RATIO);
}

/** How many times the clean baseline's duration a mutated run may take. */
export const SUITE_TIMEOUT_FACTOR = 10;

/**
 * Floor for the per-suite timeout. A fast suite (`object-cmp.test.ts` runs in
 * ~120ms) would otherwise get a timeout measured in seconds, and any ordinary
 * scheduling hiccup would read as a hang.
 */
export const SUITE_TIMEOUT_FLOOR_MS = 30_000;

/**
 * The per-suite timeout, derived from the clean baseline's duration.
 *
 * A mutation CAN hang the suite rather than fail it, and without a timeout that
 * hangs the whole run — measured here: removing `countOccurrences`' empty-needle
 * guard turns its `indexOf` loop into an infinite one, and the runner sat until
 * an external `timeout` killed it. An unbounded wait is also the worst possible
 * failure for this tool, because the operator's instinct is to Ctrl-C, and the
 * window between apply and restore is exactly where a Ctrl-C costs their tree.
 *
 * Scaled off the baseline rather than fixed: a `-pg` suite legitimately takes
 * orders of magnitude longer than a pure-TS one, and one constant cannot serve
 * both without being uselessly loose for the fast case.
 */
export function suiteTimeoutMs(baselineMs: number): number {
  return Math.max(SUITE_TIMEOUT_FLOOR_MS, Math.ceil(baselineMs * SUITE_TIMEOUT_FACTOR));
}

// ---------------------------------------------------------------------------
// Dependency discovery (`mutate.ts --files`)
// ---------------------------------------------------------------------------

/**
 * Every module specifier a TypeScript source names.
 *
 * ⚠️ **Deliberately LOOSE, because the two error directions are not
 * symmetrical here.** This feeds `--files`, which feeds
 * `check-mutation-tables.sh --affected`: a specifier this misses is a file
 * whose edit selects no spec, so the gate prints *"nothing to verify"* and a
 * table goes stale unnoticed — the exact silence #5060 and #5077 were both
 * filed for. A specifier this over-reports selects one extra spec on one PR,
 * which costs minutes and catches more. Widen, never narrow.
 *
 * So it matches `from "…"` and bare `import "…"` ANYWHERE, rather than parsing
 * import statements: a multi-line `import {\n a,\n b,\n} from "./x"` defeats
 * any single-line statement pattern, and that shape is the common one in this
 * repo. A `from "…"` inside a string literal or a comment is a false positive
 * this accepts on purpose.
 */
export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bfrom\s*["']([^"'\n]+)["']/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*["']([^"'\n]+)["']/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** Extension-less specifiers are tried in this order, mirroring bun's resolver. */
const IMPORT_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"] as const;

/**
 * Candidate paths for one specifier, relative to `packages/api`, or `[]` for a
 * specifier this walker does not follow.
 *
 * PURE — it does not touch the filesystem — so the whole resolution table is
 * unit-testable and `mutate.ts` only has to decide which candidate exists.
 *
 * ⚠️ Two specifier shapes are followed and no others:
 *
 * - **relative** (`./`, `../`), which is how a target reaches its corpus
 *   (`./__tests__/identity-corpus`) and how `bundle-identity` reaches
 *   `../types/src/migration.ts` from outside `packages/api` at all;
 * - **`@atlas/api/*`**, the package's own tsconfig alias for `./src/*`.
 *
 * A bare package specifier is NOT followed. `node_modules` cannot change a
 * suite's size on a branch, and a workspace sibling reached by its package name
 * would drag its whole graph in — which matters because this gate's cost is a
 * correctness property (a gate that doubles the pre-PR loop gets disabled).
 */
export function importCandidates(fromFile: string, specifier: string): string[] {
  let base: string;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = `${dirname(fromFile)}/${specifier}`;
  } else if (specifier.startsWith("@atlas/api/")) {
    base = `src/${specifier.slice("@atlas/api/".length)}`;
  } else {
    return [];
  }
  // A `.js` specifier is TypeScript's NodeNext spelling for a `.ts` file.
  const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
  return IMPORT_SUFFIXES.map((suffix) => normalize(`${stem}${suffix}`));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Structural problems that would otherwise surface as a confident wrong number.
 * Returns every problem rather than the first, so one run fixes the spec.
 */
export function validateSpec(spec: MutationSpec): string[] {
  const problems: string[] = [];
  if (spec.targets.length === 0) problems.push("spec has no targets");
  if (spec.mutations.length === 0) problems.push("spec has no mutations");

  const seenTargets = new Set<string>();
  for (const target of spec.targets) {
    if (seenTargets.has(target.name)) problems.push(`duplicate target name: ${target.name}`);
    seenTargets.add(target.name);
  }

  const seenLabels = new Set<string>();
  for (const mutation of spec.mutations) {
    // Labels are the row key a human reads and `--only` matches. Two rows with
    // one label make the table ambiguous about which mutation was measured.
    if (seenLabels.has(mutation.label)) problems.push(`duplicate mutation label: ${mutation.label}`);
    seenLabels.add(mutation.label);

    if (mutation.edits.length === 0) problems.push(`${mutation.label}: no edits`);
    for (const edit of mutation.edits) {
      // An empty anchor matches everywhere; a no-op edit measures the baseline
      // under a label claiming otherwise. Both are the 0-match lie in disguise.
      if (edit.oldString === "") problems.push(`${mutation.label}: empty oldString`);
      if (edit.oldString === edit.newString) {
        problems.push(`${mutation.label}: oldString === newString (a no-op measures the baseline)`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * What one mutation did to one target — a DISCRIMINATED UNION, and the
 * discriminant is the whole point (#5097).
 *
 * ⚠️ **`--check` compares BYTES, so any cell recording "this measured nothing"
 * becomes the expected output forever once committed, and the gate then
 * certifies a table that measures nothing.** #5077 closed exactly one member of
 * that class with a `Cell.anchorFailed?: true` flag beside a free-form `flag`
 * string — which left `{ kind: "error", fail: 0, flag: "ANCHOR: 0 matches" }`
 * typechecking, rendering the blessed byte, and reporting no anchor failure.
 * The tombstone STRING could exist without the tombstone STATE.
 *
 * Three variants make that unrepresentable, and they partition the cell space
 * by one question — *was anything actually measured?*
 *
 * - `count` — a real number. `wholeSuite` marks the ratio trip, which is a
 *   caveat on a real measurement, not an absence of one.
 * - `error` — nothing was counted, but the RUN is the finding: a mutation that
 *   HANGS the suite is a measured fact about the mutation. This is the
 *   carve-out, and it is deliberately the only one.
 * - `unmeasured` — nothing was measured, so no byte may be committed. Every
 *   member of the class lands here: a dead anchor, a mutated run that SKIPPED
 *   or TODO'd tests (its count is deflated), an unaccounted bucket, a compile
 *   error, a kill by a signal that was not the timeout.
 *
 * {@link unmeasuredRows} is the single mechanism {@link module:mutate} refuses
 * on. There is no second one.
 */
export type Cell =
  | {
      readonly kind: "count";
      readonly fail: number;
      /** The count reached ~every test in the file — see {@link isWholeSuite}. */
      readonly wholeSuite?: true;
    }
  | {
      /**
       * A real measurement of a real hang, and the ONE committable no-count
       * cell. The mutation's effect IS the hang, so the bytes describe it
       * honestly.
       *
       * ⚠️ **PAYLOAD-FREE, and that is the whole point of the variant.** The
       * first cut of this union kept a `flag: string` here, which left
       * `{ kind: "error", flag: "ANCHOR: 0 matches" }` typechecking, rendering
       * the blessed byte, and escaping {@link unmeasuredRows} — so the union
       * RELOCATED #5077's hole rather than closing it. Two fields that could
       * disagree had become one field that could be wrong. With no field for
       * prose, a tombstone string has nowhere to live but `unmeasured`.
       *
       * ⚠️ It also makes the cell DETERMINISTIC. The flag used to carry
       * `timed out after ${round(timeoutMs / 1000)}s`, and `timeoutMs` derives
       * from the clean baseline's measured duration — so the committed byte was
       * stable only while that suite stayed under 3s, and for any `-pg` target
       * it could never be stable at all. `--check` compares BYTES and is a
       * required CI gate, so a wall-clock-derived cell is the same defect class
       * as a timestamp. The seconds stay on the console, where they help.
       */
      readonly kind: "timeout";
    }
  | {
      readonly kind: "unmeasured";
      /** Cell-sized prose. Never committed — the run refuses first. */
      readonly reason: string;
    };

/** The committed text for a {@link Cell} of kind `timeout`. Deterministic. */
export const TIMEOUT_CELL = "⚠️ HANGS — timed out";

/**
 * The only way to build a `count` cell, so `wholeSuite` cannot disagree with
 * {@link isWholeSuite}.
 *
 * ⚠️ Two representable-but-wrong states motivated this, and both are the kind of
 * thing nothing would notice. FORGETTING the flag publishes an unflagged
 * near-total — *"a defect in the mutation, not a triumph of the tests"*, per
 * `mutate.ts`'s header. And `{ fail: 0, wholeSuite: true }` is nonsense
 * (`isWholeSuite(0, n)` is false for every n) yet typechecks. The flag is never
 * a judgement call — it is this predicate at every site — so deriving it is the
 * same move `cellFlag` makes one function up: *"One function rather than a
 * field, because the field is what let the tombstone string exist without the
 * tombstone state. Derived, it cannot."*
 */
export function countCell(fail: number, total: number): Cell {
  return isWholeSuite(fail, total) ? { kind: "count", fail, wholeSuite: true } : { kind: "count", fail };
}

export function renderCell(cell: Cell): string {
  switch (cell.kind) {
    case "unmeasured":
      return `⚠️ ${cell.reason}`;
    case "timeout":
      return TIMEOUT_CELL;
    case "count":
      return cell.wholeSuite === true ? `${cell.fail} ⚠️` : String(cell.fail);
    default: {
      // ⚠️ The repo's `_exhaustive: never` idiom (metrics.ts, admin-publish.ts,
      // dashboards.ts and five more). Here it is BELT AND BRACES: this
      // function's return type already excludes `undefined`, so a fourth
      // variant is a TS2366 on its own — measured. The two functions below have
      // no such backstop, which is why the pin is not optional there.
      const _exhaustive: never = cell;
      throw new Error(`unhandled Cell kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * The cell's entry in the table's `## ⚠️ Flagged` section, or `undefined` when
 * it has none.
 *
 * One function rather than a `flag` field, because the field is what let the
 * tombstone string exist without the tombstone state. Derived, it cannot.
 */
export function cellFlag(cell: Cell): string | undefined {
  switch (cell.kind) {
    case "unmeasured":
      return cell.reason;
    case "timeout":
      return "HANGS — timed out";
    case "count":
      return cell.wholeSuite === true ? "whole-suite" : undefined;
    default: {
      // ⚠️ NOT belt and braces here, unlike `renderCell`. This return type
      // INCLUDES `undefined`, so falling off the end is legal and
      // `noImplicitReturns` is set nowhere in this repo — measured by adding a
      // fourth variant and compiling: `renderCell` went red with TS2366 and
      // this function did not. Without the pin, a new variant silently gets no
      // entry in the `## ⚠️ Flagged` section.
      const _exhaustive: never = cell;
      throw new Error(`unhandled Cell kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Every mutation label with a cell that MEASURED NOTHING, and why.
 *
 * ⚠️ **ONE mechanism for the whole class, which is #5097's entire point.** Its
 * predecessor (`anchorFailures`) refused exactly one member — a dead anchor —
 * so a mutated run that skipped tests rendered a deflated count as an honest
 * number and `--check` blessed it forever. Refusing on the DISCRIMINANT rather
 * than on any particular cause means one refusal covers every cause that
 * already exists, and {@link uncommittableReason}'s `never` pin means a cause
 * added LATER cannot compile until its author states which side of the
 * committable line it sits on.
 *
 * Returned as a LIST rather than a boolean so the runner can name all of them
 * in one pass — `measure()` deliberately keeps going after an `AnchorError` so
 * one bad anchor does not cost the other twenty measurements, and the same
 * courtesy should extend to repairing them.
 *
 * One entry per LABEL, from its first unmeasured target: the label is the row a
 * human repairs, and a spec with four targets should not print the same repair
 * four times.
 */
export function unmeasuredRows(
  rows: ReadonlyMap<string, ReadonlyMap<string, Cell>>,
): readonly { readonly label: string; readonly reason: string }[] {
  const unmeasured: { readonly label: string; readonly reason: string }[] = [];
  for (const [label, cells] of rows) {
    // ⚠️ Scans EVERY cell, not the first. A four-target spec where only the
    // `-pg` column deflated is the realistic shape — `measure()` marks one
    // target at a time — so stopping at the first measured cell would let the
    // deflated column through.
    for (const cell of cells.values()) {
      const reason = uncommittableReason(cell);
      if (reason !== null) {
        unmeasured.push({ label, reason });
        break;
      }
    }
  }
  return unmeasured;
}

/**
 * Why this cell may not be committed, or `null` when it may.
 *
 * ⚠️ **A `switch` with a `never` pin, and that is what makes the refusal
 * structural rather than aspirational.** The first cut asked
 * `cell.kind === "unmeasured"` inline, which gave a fifth variant NO compile
 * pressure at all: a `{ kind: "deflated-count"; fail: number }` would have
 * sailed past the refusal and only `renderCell` would have objected. Measured
 * by adding a fourth variant and compiling.
 *
 * The claim this supports is narrow and worth stating exactly: a new variant
 * cannot be added without its author STATING which side of the committable line
 * it sits on. That is not the same as "nowhere else for it to live", which is
 * what an earlier draft of this docstring claimed and could not deliver.
 */
function uncommittableReason(cell: Cell): string | null {
  switch (cell.kind) {
    case "unmeasured":
      return cell.reason;
    // The one committable no-count cell: a real measurement of a real hang.
    case "timeout":
      return null;
    case "count":
      return null;
    default: {
      const _exhaustive: never = cell;
      throw new Error(`unhandled Cell kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Why a run measured NOTHING USABLE — tests that did not run, or none at all —
 * or `null` when its counts can be trusted.
 *
 * ⚠️ **ONE copy, read by the baseline guard AND the per-mutation refusal.**
 * #5077 detected a deflated MUTATED run, flagged it rather than refusing it, and
 * was then removed rather than shipped — so before this change the runner
 * rendered a deflated count as an honest number. Reinstating that as a second
 * copy of these arms would be a sibling one edit from disagreeing with this one.
 *
 * The arms deliberately exclude RED, which is baseline-only: under a mutation,
 * `fail !== 0` is the POINT.
 *
 * ⚠️ EMPTY is **not** baseline-only, and an earlier draft of this comment said
 * it was — on the argument that `pass === 0` is a legitimate whole-suite kill.
 * That is true only when `fail > 0`. `{ pass: 0, fail: 0 }` is a suite that
 * registered NO TESTS, and bun really does print that: measured on bun 1.3.13,
 * an empty `describe` and a `for (const c of []) test(...)` corpus both emit
 * ` 0 pass`, ` 0 fail`, `Ran 0 tests`. Neither the accounting arm nor the
 * skip/todo arm fires, `isWholeSuite(0, n)` is false, and `measure()` therefore
 * published a `0` — which the generated header defines as *"the suite does not
 * catch it"*. A coverage claim, from a run that measured nothing. That is
 * #5097's own class, and the emptied-corpus shape is reachable by exactly the
 * data-driven mutation this PR's `--files` hop was added to track.
 */
export interface UnmeasurableOutcome {
  readonly kind: "unaccounted" | "deflated" | "empty";
  /** Operator-facing prose, for the baseline's hard refusal. */
  readonly message: string;
  /**
   * Cell-sized prose, for an `unmeasured` {@link Cell}.
   *
   * Produced HERE rather than by the caller so a cell and the message
   * explaining it can never describe different arms.
   */
  readonly cell: string;
  /**
   * Whether the `TEST_DATABASE_URL` hint applies.
   *
   * ⚠️ **CARRIED ON THE PROBLEM, not re-derived by the caller, and this field is
   * the reason two individually-correct fixes compose.** `mutate.ts` used to ask
   * `kind === "deflated" || kind === "unaccounted"` — a hand-copied list that
   * happened to give the right answer until a kind was added. Adding `empty`
   * here is exactly that event: an `empty` run told to "find the .skip/.todo in
   * the target" sends an operator hunting a skip in a suite that registered no
   * tests, which is the misdirecting-diagnostic defect `kind` exists to prevent.
   * A structural `"cell" in problem` test would have made the same mistake.
   */
  readonly pgHint: boolean;
}

export function unmeasurableOutcome(outcome: SuiteOutcome): UnmeasurableOutcome | null {
  const accounted = outcome.pass + outcome.fail + outcome.skip + outcome.todo;
  if (outcome.ran !== null && accounted !== outcome.ran) {
    const missing = outcome.ran - accounted;
    return {
      kind: "unaccounted",
      message:
        `ran ${outcome.ran} tests but only ${accounted} are accounted for (${missing} unclassified). ` +
        "A test that did not run cannot be killed by a mutation, so every count would be deflated.",
      cell: `${missing} UNACCOUNTED — count would be deflated`,
      pgHint: true,
    };
  }
  if (outcome.skip !== 0 || outcome.todo !== 0) {
    const what =
      outcome.todo === 0
        ? `SKIPPED ${outcome.skip}`
        : outcome.skip === 0
          ? `marked TODO on ${outcome.todo}`
          : `SKIPPED ${outcome.skip} and marked TODO on ${outcome.todo}`;
    return {
      kind: "deflated",
      message:
        `${what} of ${accounted} tests. A skipped test cannot be killed by a mutation, so every count ` +
        "would be silently deflated and the generated file would overwrite real numbers with zeros.",
      cell: `${what} — count would be deflated`,
      pgHint: true,
    };
  }
  // ⚠️ LAST, and the ordering is the finding. Placed before the two arms above
  // it swallowed THREE OF FIVE `-pg` targets: a suite with no non-`-pg` tests
  // reports `0 pass / 29 skip`, which is DEFLATED, but a `pass === 0` test
  // claimed it first and printed "check the target's path" — sending an operator
  // after a path that is fine while Postgres is down. "Ran nothing AND explains
  // why" beats "ran nothing", so every arm that can explain goes first.
  //
  // ⚠️ `fail === 0` too, not `pass === 0` alone: a whole-suite kill reports
  // `0 pass` with a large `fail` and is a real, publishable measurement.
  if (outcome.pass === 0 && outcome.fail === 0) {
    return {
      kind: "empty",
      message:
        "ran ZERO tests — neither passing nor failing — and reported no skips, todos or " +
        "unaccounted tests to explain it. Every cell would render an honest-looking 0 meaning " +
        "'the suite does not catch this'. Check the target's path, and whether the mutation " +
        "stopped the suite from registering its tests at all.",
      cell: "ZERO tests ran — nothing was measured",
      // ⚠️ FALSE. A self-skipped `-pg` suite reports `skip !== 0` and lands on
      // the deflated arm above; reaching here means no test was DISCOVERED, so
      // pointing at Postgres would be the misdirection this field exists to stop.
      pgHint: false,
    };
  }
  return null;
}

/**
 * Why this outcome cannot serve as a BASELINE, or `null` if it can.
 *
 * ⚠️ **A pure function in this file rather than an inline block in
 * `mutate.ts`, because that is this module's stated split** — *"the logic
 * behind all three [guardrails] lives in `mutation-core.ts` and is unit-tested;
 * [mutate.ts] is the process around it"*. Guardrail 4 was written inline, and
 * the consequence was measurable: deleting the entire guard left every test
 * green and regenerated every table byte-identically. A guardrail that its own
 * suite cannot see is the shape this whole runner exists to refuse.
 *
 * ## The ways a baseline lies, and why counting buckets is not enough
 *
 * `pass` becomes the published suite size (`render`'s *"Suite sizes: N tests"*)
 * and `isWholeSuite`'s denominator, so a deflated baseline silently deflates
 * every cell measured against it.
 *
 * 1. **RED** — inflates. Already caught before this existed, and the one arm
 *    that is genuinely baseline-only.
 * 2. **EMPTY** — `0 pass` and `0 fail` with no error is a target whose file was
 *    renamed or emptied. Every cell then renders an honest-looking `0` meaning
 *    *"the suite does not catch this"*.
 * 3. **UNACCOUNTED** — the buckets do not sum to what bun says it ran. This is
 *    the general form of #5077, and it is deliberately NOT spelled as
 *    `skip !== 0`: bun prints `todo` on its own summary line and does not fold
 *    it into `skip`, so a `test.todo` deflates the denominator exactly like a
 *    `.skip` and slipped straight past the first cut of this guard. `filtered
 *    out` is a third bucket with the same effect. Checking the SUM against
 *    `Ran N tests` closes every bucket bun has now and every one it adds later,
 *    rather than chasing its release notes.
 *
 * 2 and 3 — and the skip/todo arm — live in {@link unmeasurableOutcome},
 * because a MUTATED run can produce all three too. Only RED is decided here.
 */
export type BaselineProblem =
  | {
      /**
       * ⚠️ The kinds present so the CALLER can decide which remediation to
       * print — but the DECISION now travels as `pgHint` on
       * {@link UnmeasurableOutcome} rather than as a kind list the caller
       * re-derives. The first cut returned a bare string and `mutate.ts`
       * appended the TEST_DATABASE_URL hint to all of them, so a suite that was
       * simply RED got told to "find the .skip/.todo in the target".
       */
      readonly kind: "errored" | "red";
      readonly message: string;
      readonly pgHint: false;
    }
  | UnmeasurableOutcome;

export function baselineProblem(outcome: SuiteOutcome): BaselineProblem | null {
  if (outcome.error !== undefined) {
    return { kind: "errored", message: `did not run: ${outcome.error}`, pgHint: false };
  }
  if (outcome.fail !== 0) {
    return {
      kind: "red",
      message:
        `is RED — ${outcome.fail} failing. Every mutation count would be this breakage plus the ` +
        "mutation's, which is indistinguishable from a strong result. Fix the tree first.",
      pgHint: false,
    };
  }
  // Every remaining way a baseline lies is a way a MUTATED run lies too, so it
  // lives in the shared function — including the arm ordering, which the
  // comments there record.
  return unmeasurableOutcome(outcome);
}

/**
 * Escape `|` so a label containing one cannot split its row into extra cells.
 *
 * A backslash is escaped only where one already precedes a pipe. Escaping `|`
 * alone sends `a\|b` to `a\\|b`, where the `\\` is a literal backslash and the
 * `|` behind it is a live delimiter again — the escape defeats itself on
 * precisely the input it exists for (the shape fixed in #4389).
 *
 * The narrowing is not timidity, it is the renderer: GFM special-cases `\|` at
 * the row-splitting stage and nothing else, and labels put their backslashes
 * inside CODE SPANS (`` `\s+` ``), where markdown escapes do not apply. So
 * doubling every backslash would fix nothing structural and would render a
 * visible `\\s+` to the reader. Escape what can split a row; leave the rest.
 *
 * ⚠️ The two-replace spelling of this — `.replace(/\\/g, …)` then
 * `.replace(/\|/g, …)` — is what CodeQL's `js/incomplete-sanitization` asks
 * for, and it is WRONG here for the code-span reason above. The single pass
 * satisfies the rule without doubling benign backslashes; if a future edit
 * splits it back into two replaces, expect a HIGH alert and re-read this
 * comment rather than blanket-escaping to silence it.
 */
export function escapeCell(text: string): string {
  // One pass over "an optional backslash then a pipe", so there is no
  // which-replace-runs-first hazard to get wrong: a pipe already carrying a
  // backslash gets both escaped together, a bare pipe just gets escaped.
  return text.replace(/\\?\|/g, (match) => (match.startsWith("\\") ? "\\\\\\|" : "\\|"));
}

/**
 * The generated markdown.
 *
 * Deterministic — no timestamps, no SHAs — so regenerating against an
 * unchanged tree produces a byte-identical file and `--check` is a usable CI
 * gate. A diff then means a number moved, which is precisely the event that
 * used to pass unnoticed.
 */
export function render(
  spec: MutationSpec,
  targets: readonly MutationTarget[],
  mutations: readonly Mutation[],
  baselines: ReadonlyMap<string, number>,
  rows: ReadonlyMap<string, ReadonlyMap<string, Cell>>,
  specPath: string,
): string {
  const lines: string[] = [];
  lines.push("<!-- GENERATED by packages/api/scripts/mutate.ts — DO NOT EDIT BY HAND. -->");
  lines.push(`<!-- Regenerate: cd packages/api && bun run scripts/mutate.ts ${specPath} -->`);
  lines.push("");
  lines.push(`# ${spec.title}`);
  lines.push("");
  if (spec.preamble !== undefined) {
    lines.push(spec.preamble.trim());
    lines.push("");
  }
  lines.push(
    "Every number is the count of tests that FAIL in that suite under that mutation, " +
      "measured one mutation at a time against an otherwise clean tree. A `0` means the " +
      "suite does not catch it — see the notes for whether that is honest or a gap.",
  );
  lines.push("");

  lines.push(`| Mutation | ${targets.map((t) => escapeCell(t.name)).join(" | ")} |`);
  lines.push(`|---|${targets.map(() => "---").join("|")}|`);
  for (const mutation of mutations) {
    const cells = rows.get(mutation.label);
    const rendered = targets.map((t) => {
      const cell = cells?.get(t.name);
      return cell === undefined ? "—" : renderCell(cell);
    });
    lines.push(`| ${escapeCell(mutation.label)} | ${rendered.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    `Suite sizes: ${targets
      .map((t) => `**${escapeCell(t.name)}** ${baselines.get(t.name) ?? 0} tests (\`${t.file}\`)`)
      .join(" · ")}.`,
  );
  lines.push("");

  const noted = mutations.filter((m) => m.note !== undefined);
  if (noted.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const mutation of noted) {
      lines.push(`- **${mutation.label}** — ${mutation.note}`);
    }
    lines.push("");
  }

  const flagged = mutations.filter((m) =>
    [...(rows.get(m.label)?.values() ?? [])].some((c) => cellFlag(c) !== undefined),
  );
  if (flagged.length > 0) {
    lines.push("## ⚠️ Flagged");
    lines.push("");
    lines.push(
      "A `whole-suite` flag means the count reached ~every test in the file. That is " +
        "usually a mutation that broke SETUP rather than the behaviour under test, and the " +
        "honest count is much smaller. An `ANCHOR` flag means nothing was mutated at all.",
    );
    lines.push("");
    for (const mutation of flagged) {
      const cells = rows.get(mutation.label);
      const detail = targets
        .map((t) => {
          const cell = cells?.get(t.name);
          const flag = cell === undefined ? undefined : cellFlag(cell);
          return flag === undefined ? null : `${escapeCell(t.name)}: ${flag}`;
        })
        .filter((entry): entry is string => entry !== null);
      lines.push(`- **${mutation.label}** — ${detail.join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
