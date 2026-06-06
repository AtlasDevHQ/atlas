/**
 * Shared LLM enrichment engine — direct coverage (issue #3233).
 *
 * Enrichment moved out of CLI-only `packages/cli/bin/enrich.ts` into the shared
 * lib so it is callable from both the CLI and the API path. It had no tests
 * before the move; this file pins its behaviour with a mocked LLM and a real
 * temp-dir of seed YAML (the pass is file-based: read → merge → write).
 *
 * No connection mocks: this slice's enrichment makes no DB calls — it consumes
 * the in-memory profile + the YAML on disk. DB-grounded enrichment
 * (docs/design/semantic-onboarding.md § D, Phase 2) is a later slice.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import type { TableProfile } from "@useatlas/types";

// --- LLM mock: branch the response off the prompt ----------------------------

type GenArgs = { prompt: string };
const ENTITY_RESPONSE = "```yaml\ndescription: |\n  Enriched: orders placed by a customer.\nuse_cases:\n  - Analyze order volume over time\n```";
const GLOSSARY_RESPONSE = "```yaml\nterms:\n  refund:\n    status: defined\n    definition: An order whose payment was returned.\n```";
const METRIC_RESPONSE = "```yaml\nmetrics:\n  - id: avg_order_value\n    label: Average order value\n    description: Mean amount per order.\n    type: derived\n    sql: |\n      SELECT AVG(amount) FROM orders\n```";

const mockGenerateText = mock(async ({ prompt }: GenArgs) => {
  let text = "no usable yaml here";
  if (prompt.includes("enriching a semantic layer YAML file")) text = ENTITY_RESPONSE;
  else if (prompt.includes("building a business glossary")) text = GLOSSARY_RESPONSE;
  else if (prompt.includes("enriching metric definitions")) text = METRIC_RESPONSE;
  return { text, usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 } };
});

mock.module("ai", () => ({ generateText: mockGenerateText }));
mock.module("@atlas/api/lib/providers", () => ({ getModel: () => ({ modelId: "test-model" }) }));

const { enrichSemanticLayer, enrichEntity } = await import("../enrich");

// --- fixtures ----------------------------------------------------------------

const ordersProfile: TableProfile = {
  table_name: "orders",
  object_type: "table",
  row_count: 4200,
  columns: [
    {
      name: "id", type: "integer", nullable: false, unique_count: 4200, null_count: 0,
      sample_values: [], is_primary_key: true, is_foreign_key: false,
      fk_target_table: null, fk_target_column: null, is_enum_like: false, profiler_notes: [],
    },
    {
      name: "amount", type: "numeric", nullable: false, unique_count: 3800, null_count: 0,
      sample_values: ["12.50", "9.99"], is_primary_key: false, is_foreign_key: false,
      fk_target_table: null, fk_target_column: null, is_enum_like: false, profiler_notes: [],
    },
  ],
  primary_key_columns: ["id"],
  foreign_keys: [],
  inferred_foreign_keys: [],
  profiler_notes: [],
  table_flags: { possibly_abandoned: false, possibly_denormalized: false },
};

const ENTITY_YAML = "name: Orders\ntype: fact_table\ntable: orders\ndescription: Auto-profiled schema for orders.\ndimensions:\n  - name: id\n    sql: id\n    type: number\n";
const GLOSSARY_YAML = "terms:\n  status:\n    status: defined\n    definition: Existing term.\n";
const METRIC_YAML = "metrics:\n  - id: orders_count\n    label: Total Orders\n    type: atomic\n    sql: SELECT COUNT(*) FROM orders\n";

let tmpDir: string;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  mockGenerateText.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-enrich-"));
  fs.mkdirSync(path.join(tmpDir, "entities"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "metrics"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "entities", "orders.yml"), ENTITY_YAML);
  fs.writeFileSync(path.join(tmpDir, "glossary.yml"), GLOSSARY_YAML);
  fs.writeFileSync(path.join(tmpDir, "metrics", "orders.yml"), METRIC_YAML);
  // Keep test output quiet — enrichment narrates progress via console.
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function read(rel: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(path.join(tmpDir, rel), "utf-8")) as Record<string, unknown>;
}

describe("enrichSemanticLayer (shared engine, file-based)", () => {
  it("merges LLM fields into the entity, glossary, and metric files", async () => {
    await enrichSemanticLayer([ordersProfile], { semanticDir: tmpDir });

    // Entity: enriched description replaces the mechanical one; existing
    // structural fields (name, dimensions) are preserved (deepMerge).
    const entity = read("entities/orders.yml");
    expect(String(entity.description)).toContain("Enriched: orders placed by a customer.");
    expect(entity.name).toBe("Orders");
    expect(Array.isArray(entity.dimensions)).toBe(true);

    // Glossary: new term added, existing term preserved.
    const glossary = read("glossary.yml") as { terms: Record<string, unknown> };
    expect(glossary.terms.refund).toBeDefined();
    expect(glossary.terms.status).toBeDefined();

    // Metric: new metric appended, existing metric preserved.
    const metric = read("metrics/orders.yml") as { metrics: { id: string }[] };
    const ids = metric.metrics.map((m) => m.id);
    expect(ids).toContain("orders_count");
    expect(ids).toContain("avg_order_value");
  });

  it("enriches metric files with no matching profile via the first-profile fallback", async () => {
    // Metric files don't always map 1:1 to a table (the real case: revenue.yml,
    // engagement.yml). enrichSemanticLayer falls back to profiles[0] for those.
    fs.writeFileSync(
      path.join(tmpDir, "metrics", "revenue.yml"),
      "metrics:\n  - id: revenue_total\n    label: Revenue\n    type: atomic\n    sql: SELECT SUM(amount) FROM orders\n",
    );
    await enrichSemanticLayer([ordersProfile], { semanticDir: tmpDir });
    const revenue = read("metrics/revenue.yml") as { metrics: { id: string }[] };
    const ids = revenue.metrics.map((m) => m.id);
    expect(ids).toContain("revenue_total"); // existing preserved
    expect(ids).toContain("avg_order_value"); // appended via the fallback profile
  });

  it("skips entity files that have no matching profile", async () => {
    fs.writeFileSync(path.join(tmpDir, "entities", "ghost.yml"), "name: Ghost\ntable: ghost\n");
    await enrichSemanticLayer([ordersProfile], { semanticDir: tmpDir });
    // ghost.yml was never sent to the LLM (no profile) → unchanged.
    expect(fs.readFileSync(path.join(tmpDir, "entities", "ghost.yml"), "utf-8")).toBe("name: Ghost\ntable: ghost\n");
    // Only entity(orders) + glossary + metric(orders) → exactly 3 LLM calls.
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });
});

describe("enrichEntity (per-table primitive)", () => {
  it("leaves the file untouched when the LLM response is not parseable YAML", async () => {
    const before = ENTITY_YAML;
    const filePath = path.join(tmpDir, "entities", "orders.yml");
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // A profile whose prompt won't match any branch → mock returns prose.
    const unmatched: TableProfile = { ...ordersProfile, table_name: "orders" };
    mockGenerateText.mockImplementationOnce(async () => ({
      text: "Sorry, I cannot help with that.",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    await enrichEntity(filePath, unmatched, { modelId: "x" } as never, usage);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
  });

  it("replaces array fields instead of concatenating them (deepMerge contract)", async () => {
    // deepMerge documents "Arrays are replaced, not concatenated". If that ever
    // regresses to concat, every re-run of enrichment would duplicate list
    // entries (use_cases, query_patterns). Pin it.
    const filePath = path.join(tmpDir, "entities", "orders.yml");
    fs.writeFileSync(filePath, "name: Orders\ntable: orders\nuse_cases:\n  - stale one\n  - stale two\n");
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    mockGenerateText.mockImplementationOnce(async () => ({
      text: "```yaml\nuse_cases:\n  - the only fresh use case\n```",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    await enrichEntity(filePath, ordersProfile, { modelId: "x" } as never, usage);
    const merged = yaml.load(fs.readFileSync(filePath, "utf-8")) as { use_cases: string[]; name: string };
    expect(merged.use_cases).toEqual(["the only fresh use case"]); // replaced, not appended
    expect(merged.name).toBe("Orders"); // non-array field preserved
  });
});
