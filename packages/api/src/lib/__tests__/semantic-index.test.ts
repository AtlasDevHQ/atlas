/**
 * Tests for the pre-indexed semantic layer summary (semantic-index.ts).
 *
 * Uses temp directories with entity/metric/glossary YAMLs to verify
 * index building, small vs large mode, cache invalidation, and system
 * prompt injection.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

// Cache-busting import for fresh module instance
const modPath = resolve(__dirname, "../semantic/search.ts");
const mod = await import(`${modPath}?t=${Date.now()}`);
const buildSemanticIndex = mod.buildSemanticIndex as typeof import("../semantic/search").buildSemanticIndex;
const getSemanticIndex = mod.getSemanticIndex as typeof import("../semantic/search").getSemanticIndex;
const invalidateSemanticIndex = mod.invalidateSemanticIndex as typeof import("../semantic/search").invalidateSemanticIndex;
const getIndexedEntityCount = mod.getIndexedEntityCount as typeof import("../semantic/search").getIndexedEntityCount;

const tmpBase = resolve(__dirname, ".tmp-semantic-index-test");
let testCounter = 0;

function ensureDir(subdir: string): string {
  const dir = resolve(tmpBase, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpBase() {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

function makeEntity(table: string, opts?: {
  description?: string;
  connection?: string;
  group?: string;
  type?: string;
  grain?: string;
  dimensions?: Array<{ name: string; type: string; description?: string; primary_key?: boolean }>;
  measures?: Array<{ name: string; type: string; description?: string }>;
  joins?: Array<{ target_entity: string; relationship: string }>;
  query_patterns?: Array<{ name: string; description: string }>;
}) {
  const lines: string[] = [];
  lines.push(`name: ${table}`);
  lines.push(`table: ${table}`);
  if (opts?.type) lines.push(`type: ${opts.type}`);
  if (opts?.group) lines.push(`group: ${opts.group}`);
  if (opts?.connection) lines.push(`connection: ${opts.connection}`);
  if (opts?.grain) lines.push(`grain: ${opts.grain}`);
  if (opts?.description) lines.push(`description: "${opts.description}"`);

  if (opts?.dimensions) {
    lines.push("dimensions:");
    for (const d of opts.dimensions) {
      lines.push(`  - name: ${d.name}`);
      lines.push(`    type: ${d.type}`);
      if (d.description) lines.push(`    description: "${d.description}"`);
      if (d.primary_key) lines.push(`    primary_key: true`);
    }
  }

  if (opts?.measures) {
    lines.push("measures:");
    for (const m of opts.measures) {
      lines.push(`  - name: ${m.name}`);
      lines.push(`    type: ${m.type}`);
      if (m.description) lines.push(`    description: "${m.description}"`);
    }
  }

  if (opts?.joins) {
    lines.push("joins:");
    for (const j of opts.joins) {
      lines.push(`  - target_entity: ${j.target_entity}`);
      lines.push(`    relationship: ${j.relationship}`);
    }
  }

  if (opts?.query_patterns) {
    lines.push("query_patterns:");
    for (const p of opts.query_patterns) {
      lines.push(`  - name: ${p.name}`);
      lines.push(`    description: "${p.description}"`);
    }
  }

  return lines.join("\n") + "\n";
}

describe("buildSemanticIndex", () => {
  beforeEach(() => {
    invalidateSemanticIndex();
    testCounter++;
  });

  afterEach(() => {
    invalidateSemanticIndex();
    cleanTmpBase();
  });

  it("returns empty string for missing semantic directory", () => {
    const index = buildSemanticIndex("/tmp/nonexistent-semantic-index-test");
    expect(index).toBe("");
  });

  it("returns empty string for empty entities directory", () => {
    const root = ensureDir(`empty-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    const index = buildSemanticIndex(root);
    expect(index).toBe("");
  });

  it("builds full index for small semantic layer (< 20 entities)", () => {
    const root = ensureDir(`small-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "users.yml"),
      makeEntity("users", {
        description: "User accounts table",
        type: "fact_table",
        grain: "one row per user",
        dimensions: [
          { name: "id", type: "integer", primary_key: true },
          { name: "name", type: "text", description: "User full name" },
          { name: "email", type: "text", description: "User email address" },
        ],
        measures: [
          { name: "user_count", type: "count_distinct", description: "Number of unique users" },
        ],
        joins: [
          { target_entity: "orders", relationship: "one_to_many" },
        ],
        query_patterns: [
          { name: "users_by_status", description: "Count users by status" },
        ],
      }),
    );

    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", {
        description: "Customer orders",
        dimensions: [
          { name: "id", type: "integer", primary_key: true },
          { name: "user_id", type: "integer" },
          { name: "total", type: "numeric", description: "Order total amount" },
        ],
      }),
    );

    const index = buildSemanticIndex(root);

    // Should be in full mode
    expect(index).toContain("mode: full");
    expect(index).toContain("2 entities");

    // Full mode shows columns
    expect(index).toContain("**users**");
    expect(index).toContain("id (integer PK)");
    expect(index).toContain("name (text)");
    expect(index).toContain("email (text)");
    expect(index).toContain("User full name");

    // Shows measures
    expect(index).toContain("user_count");

    // Shows joins
    expect(index).toContain("→ orders");

    // Shows query patterns
    expect(index).toContain("users_by_status");

    // Shows orders entity
    expect(index).toContain("**orders**");
    expect(index).toContain("total (numeric)");
  });

  it("builds summary index for large semantic layer (20+ entities)", () => {
    const root = ensureDir(`large-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    // Create 22 entities to exceed threshold
    for (let i = 0; i < 22; i++) {
      writeFileSync(
        join(root, "entities", `table_${i}.yml`),
        makeEntity(`table_${i}`, {
          description: `Table number ${i}`,
          dimensions: [
            { name: "id", type: "integer", primary_key: true },
            { name: `col_${i}`, type: "text" },
            { name: `value_${i}`, type: "numeric" },
          ],
          measures: [
            { name: `count_${i}`, type: "count" },
          ],
          joins: i > 0
            ? [{ target_entity: `table_${i - 1}`, relationship: "many_to_one" }]
            : undefined,
        }),
      );
    }

    const index = buildSemanticIndex(root);

    // Should be in summary mode
    expect(index).toContain("mode: summary");
    expect(index).toContain("22 entities");

    // Summary mode shows column count but not individual columns
    expect(index).toContain("3 columns");
    expect(index).toContain("PK: id");

    // Summary mode shows measures count and join targets
    expect(index).toContain("1 measures");
    expect(index).toContain("joins: table_0");

    // Should NOT show individual column details like "(text)" descriptions
    expect(index).not.toContain("id (integer PK)");
  });

  it("includes metrics in the index", () => {
    const root = ensureDir(`metrics-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    mkdirSync(join(root, "metrics"), { recursive: true });

    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    writeFileSync(
      join(root, "metrics", "orders_metrics.yml"),
      [
        "metrics:",
        "  - name: total_revenue",
        '    description: "Sum of all order totals"',
        "    entity: orders",
        "    aggregation: sum",
        "  - name: avg_order_value",
        '    description: "Average order value"',
        "    entity: orders",
        "    aggregation: avg",
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("### Metrics");
    expect(index).toContain("total_revenue");
    expect(index).toContain("Sum of all order totals");
    expect(index).toContain("avg_order_value");
  });

  it("includes glossary terms in the index", () => {
    const root = ensureDir(`glossary-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    writeFileSync(
      join(root, "glossary.yml"),
      [
        "terms:",
        "  - term: revenue",
        '    definition: "Total income from sales"',
        "    status: defined",
        "  - term: size",
        '    definition: "Could refer to company size or deal size"',
        "    status: ambiguous",
        '    disambiguation: "Ask the user which size they mean"',
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("### Glossary");
    expect(index).toContain("**revenue**");
    expect(index).toContain("Total income from sales");
    expect(index).toContain("**size**");
    expect(index).toContain("[AMBIGUOUS]");
    expect(index).toContain("Ask the user which size they mean");
    // Array-form terms without note/possible_mappings carry no mapping noise.
    expect(index).not.toContain("maps to:");
  });

  it("renders note and possible_mappings for object-form ambiguous terms (#3277)", () => {
    const root = ensureDir(`glossary-mappings-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    // Object-form glossary — the term carries its disambiguation guidance in
    // `note` + `possible_mappings` (the shape the lookup layer uses), not in
    // `definition`/`disambiguation`. The prompt index must surface both.
    writeFileSync(
      join(root, "glossary.yml"),
      [
        "terms:",
        "  status:",
        "    status: ambiguous",
        '    note: "Appears in multiple tables — ASK the user."',
        "    possible_mappings: [orders.status, users.status]",
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("### Glossary");
    expect(index).toContain("**status**");
    expect(index).toContain("[AMBIGUOUS]");
    // The "ask the user" guidance and the candidate columns both surface.
    expect(index).toContain("Appears in multiple tables — ASK the user.");
    expect(index).toContain("orders.status");
    expect(index).toContain("users.status");
  });

  it("renders note and possible_mappings independently across object-form terms (#3277)", () => {
    const root = ensureDir(`glossary-independent-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", { dimensions: [{ name: "id", type: "integer" }] }),
    );

    // The two render branches are independent ternaries — exercise each on its
    // own: note-only, possible_mappings-only, and an empty mappings array.
    writeFileSync(
      join(root, "glossary.yml"),
      [
        "terms:",
        "  note_only:",
        "    status: ambiguous",
        '    note: "Guidance with no candidate columns."',
        "  mappings_only:",
        "    status: ambiguous",
        "    possible_mappings: [orders.id, orders.total]",
        "  empty_mappings:",
        "    status: ambiguous",
        "    possible_mappings: []",
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);
    const lineOf = (term: string) =>
      index.split("\n").find((l) => l.includes(`**${term}**`)) ?? "";

    // note-only → renders the note, no "(maps to:" suffix.
    expect(lineOf("note_only")).toContain("→ Guidance with no candidate columns.");
    expect(lineOf("note_only")).not.toContain("maps to:");

    // possible_mappings-only → renders the mappings, no note arrow.
    expect(lineOf("mappings_only")).toContain("(maps to: orders.id, orders.total)");
    expect(lineOf("mappings_only")).not.toContain("→");

    // empty possible_mappings array → the `.length > 0` guard suppresses the suffix.
    expect(lineOf("empty_mappings")).not.toContain("maps to:");
  });

  it("filters non-string possible_mappings entries (#3277)", () => {
    const root = ensureDir(`glossary-filter-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", { dimensions: [{ name: "id", type: "integer" }] }),
    );

    // Hand-written YAML can carry non-string or blank entries; the formatter
    // drops them, preserves the order of the survivors, and emits no clause at
    // all when nothing survives (never a bare "(maps to: )").
    writeFileSync(
      join(root, "glossary.yml"),
      [
        "terms:",
        "  mixed:",
        "    status: ambiguous",
        "    possible_mappings: [orders.status, 42, users.status]",
        "  all_invalid:",
        "    status: ambiguous",
        "    possible_mappings: [1, 2, 3]",
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);
    const lineOf = (term: string) =>
      index.split("\n").find((l) => l.includes(`**${term}**`)) ?? "";

    // Survivors render in order; the non-string entry is dropped.
    expect(lineOf("mixed")).toContain("(maps to: orders.status, users.status)");
    expect(lineOf("mixed")).not.toContain("42");

    // No surviving strings → no "maps to" clause (not an empty one).
    expect(lineOf("all_invalid")).not.toContain("maps to:");
  });

  it("discovers groups/<group>/metrics, glossary, and catalog in the index (#3240)", () => {
    const root = ensureDir(`group-discovery-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    mkdirSync(join(root, "groups", "analytics", "entities"), { recursive: true });
    mkdirSync(join(root, "groups", "analytics", "metrics"), { recursive: true });

    // An entity in the group so its catalog use_for hint can attach.
    writeFileSync(
      join(root, "groups", "analytics", "entities", "sessions.yml"),
      makeEntity("sessions", { dimensions: [{ name: "id", type: "integer" }] }),
    );
    // A flat-root entity so the layer isn't group-only.
    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", { dimensions: [{ name: "id", type: "integer" }] }),
    );
    // A flat-root catalog alongside the group catalog → loadCatalog must MERGE
    // both layouts' entities[] so each entity gets its own use_for hint.
    writeFileSync(
      join(root, "catalog.yml"),
      [
        "version: '1'",
        "entities:",
        "  - name: orders",
        '    description: "Customer orders"',
        "    use_for:",
        '      - "Revenue analysis"',
      ].join("\n") + "\n",
    );

    // Canonical single-metric shape — keyed by `id:` (no `name:`), the common
    // form for generated group metrics. The index must surface it.
    writeFileSync(
      join(root, "groups", "analytics", "metrics", "wau.yml"),
      [
        "id: weekly_active_users",
        'description: "Distinct users active in the last 7 days"',
        "entity: sessions",
        "aggregation: count_distinct",
        "sql: SELECT COUNT(DISTINCT user_id) FROM sessions",
      ].join("\n") + "\n",
    );
    // Object-form glossary (current shape) — keyed by term name.
    writeFileSync(
      join(root, "groups", "analytics", "glossary.yml"),
      [
        "terms:",
        "  wau:",
        '    definition: "Weekly active users"',
        "    status: defined",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(root, "groups", "analytics", "catalog.yml"),
      [
        "version: '1'",
        "entities:",
        "  - name: sessions",
        '    description: "User sessions"',
        "    use_for:",
        '      - "Engagement analysis"',
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);

    // Group metric + glossary term are discovered (were entirely skipped before)
    // AND attributed to their group on their own line (not just via the entity).
    expect(index).toContain("weekly_active_users");
    expect(index).toContain("**wau**");
    expect(index).toMatch(/weekly_active_users.*\[analytics\]/);
    expect(index).toMatch(/\*\*wau\*\*.*\[analytics\]/);
    // Catalog use_for hints from BOTH the flat-root catalog and the group
    // catalog merge in — each attaches to its own entity.
    expect(index).toContain("Use for: Engagement analysis"); // group catalog → sessions
    expect(index).toContain("Use for: Revenue analysis"); // flat catalog → orders
    // The group entity is labeled with its group; nothing is attributed to "groups".
    expect(index).toContain("[analytics]");
    expect(index).not.toContain("[groups]");
  });

  it("scopes catalog use_for hints to the matching group on a cross-group name collision (#3240)", () => {
    const root = ensureDir(`catalog-collision-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    mkdirSync(join(root, "groups", "analytics", "entities"), { recursive: true });

    // Same entity NAME (`customers`) in two groups — the flat default and the
    // analytics group — each with its own catalog hint.
    writeFileSync(
      join(root, "entities", "customers.yml"),
      makeEntity("customers", { dimensions: [{ name: "id", type: "integer" }] }),
    );
    writeFileSync(
      join(root, "groups", "analytics", "entities", "customers.yml"),
      makeEntity("customers", { dimensions: [{ name: "id", type: "integer" }] }),
    );
    writeFileSync(
      join(root, "catalog.yml"),
      [
        "entities:",
        "  - name: customers",
        "    use_for:",
        '      - "Billing default-group"',
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(root, "groups", "analytics", "catalog.yml"),
      [
        "entities:",
        "  - name: customers",
        "    use_for:",
        '      - "Engagement analytics-group"',
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);

    // Each entity gets ONLY its own group's hint — no cross-group leakage.
    expect(index).toContain("Use for: Billing default-group");
    expect(index).toContain("Use for: Engagement analytics-group");
    // The analytics-group hint must not also attach to the default customers
    // entity rendered under the default (unlabeled) section, and vice versa.
    // Render order is default first, then groups, so the default entity's block
    // precedes the [analytics] block; assert the default block doesn't carry
    // the analytics hint by checking the analytics hint appears only after the
    // [analytics] label.
    const analyticsLabelIdx = index.indexOf("[analytics]");
    const analyticsHintIdx = index.indexOf("Use for: Engagement analytics-group");
    const defaultHintIdx = index.indexOf("Use for: Billing default-group");
    expect(analyticsHintIdx).toBeGreaterThan(analyticsLabelIdx);
    expect(defaultHintIdx).toBeLessThan(analyticsLabelIdx);
  });

  it("handles per-source subdirectories", () => {
    const root = ensureDir(`multisource-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    mkdirSync(join(root, "warehouse", "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "users.yml"),
      makeEntity("users", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    writeFileSync(
      join(root, "warehouse", "entities", "events.yml"),
      makeEntity("events", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("2 entities");
    expect(index).toContain("**users**");
    expect(index).toContain("**events**");
    // Per-source entities show connection ID
    expect(index).toContain("[warehouse]");
  });

  it("labels the resolved Connection group for the canonical groups/ layout and flat-root group: (ADR-0012)", () => {
    const root = ensureDir(`group-scope-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });
    mkdirSync(join(root, "groups", "warehouse", "entities"), { recursive: true });

    // Canonical groups/<group>/ entity → labeled with the directory group.
    writeFileSync(
      join(root, "groups", "warehouse", "entities", "events.yml"),
      makeEntity("events", { dimensions: [{ name: "id", type: "integer" }] }),
    );
    // Flat-root entity with a `group:` override → labeled with the field group,
    // matching how the whitelist routes it (never shown unscoped).
    writeFileSync(
      join(root, "entities", "leads.yml"),
      makeEntity("leads", { group: "crm", dimensions: [{ name: "id", type: "integer" }] }),
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("[warehouse]");
    expect(index).toContain("[crm]");
  });

  it("skips malformed YAML files gracefully", () => {
    const root = ensureDir(`malformed-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(join(root, "entities", "bad.yml"), "{{{not valid yaml");
    writeFileSync(
      join(root, "entities", "good.yml"),
      makeEntity("good_table", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("1 entities");
    expect(index).toContain("**good_table**");
  });

  it("includes catalog use_for hints in the index", () => {
    const root = ensureDir(`catalog-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", {
        description: "Customer orders",
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    writeFileSync(
      join(root, "catalog.yml"),
      [
        "version: '1'",
        "entities:",
        "  - name: orders",
        '    description: "Customer orders"',
        "    use_for:",
        '      - "Revenue analysis"',
        '      - "Order volume tracking"',
      ].join("\n") + "\n",
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("Use for: Revenue analysis; Order volume tracking");
  });

  it("truncates long entity descriptions at 200 characters", () => {
    const root = ensureDir(`truncate-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    const longDesc = "A".repeat(250);
    writeFileSync(
      join(root, "entities", "wide.yml"),
      makeEntity("wide", {
        description: longDesc,
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const index = buildSemanticIndex(root);

    // Should truncate to 197 chars + "..."
    expect(index).toContain("A".repeat(197) + "...");
    expect(index).not.toContain("A".repeat(200));
  });

  it("skips entities without a table field", () => {
    const root = ensureDir(`notable-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    // Valid YAML but missing the required `table` field
    writeFileSync(join(root, "entities", "no_table.yml"), "name: orphan\ndescription: No table field\n");
    writeFileSync(
      join(root, "entities", "good.yml"),
      makeEntity("good_table", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("1 entities");
    expect(index).toContain("**good_table**");
    expect(index).not.toContain("orphan");
  });

  it("handles entity with connection field", () => {
    const root = ensureDir(`connection-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "events.yml"),
      makeEntity("events", {
        connection: "analytics",
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const index = buildSemanticIndex(root);

    expect(index).toContain("[analytics]");
  });
});

describe("getSemanticIndex caching", () => {
  beforeEach(() => {
    invalidateSemanticIndex();
    testCounter++;
  });

  afterEach(() => {
    invalidateSemanticIndex();
    cleanTmpBase();
  });

  it("caches index across calls with same root", () => {
    const root = ensureDir(`cache-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "users.yml"),
      makeEntity("users", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const first = getSemanticIndex(root);
    const second = getSemanticIndex(root);

    // Same reference (cached)
    expect(first).toBe(second);
    expect(getIndexedEntityCount()).toBe(1);
  });

  it("invalidateSemanticIndex clears the cache", () => {
    const root = ensureDir(`invalidate-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    writeFileSync(
      join(root, "entities", "users.yml"),
      makeEntity("users", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const first = getSemanticIndex(root);
    expect(first).toContain("**users**");
    expect(getIndexedEntityCount()).toBe(1);

    invalidateSemanticIndex();
    expect(getIndexedEntityCount()).toBe(0);

    // Add a new entity and rebuild
    writeFileSync(
      join(root, "entities", "orders.yml"),
      makeEntity("orders", {
        dimensions: [{ name: "id", type: "integer" }],
      }),
    );

    const second = getSemanticIndex(root);
    expect(second).toContain("**users**");
    expect(second).toContain("**orders**");
    expect(getIndexedEntityCount()).toBe(2);
  });
});

describe("small vs large mode boundary", () => {
  beforeEach(() => {
    invalidateSemanticIndex();
    testCounter++;
  });

  afterEach(() => {
    invalidateSemanticIndex();
    cleanTmpBase();
  });

  it("19 entities → full mode", () => {
    const root = ensureDir(`boundary-19-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    for (let i = 0; i < 19; i++) {
      writeFileSync(
        join(root, "entities", `t${i}.yml`),
        makeEntity(`t${i}`, {
          dimensions: [
            { name: "id", type: "integer", primary_key: true },
            { name: "val", type: "text" },
          ],
        }),
      );
    }

    const index = buildSemanticIndex(root);
    expect(index).toContain("mode: full");
    expect(index).toContain("19 entities");
    // Full mode shows column types
    expect(index).toContain("id (integer PK)");
  });

  it("20 entities → summary mode", () => {
    const root = ensureDir(`boundary-20-${testCounter}`);
    mkdirSync(join(root, "entities"), { recursive: true });

    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(root, "entities", `t${i}.yml`),
        makeEntity(`t${i}`, {
          dimensions: [
            { name: "id", type: "integer", primary_key: true },
            { name: "val", type: "text" },
          ],
        }),
      );
    }

    const index = buildSemanticIndex(root);
    expect(index).toContain("mode: summary");
    expect(index).toContain("20 entities");
    // Summary mode shows count, not types
    expect(index).toContain("2 columns");
    expect(index).not.toContain("id (integer PK)");
  });
});
