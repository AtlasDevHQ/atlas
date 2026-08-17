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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { runFileWithSignalRetry } from "./signal-retry";
import {
  AnchorError,
  applyMutation,
  baselineProblem,
  deflationProblem,
  diskStore,
  importCandidates,
  importSpecifiers,
  isWholeSuite,
  parseBunSummary,
  render,
  restoreAll,
  suiteTimeoutMs,
  SUITE_TIMEOUT_FLOOR_MS,
  unmeasuredRows,
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
   * could actually have invalidated. The full sweep is ~16 min measured at
   * thirteen specs (`check-mutation-tables.sh`'s header carries both data
   * points) — more
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

/** Whether `abs` is a regular file. False for a directory, or for nothing. */
function isFile(abs: string): boolean {
  if (!existsSync(abs)) return false;
  try {
    return statSync(abs).isFile();
  } catch (err) {
    // A path we cannot stat is a path we cannot claim as a dependency. Logged
    // rather than swallowed: an EACCES here means the selector is silently
    // narrower than it reads, which is this gate's one unacceptable failure.
    console.warn(`${YELLOW}warn${RESET}  cannot stat ${abs}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
async function runTarget(
  target: MutationTarget,
  timeoutMs: number,
  // ⚠️ The baseline runs through here too, and there is NO mutation applied
  // then — so the timeout text below must not say there is. Measured: a loaded
  // machine timed out a 113ms baseline and the runner reported "the mutation
  // HANGS the suite", sending the operator to audit a spec that was fine.
  phase: "baseline" | "mutation" = "mutation",
): Promise<SuiteOutcome & { durationMs: number; timedOut?: true }> {
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
      todo: 0,
      ran: null,
      durationMs: result.durationMs,
      // ⚠️ RETURNED AS A FLAG, not left to be recovered from the prose below.
      // `measure()` has to tell the ONE committable no-count outcome (a real
      // hang) from every uncommittable one, and a substring match over
      // free-form prose is exactly the discrimination #5077's `flag` +
      // `anchorFailed` pair failed to make. A killed-by-SIGKILL run reads as a
      // timeout to any reasonable regex and measured nothing.
      ...(timedOut ? { timedOut: true as const } : {}),
      error: timedOut
        ? phase === "baseline"
          ? `timed out after ${Math.round(timeoutMs / 1000)}s on the UNMUTATED tree — no mutation ` +
            "was applied, so the suite is slower than the floor or the machine is loaded"
          : `timed out after ${Math.round(timeoutMs / 1000)}s — the mutation HANGS the suite rather than failing it`
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
        // `unmeasured`, so the run REFUSES this rather than rendering it as a
        // stable byte that `--check` then blesses forever. One of four members
        // of that class; the discriminant is what the refusal reads.
        cells.set(target.name, { kind: "unmeasured", reason: `ANCHOR: ${err.matches} matches` });
      }
      continue;
    }

    try {
      for (const target of targets) {
        const outcome = await runTarget(target, timeouts.get(target.name) ?? SUITE_TIMEOUT_FLOOR_MS);
        const total = baselines.get(target.name) ?? 0;

        if (outcome.error !== undefined) {
          // ⚠️ THE TIMEOUT CARVE-OUT, and it is the only one. A hang is a real
          // measurement of a real hang — `mutation-core.md` publishes exactly
          // such a cell for the empty-needle row and that byte is honest. Every
          // other no-count outcome (a compile error, a kill by some other
          // signal) measured NOTHING and must not reach the file.
          cells.set(
            target.name,
            outcome.timedOut === true
              ? { kind: "error", flag: outcome.error }
              : { kind: "unmeasured", reason: outcome.error },
          );
          console.error(
            `${position} ${RED}ERROR${RESET}  ${mutation.label} @ ${target.name}: ${outcome.error}`,
          );
          continue;
        }

        // ⚠️ A MUTATED RUN THAT SKIPPED TESTS HAS A DEFLATED COUNT (#5097).
        //
        // `baselineProblem` catches this on the clean tree, but a mutation can
        // introduce it: an edit that makes a `describe.skipIf(...)` predicate
        // false, or one that breaks the import a suite's own gate reads, skips
        // tests the baseline ran. The count is then real-looking and smaller
        // than the truth. #5077 detected this and merely FLAGGED it — and by
        // the runner's own criterion a skip measured nothing, so it belongs on
        // the refuse side. It was then removed rather than shipped, which is
        // why today's runner writes the deflated number with no warning at all.
        const deflation = deflationProblem(outcome);
        if (deflation !== null) {
          cells.set(target.name, { kind: "unmeasured", reason: deflation.cell });
          console.error(
            `${position} ${RED}SKIP${RESET}   ${mutation.label} @ ${target.name}: ${deflation.message}`,
          );
          continue;
        }

        const whole = isWholeSuite(outcome.fail, total);
        cells.set(
          target.name,
          whole
            ? { kind: "count", fail: outcome.fail, wholeSuite: true }
            : { kind: "count", fail: outcome.fail },
        );

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

const problems = validateSpec(spec);
if (problems.length > 0) fail(`invalid spec:\n  - ${problems.join("\n  - ")}`);

if (options.files) {
  // ⚠️ AFTER `validateSpec`, not before. A spec with an empty `edits` array is
  // a validation problem AND emits a dependency list missing that source file —
  // so `--affected` would not select it, `--check` would never run, and the log
  // would read "nothing to verify", which is indistinguishable from a clean run.
  // A broken spec must fail loudly here rather than quietly under-select.
  const deps = new Set<string>();
  const seeds: string[] = [];
  for (const t of spec.targets) {
    deps.add(t.file);
    seeds.push(t.file);
  }
  for (const m of spec.mutations) {
    for (const e of m.edits) {
      deps.add(e.file);
      seeds.push(e.file);
    }
  }
  // ⚠️ ONE HOP THROUGH THE SEEDS' IMPORTS, and the hole it closes is the one
  // this list advertises and did not cover (#5097).
  //
  // A spec's corpus is a SEPARATE file the target imports —
  // `__tests__/identity-corpus.ts`, `__tests__/alias-proposal-corpus.ts`, and
  // six more. Those are the highest-risk dependencies in the whole set, because
  // they are data-driven inputs (`for (const c of AGREEMENT_CORPUS) test(...)`):
  // adding one row changes both the published suite size AND every kill count.
  // Missing them meant a corpus-only PR selected NO spec and the gate printed
  // "nothing to verify" — for exactly the edit shape it was built to catch.
  //
  // ⚠️ ONE hop, not the transitive closure, and that bound is deliberate.
  // Following imports all the way reaches `db/`, `effect/` and half the app
  // from any `-pg` target, so every PR would select every spec and the sweep
  // costs minutes-not-seconds (see `check-mutation-tables.sh`'s header). This
  // gate's cost is a correctness property: one that doubles the pre-PR loop gets
  // disabled inside a week, and a disabled gate catches nothing. Remote CI's
  // `--all` on every push to main is the backstop for the deeper graph.
  for (const seed of seeds) {
    const abs = resolve(ROOT, seed);
    // A missing seed is a broken spec, not a reason to abort: `validateSpec`
    // above already passed, and an unreadable target will surface loudly at the
    // baseline. Selecting fewer files here would be the silent failure.
    if (!existsSync(abs)) continue;
    for (const specifier of importSpecifiers(readFileSync(abs, "utf8"))) {
      for (const candidate of importCandidates(seed, specifier)) {
        // ⚠️ `isFile`, not `existsSync` alone. `./__tests__/vocabulary` is a
        // real DIRECTORY under several targets, and the extension-less
        // candidate would match it — putting a directory path in a list git
        // never emits, so the `/index.ts` candidate behind it never got tried
        // and the real file stayed unselected.
        if (isFile(resolve(ROOT, candidate))) {
          deps.add(candidate);
          break;
        }
      }
    }
  }
  // ⚠️ The GENERATED TABLE is a dependency of its own verdict. Without it, a
  // hand-edited `.md` — bumping a number so it "matches" — selects no spec and
  // the gate prints "nothing to verify". That hand-edit is #5060's original
  // threat model, so omitting it left the gate blind to the exact input it was
  // built for.
  deps.add(spec.out);
  for (const f of [...deps].sort()) console.log(f);
  process.exit(0);
}

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
  const outcome = await runTarget(target, options.timeoutMs ?? SUITE_TIMEOUT_FLOOR_MS, "baseline");
  // ⚠️ GUARDRAIL 4 — every way a baseline can lie, in ONE tested function.
  //
  // The three guardrails in the header all assume every test in the target ran.
  // A red baseline INFLATES and was always caught; a deflated one reads as
  // honest, which is the #5077 case: with `TEST_DATABASE_URL` unset,
  // `identity-consumers-pg.test.ts` reports 6 pass / 72 skip / 0 fail, so
  // `subject-cmp.md` regenerated its real kills as ZEROS over a suite recorded
  // as 6 rather than 78, with no warning anywhere.
  //
  // ⚠️ The decision lives in `mutation-core.ts` as `baselineProblem`, NOT
  // inline here, and that is this module's own stated split — guardrails 1-3
  // are pure tested functions and only the PROCESS is in this file. Written
  // inline, guardrail 4 could be deleted whole and every test stayed green and
  // every table regenerated byte-identically. Measured, and the reason it moved.
  //
  // Fails BEFORE any mutation runs, so one guard closes both directions:
  // `--check` cannot report a false "stale", and a regenerate cannot clobber
  // numbers that were real.
  const problem = baselineProblem(outcome);
  if (problem !== null) {
    // ⚠️ Truthiness, not `=== undefined`. The suites gate on
    // `TEST_DB_URL ? describe : describe.skip`, so an EXPORTED-EMPTY variable
    // skips them for the ordinary `-pg` reason while `=== undefined` reported
    // "this is NOT the usual cause" and sent the operator hunting a `.skip`
    // that does not exist. `check-mutation-tables.sh` already uses `-z`; these
    // two must agree.
    // ⚠️ ONLY the deflation arms get the -pg hint. A RED or ERRORED baseline
    // told to "find the .skip/.todo" sends the operator hunting something that
    // is not there — measured on this very change, when a dead Postgres made
    // two suites RED and the runner blamed a skip.
    const deflation = problem.kind === "deflated" || problem.kind === "unaccounted";
    const pgHint = !deflation
      ? ""
      : process.env.TEST_DATABASE_URL === undefined || process.env.TEST_DATABASE_URL === ""
        ? "\n         TEST_DATABASE_URL is UNSET (or empty), which is almost certainly the " +
          "cause: *-pg.test.ts self-skips without it. Start Postgres (bun run db:up) and set it."
        : "\n         TEST_DATABASE_URL is set, so this is NOT the usual -pg cause — find the " +
          ".skip/.todo in the target before trusting any number from it.";
    fail(`baseline for ${target.name} (${target.file}) ${problem.message}${pgHint}`);
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

// ⚠️ A CELL THAT MEASURED NOTHING IS NOT A RESULT, and it must never become a
// committed byte. ONE refusal for the whole class (#5097).
//
// Guardrail 2 calls a 0-match "a number for a mutation that was never
// performed, which is worse than reporting nothing" — but `--check` compares
// BYTES, so once `⚠️ ANCHOR: 0 matches` is in the file it IS the expected
// output and the table passes forever. Measured on the change that added the
// first version of this refusal: a new field on `SuiteOutcome` rotted the
// anchor mirroring that literal, the table regenerated with a tombstone where a
// measured `2` had been, and `--check` said `CHECK OK`.
//
// ⚠️ That first version refused on ONE member — a dead anchor — and the class
// has four. A mutated run that skips tests, one whose buckets do not account
// for what bun ran, and one whose suite failed to compile all produced an
// honest-looking cell that `--check` blessed forever. Refusing on
// `Cell.kind === "unmeasured"` rather than on any particular cause is what
// makes a fifth member refused by construction: the union has nowhere else to
// put "nothing was measured".
//
// `measure()` still keeps going after an `AnchorError` — one bad anchor should
// not cost the other twenty measurements — so this refuses at the END, naming
// every affected row at once, each with its own reason.
//
// ⚠️ Deliberately NOT gated on `--check`. The write path is the one that
// PRODUCES the tombstone; refusing only on check would let a regenerate commit
// it and the next check bless it.
const unmeasured = unmeasuredRows(rows);
if (unmeasured.length > 0) {
  fail(
    `${unmeasured.length} mutation(s) in ${options.specPath} MEASURED NOTHING, so no number of ` +
      "theirs can be published:\n" +
      unmeasured.map(({ label, reason }) => `           - ${label} — ${reason}`).join("\n") +
      "\n         Repair the spec (a dead anchor) or the tree (a skipped, unaccounted or " +
      "uncompilable suite). Writing this table would record a tombstone where a real number " +
      "belongs, and every later --check would accept it as current.",
  );
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
