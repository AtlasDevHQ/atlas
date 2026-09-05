#!/usr/bin/env bun
/**
 * Merge per-shard `bun test --update-timings` maps into one balancer input (#5383).
 *
 * Under `--shard`, `--update-timings` writes ONLY the files that shard ran, so
 * the inputs are disjoint and their union is the whole suite. This does the
 * union, and — more importantly — REFUSES the merges that would quietly produce
 * a worse balancer than the stale file they replace:
 *
 *   - **A missing shard.** ⚠️ The one that is easy to miss, because it does not
 *     look like an error anywhere: a leg that died before any test body ran
 *     uploads NOTHING (`if-no-files-found: error`), so the glob yields three
 *     files, the merge succeeds, and a quarter of the suite is carried over from
 *     the stale baseline behind a printed warning — a partial refresh that reads
 *     as a complete one. Counting the files is the only thing that catches it,
 *     hence `--expect-shards`.
 *   - **An empty shard.** The same failure wearing a different shape, when the
 *     leg got far enough to write a file and no further.
 *   - **A collision between shards.** Disjointness is the premise. If two shards
 *     claim the same file, the composition did not match the one being measured
 *     under, and last-writer-wins would pick an arbitrary number.
 *   - **A sweep that ran without a database.** The `-pg` suites self-skip in
 *     milliseconds when `TEST_DATABASE_URL` is unset, and a refresh measured
 *     that way is well-formed JSON in which the hundred heaviest files are the
 *     lightest entries. ci.yml used to ask the operator to eyeball this on the
 *     artifact. The MEASURED `-pg` durations must have a median above
 *     `PG_MEDIAN_FLOOR_MS`: on runners with Postgres it is ~4.3s (104 suites,
 *     2026-09-04), without Postgres ~10ms, so 500ms sits an order of magnitude
 *     from either. Per-file floors do not work — ten real `-pg` suites
 *     legitimately finish under a second.
 *
 * A file present in the baseline but measured by no shard is carried over and
 * REPORTED rather than dropped: dropping it makes the balancer treat the file as
 * unknown, and coverage loss should be visible rather than inferred from a
 * smaller output.
 *
 * ⚠️ Bun rather than python3, though python3 is preinstalled on the runners and
 * this would need no setup step: CLAUDE.md's "bun only — package manager and
 * runtime" is the repo's one scripting runtime, and the workflow installs bun
 * for the measuring legs anyway. The merge job adds `install: "false"` because
 * this script has no dependencies.
 *
 * Usage:
 *   bun .github/scripts/merge-test-timings.ts \
 *     --out <path> --baseline <path> --expect-shards <n> <shard.json>...
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/** A bun timings file: per-test-file durations in ms. */
interface TimingsFile {
  readonly version: number;
  readonly files: Record<string, number>;
}

/**
 * Median of the measured `-pg` suite durations below this means the sweep had
 * no database. See the refusal list above for the two measured values it sits
 * between.
 */
const PG_MEDIAN_FLOOR_MS = 500;
const PG_SUITE = /-pg\.test\.ts$/;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  const lo = sorted[mid - 1];
  if (hi === undefined) die("median of nothing");
  return sorted.length % 2 === 0 && lo !== undefined ? (lo + hi) / 2 : hi;
}

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Read one timings file.
 *
 * Throws rather than exiting, so the caller decides what a bad file means —
 * `die` is reserved for the top level, where the message can say which of the
 * refusals above was tripped.
 */
function load(path: string): Record<string, number> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    die(`${path}: unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    die(`${path}: not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const files = (parsed as Partial<TimingsFile> | null)?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    die(`${path}: no 'files' object — not a bun timings file`);
  }
  return files as Record<string, number>;
}

function main(): void {
  const argv = process.argv.slice(2);
  const shards: string[] = [];
  let out: string | undefined;
  let baselinePath: string | undefined;
  let expectShards: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = argv[++i];
    else if (arg === "--baseline") baselinePath = argv[++i];
    else if (arg === "--expect-shards") expectShards = Number(argv[++i]);
    else if (arg !== undefined && arg.startsWith("--")) die(`unknown flag ${arg}`);
    else if (arg !== undefined) shards.push(arg);
  }

  if (out === undefined) die("--out is required");
  if (baselinePath === undefined) die("--baseline is required");
  if (expectShards === undefined || !Number.isInteger(expectShards) || expectShards < 1) {
    die("--expect-shards must be a positive integer");
  }

  // ⚠️ Read the baseline BEFORE anything is written. The workflow passes the
  // same path as --out and --baseline, so without this the carry-over below
  // would depend on statement order rather than on anything stated.
  const baseline = load(baselinePath);

  if (shards.length !== expectShards) {
    die(
      `expected ${expectShards} shard file(s), found ${shards.length} ` +
        `(${shards.map((p) => basename(p)).join(", ") || "none"}). A leg that died before ` +
        `any test body ran uploads no artifact, so its share of the suite would be carried ` +
        `over from the stale baseline and the refresh would read as complete. Re-run it.`,
    );
  }

  const merged = new Map<string, number>();
  const owner = new Map<string, string>();
  for (const path of shards) {
    const files = load(path);
    const names = Object.keys(files);
    if (names.length === 0) {
      die(
        `${path} measured 0 files. That leg produced no durations, so its share of the ` +
          `suite would silently keep the stale baseline. Re-run the refresh rather than ` +
          `committing a partial map.`,
      );
    }
    for (const [name, ms] of Object.entries(files)) {
      const claimed = owner.get(name);
      if (claimed !== undefined) {
        die(
          `${name} was measured by both ${claimed} and ${path}. The shards were not ` +
            `disjoint, so the composition did not match the one being measured under and ` +
            `the merge would be arbitrary.`,
        );
      }
      merged.set(name, ms);
      owner.set(name, path);
    }
    console.log(`  ${basename(path)}: ${names.length} files`);
  }

  // Only what the SHARDS measured counts here — the baseline carry-over below
  // would smuggle last refresh's real durations into this refusal's median.
  const measuredPg = [...merged].filter(([name]) => PG_SUITE.test(name)).map(([, ms]) => ms);
  if (measuredPg.length === 0) {
    die(
      `no -pg suite was measured by any shard. Either the sweep ran no Postgres suites or ` +
        `the naming convention moved; a balancer without them puts the heaviest files anywhere.`,
    );
  }
  const pgMedian = median(measuredPg);
  if (pgMedian < PG_MEDIAN_FLOOR_MS) {
    die(
      `median measured -pg suite duration is ${pgMedian}ms across ${measuredPg.length} suite(s), ` +
        `below the ${PG_MEDIAN_FLOOR_MS}ms floor. The sweep ran WITHOUT a database, so those ` +
        `suites self-skipped and recorded as the fastest files in the tree. Committing this would ` +
        `ship a balancer worse than the stale one. Check TEST_DATABASE_URL and the postgres service.`,
    );
  }
  console.log(`  -pg suites measured: ${measuredPg.length}, median ${pgMedian}ms`);

  const missing = Object.keys(baseline)
    .filter((name) => !merged.has(name))
    .sort();
  for (const name of missing) merged.set(name, baseline[name]!);

  console.log(`\nmerged ${merged.size} files from ${shards.length} shard(s)`);
  if (missing.length > 0) {
    console.log(
      `⚠️  ${missing.length} file(s) were in the baseline and measured by no shard — ` +
        `their OLD durations are carried over:`,
    );
    for (const name of missing.slice(0, 20)) console.log(`     ${name}`);
    if (missing.length > 20) console.log(`     … and ${missing.length - 20} more`);
  }

  const sorted = Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(out, `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

main();
