/**
 * Isolated test runner — spawns each test file in its own subprocess to
 * avoid bun's process-global mock.module() contamination.
 *
 * Usage:
 *   bun run scripts/test-isolated.ts [--concurrency N] [--shard N/M] [filter]
 *   bun run scripts/test-isolated.ts --affected [--since <ref>]
 *
 * --shard N/M partitions the sorted file list round-robin (file index % M == N-1).
 * Round-robin spreads slow files statistically across shards without a
 * profiling pass — CI uses it to fan the api test suite across parallel jobs.
 *
 * --affected runs only the tests whose source graph was touched on the
 * current branch. `--since <ref>` sets the base (default: origin/main) and
 * implies --affected. Use this locally to tighten the edit/test loop —
 * typical PRs drop from 4 min to 10–30 s.
 */

import { Glob } from "bun";
import { cpus } from "node:os";
import { resolve, relative } from "node:path";
import { runFileWithSignalRetry } from "./signal-retry";
import { collectAffectedTests } from "./affected";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "src");

// --- CLI args ---
const args = process.argv.slice(2);
let concurrency = cpus().length;
let filter: string | undefined;
let shardIndex = 0;
let shardTotal = 1;
let affected = false;
let since = "origin/main";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--concurrency" && args[i + 1]) {
    concurrency = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--shard" && args[i + 1]) {
    const match = args[i + 1].match(/^(\d+)\/(\d+)$/);
    if (!match) {
      console.error(`Invalid --shard value: ${args[i + 1]}. Expected N/M.`);
      process.exit(1);
    }
    const n = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (m < 1 || n < 1 || n > m) {
      console.error(`Invalid --shard value: ${args[i + 1]}. Expected 1 <= N <= M.`);
      process.exit(1);
    }
    shardIndex = n - 1;
    shardTotal = m;
    i++;
  } else if (args[i] === "--affected") {
    affected = true;
  } else if (args[i] === "--since" && args[i + 1]) {
    since = args[i + 1];
    affected = true;
    i++;
  } else if (!args[i].startsWith("-")) {
    filter = args[i];
  }
}

// --- Affected-mode helpers ---
async function gitLines(...cmd: string[]): Promise<string[]> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.exitCode !== 0) {
    // Fail loud. A silent empty result here would make --affected report
    // "nothing to test" and exit 0 — hiding the real problem (unfetched
    // base ref, shallow clone, typo in --since).
    throw new Error(
      `git ${cmd.slice(1).join(" ")} failed (exit ${proc.exitCode}): ${err.trim() || "<no stderr>"}`,
    );
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

// The repo root — what git's `--name-only` paths are relative to. Asked of git
// rather than derived as `resolve(ROOT, "../..")` so a package move can't
// silently reintroduce the path-doubling bug this replaced (#4851).
async function gitRepoRoot(): Promise<string> {
  const [top] = await gitLines("git", "rev-parse", "--show-toplevel");
  if (!top) throw new Error("git rev-parse --show-toplevel returned no output");
  return top;
}

// All repo files changed on the branch: committed since base + staged +
// unstaged + untracked. Paths are repo-root-relative.
async function collectChangedFiles(base: string): Promise<string[]> {
  const out = new Set<string>();
  const buckets = await Promise.all([
    gitLines("git", "diff", "--name-only", `${base}...HEAD`),
    gitLines("git", "diff", "--name-only", "HEAD"),
    gitLines("git", "ls-files", "--others", "--exclude-standard"),
  ]);
  for (const bucket of buckets) for (const f of bucket) out.add(f);
  return [...out];
}

// --- Discover test files ---
const glob = new Glob("**/*.test.ts");
let files: string[] = [];
for await (const path of glob.scan({ cwd: SRC, absolute: true })) {
  files.push(path);
}
files.sort();

if (filter) {
  files = files.filter((f) => f.includes(filter));
}

if (affected) {
  const [repoRoot, changed] = await Promise.all([gitRepoRoot(), collectChangedFiles(since)]);
  if (changed.length === 0) {
    console.log(`No changed files vs ${since} — nothing to test.`);
    process.exit(0);
  }
  const testSet = new Set(files);
  files = collectAffectedTests(changed, testSet, {
    repoRoot,
    packageRoot: ROOT,
    srcRoot: SRC,
  });
  if (files.length === 0) {
    console.log(
      `Affected-mode: ${changed.length} changed files vs ${since}, but no tests import them.\n` +
        `  Hint: run without --affected for a full suite if you just touched infrastructure.`,
    );
    process.exit(0);
  }
  files.sort();
}

const totalFiles = files.length;
if (shardTotal > 1) {
  files = files.filter((_, i) => i % shardTotal === shardIndex);
}

if (files.length === 0) {
  console.log("No test files found.");
  process.exit(0);
}

const modeLabel = affected ? ` (--affected vs ${since})` : "";
const shardLabel =
  shardTotal > 1 ? ` (shard ${shardIndex + 1}/${shardTotal} of ${totalFiles} total)` : "";
console.log(
  `Running ${files.length} test files (concurrency: ${concurrency})${modeLabel}${shardLabel}\n`,
);

// --- Run tests with bounded concurrency ---
// Signal-aware retry logic is in ./signal-retry.ts (exported for unit tests).

type Result = Awaited<ReturnType<typeof runFileWithSignalRetry>>;

async function runFile(file: string): Promise<Result> {
  return runFileWithSignalRetry(file, ROOT, { ...process.env, FORCE_COLOR: "1" });
}

const results: Result[] = [];
const queue = [...files];
const active = new Set<Promise<void>>();

async function scheduleNext(): Promise<void> {
  if (queue.length === 0) return;
  const file = queue.shift()!;
  const p = runFile(file).then((result) => {
    results.push(result);
    const rel = relative(ROOT, result.file);
    const status = result.exitCode === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    const ms = result.durationMs.toFixed(0);
    console.log(`  ${status}  ${rel}  (${ms}ms)`);

    if (result.exitCode !== 0) {
      // Print failure output indented
      const output = (result.stdout + result.stderr).trim();
      if (output) {
        for (const line of output.split("\n")) {
          console.log(`    ${line}`);
        }
        console.log();
      }
    }

    active.delete(p);
    return scheduleNext();
  });
  active.add(p);
}

// Seed initial batch
for (let i = 0; i < concurrency && queue.length > 0; i++) {
  await scheduleNext();
}

// Wait for all to finish
while (active.size > 0) {
  await Promise.race(active);
}

// --- Summary ---
const passed = results.filter((r) => r.exitCode === 0).length;
const failed = results.filter((r) => r.exitCode !== 0).length;
const totalRetries = results.reduce((s, r) => s + r.retries, 0);
const totalMs = results.reduce((s, r) => s + r.durationMs, 0).toFixed(0);

console.log("\n" + "─".repeat(60));
console.log(
  `  Files: ${results.length}  |  ` +
    `\x1b[32mPassed: ${passed}\x1b[0m  |  ` +
    (failed > 0 ? `\x1b[31mFailed: ${failed}\x1b[0m` : `Failed: 0`) +
    (totalRetries > 0 ? `  |  \x1b[33mSignal retries: ${totalRetries}\x1b[0m` : "") +
    `  |  Time: ${totalMs}ms`,
);
console.log("─".repeat(60));

if (failed > 0) {
  console.log("\nFailed files:");
  for (const r of results.filter((r) => r.exitCode !== 0)) {
    const sigSuffix = r.signalCode !== null ? ` (killed by ${r.signalCode})` : "";
    console.log(`  \x1b[31m✗\x1b[0m ${relative(ROOT, r.file)}${sigSuffix}`);
  }
  process.exit(1);
}
