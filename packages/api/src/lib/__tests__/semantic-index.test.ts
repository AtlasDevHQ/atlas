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
const modPath = resolve(__dirname, "../semantic-index.ts");
const mod = await import(`${modPath}?t=${Date.now()}`);
const buildSemanticIndex = mod.buildSemanticIndex as typeof import("../semantic-index").buildSemanticIndex;
const getSemanticIndex = mod.getSemanticIndex as typeof import("../semantic-index").getSemanticIndex;
const invalidateSemanticIndex = mod.invalidateSemanticIndex as typeof import("../semantic-index").invalidateSemanticIndex;
const getIndexedEntityCount = mod.getIndexedEntityCount as typeof import("../semantic-index").getIndexedEntityCount;

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
