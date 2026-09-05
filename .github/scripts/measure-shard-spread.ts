#!/usr/bin/env bun
/**
 * Fail when the `api-tests` shards have drifted out of balance on `main`.
 *
 * `packages/api/scripts/test-timings.json` balances the four shards by measured
 * per-file duration, and it goes stale silently: nothing in the tree changes
 * when a PR adds six `-pg` suites the balancer has never seen. The imbalance
 * that prompted the 2026-09-04 refresh was found because someone happened to
 * read four job durations side by side. This turns that read into a
 * measurement that can fail.
 *
 * ## Why the median across runs, not one run
 *
 * A single green `main` run is the wrong instrument, and that was measured
 * before the threshold below was chosen: over 28 consecutive green runs on
 * 2026-09-03..05 the per-run max/min of the test step ranged 1.11x..2.41x, with
 * a FRESHLY rebalanced tree sitting at 1.30x and more than half the runs above
 * 1.3x. One slow runner puts one shard at 2x for one run and says nothing about
 * the balance. Runner noise lands on a random shard; imbalance lands on the
 * same shard every time. So the statistic is the PER-SHARD MEDIAN of the test
 * step's wall time over the last N green runs, and the spread is the ratio of
 * the heaviest shard's median to the lightest's. On the same 28 runs that
 * ratio was 1.31x for the pre-refresh tree.
 *
 * ## What is measured
 *
 * The `Test @atlas/api` STEP, not the job: the job carries ~50s of checkout,
 * install and SDK build that is the same on every shard and only compresses
 * the ratio. A run counts only if every shard's step completed successfully —
 * a cancelled leg (runner preemption, see #5383) is a runner loss, not a
 * duration, and is skipped with a note rather than folded into a median.
 *
 * Inputs are the GitHub jobs-list payloads, one file per run, as written by
 * `gh api repos/<r>/actions/runs/<id>/jobs --paginate --slurp` (an array of
 * pages) or a single page object. No dependencies: the workflow runs this
 * with `install: "false"`.
 *
 * Exit codes: 0 spread within threshold · 1 spread past threshold · 2 could
 * not measure (fewer usable runs than --min-runs, or an unreadable input).
 *
 * Usage:
 *   bun .github/scripts/measure-shard-spread.ts \
 *     [--threshold 1.5] [--min-runs 5] [--shards 4] \
 *     [--job-pattern '^api-tests \('] [--step-pattern '^Test @atlas/api'] \
 *     <jobs.json>...
 *
 * Adversarial fixtures: scripts/__tests__/measure-shard-spread.test.sh
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

interface Step {
  readonly name: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface Job {
  readonly run_id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly steps: readonly Step[];
}

interface Options {
  threshold: number;
  minRuns: number;
  shards: number;
  jobPattern: RegExp;
  stepPattern: RegExp;
  inputs: string[];
}

function die(message: string, code: 1 | 2): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    threshold: 1.5,
    minRuns: 5,
    shards: 4,
    jobPattern: /^api-tests \(/,
    stepPattern: /^Test @atlas\/api/,
    inputs: [],
  };
  const num = (flag: string, raw: string | undefined): number => {
    const n = Number(raw);
    if (raw === undefined || !Number.isFinite(n) || n <= 0) die(`${flag} needs a positive number`, 2);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--threshold") opts.threshold = num(arg, argv[++i]);
    else if (arg === "--min-runs") opts.minRuns = num(arg, argv[++i]);
    else if (arg === "--shards") opts.shards = num(arg, argv[++i]);
    else if (arg === "--job-pattern") opts.jobPattern = new RegExp(argv[++i] ?? die("--job-pattern needs a value", 2));
    else if (arg === "--step-pattern") opts.stepPattern = new RegExp(argv[++i] ?? die("--step-pattern needs a value", 2));
    else if (arg.startsWith("--")) die(`unknown flag ${arg}`, 2);
    else opts.inputs.push(arg);
  }
  if (opts.inputs.length === 0) die("no input files", 2);
  return opts;
}

/** Load one jobs payload: a slurped array of pages, or a single page. */
function loadJobs(path: string): Job[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err: unknown) {
    die(`${path}: unreadable or not JSON (${err instanceof Error ? err.message : String(err)})`, 2);
  }
  const pages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const jobs: Job[] = [];
  for (const page of pages) {
    const list = (page as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(list)) die(`${path}: no 'jobs' array — not a GitHub jobs-list payload`, 2);
    jobs.push(...(list as Job[]));
  }
  return jobs;
}

/** Shard index from a matrix job name like `api-tests (2/4)`. */
function shardOf(name: string): number | undefined {
  const m = /\((\d+)\/\d+\)/.exec(name);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function seconds(step: Step): number | undefined {
  if (step.conclusion !== "success" || step.started_at === null || step.completed_at === null) return undefined;
  const ms = Date.parse(step.completed_at) - Date.parse(step.started_at);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (hi === undefined) die("median of nothing", 2);
  return sorted.length % 2 === 0 && lo !== undefined ? (lo + hi) / 2 : hi;
}

/**
 * Per-shard test-step seconds for one run, or a reason the run is unusable.
 * Every shard must be present exactly once with a successful step.
 */
function measureRun(jobs: readonly Job[], opts: Options): { readonly perShard: number[] } | { readonly skip: string } {
  const perShard = new Array<number | undefined>(opts.shards).fill(undefined);
  for (const job of jobs) {
    if (!opts.jobPattern.test(job.name)) continue;
    const shard = shardOf(job.name);
    if (shard === undefined || shard < 1 || shard > opts.shards) return { skip: `job '${job.name}' is not shard 1..${opts.shards}` };
    const step = job.steps.find((s) => opts.stepPattern.test(s.name));
    if (step === undefined) return { skip: `${job.name} has no step matching ${opts.stepPattern}` };
    const secs = seconds(step);
    if (secs === undefined) return { skip: `${job.name} test step did not complete successfully (${step.conclusion ?? "no conclusion"})` };
    if (perShard[shard - 1] !== undefined) return { skip: `${job.name} appears twice` };
    perShard[shard - 1] = secs;
  }
  const missing = perShard.map((v, i) => (v === undefined ? i + 1 : undefined)).filter((v) => v !== undefined);
  if (missing.length > 0) return { skip: `shard(s) ${missing.join(", ")} absent` };
  return { perShard: perShard as number[] };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const runs: { id: string; perShard: number[] }[] = [];
  for (const path of opts.inputs) {
    const jobs = loadJobs(path);
    const id = jobs[0] === undefined ? basename(path) : String(jobs[0].run_id);
    const measured = measureRun(jobs, opts);
    if ("skip" in measured) {
      console.log(`  skip run ${id} (${basename(path)}): ${measured.skip}`);
      continue;
    }
    runs.push({ id, perShard: measured.perShard });
  }

  if (runs.length < opts.minRuns) {
    die(
      `only ${runs.length} usable run(s) of ${opts.inputs.length} input(s); need ${opts.minRuns}. ` +
        `A median over fewer runs is one slow runner wearing a trend.`,
      2,
    );
  }

  const medians = Array.from({ length: opts.shards }, (_, i) => median(runs.map((r) => r.perShard[i] ?? die("shard missing after validation", 2))));
  const heaviest = Math.max(...medians);
  const lightest = Math.min(...medians);
  const spread = heaviest / lightest;

  console.log(`\napi-tests shard spread over ${runs.length} green run(s):`);
  for (let i = 0; i < opts.shards; i++) {
    const samples = runs.map((r) => Math.round(r.perShard[i] ?? 0)).join(" ");
    console.log(`  shard ${i + 1}/${opts.shards}: median ${medians[i]?.toFixed(0)}s  (${samples})`);
  }
  console.log(`  spread: ${spread.toFixed(2)}x (heaviest median / lightest median), threshold ${opts.threshold.toFixed(2)}x`);

  if (spread > opts.threshold) {
    die(
      `shard spread ${spread.toFixed(2)}x exceeds ${opts.threshold.toFixed(2)}x. The balancer in ` +
        `packages/api/scripts/test-timings.json is stale. Regenerate it on runners: ` +
        `gh workflow run test-timings-refresh.yml --ref main`,
      1,
    );
  }
  console.log("  within threshold.");
}

main();
