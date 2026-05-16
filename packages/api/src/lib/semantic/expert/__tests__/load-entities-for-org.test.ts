/**
 * Unit test for `loadEntitiesForOrg` (#2503).
 *
 * Pins the load-bearing contract: the loader feeding the Semantic Health
 * card must produce the same `(name, connection_group_id)` dedup behavior
 * as `listAdminEntities` (the source-of-truth for the Overview tile + the
 * `/admin/semantic` file tree + the chat empty state). If a future refactor
 * forks the merge logic, this test fails before the count divergence reaches
 * a user.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Shared switches
// ---------------------------------------------------------------------------

let internalDBAvailable = true;

interface FakeDBRow {
  /** Row `name` column — also the default display name unless `yamlName` overrides. */
  readonly name: string;
  readonly table: string;
  /** Optional explicit `name:` line in the YAML content. When set and distinct
   * from `table`, the parser surfaces a divergent display name (the case the
   * disk-dedup test exercises). When omitted, the YAML has no `name:` field
   * so the display name falls back to `table` — matching the common case. */
  readonly yamlName?: string;
  readonly description?: string;
  readonly connection_group_id?: string | null;
  readonly status?: "published" | "draft";
  readonly dimensions?: number;
  readonly measures?: number;
  readonly joins?: number;
}

let publishedRows: FakeDBRow[] = [];
let overlayRows: FakeDBRow[] = [];
// Escape hatch for tests that need a specific malformed `yaml_content` —
// when populated, takes precedence over `publishedRows`. Cleared each test.
let publishedRowsOverride: ReturnType<typeof toSemanticRow>[] | null = null;

function toSemanticRow(r: FakeDBRow) {
  // YAML array syntax for dimensions so `Array.isArray(parsed.dimensions)`
  // in `loadEntitiesForOrg` accepts it. Matches the shape `ParsedEntity`
  // expects (array of `{name, sql, type, ...}` objects) rather than the
  // object-map alternative the discover-layer also accepts.
  const dims = Array.from({ length: r.dimensions ?? 0 }, (_, i) =>
    `  - name: d${i}\n    sql: d${i}\n    type: string\n`,
  ).join("");
  const measures = Array.from({ length: r.measures ?? 0 }, (_, i) =>
    `  - name: m${i}\n    sql: COUNT(*)\n    type: count\n`,
  ).join("");
  const joins = Array.from({ length: r.joins ?? 0 }, (_, i) =>
    `  - name: j${i}\n    sql: a = b\n`,
  ).join("");
  const yamlContent =
    `table: ${r.table}\n` +
    (r.yamlName ? `name: ${r.yamlName}\n` : "") +
    (r.description ? `description: ${r.description}\n` : "") +
    (dims ? `dimensions:\n${dims}` : "") +
    (measures ? `measures:\n${measures}` : "") +
    (joins ? `joins:\n${joins}` : "");
  return {
    id: `id-${r.name}-${r.connection_group_id ?? "null"}`,
    org_id: "org-1",
    entity_type: "entity" as const,
    name: r.name,
    yaml_content: yamlContent,
    connection_group_id: r.connection_group_id ?? null,
    status: r.status ?? ("published" as const),
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };
}

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDBAvailable,
}));

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntityRows: async (_orgId: string, _type: string, _status: string) =>
    publishedRowsOverride ?? publishedRows.map(toSemanticRow),
  listEntitiesWithOverlay: async (_orgId: string, _type: string) =>
    overlayRows.map(toSemanticRow),
}));

// ---------------------------------------------------------------------------
// Disk fixture — org-scoped under `.orgs/<orgId>/entities/`
// ---------------------------------------------------------------------------

const ORG_ID = "org-1";
let tmpRoot: string;
const ORIGINAL_SEMANTIC_ROOT = process.env.ATLAS_SEMANTIC_ROOT;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-load-entities-for-org-"));
  process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_SEMANTIC_ROOT === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = ORIGINAL_SEMANTIC_ROOT;
});

beforeEach(() => {
  internalDBAvailable = true;
  publishedRows = [];
  overlayRows = [];
  publishedRowsOverride = null;
  // Reset the org-scoped disk fixture each test.
  const orgRoot = path.join(tmpRoot, ".orgs", ORG_ID);
  fs.rmSync(orgRoot, { recursive: true, force: true });
});

function writeDiskEntity(name: string, body: string): void {
  const dir = path.join(tmpRoot, ".orgs", ORG_ID, "entities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), body);
}

// Re-import per test file (matches the pattern used by sibling semantic tests).
const mod = (await import(`../context-loader.ts?t=${Date.now()}`)) as typeof import("../context-loader");
const loadEntitiesForOrg = mod.loadEntitiesForOrg;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadEntitiesForOrg", () => {
  it("returns empty when no internal DB is configured", async () => {
    internalDBAvailable = false;
    publishedRows = [{ name: "users", table: "users" }];
    writeDiskEntity("orders", "table: orders\n");
    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result).toEqual({ entities: [], totalRows: 0, parseFailures: 0 });
  });

  it("DB row in named group + disk-mirror with null group both appear (matches listAdminEntities dedup)", async () => {
    // This is the #2503 shape: 1.4.4 backfill put `connection_group_id`
    // on the DB row, the dual-write sync wrote a disk mirror under the
    // null group, and `mergeAdminEntities` keys dedup on (name, group).
    // The Health loader must mirror that — otherwise its count drops
    // below what the file tree above it renders.
    publishedRows = [{ name: "users", table: "users", connection_group_id: "g_prod" }];
    writeDiskEntity("users", "table: users\ndescription: From disk\n");

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    // `entities.length` is the merged count (DB + disk after dedup); the
    // 1 DB row + 1 disk-mirror entry survive as 2 distinct entries because
    // the named-group DB key doesn't collide with the null-group disk key.
    expect(result.entities).toHaveLength(2);
    // `totalRows` is DB-rows-considered (#2503 review) — kept distinct from
    // `entities.length` so the route's `corrupt` discriminator stays sound.
    expect(result.totalRows).toBe(1);
    expect(result.entities.map((e) => e.name).toSorted()).toEqual(["users", "users"]);
  });

  it("DB row with null group shadows the disk mirror (legacy null-scope case)", async () => {
    // The single-group pre-#2503 scenario: DB row and disk row both
    // null-scoped → same dedup key → DB wins, disk is dropped. Confirms
    // we don't break the count for orgs that haven't migrated to groups.
    publishedRows = [{ name: "users", table: "users", connection_group_id: null, description: "From DB" }];
    writeDiskEntity("users", "table: users\ndescription: From disk\n");

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result.entities).toHaveLength(1);
    expect(result.totalRows).toBe(1);
    expect(result.entities[0].description).toBe("From DB");
  });

  it("multi-group: same name in two named groups both survive, disk mirror also appears", async () => {
    // Multi-environment case from #2412: `users` in `g_us` AND `g_eu`
    // are genuinely distinct (different replicas). The disk mirror's
    // null-group entry doesn't collide with either named-group key.
    publishedRows = [
      { name: "users", table: "users", connection_group_id: "g_us", description: "US" },
      { name: "users", table: "users", connection_group_id: "g_eu", description: "EU" },
    ];
    writeDiskEntity("users", "table: users\ndescription: From disk\n");

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result.entities).toHaveLength(3);
    expect(result.totalRows).toBe(2); // 2 DB rows considered
    const descriptions = result.entities.map((e) => e.description).toSorted();
    expect(descriptions).toEqual(["EU", "From disk", "US"]);
  });

  it("disk entries dedup on `parsed.table` not `parsed.name` (matches diskToAdminSummary)", async () => {
    // #2503 review: a disk YAML with `name: mrr` over `table: subscription_events`
    // and a DB row with the same YAML are genuinely different things in
    // `mergeAdminEntities`'s book — DB keys on (`mrr`, group), disk keys on
    // (`subscription_events`, null). They don't collide and both appear.
    // The earlier draft of this loader keyed disk on `parsed.name` and would
    // have falsely collapsed them in a single-group null-scope workspace.
    publishedRows = [{
      name: "mrr",
      yamlName: "mrr",
      table: "subscription_events",
      connection_group_id: null,
      description: "From DB",
    }];
    writeDiskEntity(
      "subscription_events",
      "table: subscription_events\nname: mrr\ndescription: From disk\n",
    );

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    // DB key = (`mrr`, null). Disk key = (`subscription_events`, null).
    // Different keys → both appear. (Same outcome as `mergeAdminEntities`'s
    // "dedup key is summary `name`, not DB row `name`" test.)
    expect(result.entities).toHaveLength(2);
    const descriptions = result.entities.map((e) => e.description).toSorted();
    expect(descriptions).toEqual(["From DB", "From disk"]);
  });

  it("walks per-source disk subdirectories (matches discoverEntities traversal)", async () => {
    // `mergeAdminEntities` reads disk via `discoverEntities`, which walks
    // both `entities/` AND `{source}/entities/` subdirectories (#2503 review).
    // A loader that only walked flat `entities/` would silently undercount
    // when an admin manually places per-source files.
    const orgDir = path.join(tmpRoot, ".orgs", ORG_ID);
    fs.mkdirSync(path.join(orgDir, "entities"), { recursive: true });
    fs.writeFileSync(
      path.join(orgDir, "entities", "users.yml"),
      "table: users\n",
    );
    fs.mkdirSync(path.join(orgDir, "warehouse", "entities"), { recursive: true });
    fs.writeFileSync(
      path.join(orgDir, "warehouse", "entities", "fact_orders.yml"),
      "table: fact_orders\n",
    );

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result.entities.map((e) => e.name).toSorted()).toEqual([
      "fact_orders",
      "users",
    ]);
  });

  it("counts dimensions, measures, and joins on each entity for computeSemanticHealth", async () => {
    // Health coverage / measureCoverage / joinCoverage all sum these fields
    // across entities. If the loader returned them empty the score would
    // collapse even when the YAML carries real definitions.
    publishedRows = [
      { name: "users", table: "users", connection_group_id: null, dimensions: 3, measures: 2, joins: 1 },
    ];
    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].dimensions).toHaveLength(3);
    expect(result.entities[0].measures).toHaveLength(2);
    expect(result.entities[0].joins).toHaveLength(1);
  });

  it("developer mode reads the overlay (drafts shadow published)", async () => {
    // Pins that the mode parameter actually swaps DB sources. A regression
    // that hardcoded `listEntityRows` would silently never surface drafts
    // in the Health card.
    overlayRows = [{ name: "users", table: "users", status: "draft", description: "Draft only" }];
    publishedRows = [{ name: "users", table: "users", description: "Published" }];

    const dev = await loadEntitiesForOrg(ORG_ID, "developer");
    expect(dev.entities.map((e) => e.description)).toEqual(["Draft only"]);
  });

  it("counts unparseable DB rows in parseFailures, leaves entities clean", async () => {
    // The `corrupt` discriminator on the route response distinguishes
    // empty workspace from data-rot. parseFailures must reflect ONLY DB
    // rows (not disk parse errors, which surface via the logger) so
    // operators get the same signal post-#2503 as they did pre-#2503.
    publishedRowsOverride = [
      toSemanticRow({ name: "good", table: "good" }),
      { ...toSemanticRow({ name: "bad", table: "bad" }), yaml_content: "{{{ not yaml" },
    ];

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result.entities.map((e) => e.name)).toEqual(["good"]);
    expect(result.parseFailures).toBe(1);
  });

  it("disk parse failures do NOT increment parseFailures (DB-only contract)", async () => {
    // #2503 review (test-analyzer): the previous `parseFailures` test
    // exercised only the DB-corruption path. Without a disk-corruption case
    // a regression that adds `parseFailures++` to the disk catch block
    // would silently flip the `corrupt` discriminator's semantics and the
    // existing tests would still pass. Pin the asymmetry explicitly.
    publishedRows = [{ name: "good", table: "good", connection_group_id: null }];
    writeDiskEntity("bad", "{{{ not yaml at all");
    writeDiskEntity("also_bad", "- just\n- a\n- list\n"); // parses but not an object

    const result = await loadEntitiesForOrg(ORG_ID, "published");
    expect(result.entities.map((e) => e.name)).toEqual(["good"]);
    // Disk parse failure (`scanEntities` returns it in `warnings`, the
    // file simply doesn't appear in `entities`) does not increment
    // parseFailures.
    expect(result.parseFailures).toBe(0);
    // `totalRows` stays the DB-rows-considered count (just the one healthy
    // DB row), confirming the disk side never contributes to it.
    expect(result.totalRows).toBe(1);
  });
});
