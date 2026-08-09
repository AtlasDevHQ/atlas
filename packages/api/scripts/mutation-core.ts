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
  if (pass === null || fails === null) {
    const firstError = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("error:") || line.startsWith("SyntaxError"));
    return {
      pass: 0,
      fail: 0,
      skip: 0,
      error: firstError ?? "bun printed no pass/fail summary (compile or import error)",
    };
  }
  return {
    pass: Number(pass[1]),
    fail: Number(fails[1]),
    skip: skips === null ? 0 : Number(skips[1]),
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
}

export function renderCell(cell: Cell): string {
  if (cell.kind === "error") return `⚠️ ${cell.flag ?? "ERROR"}`;
  return cell.flag === undefined ? String(cell.fail) : `${cell.fail} ⚠️`;
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
