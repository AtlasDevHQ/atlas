/**
 * Affected-test selection for scripts/test-isolated.ts (`--affected`).
 *
 * Extracted from the runner so the path mapping can be unit-tested without a
 * live git repo or a real test run — same reason signal-retry.ts is its own
 * module. See src/__tests__/test-isolated-affected.test.ts.
 *
 * The path contract is the whole point of this module. `git diff --name-only`
 * emits **repo-root-relative** paths regardless of the cwd it runs in
 * (`packages/api/src/lib/tools/explore.ts`), while every consumer here wants
 * them relative to the api package. That conversion happens exactly once, in
 * `toPackageRelative` at the top of `collectAffectedTests` — previously it did
 * not happen at all, so `resolve(ROOT, rel)` produced a doubled path
 * (`packages/api/packages/api/src/...`) that matched nothing on disk and the
 * `src/` prefix test was never true, silently degrading selection to
 * basename-only tokens (#4851).
 */

import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

export interface AffectedContext {
  /** Absolute path to the repo root — what git's `--name-only` paths are relative to. */
  repoRoot: string;
  /** Absolute path to the api package root (the runner's `ROOT`). */
  packageRoot: string;
  /** Absolute path to the api source root (the runner's `SRC`). */
  srcRoot: string;
  /** Seam for tests: reads a test file's contents. Defaults to readFileSync. */
  readFile?: (path: string) => string;
}

/** One changed file, resolved into the two shapes the matcher needs. */
export interface NormalizedPath {
  /** Absolute path on disk. */
  abs: string;
  /** Path relative to the api package root — `src/lib/x.ts`, or `../types/src/x.ts` for files outside it. */
  packageRel: string;
}

/**
 * The single normalization boundary: repo-root-relative → absolute + package-relative.
 *
 * Files outside the api package deliberately survive as `../<pkg>/...` rather
 * than being dropped — they still contribute a basename token (a change to
 * `packages/types/src/foo.ts` should reach tests that import `foo`), but they
 * will not match the `src/` prefix test, so they never earn the richer tokens.
 */
export function toPackageRelative(
  changed: readonly string[],
  repoRoot: string,
  packageRoot: string,
): NormalizedPath[] {
  return changed.map((repoRel) => {
    const abs = resolve(repoRoot, repoRel);
    return { abs, packageRel: relative(packageRoot, abs) };
  });
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map changed source files → test files whose content looks like it imports them.
 * Test files that changed directly are always included.
 *
 * @param changed Repo-root-relative paths, exactly as `git diff --name-only` emits them.
 * @param allTests Absolute paths of every discovered test file.
 */
export function collectAffectedTests(
  changed: readonly string[],
  allTests: Set<string>,
  ctx: AffectedContext,
): string[] {
  const readFile = ctx.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const affected = new Set<string>();
  const sourceTokens = new Set<string>();
  const srcPrefix = relative(ctx.packageRoot, ctx.srcRoot) + "/";

  for (const { abs, packageRel } of toPackageRelative(changed, ctx.repoRoot, ctx.packageRoot)) {
    if (!packageRel.endsWith(".ts") && !packageRel.endsWith(".tsx")) continue;
    if (packageRel.endsWith(".test.ts")) {
      // Only tests that actually exist in the discovered set — a deleted test
      // file still shows up in the diff but has nothing to run.
      if (allTests.has(abs)) affected.add(abs);
      continue;
    }
    // Every source file contributes a basename token. Files inside the api
    // src root additionally contribute a full stem from src (`lib/tools/explore`)
    // and a parent-dir stem (`lib/tools`), to catch both direct imports
    // (`from "../explore"`) and barrel imports (`from "@atlas/api/lib/tools"`)
    // that land in tests via mock.module(). Over-triggering is preferred to
    // false negatives.
    const stemBase = basename(packageRel).replace(/\.(ts|tsx)$/, "");
    if (stemBase && stemBase !== "index") sourceTokens.add(stemBase);
    if (packageRel.startsWith(srcPrefix)) {
      const relFromSrc = packageRel.slice(srcPrefix.length).replace(/\.(ts|tsx)$/, "");
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
  // `"<prefix-ending-in-slash><token><optional ?query>"`. Catches static
  // `from "..."`, dynamic `import("...")`, and runtime `mock.module("...", ...)`
  // — the last form is heavily used in api tests so we can't restrict to
  // static imports. Requires `/` or start-of-specifier before the token
  // so `admin` doesn't false-positive on `"./admin-like"`.
  //
  // Backticks count as delimiters and a trailing `?query` is tolerated because
  // ~32 api test files import the module under test through a cache-busting
  // template literal — `import(\`@atlas/api/lib/tools/explore?t=${n}\`)` — to
  // get fresh module state. A quote-only, token-must-be-last pattern cannot see
  // those at all, so those files were invisible to --affected via this edge
  // regardless of the path bug (#4851).
  const QUOTE = "[\"'`]";
  const NOT_QUOTE = "[^\"'`]";
  const pattern = new RegExp(
    `${QUOTE}(?:${NOT_QUOTE}*/)?(${[...sourceTokens].map(escapeRegex).join("|")})(?:\\?${NOT_QUOTE}*)?${QUOTE}`,
    "m",
  );

  for (const testFile of allTests) {
    if (affected.has(testFile)) continue;
    if (pattern.test(readFile(testFile))) {
      affected.add(testFile);
    }
  }

  return [...affected];
}
