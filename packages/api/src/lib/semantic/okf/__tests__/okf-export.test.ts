import { describe, expect, it } from "bun:test";
import * as yaml from "js-yaml";
import { parseFrontmatter } from "../frontmatter";
import { exportToOkf } from "../export";
import { importOkfBundle } from "../import";
import { SEMANTIC_LAYER } from "./fixtures";

const TIMESTAMP = "2026-07-02T00:00:00+00:00";

function fileMap(files: Array<{ path: string; content: string }>): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("exportToOkf", () => {
  const { files, report } = exportToOkf(SEMANTIC_LAYER, { timestamp: TIMESTAMP });
  const byPath = fileMap(files);

  it("emits one concept doc per entity, metric, and glossary term plus indexes", () => {
    expect([...byPath.keys()].sort()).toEqual(
      [
        "index.md",
        "references/glossary/gmv.md",
        "references/glossary/index.md",
        "references/glossary/revenue.md",
        "references/index.md",
        "references/metrics/index.md",
        "references/metrics/total_gmv.md",
        "tables/customers.md",
        "tables/index.md",
        "tables/orders.md",
      ].sort(),
    );
  });

  it("emits OKF-conformant concept docs (frontmatter with non-empty type)", () => {
    for (const [path, content] of byPath) {
      const base = path.split("/").pop() ?? path;
      if (base === "index.md" || base === "log.md") continue;
      const parsed = parseFrontmatter(content);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(`unparseable: ${path}: ${parsed.reason}`);
      expect(parsed.doc.frontmatter.type.length).toBeGreaterThan(0);
      expect(parsed.doc.frontmatter.timestamp).toBe(TIMESTAMP);
    }
  });

  it("declares okf_version on the root index only", () => {
    expect(byPath.get("index.md")).toContain('okf_version: "0.1"');
    expect(byPath.get("tables/index.md")).not.toContain("okf_version");
  });

  it("renders a prose schema section with types, PK, samples, and virtual SQL", () => {
    const orders = byPath.get("tables/orders.md") ?? "";
    expect(orders).toContain("# Schema");
    expect(orders).toContain("- `id` (NUMBER):");
    expect(orders).toContain("Primary key.");
    expect(orders).toContain("Sample values: pending, shipped, cancelled.");
    expect(orders).toContain("Virtual dimension");
    expect(orders).toContain("TO_CHAR(created_at, 'YYYY-MM')");
  });

  it("renders measures, joins, use cases, and query patterns as prose", () => {
    const orders = byPath.get("tables/orders.md") ?? "";
    expect(orders).toContain("# Measures");
    expect(orders).toContain("`total_gmv_cents` (sum of `total_cents`)");
    expect(orders).toContain("# Joins");
    expect(orders).toContain("Customers on `orders.customer_id = id` (many to one)");
    expect(orders).toContain("# Use cases");
    expect(orders).toContain("# Example queries");
    expect(orders).toContain("```sql");
  });

  it("links entity docs to the metrics sourced from them", () => {
    const orders = byPath.get("tables/orders.md") ?? "";
    expect(orders).toContain("# Metrics");
    expect(orders).toContain("[Total GMV](../references/metrics/total_gmv.md)");
  });

  it("exports metrics as Reference concepts with the authoritative SQL", () => {
    const metric = byPath.get("references/metrics/total_gmv.md") ?? "";
    const parsed = parseFrontmatter(metric);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.doc.frontmatter.type).toBe("Reference");
    expect(parsed.doc.frontmatter.tags).toContain("metric");
    expect(metric).toContain("SELECT SUM(total_cents) / 100.0 AS total_gmv");
    expect(metric).toContain("authoritative");
  });

  it("exports ambiguous glossary terms as prose and reports the dropped gating", () => {
    const revenue = byPath.get("references/glossary/revenue.md") ?? "";
    expect(revenue).toContain("Possible mappings:");
    expect(revenue).toContain("`orders.total_cents`");
    expect(revenue).toContain("asks the user");
    expect(report.lossy.some((l) => l.includes('"revenue"') && l.includes("ask-first"))).toBe(
      true,
    );
  });

  it("reports the authoritative-runtime semantics OKF cannot express", () => {
    expect(report.lossy.some((l) => l.includes("whitelist"))).toBe(true);
    expect(report.lossy.some((l) => l.includes("pinned-metric"))).toBe(true);
  });
});

describe("round-trip: Atlas -> OKF -> Atlas", () => {
  const exported = exportToOkf(SEMANTIC_LAYER, { timestamp: TIMESTAMP });
  const reimported = importOkfBundle(exported.files, { bundleName: "ecommerce" });
  const byPath = fileMap(reimported.files);

  function loadOriginal(path: string): unknown {
    const file = SEMANTIC_LAYER.find((f) => f.path === path);
    if (!file) throw new Error(`missing fixture ${path}`);
    return yaml.load(file.content);
  }

  it("restores entities verbatim via the atlas extension", () => {
    for (const path of ["entities/orders.yml", "entities/customers.yml"]) {
      expect(yaml.load(byPath.get(path) ?? "")).toEqual(loadOriginal(path));
    }
  });

  it("restores glossary terms verbatim, including ambiguity gating", () => {
    const original = loadOriginal("glossary.yml") as { terms: Record<string, unknown> };
    const roundTripped = yaml.load(byPath.get("glossary.yml") ?? "") as {
      terms: Record<string, unknown>;
    };
    expect(roundTripped.terms).toEqual(original.terms);
  });

  it("restores metrics verbatim (no unverified flag on the native path)", () => {
    const original = loadOriginal("metrics/revenue.yml") as {
      metrics: Array<Record<string, unknown>>;
    };
    const roundTripped = yaml.load(byPath.get("metrics/okf-imported.yml") ?? "") as {
      metrics: Array<Record<string, unknown>>;
    };
    expect(roundTripped.metrics).toEqual(original.metrics);
  });

  it("notes the lossless restores in the report", () => {
    expect(
      reimported.report.notes.filter((n) => n.includes("restored verbatim")).length,
    ).toBeGreaterThanOrEqual(4);
  });
});
