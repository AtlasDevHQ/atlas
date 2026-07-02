import { describe, expect, it } from "bun:test";
import * as yaml from "js-yaml";
import { parseFrontmatter } from "../frontmatter";
import { mapColumnType, parseSchemaColumns, splitSections } from "../parse";
import { importOkfBundle } from "../import";
import { FOREIGN_BUNDLE } from "./fixtures";

function fileMap(files: Array<{ path: string; content: string }>): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("parseFrontmatter", () => {
  it("parses frontmatter and body", () => {
    const result = parseFrontmatter(`---\ntype: Reference\ntitle: X\n---\n\nBody text.\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.doc.frontmatter.type).toBe("Reference");
    expect(result.doc.frontmatter.title).toBe("X");
    expect(result.doc.body.trim()).toBe("Body text.");
  });

  it("rejects documents without frontmatter", () => {
    const result = parseFrontmatter("just markdown\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("no YAML frontmatter");
  });

  it("rejects frontmatter without the required type", () => {
    const result = parseFrontmatter(`---\ntitle: X\n---\nBody\n`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("type");
  });
});

describe("schema section parsing", () => {
  it("parses bullet-form columns (GA4 style)", () => {
    const cols = parseSchemaColumns(
      "- `event_date` (STRING): The date.\n- `event_ts` (INTEGER): Micros.",
    );
    expect(cols).toEqual([
      { name: "event_date", rawType: "STRING", description: "The date." },
      { name: "event_ts", rawType: "INTEGER", description: "Micros." },
    ]);
  });

  it("parses table-form columns (launch-blog style)", () => {
    const cols = parseSchemaColumns(
      [
        "| Column | Type | Description |",
        "|--------|------|-------------|",
        "| `order_id` | STRING | Unique id. |",
        "| `total` | NUMERIC | Order total. |",
      ].join("\n"),
    );
    expect(cols).toEqual([
      { name: "order_id", rawType: "STRING", description: "Unique id." },
      { name: "total", rawType: "NUMERIC", description: "Order total." },
    ]);
  });

  it("maps source types onto Atlas dimension types", () => {
    expect(mapColumnType("STRING")).toBe("string");
    expect(mapColumnType("INT64")).toBe("number");
    expect(mapColumnType("FLOAT")).toBe("number");
    expect(mapColumnType("TIMESTAMP")).toBe("timestamp");
    expect(mapColumnType("DATE")).toBe("date");
    expect(mapColumnType("BOOLEAN")).toBe("boolean");
    expect(mapColumnType("RECORD")).toBeUndefined();
    expect(mapColumnType("ARRAY<STRING>")).toBeUndefined();
  });

  it("splits bodies on top-level headings only", () => {
    const sections = splitSections("intro\n\n# Schema\n- x\n\n## Group\n- y\n\n# Joins\nz");
    expect(sections.get("")).toBe("intro");
    expect(sections.get("schema")).toContain("## Group");
    expect(sections.get("joins")).toBe("z");
  });
});

describe("importOkfBundle (foreign bundle)", () => {
  const { files, report } = importOkfBundle(FOREIGN_BUNDLE, { bundleName: "shop" });
  const byPath = fileMap(files);

  it("drafts one entity per table concept", () => {
    expect([...byPath.keys()].filter((p) => p.startsWith("entities/")).sort()).toEqual([
      "entities/events.yml",
      "entities/users.yml",
    ]);
    const events = yaml.load(byPath.get("entities/events.yml") ?? "") as Record<string, unknown>;
    expect(events.table).toBe("events");
    expect(events.name).toBe("Events table");
    expect(String(events.description)).toContain("web event export data");
    const dims = events.dimensions as Array<Record<string, unknown>>;
    expect(dims.map((d) => d.name)).toEqual([
      "event_date",
      "event_timestamp",
      "event_name",
      "event_value_in_usd",
      "is_active_user",
    ]);
    expect(dims[1].type).toBe("number");
    expect(dims[4].type).toBe("boolean");
  });

  it("parses table-form schemas too", () => {
    const users = yaml.load(byPath.get("entities/users.yml") ?? "") as Record<string, unknown>;
    const dims = users.dimensions as Array<Record<string, unknown>>;
    expect(dims.map((d) => d.name)).toEqual(["user_id", "signup_at", "ltv_usd"]);
    expect(dims[1].type).toBe("timestamp");
    expect(dims[2].type).toBe("number");
  });

  it("reports nested RECORD columns as lossy instead of importing them", () => {
    const events = yaml.load(byPath.get("entities/events.yml") ?? "") as Record<string, unknown>;
    const dims = events.dimensions as Array<Record<string, unknown>>;
    expect(dims.some((d) => d.name === "event_params")).toBe(false);
    expect(report.lossy.some((l) => l.includes("event_params"))).toBe(true);
  });

  it("carries OKF provenance on imported entities", () => {
    const events = yaml.load(byPath.get("entities/events.yml") ?? "") as Record<string, unknown>;
    const okf = events.okf as Record<string, unknown>;
    expect(okf.source_path).toBe("tables/events.md");
    expect(String(okf.resource)).toContain("bigquery");
  });

  it("imports metrics as unverified drafts in a dedicated file", () => {
    const content = byPath.get("metrics/okf-imported.yml") ?? "";
    expect(content.startsWith("# Imported from OKF")).toBe(true);
    const doc = yaml.load(content) as { metrics: Array<Record<string, unknown>> };
    const purchase = doc.metrics.find((m) => m.id === "purchase_count");
    expect(purchase).toBeDefined();
    expect(String(purchase?.sql)).toContain("COUNT(*)");
    expect((purchase?.okf as Record<string, unknown>).unverified_sql).toBe(true);
    expect(
      report.lossy.some((l) => l.includes("not an executable contract")),
    ).toBe(true);
  });

  it("imports a metric with no sql fence as description-only", () => {
    const doc = yaml.load(byPath.get("metrics/okf-imported.yml") ?? "") as {
      metrics: Array<Record<string, unknown>>;
    };
    const prose = doc.metrics.find((m) => m.id === "prose_only_metric");
    expect(prose).toBeDefined();
    expect(prose?.sql).toBeUndefined();
    expect(report.lossy.some((l) => l.includes("prose_only_metric"))).toBe(true);
  });

  it("attaches resolvable joins and reports unresolvable ones", () => {
    const events = yaml.load(byPath.get("entities/events.yml") ?? "") as Record<string, unknown>;
    const joins = events.joins as Array<Record<string, unknown>>;
    expect(joins).toHaveLength(1);
    expect(joins[0].target_entity).toBe("Users table");
    expect(joins[0].join_columns).toEqual({ from: "user_id", to: "user_id" });
    expect(
      report.unmapped.some((u) => u.includes("events_ads") && u.includes("ADS_CLICKS")),
    ).toBe(true);
  });

  it("folds dataset concepts into the catalog and reports unknown types", () => {
    const catalog = yaml.load(byPath.get("catalog.yml") ?? "") as Record<string, unknown>;
    expect(catalog.name).toBe("shop");
    expect(String(catalog.description)).toContain("three months");
    const entities = catalog.entities as Array<Record<string, unknown>>;
    expect(entities.map((e) => e.file).sort()).toEqual([
      "entities/events.yml",
      "entities/users.yml",
    ]);
    expect(
      report.unmapped.some((u) => u.includes("runbook.md") && u.includes("Playbook")),
    ).toBe(true);
  });

  it("reports malformed concept files instead of silently skipping them", () => {
    expect(report.unmapped.some((u) => u.includes("tables/broken.md"))).toBe(true);
  });

  it("does not emit a glossary when the bundle has no term concepts", () => {
    expect(byPath.has("glossary.yml")).toBe(false);
  });
});
