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
import { resolve } from "node:path";
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

/** What one mutation did to one target. */
export interface Cell {
  readonly kind: "count" | "error";
  readonly fail: number;
  /** Present when `kind` is `error`, or when the count tripped the ratio. */
  readonly flag?: string;
  /**
   * The cell measured NOTHING because the mutation's anchor did not resolve.
   *
   * ⚠️ **Its own field rather than a substring of {@link flag}, because the
   * gate has to act on it and `flag` is free-form prose.** Guardrail 2 calls a
   * 0-match *"a number for a mutation that was never performed, which is worse
   * than reporting nothing"* — but `--check` compares BYTES, so once
   * `⚠️ ANCHOR: 0 matches` is in the committed table it becomes the expected
   * output and the table passes forever. Measured on this very change: adding a
   * field to `SuiteOutcome` rotted the anchor mirroring that literal, the table
   * regenerated with a tombstone where a measured `2` had been, and
   * `--check` said `CHECK OK`.
   *
   * So a rotted anchor is a distinct, machine-readable state, and
   * {@link anchorFailures} is what {@link module:mutate} refuses on. A
   * timeout flag must stay merely a flag — that is a real measurement of a real
   * hang — which is exactly the distinction a substring match could not draw.
   */
  readonly anchorFailed?: true;
}

export function renderCell(cell: Cell): string {
  if (cell.kind === "error") return `⚠️ ${cell.flag ?? "ERROR"}`;
  return cell.flag === undefined ? String(cell.fail) : `${cell.fail} ⚠️`;
}

/**
 * Every mutation label whose cells recorded a dead anchor.
 *
 * Returned as a LIST rather than a boolean so the runner can name all of them
 * in one pass — `measure()` deliberately keeps going after an `AnchorError` so
 * one bad anchor does not cost the other twenty measurements, and the same
 * courtesy should extend to repairing them.
 */
export function anchorFailures(rows: ReadonlyMap<string, ReadonlyMap<string, Cell>>): string[] {
  const dead: string[] = [];
  for (const [label, cells] of rows) {
    for (const cell of cells.values()) {
      if (cell.anchorFailed === true) {
        dead.push(label);
        break;
      }
    }
  }
  return dead;
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
 * ## The three ways a baseline lies, and why counting buckets is not enough
 *
 * `pass` becomes the published suite size (`render`'s *"Suite sizes: N tests"*)
 * and `isWholeSuite`'s denominator, so a deflated baseline silently deflates
 * every cell measured against it.
 *
 * 1. **RED** — inflates. Already caught before this existed.
 * 2. **EMPTY** — `0 pass` with no error is a target whose file was renamed or
 *    emptied. Every cell then renders an honest-looking `0` meaning *"the suite
 *    does not catch this"*.
 * 3. **UNACCOUNTED** — the buckets do not sum to what bun says it ran. This is
 *    the general form of #5077, and it is deliberately NOT spelled as
 *    `skip !== 0`: bun prints `todo` on its own summary line and does not fold
 *    it into `skip`, so a `test.todo` deflates the denominator exactly like a
 *    `.skip` and slipped straight past the first cut of this guard. `filtered
 *    out` is a third bucket with the same effect. Checking the SUM against
 *    `Ran N tests` closes every bucket bun has now and every one it adds later,
 *    rather than chasing its release notes.
 */
export interface BaselineProblem {
  /**
   * ⚠️ Present so the CALLER can decide which remediation to print.
   *
   * The first cut returned a bare string and `mutate.ts` appended the
   * TEST_DATABASE_URL hint to all of them — so a suite that was simply RED got
   * told to "find the .skip/.todo in the target", sending an operator hunting a
   * skip that does not exist. That is the same misdirecting-diagnostic defect
   * the empty-string env check fixed one arm over, reintroduced by the fix for
   * it. Only `deflated` and `unaccounted` are about tests that did not run.
   */
  readonly kind: "errored" | "red" | "empty" | "unaccounted" | "deflated";
  readonly message: string;
}

export function baselineProblem(outcome: SuiteOutcome): BaselineProblem | null {
  if (outcome.error !== undefined) {
    return { kind: "errored", message: `did not run: ${outcome.error}` };
  }
  if (outcome.fail !== 0) {
    return {
      kind: "red",
      message:
        `is RED — ${outcome.fail} failing. Every mutation count would be this breakage plus the ` +
        "mutation's, which is indistinguishable from a strong result. Fix the tree first.",
    };
  }
  const accounted = outcome.pass + outcome.fail + outcome.skip + outcome.todo;
  if (outcome.ran !== null && accounted !== outcome.ran) {
    const missing = outcome.ran - accounted;
    return {
      kind: "unaccounted",
      message:
        `ran ${outcome.ran} tests but only ${accounted} are accounted for (${missing} unclassified). ` +
        "A test that did not run cannot be killed by a mutation, so every count would be deflated.",
    };
  }
  if (outcome.skip !== 0 || outcome.todo !== 0) {
    const total = accounted;
    const what =
      outcome.todo === 0
        ? `SKIPPED ${outcome.skip}`
        : outcome.skip === 0
          ? `marked TODO on ${outcome.todo}`
          : `SKIPPED ${outcome.skip} and marked TODO on ${outcome.todo}`;
    return {
      kind: "deflated",
      message:
        `${what} of ${total} tests. A skipped test cannot be killed by a mutation, so every count ` +
        "would be silently deflated and the generated file would overwrite real numbers with zeros.",
    };
  }
  // ⚠️ LAST, and the ordering is the finding. Placed before the deflation arms
  // it swallowed THREE OF FIVE `-pg` targets: a suite with no non-`-pg` tests
  // reports `0 pass / 29 skip`, which is a DEFLATED baseline, but `pass === 0`
  // claimed it first and printed "check the target's path" — sending an
  // operator after a path that is fine while Postgres is down. That is the
  // misdirecting diagnostic `182eb6536` removed, reintroduced by the fix for it
  // and on the more common shape; `identity-consumers-pg` was only diagnosed
  // correctly because it happens to carry six unrelated tests.
  //
  // "Ran nothing AND explains why" beats "ran nothing", so every arm that can
  // explain goes first. Reaching here means the suite genuinely discovered no
  // tests at all.
  if (outcome.pass === 0) {
    return {
      kind: "empty",
      message:
        "ran ZERO tests, and reported no skips, todos or unaccounted tests to explain it. A " +
        "baseline of nothing is not a baseline: every cell would render an honest-looking 0 " +
        "meaning 'the suite does not catch this'. Check the target's path.",
    };
  }
  return null;
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
    [...(rows.get(m.label)?.values() ?? [])].some((c) => c.flag !== undefined),
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
          const flag = cells?.get(t.name)?.flag;
          return flag === undefined ? null : `${escapeCell(t.name)}: ${flag}`;
        })
        .filter((entry): entry is string => entry !== null);
      lines.push(`- **${mutation.label}** — ${detail.join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
