/**
 * Regression tests for --affected selection in scripts/affected.ts.
 *
 * `git diff --name-only` emits repo-root-relative paths, but the matcher used
 * to treat them as package-relative. That produced a doubled absolute path
 * (`packages/api/packages/api/src/...`), so a directly-changed test file could
 * never match the discovered set, and the `src/` prefix test was never true —
 * silently degrading selection to basename-only tokens while still returning a
 * plausible non-empty result. A red test file survived a green `--affected`
 * run because of it (#4851, found during #4834).
 *
 * These call collectAffectedTests() directly on repo-root-relative inputs with
 * a readFile seam, so the mapping is pinned without a live git repo or a real
 * test run.
 */

import { describe, test, expect } from "bun:test";
import { collectAffectedTests, toPackageRelative } from "../../scripts/affected";

const REPO_ROOT = "/repo";
const PACKAGE_ROOT = "/repo/packages/api";
const SRC_ROOT = "/repo/packages/api/src";

const CTX_BASE = { repoRoot: REPO_ROOT, packageRoot: PACKAGE_ROOT, srcRoot: SRC_ROOT };

/** Absolute path of a test file inside the api package. */
function t(rel: string): string {
  return `${SRC_ROOT}/${rel}`;
}

/**
 * Build a context whose readFile serves canned test-file bodies. Any test file
 * not in the map reads as empty (imports nothing), so it can only be selected
 * by the direct-change path.
 */
function ctx(bodies: Record<string, string> = {}) {
  return { ...CTX_BASE, readFile: (p: string) => bodies[p] ?? "" };
}

describe("toPackageRelative", () => {
  test("maps repo-root-relative api paths to package-relative", () => {
    expect(toPackageRelative(["packages/api/src/lib/tools/explore.ts"], REPO_ROOT, PACKAGE_ROOT))
      .toEqual([
        {
          abs: "/repo/packages/api/src/lib/tools/explore.ts",
          packageRel: "src/lib/tools/explore.ts",
        },
      ]);
  });

  test("keeps files outside the api package reachable as ../<pkg>/…", () => {
    const [mapped] = toPackageRelative(["packages/types/src/index.ts"], REPO_ROOT, PACKAGE_ROOT);
    expect(mapped.abs).toBe("/repo/packages/types/src/index.ts");
    expect(mapped.packageRel).toBe("../types/src/index.ts");
  });

  test("never produces a doubled package path — the #4851 regression", () => {
    const [mapped] = toPackageRelative(["packages/api/src/lib/tools/explore.ts"], REPO_ROOT, PACKAGE_ROOT);
    expect(mapped.abs).not.toContain("packages/api/packages/api");
  });
});

describe("collectAffectedTests — directly changed test files", () => {
  test("selects a changed test file that exists in the discovered set", () => {
    const testFile = t("lib/tools/__tests__/explore-backend.test.ts");
    const selected = collectAffectedTests(
      ["packages/api/src/lib/tools/__tests__/explore-backend.test.ts"],
      new Set([testFile]),
      ctx(),
    );
    expect(selected).toEqual([testFile]);
  });

  test("ignores a changed test file that no longer exists on disk", () => {
    const selected = collectAffectedTests(
      ["packages/api/src/lib/tools/__tests__/deleted.test.ts"],
      new Set([t("lib/tools/__tests__/explore-backend.test.ts")]),
      ctx(),
    );
    expect(selected).toEqual([]);
  });
});

describe("collectAffectedTests — source → test tokens", () => {
  const backend = t("lib/tools/__tests__/explore-backend.test.ts");
  const failClosed = t("lib/tools/__tests__/explore-fail-closed.test.ts");
  const unrelated = t("lib/billing/__tests__/entitlements.test.ts");

  const allTests = new Set([backend, failClosed, unrelated]);

  test("a src change reaches importers via the full stem, not just the basename", () => {
    // Neither body mentions the bare basename `explore` as its own specifier —
    // only the full stem and the barrel. Under the old basename-only
    // degradation these would both be missed.
    const selected = collectAffectedTests(
      ["packages/api/src/lib/tools/explore.ts"],
      allTests,
      ctx({
        [backend]: `import { run } from "@atlas/api/lib/tools/explore";`,
        [failClosed]: `mock.module("@atlas/api/lib/tools", () => ({}));`,
        [unrelated]: `import { entitlements } from "../entitlements";`,
      }),
    );
    expect(new Set(selected)).toEqual(new Set([backend, failClosed]));
  });

  test("does not select tests that import nothing related", () => {
    const selected = collectAffectedTests(
      ["packages/api/src/lib/tools/explore.ts"],
      allTests,
      ctx({ [unrelated]: `import { entitlements } from "../entitlements";` }),
    );
    expect(selected).toEqual([]);
  });

  test("a change outside packages/api contributes only a basename token", () => {
    const typesConsumer = t("lib/billing/__tests__/plan-limits.test.ts");
    const all = new Set([typesConsumer, unrelated]);
    const selected = collectAffectedTests(
      ["packages/types/src/plan-limits.ts"],
      all,
      ctx({
        [typesConsumer]: `import type { PlanLimits } from "@useatlas/types/plan-limits";`,
        [unrelated]: `import { entitlements } from "../entitlements";`,
      }),
    );
    expect(selected).toEqual([typesConsumer]);
  });

  test("an out-of-package index.ts contributes no token, so it selects nothing", () => {
    const selected = collectAffectedTests(
      ["packages/types/src/index.ts"],
      allTests,
      ctx({
        [backend]: `import "@useatlas/types";`,
        [failClosed]: `import "../index";`,
      }),
    );
    expect(selected).toEqual([]);
  });

  test("non-TypeScript changes select nothing", () => {
    const selected = collectAffectedTests(
      ["docs/development/testing.md", ".github/workflows/ci.yml"],
      allTests,
      ctx({ [backend]: `import "@atlas/api/lib/tools/explore";` }),
    );
    expect(selected).toEqual([]);
  });

  test("sees a cache-busting template-literal dynamic import", () => {
    // ~32 api test files import the module under test this way to get fresh
    // module state. Neither the backtick delimiter nor the trailing ?query was
    // matched before, so these files were invisible to --affected (#4851).
    const selected = collectAffectedTests(
      ["packages/api/src/lib/tools/explore.ts"],
      new Set([backend, unrelated]),
      ctx({
        [backend]: "const m = await import(`@atlas/api/lib/tools/explore?t=${testCounter}`);",
        [unrelated]: `import { entitlements } from "../entitlements";`,
      }),
    );
    expect(selected).toEqual([backend]);
  });

  test("still requires the token to end the specifier — `?` is not a wildcard", () => {
    const selected = collectAffectedTests(
      ["packages/api/src/lib/tools/explore.ts"],
      new Set([backend]),
      // `explore-like` must not match on the `explore` token, in any delimiter.
      ctx({ [backend]: "import x from `./explore-like`;" }),
    );
    expect(selected).toEqual([]);
  });

  test("a bare parent basename does not over-match — `lib/db` yes, `db` no", () => {
    const dbTest = t("lib/db/__tests__/internal.test.ts");
    const viaFullParent = t("lib/audit/__tests__/writer.test.ts");
    const all = new Set([dbTest, viaFullParent]);
    const selected = collectAffectedTests(
      ["packages/api/src/lib/db/internal.ts"],
      all,
      ctx({
        [dbTest]: `import { pool } from "@atlas/api/lib/db";`,
        // Only mentions the generic trailing segment `db`, which must not be a token.
        [viaFullParent]: `import { x } from "./some/other/db";`,
      }),
    );
    expect(selected).toEqual([dbTest]);
  });
});
