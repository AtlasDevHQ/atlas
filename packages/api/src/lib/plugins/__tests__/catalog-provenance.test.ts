/**
 * #4174 — operator-curated-only drift gate for `plugin_catalog` writes
 * (the tracked precondition of #4099, plugin-execution isolation).
 *
 * Plugins run fully in-process with tenant secrets and live DB pools;
 * that is safe only while every catalog row originates from an
 * operator-authored write path. This file is the structural teeth of
 * that invariant, mirroring `agent-surface-registry.test.ts`: it walks
 * the source trees for files that write `plugin_catalog` rows, pins the
 * exact set, and asserts each one calls `assertOperatorCatalogWrite`.
 * A new write path — in particular any third-party/community submission
 * surface — fails this suite until it is consciously triaged against
 * #4099.
 */

import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  OPERATOR_CATALOG_WRITE_SOURCES,
  assertOperatorCatalogWrite,
  type OperatorCatalogWriteSource,
} from "../catalog-provenance";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

/** Matches the INSERT statement however it is wrapped across lines. */
const CATALOG_INSERT_PATTERN = /INSERT\s+INTO\s+plugin_catalog/i;
const GUARD_CALL_PATTERN = /assertOperatorCatalogWrite\(/;

/**
 * Every file allowed to write `plugin_catalog` rows, relative to the repo
 * root. All are operator-authored by construction (see the doc header in
 * `../catalog-provenance.ts`). Adding a file here is a conscious act:
 * verify the new path is operator-authored, give it a token in
 * `OPERATOR_CATALOG_WRITE_SOURCES`, and call the guard next to the
 * INSERT. If the new path is a third-party/community submission surface,
 * STOP — that work is gated on #4099.
 */
const KNOWN_CATALOG_WRITE_SITES = [
  "packages/api/src/api/routes/admin-marketplace.ts",
  "packages/api/src/lib/db/seed-builtin-datasource-catalog.ts",
  "packages/api/src/lib/integrations/catalog-seeder.ts",
  "packages/api/src/lib/openapi/catalog-seed.ts",
  "packages/api/src/lib/openapi/data-candidate-seed.ts",
] as const;

/**
 * Trees that can reach the internal DB. `ee/src` is scanned so an
 * enterprise-side submission surface can't bypass the gate; it may be
 * absent under the ee-stub build, which the walk tolerates.
 */
const SCAN_ROOTS = ["packages/api/src", "packages/cli/src", "ee/src"];

describe("assertOperatorCatalogWrite", () => {
  it("admits every enumerated operator source", () => {
    for (const source of OPERATOR_CATALOG_WRITE_SOURCES) {
      expect(() => assertOperatorCatalogWrite(source)).not.toThrow();
    }
  });

  it("fails closed on a source outside the enumeration (JS-level bypass)", () => {
    expect(() =>
      assertOperatorCatalogWrite(
        "community-submission" as OperatorCatalogWriteSource,
      ),
    ).toThrow(/#4099/);
  });
});

describe("plugin_catalog write-site registry", () => {
  it("every file that writes plugin_catalog rows is a known write site", async () => {
    const found = await collectCatalogWriteSites();
    // Exact-set pin — additions AND removals both fail, forcing the
    // registry (and the write-source enumeration) to track reality.
    expect(found).toEqual([...KNOWN_CATALOG_WRITE_SITES].sort());
  });

  it("each known write site calls assertOperatorCatalogWrite", async () => {
    for (const file of KNOWN_CATALOG_WRITE_SITES) {
      const source = await readFile(resolve(REPO_ROOT, file), "utf8");
      expect(
        GUARD_CALL_PATTERN.test(source),
        `${file} writes plugin_catalog rows but never calls ` +
          "assertOperatorCatalogWrite — see lib/plugins/catalog-provenance.ts (#4174/#4099)",
      ).toBe(true);
    }
  });
});

/**
 * Walk the scan roots and return repo-relative paths of non-test source
 * files containing the catalog INSERT pattern. Excludes `__tests__/` and
 * `*.test.ts` (fixtures legitimately insert rows).
 */
async function collectCatalogWriteSites(): Promise<string[]> {
  const results: string[] = [];
  for (const root of SCAN_ROOTS) {
    await walk(resolve(REPO_ROOT, root), root, results);
  }
  return results.sort();
}

async function walk(
  absDir: string,
  relDir: string,
  out: string[],
): Promise<void> {
  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    // intentionally ignored: a scan root may be absent (ee/src under the
    // ee-stub build; packages/cli/src in a partial checkout) — nothing to
    // scan there.
    return;
  }
  for (const entry of entries) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const childAbs = resolve(absDir, entry.name);
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      const source = await readFile(childAbs, "utf8");
      if (CATALOG_INSERT_PATTERN.test(source)) {
        out.push(childRel);
      }
    }
  }
}
