/**
 * Isolated test runner — spawns each test file in its own subprocess to
 * avoid bun's process-global mock.module() contamination.
 *
 * Usage: bun run scripts/test-isolated.ts [--concurrency N] [--shard N/M] [filter]
 *
 * --shard N/M partitions the sorted file list round-robin (file index % M == N-1).
 * Round-robin spreads slow files statistically across shards without a
 * profiling pass — CI uses it to fan the api test suite across parallel jobs.
 */

import { Glob } from "bun";
import { cpus } from "node:os";
import { resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "src");

// --- CLI args ---
const args = process.argv.slice(2);
let concurrency = cpus().length;
let filter: string | undefined;
let shardIndex = 0;
let shardTotal = 1;

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
  } else if (!args[i].startsWith("-")) {
    filter = args[i];
  }
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

const totalFiles = files.length;
if (shardTotal > 1) {
  files = files.filter((_, i) => i % shardTotal === shardIndex);
}

if (files.length === 0) {
  console.log("No test files found.");
  process.exit(0);
}

const shardLabel =
  shardTotal > 1 ? ` (shard ${shardIndex + 1}/${shardTotal} of ${totalFiles} total)` : "";
console.log(
  `Running ${files.length} test files (concurrency: ${concurrency})${shardLabel}\n`,
);

// --- Run tests with bounded concurrency ---
interface Result {
  file: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function runFile(file: string): Promise<Result> {
  const start = performance.now();
  const proc = Bun.spawn(["bun", "test", file], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  const durationMs = performance.now() - start;
  return { file, exitCode, stdout, stderr, durationMs };
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
const totalMs = results.reduce((s, r) => s + r.durationMs, 0).toFixed(0);

console.log("\n" + "─".repeat(60));
console.log(
  `  Files: ${results.length}  |  ` +
    `\x1b[32mPassed: ${passed}\x1b[0m  |  ` +
    (failed > 0 ? `\x1b[31mFailed: ${failed}\x1b[0m` : `Failed: 0`) +
    `  |  Time: ${totalMs}ms`
);
console.log("─".repeat(60));

if (failed > 0) {
  console.log("\nFailed files:");
  for (const r of results.filter((r) => r.exitCode !== 0)) {
    console.log(`  \x1b[31m✗\x1b[0m ${relative(ROOT, r.file)}`);
  }
  process.exit(1);
}
