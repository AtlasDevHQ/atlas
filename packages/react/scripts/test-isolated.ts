/**
 * Isolated test runner — spawns each test file in its own subprocess to
 * avoid bun's process-global mock.module() contamination.
 *
 * Usage: bun run scripts/test-isolated.ts [--concurrency N] [filter]
 */

import { Glob } from "bun";
import { cpus } from "node:os";
import { resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "src");

/** Per-file subprocess timeout in milliseconds (default: 60s). */
const FILE_TIMEOUT_MS = 60_000;

// --- CLI args ---
const args = process.argv.slice(2);
let concurrency = cpus().length;
let filter: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--concurrency" && args[i + 1]) {
    const parsed = parseInt(args[i + 1], 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      console.error(
        `Invalid --concurrency value: ${args[i + 1]} (must be a positive integer)`
      );
      process.exit(1);
    }
    concurrency = parsed;
    i++;
  } else if (!args[i].startsWith("-")) {
    filter = args[i];
  }
}

// --- Discover test files (.test.ts and .test.tsx) ---
const patterns = ["**/*.test.ts", "**/*.test.tsx"];
let files: string[] = [];
for (const pattern of patterns) {
  const glob = new Glob(pattern);
  for await (const path of glob.scan({ cwd: SRC, absolute: true })) {
    files.push(path);
  }
}
files.sort();

if (filter) {
  files = files.filter((f) => f.includes(filter));
}

if (files.length === 0) {
  if (filter) {
    console.log(`No test files matching filter "${filter}".`);
    process.exit(0);
  }
  console.error("No test files found — this likely indicates a configuration error.");
  process.exit(1);
}

console.log(
  `Running ${files.length} test files (concurrency: ${concurrency})\n`
);

// --- Run tests with bounded concurrency ---
interface Result {
  file: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

async function runFile(file: string): Promise<Result> {
  const start = performance.now();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bun", "test", file], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
  } catch (err) {
    const durationMs = performance.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      file,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to spawn subprocess: ${message}`,
      durationMs,
      timedOut: false,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, FILE_TIMEOUT_MS);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const durationMs = performance.now() - start;
    return {
      file,
      exitCode: timedOut ? 1 : exitCode,
      stdout,
      stderr: timedOut
        ? `${stderr}\nTest timed out after ${FILE_TIMEOUT_MS}ms`
        : stderr,
      durationMs,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

const results: Result[] = [];
const queue = [...files];
const active = new Set<Promise<void>>();

async function scheduleNext(): Promise<void> {
  if (queue.length === 0) return;
  const file = queue.shift()!;
  const p = runFile(file)
    .then((result) => {
      results.push(result);
      const rel = relative(ROOT, result.file);
      const tag = result.timedOut ? "\x1b[33mTIME\x1b[0m" : "";
      const status =
        result.exitCode === 0
          ? "\x1b[32mPASS\x1b[0m"
          : "\x1b[31mFAIL\x1b[0m";
      const ms = result.durationMs.toFixed(0);
      console.log(`  ${status}  ${rel}  (${ms}ms)${tag ? `  ${tag}` : ""}`);

      if (result.exitCode !== 0) {
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
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        file,
        exitCode: 1,
        stdout: "",
        stderr: `Runner error: ${message}`,
        durationMs: 0,
        timedOut: false,
      });
      console.log(
        `  \x1b[31mFAIL\x1b[0m  ${relative(ROOT, file)}  (runner error)`
      );
      console.log(`    ${message}\n`);
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

// --- Verify all files produced results ---
if (results.length < files.length) {
  const missing = files.filter((f) => !results.some((r) => r.file === f));
  console.error(
    `\nRunner error: ${missing.length} file(s) produced no result:`
  );
  for (const f of missing) {
    console.error(`  ${relative(ROOT, f)}`);
  }
  process.exit(1);
}

// --- Summary ---
const passed = results.filter((r) => r.exitCode === 0).length;
const failed = results.filter((r) => r.exitCode !== 0).length;
const totalMs = results.reduce((s, r) => s + r.durationMs, 0).toFixed(0);

console.log("\n" + "\u2500".repeat(60));
console.log(
  `  Files: ${results.length}  |  ` +
    `\x1b[32mPassed: ${passed}\x1b[0m  |  ` +
    (failed > 0 ? `\x1b[31mFailed: ${failed}\x1b[0m` : `Failed: 0`) +
    `  |  Time: ${totalMs}ms`
);
console.log("\u2500".repeat(60));

if (failed > 0) {
  console.log("\nFailed files:");
  for (const r of results.filter((r) => r.exitCode !== 0)) {
    console.log(`  \x1b[31m\u2717\x1b[0m ${relative(ROOT, r.file)}`);
  }
  process.exit(1);
}

process.exit(0);
