/**
 * Regression lock for #4655 — the test preload must sandbox the semantic root.
 *
 * `getSemanticRoot()` defaults to `{cwd}/semantic`, and the dual-write sync
 * layer persists per-org YAML under `{root}/.orgs/<orgId>/`. Before this guard,
 * every suite that exercised the real write path (the `-pg` amendment /
 * connection-profile family, the wizard, `importFromDisk`, …) littered
 * `packages/api/semantic/` on the developer's actual checkout — untracked
 * (`.gitignore`'s `/semantic/` entry is anchored to the repo root, so it does
 * not cover this one), noisy in `git status`, and load-bearing in the worst
 * way: first-boot suites walk `.orgs/` and fail on the orgs a previous run
 * left behind, so a second full run went red.
 *
 * `src/test-setup.ts` (the `bunfig.toml` preload) now points
 * `ATLAS_SEMANTIC_ROOT` at a per-process `mkdtemp` sandbox. These tests pin
 * that contract so it can't silently regress.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getSemanticRoot as getBaseSemanticRoot } from "@atlas/api/lib/semantic/files";
import { getSemanticRoot, syncEntityToDisk, cleanupOrgDirectory } from "@atlas/api/lib/semantic/sync";
import { outputDirForGroup } from "@atlas/api/lib/profiler";

/** The preload's sandbox root — absent means the guard itself has regressed. */
function sandboxRoot(): string {
  const root = process.env.ATLAS_SEMANTIC_ROOT;
  if (!root) {
    throw new Error(
      "ATLAS_SEMANTIC_ROOT is unset — the test preload (src/test-setup.ts) no longer sandboxes the semantic root (#4655)",
    );
  }
  return path.resolve(root);
}

/** Real path (macOS `/tmp` is a symlink to `/private/tmp`). */
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Not yet materialized on disk — the lexical path is the best answer.
    return path.resolve(p);
  }
}

describe("test preload semantic-root sandbox (#4655)", () => {
  it("sets ATLAS_SEMANTIC_ROOT to an existing directory", () => {
    expect(fs.existsSync(sandboxRoot())).toBe(true);
  });

  it("places the sandbox under the OS temp dir, not the checkout", () => {
    const root = realpath(sandboxRoot());
    expect(root.startsWith(realpath(os.tmpdir()) + path.sep)).toBe(true);
    expect(root.startsWith(realpath(process.cwd()) + path.sep)).toBe(false);
  });

  it("routes the base semantic root away from {cwd}/semantic", () => {
    expect(getBaseSemanticRoot()).not.toBe(path.resolve(process.cwd(), "semantic"));
  });

  it("routes org-scoped write paths into the sandbox", () => {
    expect(getSemanticRoot("org-4655")).toBe(path.join(sandboxRoot(), ".orgs", "org-4655"));
  });

  it("routes the profiler's generation output into the sandbox too", () => {
    // profiler.ts used to resolve `path.resolve("semantic")` at module load,
    // which ignored the override entirely — both in tests and in any
    // deployment that configured ATLAS_SEMANTIC_ROOT.
    expect(outputDirForGroup("default", "org-4655")).toBe(
      path.join(sandboxRoot(), ".orgs", "org-4655"),
    );
    expect(outputDirForGroup("warehouse")).toBe(path.join(sandboxRoot(), "groups", "warehouse"));
  });

  it("a real dual-write sync leaves {cwd}/semantic untouched", async () => {
    // The end-to-end shape of the bug: this is the exact call the `-pg`
    // amendment suites reach through, and it used to materialize
    // `packages/api/semantic/.orgs/<orgId>/entities/*.yml` in the checkout.
    const checkoutRoot = path.resolve(process.cwd(), "semantic");
    const preexisting = fs.existsSync(checkoutRoot);
    const orgId = `org-4655-sandbox-${process.pid}`;

    try {
      await syncEntityToDisk(orgId, "orders", "entity", "table: orders\n");

      expect(
        fs.existsSync(path.join(sandboxRoot(), ".orgs", orgId, "entities", "orders.yml")),
      ).toBe(true);
      // Not merely "the org dir is absent" — the whole checkout-level semantic
      // root must not have been conjured into existence by the write.
      expect(fs.existsSync(checkoutRoot)).toBe(preexisting);
      expect(fs.existsSync(path.join(checkoutRoot, ".orgs", orgId))).toBe(false);
    } finally {
      await cleanupOrgDirectory(orgId);
    }
  });
});
