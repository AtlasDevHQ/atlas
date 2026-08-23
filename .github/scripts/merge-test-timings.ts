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
