/**
 * #4174 — operator-curated-only drift gate for `plugin_catalog` writes
 * (the tracked precondition of #4099, plugin-execution isolation).
 *
 * Plugins run fully in-process with tenant secrets and live DB pools;
 * that is safe only while every catalog row originates from an
 * operator-authored write path. This file is the structural teeth of
 * that invariant, mirroring `agent-surface-registry.test.ts`: it walks
 * the source trees for files that create or mutate `plugin_catalog`
 * rows (INSERT/UPDATE), pins the exact file set, binds each file to its
 * declared write-source token, and asserts each carries a guard call per
 * write site. A new write path — in particular any third-party/community
 * submission surface — fails this suite until it is consciously triaged
 * against #4099.
 */

import { describe, expect, it } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  OPERATOR_CATALOG_WRITE_SOURCES,
  assertOperatorCatalogWrite,
  type OperatorCatalogWriteSource,
} from "../catalog-provenance";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

/**
 * Matches raw-SQL row creation/mutation, tolerating line wraps, a
 * `public.` schema qualifier, and quoted identifiers. Deliberately does
 * NOT try to see query-builder writes: `db/schema.ts` exports a
 * `pluginCatalog` pgTable, so a future runtime-Drizzle
 * `db.insert(pluginCatalog)` would evade this scan — keep catalog writes
 * as raw SQL, or extend this pattern when that convention changes.
 * DELETEs are out of scope (removing a row cannot introduce untrusted
 * code); reads are unrestricted.
 */
const CATALOG_WRITE_PATTERN =
  /(?:INSERT\s+INTO|UPDATE)\s+"?(?:public"?\s*\.\s*"?)?plugin_catalog"?/gi;
const GUARD_CALL_PATTERN = /assertOperatorCatalogWrite\(/g;
const GUARD_IMPORT = 'from "@atlas/api/lib/plugins/catalog-provenance"';

/**
 * Every file allowed to create or mutate `plugin_catalog` rows, bound to
 * the write-source token it must pass to the guard. All are
 * operator-authored (see the doc header in `../catalog-provenance.ts`).
 * Adding an entry is a conscious act: verify the new path is
 * operator-authored, give it a token in `OPERATOR_CATALOG_WRITE_SOURCES`,
 * and call the guard next to the statement. If the new path is a
 * third-party/community submission surface, STOP — that work is gated on
 * #4099.
 */
const KNOWN_CATALOG_WRITE_SITES = {
  // #4232 — the platform-admin CRUD SQL moved out of the route into the
  // catalog-crud builders (verbatim-executed by catalog-crud-pg.test.ts);
  // the guard moved with it, so the SQL can't be built without passing it.
  "packages/api/src/lib/integrations/catalog-crud.ts": "platform-admin-crud",
  "packages/api/src/lib/db/seed-builtin-datasource-catalog.ts":
    "builtin-datasource-seed",
  "packages/api/src/lib/db/seed-builtin-knowledge-catalog.ts":
    "builtin-knowledge-seed",
  "packages/api/src/lib/integrations/catalog-seeder.ts": "config-catalog-seed",
  "packages/api/src/lib/integrations/implementation-status-override.ts":
    "implementation-status-override",
  "packages/api/src/lib/openapi/catalog-seed.ts": "openapi-generic-seed",
  "packages/api/src/lib/openapi/data-candidate-seed.ts":
    "openapi-data-candidate-seed",
} as const satisfies Record<string, OperatorCatalogWriteSource>;

/**
 * Every tree whose code can plausibly reach the internal DB: the API
 * itself, the operator CLI, enterprise code, the MCP server, and in-tree
 * plugins (which receive a plugin DB context). Roots are asserted to
 * exist — a rename must update this list rather than silently dropping a
 * tree from coverage.
 */
const SCAN_ROOTS = [
  "packages/api/src",
  "packages/cli/src",
  "packages/mcp/src",
  "ee/src",
  "plugins",
];

/** Directories that never contain production source. */
const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist"]);

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
  it("every scan root exists (a rename must update SCAN_ROOTS, not drop coverage)", async () => {
    const missing: string[] = [];
    for (const root of SCAN_ROOTS) {
      const s = await stat(resolve(REPO_ROOT, root)).catch(() => null);
      if (s === null || !s.isDirectory()) missing.push(root);
    }
    expect(missing).toEqual([]);
  });

  it("every file that creates or mutates plugin_catalog rows is a known write site", async () => {
    const found = await collectCatalogWriteSites();
    // Exact-set pin — additions AND removals both fail, forcing the
    // registry (and the write-source enumeration) to track reality.
    expect(found).toEqual(Object.keys(KNOWN_CATALOG_WRITE_SITES).sort());
  });

  it("each known write site imports the guard, calls it with its bound token, once per write site", async () => {
    for (const [file, token] of Object.entries(KNOWN_CATALOG_WRITE_SITES)) {
      const source = await readFile(resolve(REPO_ROOT, file), "utf8");
      expect(source.includes(GUARD_IMPORT), `${file} must import the guard`).toBe(
        true,
      );
      expect(
        source.includes(`assertOperatorCatalogWrite("${token}")`),
        `${file} must call assertOperatorCatalogWrite("${token}")`,
      ).toBe(true);
      const writeSites = source.match(CATALOG_WRITE_PATTERN)?.length ?? 0;
      const guardCalls = source.match(GUARD_CALL_PATTERN)?.length ?? 0;
      expect(
        guardCalls,
        `${file} has ${writeSites} plugin_catalog write site(s) but only ` +
          `${guardCalls} guard call(s) — every INSERT/UPDATE needs ` +
          "assertOperatorCatalogWrite next to it (#4174/#4099)",
      ).toBeGreaterThanOrEqual(writeSites);
    }
  });

  it("every write-source token is claimed by a registered file (no orphan tokens)", () => {
    const claimed = new Set<string>(Object.values(KNOWN_CATALOG_WRITE_SITES));
    const orphans = OPERATOR_CATALOG_WRITE_SOURCES.filter(
      (t) => !claimed.has(t),
    );
    expect(orphans).toEqual([]);
  });
});

/**
 * Walk the scan roots and return repo-relative paths of non-test source
 * files containing the catalog write pattern. Excludes `__tests__/` and
 * `*.test.ts` (fixtures legitimately insert rows). No error tolerance:
 * an unreadable directory should fail this gate loudly, never shrink its
 * coverage.
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
  const entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }> = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
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
      // Fresh regex state per file — the shared pattern is /g for match
      // counting elsewhere.
      if (new RegExp(CATALOG_WRITE_PATTERN.source, "i").test(source)) {
        out.push(childRel);
      }
    }
  }
}
