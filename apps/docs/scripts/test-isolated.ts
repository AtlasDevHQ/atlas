/**
 * Isolated test runner — spawns each test file in its own subprocess, so bun's
 * process-global `mock.module()` cannot leak across files (#5247).
 *
 * `apps/docs`'s `test` script was `bun test src/lib/__tests__` — bare `bun test`
 * against a directory, which CLAUDE.md and `.claude/rules/testing.md` both
 * forbid. Nothing was broken by it *yet*: no suite here calls `mock.module`
 * today, which is a fact about content, not about reach. The whole point of the
 * per-file spawn is that the first suite to reach for a module mock does not
 * silently take the other eight with it, and a runner added after that happens
 * is a runner added to debug it.
 *
 * Mirrors the sibling runners (`packages/web`, `packages/mcp`) rather than
 * inventing a shape. Trimmed of `--shard` / `--affected`, which the api runner
 * carries because its suite is large; this one is nine files and ~3s.
 *
 * Usage: bun run scripts/test-isolated.ts [--concurrency N] [filter]
 */

import { Glob, type Subprocess } from "bun";
import { cpus } from "node:os";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "src");

/** Per-file subprocess timeout in milliseconds. The slowest suite here is ~1s. */
const FILE_TIMEOUT_MS = 60_000;

// --- CLI args ---
const args = process.argv.slice(2);
let concurrency = cpus().length;
let filter: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--concurrency" && args[i + 1]) {
    const parsed = parseInt(args[i + 1] ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      console.error(`Invalid --concurrency value: ${args[i + 1]} (must be a positive integer)`);
      process.exit(1);
    }
    concurrency = parsed;
    i++;
  } else if (args[i]?.startsWith("-") === false) {
    filter = args[i];
  }
}

// --- Discover test files ---
// `.tsx` as well as `.ts`: `audience-conditionals.test.tsx` is a real suite here,
// and a `.ts`-only glob would drop it while still printing a green summary.
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
  // ⚠️ Exit 1, not 0. An unfiltered run that discovers nothing means the glob or
  // the layout moved — a runner that reports success on an empty set is the
  // vacuous-pass shape this repo refuses elsewhere (`scripts/test-others.ts`
  // takes the same line for the same reason).
  console.error("No test files found — this likely indicates a configuration error.");
  process.exit(1);
}

console.log(`Running ${files.length} test files (concurrency: ${concurrency})\n`);

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

  // ⚠️ Annotated with the PIPED stream kinds, not `ReturnType<typeof Bun.spawn>`.
  // The bare `ReturnType` widens `proc.stdout` back to
  // `number | ReadableStream | undefined` — the union over every stdio mode — and
  // `new Response(proc.stdout)` then does not type-check. `apps/docs`'s tsconfig
  // includes `scripts/**/*.ts`, so unlike the sibling runners this file is inside
  // `bun run type`; the annotation is what keeps it there.
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bun", "test", file], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      file,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to spawn subprocess: ${message}`,
      durationMs: performance.now() - start,
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
    return {
      file,
      exitCode: timedOut ? 1 : exitCode,
      stdout,
      stderr: timedOut ? `${stderr}\nTest timed out after ${FILE_TIMEOUT_MS}ms` : stderr,
      durationMs: performance.now() - start,
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
  const file = queue.shift();
  if (file === undefined) return;
  const p = runFile(file)
    .then((result) => {
      results.push(result);
      const rel = relative(ROOT, result.file);
      const status = result.exitCode === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      const tag = result.timedOut ? "  \x1b[33mTIME\x1b[0m" : "";
      console.log(`  ${status}  ${rel}  (${result.durationMs.toFixed(0)}ms)${tag}`);

      if (result.exitCode !== 0) {
        const output = (result.stdout + result.stderr).trim();
        if (output) {
          for (const line of output.split("\n")) console.log(`    ${line}`);
          console.log();
        }
      }

      active.delete(p);
      return scheduleNext();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        file,
        exitCode: 1,
        stdout: "",
        stderr: `Runner error: ${message}`,
        durationMs: 0,
        timedOut: false,
      });
      console.log(`  \x1b[31mFAIL\x1b[0m  ${relative(ROOT, file)}  (runner error)`);
      console.log(`    ${message}\n`);
      active.delete(p);
      return scheduleNext();
    });
  active.add(p);
}

for (let i = 0; i < concurrency && queue.length > 0; i++) await scheduleNext();
while (active.size > 0) await Promise.race(active);

// --- Verify every discovered file produced a result ---
// Without this a scheduling bug drops files silently and the summary below is
// computed over whatever survived, which reads as a pass on a smaller suite.
if (results.length < files.length) {
  const missing = files.filter((f) => !results.some((r) => r.file === f));
  console.error(`\nRunner error: ${missing.length} file(s) produced no result:`);
  for (const f of missing) console.error(`  ${relative(ROOT, f)}`);
  process.exit(1);
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
    `  |  Time: ${totalMs}ms`,
);
console.log("─".repeat(60));

if (failed > 0) {
  console.log("\nFailed files:");
  for (const r of results.filter((r) => r.exitCode !== 0)) {
    console.log(`  \x1b[31m✗\x1b[0m ${relative(ROOT, r.file)}`);
  }
  process.exit(1);
}

process.exit(0);
