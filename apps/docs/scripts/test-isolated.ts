/**
 * Isolated test runner — spawns each test file in its own subprocess, so bun's
 * process-global `mock.module()` cannot leak across files (#5247).
 *
 * `apps/docs`'s `test` script was `bun test src/lib/__tests__` — bare `bun test`
 * against a directory, which CLAUDE.md and `.claude/rules/testing.md` both
 * forbid. Nothing was broken by it *yet*: no suite here calls `mock.module`
 * today, which is a fact about content, not about reach. The whole point of the
 * per-file spawn is that the first suite to reach for a module mock does not
 * silently take the other eight with it.
 *
 * Mirrors the sibling runners (`packages/web`, `packages/mcp`) rather than
 * inventing a shape. Trimmed of `--shard` / `--affected`, which the api runner
 * carries because its suite is large; this one is nine files and under a second.
 *
 * Usage: bun run scripts/test-isolated.ts [--concurrency N] [filter]
 */

import { Glob, type Subprocess } from "bun";
import { cpus } from "node:os";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "src");

/** Per-file subprocess timeout in milliseconds. The slowest suite here is under 200ms. */
const FILE_TIMEOUT_MS = 60_000;

// --- CLI args ---
const args = process.argv.slice(2);
let concurrency = cpus().length;
let filter: string | undefined;

// ⚠️ AN UNKNOWN FLAG IS FATAL.
//
// The first cut silently dropped anything it did not recognise, so
// `--affected` printed `Running 9 test files` and a green summary — a FULL run
// reported as an affected run. That matters more here than the usual CLI nit:
// this runner deliberately omits `--affected`/`--shard` (they are the api
// runner's), while CLAUDE.md and `/ship-issue` — edited in this same PR — train
// every agent to type `bun run scripts/test-isolated.ts --affected`. Silence is
// the one response that produces a wrong pre-flight with no signal.
//
// A valueless `--concurrency` fell through both branches for the same reason
// (`"--concurrency".startsWith("-")` is true), silently keeping the default.
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined) continue;
  if (arg === "--concurrency") {
    const raw = args[i + 1];
    if (raw === undefined || raw.startsWith("-")) {
      console.error("--concurrency requires a value (a positive integer).");
      process.exit(1);
    }
    // `Number`, not `parseInt`: `parseInt("4abc", 10)` is `4`, so a typo'd value
    // would be silently accepted at a different concurrency than the one typed.
    // The digit test comes first because `Number` is looser in the other
    // direction — `Number.isInteger` passes `1e3` (1000 subprocesses), `0x20`
    // and `" 4 "`, against a message promising "a positive integer".
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`Invalid --concurrency value: ${raw} (must be a positive integer)`);
      process.exit(1);
    }
    concurrency = parsed;
    i++;
  } else if (arg.startsWith("-")) {
    console.error(
      `Unknown flag: ${arg}. This runner takes [--concurrency N] [filter] only — ` +
        `--affected and --shard belong to packages/api's runner, not this one.`,
    );
    process.exit(1);
  } else if (filter !== undefined) {
    // A second positional silently overwrote the first, so
    // `test-isolated.ts llms-surface audience` ran only the `audience` match and
    // reported green — the same silent-drop this loop refuses for flags,
    // surviving one arm over.
    console.error(`Only one filter is supported; got "${filter}" and "${arg}".`);
    process.exit(1);
  } else {
    filter = arg;
  }
}

// --- Discover test files ---
// `.tsx` as well as `.ts`: `audience-conditionals.test.tsx` is a real suite here,
// and a `.ts`-only glob would drop it while still printing a green summary.
//
// TWO roots. `src/` holds every suite today, but this PR created
// `apps/docs/scripts/`, and a suite added there would have been silently
// unrun under a `src`-only scan while the summary stayed green — the same hole
// the `.tsx` note above describes, one directory over.
const patterns = ["**/*.test.ts", "**/*.test.tsx"];
const roots = [SRC, resolve(ROOT, "scripts")];
const seen = new Set<string>();
for (const root of roots) {
  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: root, absolute: true })) {
      seen.add(path);
    }
  }
}
const discovered = [...seen].sort();
let files = discovered;

if (filter) {
  // ⚠️ Against the PACKAGE-relative path (`src/lib/__tests__/…`), not the
  // absolute one. Matching the absolute path meant any substring occurring in
  // the checkout — `docs`, `atlas`, `src`, a username — matched every file, so
  // `test-isolated.ts docs` ran all nine suites and reported them as a filtered
  // run. That is the mirror image of the `--affected` defect fixed above: a FULL
  // run reported as a narrowed one.
  const needle = filter;
  files = files.filter((f) => relative(ROOT, f).includes(needle));
}

// ⚠️ Exit 1 in BOTH arms — a runner that reports success on an empty set is the
// vacuous-pass shape this repo refuses elsewhere (`scripts/test-others.ts` takes
// the same line for the same reason).
//
// The sibling runners exit 0 on a filter that matches nothing, and that arm is
// where it bites hardest: a renamed or mistyped filter
// (`test-isolated.ts redirect-coverge`) runs zero tests and reports green. The
// discovered set is printed so the typo is visible rather than guessed at.
if (files.length === 0) {
  if (filter) {
    console.error(`No test files matching filter "${filter}" — zero tests ran, which is not a pass.`);
    console.error("Discovered suites:");
    for (const f of discovered) console.error(`  ${relative(ROOT, f)}`);
  } else {
    console.error("No test files found — this likely indicates a configuration error.");
  }
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

// ⚠️ A MAP KEYED BY FILE, not an array.
//
// The completeness check below used `results.length < files.length`, and the
// `.catch` was chained AFTER the `.then` — so it also caught rejections from the
// recursively-returned `scheduleNext()`. One rejection deep in the chain made
// every ancestor's catch fire with its OWN already-completed `file` still in
// scope, pushing a SECOND result for a file that had already passed. The count
// then met `files.length` while a file was genuinely missing, the `<` gate never
// opened, and the set difference — the entire point of the block — was never
// computed. Keyed storage makes a double-write invisible instead of load-bearing,
// and the membership check below now runs unconditionally.
const results = new Map<string, Result>();
const queue = [...files];
const active = new Set<Promise<void>>();

async function scheduleNext(): Promise<void> {
  const file = queue.shift();
  if (file === undefined) return;
  // Two-arg `.then(onFulfilled, onRejected)`, deliberately: the rejection
  // handler covers `runFile` ONLY, never its own continuation.
  const p = runFile(file).then(
    (result) => {
      results.set(result.file, result);
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
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      results.set(file, {
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
    },
  );
  active.add(p);
}

for (let i = 0; i < concurrency && queue.length > 0; i++) await scheduleNext();
while (active.size > 0) await Promise.race(active);

// --- Verify every discovered file produced a result ---
// ⚠️ UNCONDITIONAL membership, never gated on a count. A count comparison is
// satisfied by a duplicate as readily as by the real thing, which is how the
// array version of this could report a full suite with a file missing.
const missing = files.filter((f) => !results.has(f));
if (missing.length > 0) {
  console.error(`\nRunner error: ${missing.length} file(s) produced no result:`);
  for (const f of missing) console.error(`  ${relative(ROOT, f)}`);
  process.exit(1);
}

// --- Summary ---
const finished = [...results.values()];
const passed = finished.filter((r) => r.exitCode === 0).length;
const failed = finished.filter((r) => r.exitCode !== 0).length;
const totalMs = finished.reduce((s, r) => s + r.durationMs, 0).toFixed(0);

console.log("\n" + "─".repeat(60));
console.log(
  `  Files: ${finished.length}  |  ` +
    `\x1b[32mPassed: ${passed}\x1b[0m  |  ` +
    (failed > 0 ? `\x1b[31mFailed: ${failed}\x1b[0m` : `Failed: 0`) +
    `  |  Time: ${totalMs}ms`,
);
console.log("─".repeat(60));

if (failed > 0) {
  console.log("\nFailed files:");
  for (const r of finished.filter((r) => r.exitCode !== 0)) {
    console.log(`  \x1b[31m✗\x1b[0m ${relative(ROOT, r.file)}`);
  }
  process.exit(1);
}

process.exit(0);
