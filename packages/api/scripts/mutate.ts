/**
 * Mutation runner — GENERATES the `MUTATIONS THIS CATCHES` tables that Brain
 * test files carry, so they cannot go stale in a docstring (#5060).
 *
 * Usage:
 *   bun run scripts/mutate.ts scripts/mutations/<name>.mutations.ts
 *   bun run scripts/mutate.ts <spec> --only "<label substring>"   (repeatable)
 *   bun run scripts/mutate.ts <spec> --target here
 *   bun run scripts/mutate.ts <spec> --check     # fail if the output would change
 *
 * ## Why this exists
 *
 * A mutation table is a column of numbers, each of which must equal a count
 * produced by running a mutated tree. Stored by hand in a docstring, every one
 * of them is a claim nothing can falsify: add a test and N cells silently
 * become false. `object-cmp.test.ts` recorded four rows going stale in a single
 * slice (20→22, 11→13, 3→4, 2→3) because a later review round appended tests
 * and edited the prose without re-running anything.
 *
 * ## The three guardrails, and the failure each one closes
 *
 *   1. **Baseline first, abort if red.** Every count here is `fail` under a
 *      mutation. Against a tree that was already failing, that number is the
 *      pre-existing breakage plus whatever the mutation did, and it is
 *      indistinguishable from a strong result.
 *
 *   2. **The anchor must match EXACTLY once.** A 0-match applies nothing and
 *      measures the unmutated tree — reporting a confident `0` that reads as
 *      "no coverage" when the truth is "no mutation". A 2-match mutates one of
 *      two sites, and which one depends on string order. Both report a number
 *      for a mutation that was never performed, which is worse than reporting
 *      nothing.
 *
 *   3. **Restore from an IN-MEMORY backup, never `git checkout --`.** The tree
 *      normally carries uncommitted work — this runner is used mid-slice, which
 *      is the whole point — and `git checkout -- <file>` would destroy it.
 *
 * The logic behind all three lives in `mutation-core.ts` and is unit-tested;
 * this file is the process around it. Same split as `signal-retry.ts`.
 *
 * ## The whole-suite trap
 *
 * A mutation that breaks the suite's SETUP rather than its subject fails every
 * test in the file, and the runner cannot tell that from a mutation the suite
 * genuinely catches everywhere. The measured instance: substituting an untyped
 * parameter (`AND ($2 IS NOT NULL)`) makes Postgres refuse the statement with
 * "could not determine data type", every test in the file dies, and the honest
 * count of 1 gets recorded as 51. Any count at or above
 * `WHOLE_SUITE_WARN_RATIO` of the suite is flagged in the console AND marked in
 * the generated table — an unreviewed near-total is a defect in the mutation,
 * not a triumph of the tests.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { runFileWithSignalRetry } from "./signal-retry";
import {
  AnchorError,
  applyMutation,
  diskStore,
  isWholeSuite,
  parseBunSummary,
  render,
  restoreAll,
  suiteTimeoutMs,
  SUITE_TIMEOUT_FLOOR_MS,
  validateSpec,
  type Cell,
  type SuiteOutcome,
} from "./mutation-core";
import type { Mutation, MutationSpec, MutationTarget } from "./mutation-spec";

const ROOT = resolve(import.meta.dir, "..");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function fail(message: string): never {
  console.error(`${RED}error${RESET}  ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  readonly specPath: string;
  readonly only: readonly string[];
  readonly targets: readonly string[];
  readonly check: boolean;
  /**
   * Print the files this spec's verdict DEPENDS ON, then exit. Runs nothing.
   *
   * Exists so `check-mutation-tables.sh` can verify only the specs a branch
   * could actually have invalidated. The full sweep is 832s measured — more
   * than the entire rest of `/ci` — so a gate that always ran everything would
   * be disabled inside a week, and a disabled gate catches nothing.
   *
   * Derived from the loaded spec rather than grepped, because the paths are
   * behind `SOURCE`-style consts that a regex would miss — and a dependency
   * list that silently misses a file is a gate that silently stops gating.
   */
  readonly files: boolean;
  /** Overrides the baseline-derived per-suite timeout. */
  readonly timeoutMs?: number;
}

function parseArgs(argv: readonly string[]): Options {
  let specPath: string | undefined;
  const only: string[] = [];
  const targets: string[] = [];
  let check = false;
  let files = false;
  let timeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only" && argv[i + 1] !== undefined) {
      only.push(argv[++i] as string);
    } else if (arg === "--target" && argv[i + 1] !== undefined) {
      targets.push(argv[++i] as string);
    } else if (arg === "--timeout" && argv[i + 1] !== undefined) {
      const raw = argv[++i] as string;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) fail(`--timeout expects milliseconds, got: ${raw}`);
      timeoutMs = parsed;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--files") {
      files = true;
    } else if (arg !== undefined && arg.startsWith("--")) {
      fail(`Unknown flag: ${arg}`);
    } else if (specPath === undefined) {
      specPath = arg;
    } else {
      fail(`Unexpected argument: ${arg}. Pass exactly one spec path.`);
    }
  }

  if (specPath === undefined) {
    fail(
      "Usage: bun run scripts/mutate.ts <spec.mutations.ts> " +
        "[--only <label>] [--target <name>] [--timeout <ms>] [--check] [--files]",
    );
  }
  return { specPath, only, targets, check, files, timeoutMs };
}

async function loadSpec(specPath: string): Promise<MutationSpec> {
  const abs = resolve(ROOT, specPath);
  let mod: { default?: unknown };
  try {
    mod = (await import(abs)) as { default?: unknown };
  } catch (err) {
    fail(`could not load spec ${specPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const spec = mod.default;
  if (spec === undefined || spec === null || typeof spec !== "object") {
    fail(`${specPath} must have a default export of type MutationSpec`);
  }
  return spec as MutationSpec;
}

// ---------------------------------------------------------------------------
// Restore safety
// ---------------------------------------------------------------------------

/**
 * Files this process has modified, mapped to their original bytes. Module-level
 * rather than threaded through, because the signal handlers need it: a Ctrl-C
 * between apply and restore would otherwise leave a mutated source in the
 * working tree, and the next `bun test` would blame the author's own work.
 */
const backups = new Map<string, string>();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    restoreAll(diskStore, backups);
    console.error(`\n${YELLOW}interrupted${RESET}  sources restored.`);
    // 128 + signal number, the shell convention: SIGINT 2, SIGTERM 15.
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

// ---------------------------------------------------------------------------
// Running a suite
// ---------------------------------------------------------------------------

/**
 * Run one target suite, bounded by `timeoutMs`.
 *
 * The bound is not optional: a mutation can HANG a suite rather than fail it
 * (removing `countOccurrences`' empty-needle guard makes its `indexOf` loop
 * infinite), and an unbounded wait stalls the whole run in the one state where
 * the operator's instinct — Ctrl-C — lands between apply and restore.
 */
async function runTarget(target: MutationTarget, timeoutMs: number): Promise<SuiteOutcome & { durationMs: number }> {
  const abs = resolve(ROOT, target.file);
  const result = await runFileWithSignalRetry(
    abs,
    ROOT,
    { ...process.env, ...target.env },
    (args, opts) => Bun.spawn(args, { ...opts, timeout: timeoutMs }),
  );
  if (result.signalCode !== null) {
    // Bun reports a timed-out child as SIGTERM with a null exit code. Anything
    // at or past the bound is the timeout; anything short of it is a genuine
    // signal and must not be mislabelled as one.
    const timedOut = result.signalCode === "SIGTERM" && result.durationMs >= timeoutMs;
    return {
      pass: 0,
      fail: 0,
      skip: 0,
      durationMs: result.durationMs,
      error: timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s — the mutation HANGS the suite rather than failing it`
        : `killed by ${result.signalCode}`,
    };
  }
  return { ...parseBunSummary(result.stdout + result.stderr), durationMs: result.durationMs };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

async function measure(
  targets: readonly MutationTarget[],
  mutations: readonly Mutation[],
  baselines: ReadonlyMap<string, number>,
  timeouts: ReadonlyMap<string, number>,
): Promise<Map<string, Map<string, Cell>>> {
  const rows = new Map<string, Map<string, Cell>>();

  for (const [index, mutation] of mutations.entries()) {
    const position = `[${index + 1}/${mutations.length}]`;
    const cells = new Map<string, Cell>();
    rows.set(mutation.label, cells);

    try {
      applyMutation(mutation, ROOT, diskStore, backups);
    } catch (err) {
      restoreAll(diskStore, backups);
      if (!(err instanceof AnchorError)) throw err;
      // Not fatal to the run — one bad anchor should not cost the other 20
      // measurements — but it must never render as a number.
      console.error(`${position} ${RED}ANCHOR${RESET} ${mutation.label}\n         ${err.message}`);
      for (const target of targets) {
        cells.set(target.name, {
          kind: "error",
          fail: 0,
          flag: `ANCHOR: ${err.matches} matches`,
        });
      }
      continue;
    }

    try {
      for (const target of targets) {
        const outcome = await runTarget(target, timeouts.get(target.name) ?? SUITE_TIMEOUT_FLOOR_MS);
        const total = baselines.get(target.name) ?? 0;

        if (outcome.error !== undefined) {
          cells.set(target.name, { kind: "error", fail: 0, flag: outcome.error });
          console.error(
            `${position} ${RED}ERROR${RESET}  ${mutation.label} @ ${target.name}: ${outcome.error}`,
          );
          continue;
        }

        const whole = isWholeSuite(outcome.fail, total);
        cells.set(target.name, {
          kind: "count",
          fail: outcome.fail,
          flag: whole ? "whole-suite" : undefined,
        });

        const colour = outcome.fail === 0 ? YELLOW : GREEN;
        console.log(
          `${position} ${colour}${String(outcome.fail).padStart(3)}${RESET} ` +
            `${DIM}/${String(total).padEnd(3)}${RESET} ${target.name}  ${mutation.label}`,
        );
        if (whole) {
          console.warn(
            `        ${YELLOW}WARN${RESET}  ${outcome.fail} of ${total} tests failed — ` +
              "suspect the mutation broke suite SETUP rather than its subject. " +
              "Verify before publishing this number.",
          );
        }
      }
    } finally {
      restoreAll(diskStore, backups);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
const spec = await loadSpec(options.specPath);

if (options.files) {
  // Every file whose change could alter this spec's table: the suites that get
  // run, and the sources that get mutated. The spec itself is added by the
  // caller — it knows its own path and does not need us to echo it.
  const deps = new Set<string>();
  for (const t of spec.targets) deps.add(t.file);
  for (const m of spec.mutations) for (const e of m.edits) deps.add(e.file);
  for (const f of [...deps].sort()) console.log(f);
  process.exit(0);
}

const problems = validateSpec(spec);
if (problems.length > 0) fail(`invalid spec:\n  - ${problems.join("\n  - ")}`);

const targets =
  options.targets.length === 0
    ? spec.targets
    : spec.targets.filter(
        (t) => options.targets.includes(t.name) || options.targets.includes(t.file),
      );
if (targets.length === 0) {
  fail(`--target matched no target. Available: ${spec.targets.map((t) => t.name).join(", ")}`);
}

const mutations =
  options.only.length === 0
    ? spec.mutations
    : spec.mutations.filter((m) => options.only.some((needle) => m.label.includes(needle)));
if (mutations.length === 0) {
  fail(`--only matched no mutation in ${options.specPath}`);
}

const partial =
  targets.length !== spec.targets.length || mutations.length !== spec.mutations.length;

console.log(
  `${DIM}spec${RESET} ${options.specPath}  ` +
    `${DIM}targets${RESET} ${targets.map((t) => t.name).join(", ")}  ` +
    `${DIM}mutations${RESET} ${mutations.length}`,
);

// --- Baseline. Every count below is meaningless if this is not green. ---
const baselines = new Map<string, number>();
const timeouts = new Map<string, number>();
for (const target of targets) {
  // The baseline itself gets the floor: there is no measured duration to scale
  // off yet, and a baseline that hangs must not hang the run either.
  const outcome = await runTarget(target, options.timeoutMs ?? SUITE_TIMEOUT_FLOOR_MS);
  if (outcome.error !== undefined) {
    fail(`baseline for ${target.name} (${target.file}) did not run: ${outcome.error}`);
  }
  if (outcome.fail !== 0) {
    fail(
      `baseline for ${target.name} (${target.file}) is RED — ${outcome.fail} failing. ` +
        "Every mutation count would be this breakage plus the mutation's, which is " +
        "indistinguishable from a strong result. Fix the tree first.",
    );
  }
  // ⚠️ GUARDRAIL 4 — a baseline that SKIPPED tests is not a baseline (#5077).
  //
  // The three guardrails in the header all assume every test in the target ran.
  // A skipped test cannot be killed by a mutation, so each one silently deflates
  // the cell it would have contributed to — and unlike a red baseline, which
  // inflates and is caught above, this one DEFLATES and reads as honest.
  //
  // The measured instance is the one #5077 was filed for: with `TEST_DATABASE_URL`
  // unset, `identity-consumers-pg.test.ts` reports 6 pass / 72 skip / 0 fail, so
  // `subject-cmp.md` regenerated its real kills (3, 1, 1, 37, 29, 3, 66) as ZEROS
  // over a suite recorded as 6 instead of 78, with no warning anywhere.
  //
  // ⚠️ FAIL rather than flag-the-column, and fail BEFORE any mutation runs. The
  // write path is the dangerous one — `--check` merely reports a false "stale",
  // while a regenerate CLOBBERS numbers that were real — and both come through
  // here, so one guard at the baseline closes both. It also generalises past the
  // `-pg` case: any `.skip`/`.todo` a target picks up for any reason lands the
  // same deflation, and this refuses all of them rather than the one cause.
  if (outcome.skip !== 0) {
    fail(
      `baseline for ${target.name} (${target.file}) SKIPPED ${outcome.skip} of ` +
        `${outcome.pass + outcome.skip} tests. A skipped test cannot be killed by a mutation, ` +
        "so every count in this table would be silently deflated and the generated file would " +
        "overwrite real numbers with zeros.\n" +
        (process.env.TEST_DATABASE_URL === undefined
          ? "         TEST_DATABASE_URL is UNSET, which is almost certainly the cause: " +
            "*-pg.test.ts self-skips without it. Start Postgres (bun run db:up) and set it."
          : "         TEST_DATABASE_URL is set, so this is NOT the usual -pg cause — find " +
            "the .skip/.todo in the target before trusting any number from it."),
    );
  }
  baselines.set(target.name, outcome.pass);
  timeouts.set(target.name, options.timeoutMs ?? suiteTimeoutMs(outcome.durationMs));
  console.log(
    `${GREEN}baseline${RESET} ${target.name}: ${outcome.pass} pass, 0 fail ` +
      `${DIM}(${Math.round(outcome.durationMs)}ms, timeout ${Math.round((timeouts.get(target.name) ?? 0) / 1000)}s)${RESET}`,
  );
}

let rows: Map<string, Map<string, Cell>>;
try {
  rows = await measure(targets, mutations, baselines, timeouts);
} finally {
  // measure() restores per mutation; this covers a throw between apply and the
  // inner finally, and costs nothing when the map is already empty.
  restoreAll(diskStore, backups);
}

const markdown = render(spec, targets, mutations, baselines, rows, options.specPath);

if (partial) {
  // A filtered run measured a subset. Writing it would silently DELETE the rows
  // it did not measure — the exact staleness this tool exists to prevent, with
  // a generated-file header vouching for it.
  console.log(
    `\n${YELLOW}partial run${RESET} — not writing ${spec.out}. ` +
      "Drop --only/--target to regenerate the full table.\n",
  );
  console.log(markdown);
  process.exit(0);
}

const outAbs = resolve(ROOT, spec.out);
const existing = await Bun.file(outAbs)
  .text()
  .catch(() => null); // intentionally ignored: absent on first generation

if (options.check) {
  if (existing === markdown) {
    console.log(`\n${GREEN}CHECK OK${RESET} ${spec.out} is current.`);
    process.exit(0);
  }
  fail(
    `${spec.out} is stale. Regenerate: cd packages/api && bun run scripts/mutate.ts ${options.specPath}`,
  );
}

mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, markdown);
console.log(
  `\n${GREEN}wrote${RESET} ${relative(ROOT, outAbs)}` +
    (existing === markdown ? ` ${DIM}(unchanged)${RESET}` : ""),
);
