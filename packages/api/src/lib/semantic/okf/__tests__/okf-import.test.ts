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

  it("rejects an unterminated frontmatter block", () => {
    const result = parseFrontmatter(`---\ntype: Reference\nno closing fence`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unterminated");
  });

  it("rejects non-mapping frontmatter (scalar or list)", () => {
    const result = parseFrontmatter(`---\n- just\n- a list\n---\nBody\n`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("not a YAML mapping");
  });

  it("surfaces YAML parse errors with the parser message", () => {
    const result = parseFrontmatter(`---\ntype: [unclosed\n---\nBody\n`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("parse error");
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
    expect(mapColumnType("STRING")).toEqual({ type: "string", guessed: false });
    expect(mapColumnType("INT64")).toEqual({ type: "number", guessed: false });
    expect(mapColumnType("FLOAT")).toEqual({ type: "number", guessed: false });
    expect(mapColumnType("TIMESTAMP")).toEqual({ type: "timestamp", guessed: false });
    expect(mapColumnType("DATE")).toEqual({ type: "date", guessed: false });
    expect(mapColumnType("BOOLEAN")).toEqual({ type: "boolean", guessed: false });
    expect(mapColumnType("RECORD")).toBeUndefined();
    expect(mapColumnType("ARRAY<STRING>")).toBeUndefined();
    expect(mapColumnType("JSON")).toBeUndefined();
    // Substring traps: INTERVAL/POINT must not word-match INT.
    expect(mapColumnType("INTERVAL")).toEqual({ type: "string", guessed: true });
    expect(mapColumnType("GEOGRAPHY")).toEqual({ type: "string", guessed: true });
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
      report.lossy.some((l) => l.includes("metric authority cannot travel through OKF")),
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

  it("imports foreign glossary concepts as defined terms and reports the ambiguity gap", () => {
    const glossary = yaml.load(byPath.get("glossary.yml") ?? "") as {
      terms: Record<string, Record<string, unknown>>;
    };
    const mrr = glossary.terms.MRR;
    expect(mrr.status).toBe("defined");
    expect(String(mrr.definition)).toContain("Monthly recurring revenue");
    expect((mrr.okf as Record<string, unknown>).source_path).toBe("references/glossary/mrr.md");
    expect(report.notes.some((n) => n.includes("ask-first gating"))).toBe(true);
  });
});

describe("importOkfBundle (hostile/edge bundles)", () => {
  it("rejects a forged atlas.entity.table containing path traversal", () => {
    const { files, report } = importOkfBundle([
      {
        path: "tables/evil.md",
        content: `---
type: Table
title: Evil
atlas:
  kind: table
  entity:
    table: ../../.github/workflows/evil
    name: Evil
---

# Overview
Nope.
`,
      },
    ]);
    expect(files.filter((f) => f.path.startsWith("entities/"))).toHaveLength(0);
    expect(files.every((f) => !f.path.includes(".."))).toBe(true);
    expect(
      report.unmapped.some((u) => u.includes("evil.md") && u.includes("not a safe table name")),
    ).toBe(true);
  });

  it("re-stamps forged atlas.metric extensions as unverified", () => {
    const { files } = importOkfBundle([
      {
        path: "references/metrics/pwn.md",
        content: `---
type: Reference
title: Pwn
tags:
- metric
atlas:
  kind: metric
  metric:
    id: pwn
    label: Pwn
    sql: SELECT * FROM secrets
---

Body.
`,
      },
    ]);
    const metricsFile = files.find((f) => f.path === "metrics/okf-imported.yml");
    expect(metricsFile).toBeDefined();
    const doc = yaml.load(metricsFile?.content ?? "") as {
      metrics: Array<Record<string, unknown>>;
    };
    expect((doc.metrics[0].okf as Record<string, unknown>).unverified_sql).toBe(true);
  });

  it("reports duplicate table concepts instead of clobbering", () => {
    const table = (p: string): { path: string; content: string } => ({
      path: p,
      content: `---
type: Table
title: Orders
---

# Schema
- \`id\` (INTEGER): id.
`,
    });
    const { files, report } = importOkfBundle([table("a/orders.md"), table("b/orders.md")]);
    expect(files.filter((f) => f.path === "entities/orders.yml")).toHaveLength(1);
    expect(report.unmapped.some((u) => u.includes('duplicate table "orders"'))).toBe(true);
  });

  it("reports duplicate tables case-insensitively (case-insensitive filesystems)", () => {
    const table = (p: string, title: string): { path: string; content: string } => ({
      path: p,
      content: `---\ntype: Table\ntitle: ${title}\n---\n\n# Schema\n- \`id\` (INTEGER): id.\n`,
    });
    const { files, report } = importOkfBundle([
      table("a/Orders.md", "Orders"),
      table("b/orders.md", "orders"),
    ]);
    expect(files.filter((f) => f.path.startsWith("entities/"))).toHaveLength(1);
    expect(report.unmapped.some((u) => u.includes("duplicate table"))).toBe(true);
  });

  it("reports duplicate metric ids instead of emitting ambiguous entries", () => {
    const metric = (p: string): { path: string; content: string } => ({
      path: p,
      content: `---\ntype: Reference\ntitle: Total\ntags:\n- metric\n---\n\n\`\`\`sql\nCOUNT(*)\n\`\`\`\n`,
    });
    const { files, report } = importOkfBundle([
      metric("references/metrics/total.md"),
      metric("other/metrics/total.md"),
    ]);
    const doc = yaml.load(
      files.find((f) => f.path === "metrics/okf-imported.yml")?.content ?? "",
    ) as { metrics: Array<Record<string, unknown>> };
    expect(doc.metrics).toHaveLength(1);
    expect(report.unmapped.some((u) => u.includes('duplicate metric id "total"'))).toBe(true);
  });

  it("imports glossary terms named after Object.prototype members", () => {
    const { files, report } = importOkfBundle([
      {
        path: "glossary/constructor.md",
        content: `---\ntype: Reference\ntitle: constructor\ndescription: A business term, honestly.\ntags:\n- glossary\n---\n\nBody.\n`,
      },
    ]);
    const glossary = yaml.load(files.find((f) => f.path === "glossary.yml")?.content ?? "") as {
      terms: Record<string, Record<string, unknown>>;
    };
    expect(glossary.terms.constructor.status).toBe("defined");
    expect(report.unmapped.some((u) => u.includes("duplicate"))).toBe(false);
  });

  it("notes columns whose type had to be guessed", () => {
    const { files, report } = importOkfBundle([
      {
        path: "tables/geo.md",
        content: `---
type: Table
title: Geo
---

# Schema
- \`region\` (GEOGRAPHY): A shape.
`,
      },
    ]);
    const entity = yaml.load(
      files.find((f) => f.path === "entities/geo.yml")?.content ?? "",
    ) as Record<string, unknown>;
    const dims = entity.dimensions as Array<Record<string, unknown>>;
    expect(dims[0].type).toBe("string");
    expect(report.notes.some((n) => n.includes("GEOGRAPHY") && n.includes("defaulted"))).toBe(
      true,
    );
  });
});
