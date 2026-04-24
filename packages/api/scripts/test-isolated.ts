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
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve, relative, basename } from "node:path";

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
async function gitDiffNames(...cmd: string[]): Promise<string[]> {
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

// All repo files changed on the branch: committed since base + staged +
// unstaged + untracked. Paths are repo-root-relative.
async function collectChangedFiles(base: string): Promise<string[]> {
  const out = new Set<string>();
  const buckets = await Promise.all([
    gitDiffNames("git", "diff", "--name-only", `${base}...HEAD`),
    gitDiffNames("git", "diff", "--name-only", "HEAD"),
    gitDiffNames("git", "ls-files", "--others", "--exclude-standard"),
  ]);
  for (const bucket of buckets) for (const f of bucket) out.add(f);
  return [...out];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Map changed source files → test files whose content looks like it imports them.
// Test files that changed directly are always included.
function collectAffectedTests(changed: string[], allTests: Set<string>): string[] {
  const affected = new Set<string>();
  const sourceTokens = new Set<string>();
  const API_PREFIX = relative(ROOT, SRC) + "/";

  for (const rel of changed) {
    if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
    const abs = resolve(ROOT, rel);
    if (rel.endsWith(".test.ts")) {
      if (allTests.has(abs)) affected.add(abs);
      continue;
    }
    // Source files outside packages/api/src contribute just a basename
    // token. Source files inside packages/api/src contribute multiple
    // tokens to catch both direct imports (`from "../admin"`) and barrel
    // imports (`from "@atlas/api/lib/audit"`) that land in tests via
    // mock.module(). Over-triggering is preferred to false negatives.
    const stemBase = basename(rel).replace(/\.(ts|tsx)$/, "");
    if (stemBase && stemBase !== "index") sourceTokens.add(stemBase);
    if (rel.startsWith(API_PREFIX)) {
      const relFromSrc = rel.slice(API_PREFIX.length).replace(/\.(ts|tsx)$/, "");
      const segments = relFromSrc.split("/");
      // Full stem from src root (`lib/audit/admin`)
      if (stemBase !== "index") sourceTokens.add(relFromSrc);
      // Parent dir stem for barrel imports (`lib/audit`) — applies to
      // both regular files and index.ts files. Skip the bare parent
      // basename (e.g. `audit`) because short, generic names like `db`,
      // `types`, `config`, `utils`, `middleware`, `errors`, `auth` would
      // match nearly every test in the suite via `@scope/pkg/.../db` etc.
      // The full parent stem (`lib/db`) still catches fully-qualified
      // barrel imports without the over-match.
      if (segments.length >= 2) {
        const parentStem = segments.slice(0, -1).join("/");
        sourceTokens.add(parentStem);
      }
    }
  }

  if (sourceTokens.size === 0) return [...affected];

  // Build one combined regex so we read each test file once.
  // Match any quoted module-specifier-shaped string ending in a token:
  // `"<prefix-ending-in-slash><token>"`. Catches static `from "..."`,
  // dynamic `import("...")`, and runtime `mock.module("...", ...)` —
  // the last form is heavily used in api tests so we can't restrict to
  // static imports. Requires `/` or start-of-specifier before the token
  // so `admin` doesn't false-positive on `"./admin-like"`.
  const pattern = new RegExp(
    `["'](?:[^"']*/)?(${[...sourceTokens].map(escapeRegex).join("|")})["']`,
    "m",
  );

  for (const testFile of allTests) {
    if (affected.has(testFile)) continue;
    const text = readFileSync(testFile, "utf8");
    if (pattern.test(text)) {
      affected.add(testFile);
    }
  }

  return [...affected];
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
  const changed = await collectChangedFiles(since);
  if (changed.length === 0) {
    console.log(`No changed files vs ${since} — nothing to test.`);
    process.exit(0);
  }
  const testSet = new Set(files);
  files = collectAffectedTests(changed, testSet);
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
