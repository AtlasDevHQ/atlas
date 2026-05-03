import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listEntities,
  getEntityByName,
  loadGlossaryTerms,
  searchGlossary,
  loadMetricDefinitions,
  findMetricById,
} from "../lookups";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-lookups-"));
  fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "metrics"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "warehouse", "entities"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "warehouse", "metrics"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRoot, "entities", "users.yml"),
    [
      "name: User",
      "table: users",
      "description: Application user accounts",
      "dimensions:",
      "  - name: id",
      "    type: string",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tmpRoot, "entities", "orders.yml"),
    [
      "table: orders",
      "description: Order records — one row per checkout",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tmpRoot, "warehouse", "entities", "events.yml"),
    [
      "table: events",
      "description: Tracking events from the warehouse source",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(tmpRoot, "glossary.yml"),
    [
      "terms:",
      "  revenue:",
      "    status: defined",
      "    definition: Sum of paid invoice amounts.",
      "  status:",
      "    status: ambiguous",
      "    note: Appears in multiple tables — ASK the user.",
      "    possible_mappings:",
      "      - orders.status",
      "      - users.status",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tmpRoot, "warehouse", "glossary.yml"),
    [
      "terms:",
      "  - term: cohort",
      "    status: defined",
      "    definition: Group of users sharing a signup month.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(tmpRoot, "metrics", "orders.yml"),
    [
      "metrics:",
      "  - id: orders_count",
      "    label: Total orders",
      "    description: Distinct order count.",
      "    type: atomic",
      "    sql: |-",
      "      SELECT COUNT(DISTINCT id) AS count FROM orders",
      "    aggregation: count_distinct",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tmpRoot, "warehouse", "metrics", "events.yml"),
    [
      "id: events_count",
      "sql: |-",
      "  SELECT COUNT(*) AS count FROM events",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("listEntities", () => {
  it("returns all entities sorted by name", () => {
    const result = listEntities({ semanticRoot: tmpRoot });
    const names = result.map((e) => e.name);
    expect(names).toContain("User");
    expect(names).toContain("orders");
    expect(names).toContain("events");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("filters by case-insensitive substring across name/table/description", () => {
    const result = listEntities({ semanticRoot: tmpRoot, filter: "ORDER" });
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("orders");
  });

  it("returns empty array when filter matches nothing", () => {
    const result = listEntities({ semanticRoot: tmpRoot, filter: "nonexistent" });
    expect(result).toEqual([]);
  });

  it("tags per-source entities with the source directory name", () => {
    const result = listEntities({ semanticRoot: tmpRoot });
    const events = result.find((e) => e.table === "events");
    expect(events?.source).toBe("warehouse");
  });
});

describe("getEntityByName", () => {
  it("returns parsed YAML for an existing entity (by file basename)", () => {
    const entity = getEntityByName("users", { semanticRoot: tmpRoot });
    expect(entity).not.toBeNull();
    expect(entity?.table).toBe("users");
    expect(entity?.name).toBe("User");
  });

  it("returns parsed YAML when looking up by `name` field", () => {
    const entity = getEntityByName("User", { semanticRoot: tmpRoot });
    expect(entity?.table).toBe("users");
  });

  it("returns null for an unknown entity", () => {
    const entity = getEntityByName("does_not_exist", { semanticRoot: tmpRoot });
    expect(entity).toBeNull();
  });

  it("rejects names with path traversal segments", () => {
    expect(getEntityByName("../etc/passwd", { semanticRoot: tmpRoot })).toBeNull();
    expect(getEntityByName("a/b", { semanticRoot: tmpRoot })).toBeNull();
  });
});

describe("loadGlossaryTerms", () => {
  it("flattens object-form terms with the implicit key as `term`", () => {
    const terms = loadGlossaryTerms({ semanticRoot: tmpRoot });
    const revenue = terms.find((t) => t.term === "revenue");
    expect(revenue?.status).toBe("defined");
    expect(revenue?.definition).toContain("paid invoice");
  });

  it("flattens array-form terms (legacy)", () => {
    const terms = loadGlossaryTerms({ semanticRoot: tmpRoot });
    const cohort = terms.find((t) => t.term === "cohort");
    expect(cohort?.source).toBe("warehouse");
    expect(cohort?.definition).toContain("signup month");
  });

  it("preserves possible_mappings for ambiguous terms", () => {
    const terms = loadGlossaryTerms({ semanticRoot: tmpRoot });
    const status = terms.find((t) => t.term === "status");
    expect(status?.status).toBe("ambiguous");
    expect(status?.possible_mappings).toContain("orders.status");
  });
});

describe("searchGlossary", () => {
  it("matches by term substring", () => {
    const hits = searchGlossary("REVENUE", { semanticRoot: tmpRoot });
    expect(hits).toHaveLength(1);
    expect(hits[0].term).toBe("revenue");
  });

  it("matches by definition or note text", () => {
    const hits = searchGlossary("invoice", { semanticRoot: tmpRoot });
    expect(hits.map((t) => t.term)).toContain("revenue");
  });

  it("returns empty array when nothing matches", () => {
    expect(searchGlossary("not-a-real-term", { semanticRoot: tmpRoot })).toEqual([]);
  });

  it("returns empty array for empty query", () => {
    expect(searchGlossary("   ", { semanticRoot: tmpRoot })).toEqual([]);
  });
});

describe("loadMetricDefinitions", () => {
  it("loads metrics from default and per-source directories", () => {
    const metrics = loadMetricDefinitions({ semanticRoot: tmpRoot });
    const ids = metrics.map((m) => m.id).sort();
    expect(ids).toEqual(["events_count", "orders_count"]);
  });

  it("normalizes top-level single-metric files", () => {
    const metrics = loadMetricDefinitions({ semanticRoot: tmpRoot });
    const events = metrics.find((m) => m.id === "events_count");
    expect(events?.sql).toContain("SELECT COUNT(*)");
    expect(events?.source).toBe("warehouse");
  });
});

describe("findMetricById", () => {
  it("returns the metric definition when it exists", () => {
    const metric = findMetricById("orders_count", { semanticRoot: tmpRoot });
    expect(metric?.label).toBe("Total orders");
    expect(metric?.aggregation).toBe("count_distinct");
  });

  it("returns null for an unknown metric", () => {
    expect(findMetricById("nonexistent", { semanticRoot: tmpRoot })).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(findMetricById("", { semanticRoot: tmpRoot })).toBeNull();
  });
});
