/**
 * Unit tests for the LLM-driven MCP eval grader (#2119 Part B).
 *
 * The grader is the new logic this PR introduces — every other moving
 * part (`startEvalAuthServer`, `EvalMcpClient`, the AI SDK tool binding)
 * comes from upstream packages with their own tests. We pin the grader's
 * per-mode behaviour against synthetic `RecordedToolCall[]` sequences so
 * a regression in pass / fail / category-selection ships caught.
 *
 * The integration path (real MCP route + mock LLM) is exercised in CI
 * via the `eval-mcp-llm` job in `.github/workflows/eval.yml` — running
 * a real `MockLanguageModelV3` end-to-end here would require staging the
 * demo semantic layer and seeding Postgres for every test, which the
 * isolated-test-runner spawns per file. Splitting the test surface keeps
 * the unit cycle fast (sub-second) without sacrificing CI coverage.
 */

import { describe, expect, it } from "bun:test";
import {
  __forTesting__,
  type RecordedToolCall,
} from "./canonical-eval-mcp-llm";
import { parseCanonicalEvalOptions } from "./canonical-eval-run";
import type { Question } from "./canonical-eval";

const { gradeMetric, gradeGlossary, gradePattern, gradeVirtual } =
  __forTesting__;

// ── Fixture helpers ──────────────────────────────────────────────────

function metricQuestion(
  id: string,
  metric_id: string,
  sql_pattern: readonly string[] = [],
): Extract<Question, { mode: "metric" }> {
  return {
    id,
    category: "simple_metric",
    question: `What is ${metric_id}?`,
    mode: "metric",
    metric_id,
    expect: { sql_pattern, non_zero: true },
  };
}

function glossaryQuestion(
  id: string,
  term: string,
  status: "ambiguous" | "defined" | undefined = "ambiguous",
): Extract<Question, { mode: "glossary" }> {
  return {
    id,
    category: "glossary",
    question: `What is ${term}?`,
    mode: "glossary",
    term,
    expect: status ? { status } : {},
  };
}

function patternQuestion(
  id: string,
  entity: string,
  pattern: string,
  sql_pattern: readonly string[] = [],
): Extract<Question, { mode: "pattern" }> {
  return {
    id,
    category: "filtered_pattern",
    question: `Run ${entity}.${pattern}`,
    mode: "pattern",
    entity,
    pattern,
    expect: { sql_pattern },
  };
}

function virtualQuestion(
  id: string,
  entity: string,
  dimension: string,
  sql_pattern: readonly string[] = [],
): Extract<Question, { mode: "virtual" }> {
  return {
    id,
    category: "virtual_dimension",
    question: `Bucket ${entity} by ${dimension}`,
    mode: "virtual",
    entity,
    dimension,
    sql: `SELECT ${dimension} FROM ${entity}`,
    expect: { sql_pattern },
  };
}

function call(
  name: string,
  args: Record<string, unknown>,
  result: RecordedToolCall["result"],
  latencyMs = 5,
): RecordedToolCall {
  return { name, args, latencyMs, result };
}

// ── Metric mode ──────────────────────────────────────────────────────

describe("gradeMetric", () => {
  it("passes when runMetric is called with the matching id and returns ok", () => {
    const q = metricQuestion("cq-001", "total_gmv", ["SUM(total_cents)"]);
    const calls = [
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "ok", data: { id: "total_gmv", sql: "SELECT 1", columns: ["v"], rows: [{ v: 42 }], truncated: false } },
      ),
    ];
    const out = gradeMetric(q, calls, "GMV is $42", 12);
    expect(out.status).toBe("pass");
  });

  it("passes when executeSQL is called with the expected SQL substrings", () => {
    const q = metricQuestion("cq-001", "total_gmv", ["sum(total_cents)", "from orders"]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT SUM(total_cents) FROM orders" },
        { kind: "ok", data: { columns: ["v"], rows: [{ v: 1 }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "OK", 7);
    expect(out.status).toBe("pass");
  });

  it("emits tool_selection when neither runMetric nor executeSQL is called", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call("searchGlossary", { term: "gmv" }, { kind: "ok", data: { matches: [] } }),
    ];
    const out = gradeMetric(q, calls, "", 3);
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("tool_selection");
      expect(out.artifact.summary).toContain("never called runMetric or executeSQL");
    }
  });

  it("emits recovery when runMetric returned an error envelope and the LLM never recovered", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "error", envelope: { code: "unknown_metric", hint: "call listEntities" } },
      ),
    ];
    const out = gradeMetric(q, calls, "I don't know", 9);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("recovery");
  });

  it("emits tool_selection when the LLM called runMetric with a different id", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "aov" },
        { kind: "ok", data: { id: "aov", sql: "SELECT AVG(...)", columns: ["v"], rows: [{ v: 7 }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "", 4);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });
});

// ── Glossary mode ────────────────────────────────────────────────────

describe("gradeGlossary", () => {
  it("passes when searchGlossary returns ambiguous_term and the LLM stops", () => {
    const q = glossaryQuestion("cq-016", "revenue", "ambiguous");
    const calls = [
      call(
        "searchGlossary",
        { term: "revenue" },
        {
          kind: "error",
          envelope: { code: "ambiguous_term", hint: "ask user", possible_mappings: ["gmv", "net_revenue"] },
        },
      ),
    ];
    const out = gradeGlossary(q, calls, "The term 'revenue' is ambiguous — did you mean GMV or net_revenue?", 8);
    expect(out.status).toBe("pass");
  });

  it("emits tool_selection when searchGlossary was never called", () => {
    const q = glossaryQuestion("cq-016", "revenue", "ambiguous");
    const calls = [
      call("executeSQL", { sql: "SELECT 1" }, { kind: "ok", data: {} }),
    ];
    const out = gradeGlossary(q, calls, "", 3);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("emits recovery when LLM ignored ambiguous_term envelope and dispatched executeSQL anyway", () => {
    const q = glossaryQuestion("cq-016", "revenue", "ambiguous");
    const calls = [
      call(
        "searchGlossary",
        { term: "revenue" },
        {
          kind: "error",
          envelope: { code: "ambiguous_term", hint: "ask user", possible_mappings: ["gmv", "net_revenue"] },
        },
      ),
      call(
        "executeSQL",
        { sql: "SELECT SUM(total_cents) FROM orders" },
        { kind: "ok", data: { columns: ["v"], rows: [{ v: 1 }] } },
      ),
    ];
    const out = gradeGlossary(q, calls, "Revenue is $42", 10);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("recovery");
  });

  it("accepts dispatch-after-ambiguous when the final text surfaces the ambiguity", () => {
    const q = glossaryQuestion("cq-016", "revenue", "ambiguous");
    const calls = [
      call(
        "searchGlossary",
        { term: "revenue" },
        {
          kind: "error",
          envelope: { code: "ambiguous_term", hint: "ask user", possible_mappings: ["gmv", "net_revenue"] },
        },
      ),
      call(
        "executeSQL",
        { sql: "SELECT SUM(total_cents) FROM orders" },
        { kind: "ok", data: { columns: ["v"], rows: [{ v: 1 }] } },
      ),
    ];
    const out = gradeGlossary(
      q,
      calls,
      "The term 'revenue' is ambiguous — I assumed GMV. Net_revenue is also a valid interpretation.",
      10,
    );
    expect(out.status).toBe("pass");
  });
});

// ── Pattern mode ─────────────────────────────────────────────────────

describe("gradePattern", () => {
  it("passes when describeEntity returns an entity carrying the named pattern", () => {
    const q = patternQuestion("cq-019", "orders", "orders_with_promotions");
    const calls = [
      call(
        "describeEntity",
        { name: "orders" },
        {
          kind: "ok",
          data: {
            entity: {
              name: "orders",
              query_patterns: [
                { name: "orders_with_promotions", sql: "SELECT *" },
              ],
            },
          },
        },
      ),
    ];
    const out = gradePattern(q, calls, "", 6);
    expect(out.status).toBe("pass");
  });

  it("passes when executeSQL is called with the expected pattern substrings", () => {
    const q = patternQuestion("cq-019", "orders", "orders_with_promotions", [
      "from orders",
      "status",
    ]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT * FROM orders WHERE status != 'cancelled'" },
        { kind: "ok", data: { columns: ["id"], rows: [] } },
      ),
    ];
    const out = gradePattern(q, calls, "", 5);
    expect(out.status).toBe("pass");
  });

  it("emits tool_selection when neither describeEntity nor executeSQL was called", () => {
    const q = patternQuestion("cq-019", "orders", "orders_with_promotions");
    const calls = [
      call("listEntities", {}, { kind: "ok", data: { entities: [] } }),
    ];
    const out = gradePattern(q, calls, "", 4);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });
});

// ── Virtual mode ─────────────────────────────────────────────────────

describe("gradeVirtual", () => {
  it("passes when executeSQL is called with the expected substrings", () => {
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket", [
      "case when",
      "order_size_bucket",
    ]);
    const calls = [
      call(
        "executeSQL",
        {
          sql: "SELECT CASE WHEN total_cents < 1000 THEN 'small' END AS order_size_bucket FROM orders",
        },
        { kind: "ok", data: { columns: ["order_size_bucket"], rows: [{ order_size_bucket: "small" }] } },
      ),
    ];
    const out = gradeVirtual(q, calls, "", 8);
    expect(out.status).toBe("pass");
  });

  it("emits tool_selection when executeSQL was never called", () => {
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket");
    const calls = [
      call("listEntities", {}, { kind: "ok", data: { entities: [] } }),
    ];
    const out = gradeVirtual(q, calls, "", 3);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("emits recovery when executeSQL only returned error envelopes", () => {
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket");
    const calls = [
      call(
        "executeSQL",
        { sql: "BROKEN" },
        { kind: "error", envelope: { code: "validation_failed", hint: "fix SQL" } },
      ),
    ];
    const out = gradeVirtual(q, calls, "", 4);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("recovery");
  });
});

// ── End-to-end grade dispatch ─────────────────────────────────────────

describe("grade", () => {
  it("emits a protocol artifact when any tool result was unparseable", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "unparseable", raw: "<<malformed>>" },
      ),
    ];
    const out = __forTesting__.grade({
      question: q,
      toolCalls: calls,
      finalText: "",
      latencyMs: 5,
      baseline: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("protocol");
      expect(out.artifact.tool).toBe("runMetric");
    }
  });

  it("emits a latency artifact when dispatch exceeds baseline by >25% (after a successful answer)", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "ok", data: { id: "total_gmv", sql: "...", columns: ["v"], rows: [{ v: 1 }] } },
      ),
    ];
    const out = __forTesting__.grade({
      question: q,
      toolCalls: calls,
      finalText: "$1",
      latencyMs: 200,
      baseline: { "cq-001": 100 },
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("latency");
      expect(out.artifact.summary).toContain("exceeded baseline");
    }
  });

  it("does NOT emit latency when dispatch is within 25% of baseline", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "ok", data: { id: "total_gmv", sql: "...", columns: ["v"], rows: [{ v: 1 }] } },
      ),
    ];
    const out = __forTesting__.grade({
      question: q,
      toolCalls: calls,
      finalText: "$1",
      latencyMs: 124,
      baseline: { "cq-001": 100 },
    });
    expect(out.status).toBe("pass");
  });
});

// ── CLI flag parsing ──────────────────────────────────────────────────

describe("parseCanonicalEvalOptions", () => {
  it("rejects --llm and --mcp-llm when both are supplied", () => {
    expect(() => parseCanonicalEvalOptions(["--llm", "--mcp-llm"])).toThrow(
      /mutually exclusive/i,
    );
  });

  it("rejects --write-baseline outside of --mcp-llm mode", () => {
    expect(() => parseCanonicalEvalOptions(["--write-baseline"])).toThrow(
      /--write-baseline only applies/i,
    );
  });

  it("accepts --mcp-llm alone and resolves mode to 'mcp-llm'", () => {
    const opts = parseCanonicalEvalOptions(["--mcp-llm"]);
    expect(opts.mode).toBe("mcp-llm");
    expect(opts.writeBaseline).toBe(false);
  });

  it("accepts --mcp-llm --write-baseline together", () => {
    const opts = parseCanonicalEvalOptions(["--mcp-llm", "--write-baseline"]);
    expect(opts.mode).toBe("mcp-llm");
    expect(opts.writeBaseline).toBe(true);
  });

  it("defaults mode to 'deterministic' when no mode flag is supplied", () => {
    const opts = parseCanonicalEvalOptions([]);
    expect(opts.mode).toBe("deterministic");
  });
});
