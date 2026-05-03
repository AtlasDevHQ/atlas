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
// `beforeAll` / `afterAll` already imported at the top from "bun:test".

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

// ---------------------------------------------------------------------------
// Edge-case coverage — locks the silent-fallback contracts that the
// loader-side warn-and-skip behaviour depends on. A future refactor that
// re-throws on a single bad file would silently brick `listEntities` and
// `searchGlossary` for the whole catalog, so these tests pin the contract.
// ---------------------------------------------------------------------------

describe("malformed-file resilience", () => {
  let resilientRoot: string;

  beforeAll(() => {
    resilientRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-lookups-bad-"));
    fs.mkdirSync(path.join(resilientRoot, "entities"), { recursive: true });
    fs.mkdirSync(path.join(resilientRoot, "metrics"), { recursive: true });

    fs.writeFileSync(
      path.join(resilientRoot, "entities", "good.yml"),
      "table: good\ndescription: Healthy entity\n",
    );
    // Real YAML can produce parse errors (unbalanced quotes, bad indentation).
    fs.writeFileSync(
      path.join(resilientRoot, "entities", "bad.yml"),
      "table: bad\ndimensions:\n  - {name: id, type:\nbroken indent\n",
    );
    fs.writeFileSync(
      path.join(resilientRoot, "glossary.yml"),
      "terms:\n  good_term:\n    status: defined\n    definition: ok\n",
    );
    fs.writeFileSync(
      path.join(resilientRoot, "metrics", "good.yml"),
      "id: good_metric\nsql: SELECT 1\n",
    );
    fs.writeFileSync(
      path.join(resilientRoot, "metrics", "bad.yml"),
      "metrics:\n  - id: still_bad\n    sql: |\n  unclosed { brace\n",
    );
  });

  afterAll(() => {
    fs.rmSync(resilientRoot, { recursive: true, force: true });
  });

  it("listEntities skips malformed entity files and returns the rest", () => {
    const result = listEntities({ semanticRoot: resilientRoot });
    const tables = result.map((e) => e.table);
    expect(tables).toContain("good");
    // The bad file may or may not parse far enough to surface — what
    // matters is that the loader didn't throw and good entities still load.
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("loadMetricDefinitions skips a malformed file and returns the rest", () => {
    const metrics = loadMetricDefinitions({ semanticRoot: resilientRoot });
    expect(metrics.find((m) => m.id === "good_metric")).toBeDefined();
  });

  it("findMetricById still resolves the good metric when a sibling is malformed", () => {
    const metric = findMetricById("good_metric", { semanticRoot: resilientRoot });
    expect(metric?.sql).toContain("SELECT 1");
  });

  it("getEntityByName falls through to the scan when the basename match is malformed", () => {
    // bad.yml exists at the basename, but parsing fails. The scan-fallback
    // pass should not crash; the entity is unrecoverable so we expect null.
    expect(getEntityByName("bad", { semanticRoot: resilientRoot })).toBeNull();
    // The good entity is reachable both via basename and via fallback scan.
    expect(getEntityByName("good", { semanticRoot: resilientRoot })?.table).toBe("good");
  });
});

describe("searchGlossary — possible_mappings haystack", () => {
  it("matches by an entry inside possible_mappings (e.g. orders.status)", () => {
    const hits = searchGlossary("orders.status", { semanticRoot: tmpRoot });
    expect(hits.map((t) => t.term)).toContain("status");
  });
});

describe("listEntities — defensive coercion", () => {
  let coerceRoot: string;

  beforeAll(() => {
    coerceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-lookups-coerce-"));
    fs.mkdirSync(path.join(coerceRoot, "entities"), { recursive: true });
    fs.writeFileSync(
      path.join(coerceRoot, "entities", "no_desc.yml"),
      "table: no_desc\ndescription:\n",
    );
    fs.writeFileSync(
      path.join(coerceRoot, "entities", "non_string_name.yml"),
      "name: 42\ntable: non_string_name\n",
    );
  });

  afterAll(() => {
    fs.rmSync(coerceRoot, { recursive: true, force: true });
  });

  it("returns description: null when the YAML field is empty", () => {
    const result = listEntities({ semanticRoot: coerceRoot });
    const noDesc = result.find((e) => e.table === "no_desc");
    expect(noDesc?.description).toBeNull();
  });

  it("falls back to table when name is non-string", () => {
    const result = listEntities({ semanticRoot: coerceRoot });
    const nonStringName = result.find((e) => e.table === "non_string_name");
    expect(nonStringName?.name).toBe("non_string_name");
  });
});

describe("RESERVED_DIRS — entities/ and metrics/ are not scanned for glossaries or sub-metrics", () => {
  let reservedRoot: string;

  beforeAll(() => {
    reservedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-lookups-reserved-"));
    fs.mkdirSync(path.join(reservedRoot, "entities"), { recursive: true });
    fs.mkdirSync(path.join(reservedRoot, "metrics"), { recursive: true });
    // A hostile/confused author drops a glossary inside the reserved
    // entities/ dir. The traversal must not pick this up as a per-source
    // glossary or it would shadow the real one.
    fs.writeFileSync(
      path.join(reservedRoot, "entities", "../entities/glossary.yml"),
      "terms:\n  ghost_term:\n    status: defined\n    definition: should not load\n",
    );
    // Sanity: an actual entity inside entities/ so the scan finds something.
    fs.writeFileSync(
      path.join(reservedRoot, "entities", "real.yml"),
      "table: real\n",
    );
  });

  afterAll(() => {
    fs.rmSync(reservedRoot, { recursive: true, force: true });
  });

  it("does not pick up glossary.yml from inside the reserved entities/ dir", () => {
    const terms = loadGlossaryTerms({ semanticRoot: reservedRoot });
    expect(terms.find((t) => t.term === "ghost_term")).toBeUndefined();
  });
});
