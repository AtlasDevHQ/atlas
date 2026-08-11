/**
 * Unit tests for the LLM-driven MCP eval grader (#2119 Part B).
 *
 * The grader is the new logic this PR introduces — every other moving
 * part (`startEvalAuthServer`, `EvalMcpClient`, the AI SDK tool binding)
 * comes from upstream packages with their own tests. We pin the grader's
 * per-mode behaviour against synthetic `RecordedToolCall[]` sequences so
 * a regression in pass / fail / category-selection ships caught.
 *
 * The end-to-end integration path (real MCP route + a real LLM gated
 * on `ANTHROPIC_API_KEY`) is exercised in CI by the `eval-mcp-llm` job
 * in `.github/workflows/eval.yml`. Splitting the test surface keeps
 * the unit cycle fast (sub-second, no LLM tokens burned) and gives
 * CI a real-world signal a synthetic mock can't.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  __forTesting__,
  readBaseline,
  writeBaseline,
  type McpLlmOutcome,
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

/**
 * Ground truth for the dispatcher-level tests. These exercise `grade`'s
 * pre-mode branches (protocol / transport / latency), not value comparison, so
 * one entry covering the `cq-001` fixtures is enough — but it must exist, or a
 * successful answering call would trip the missing-expectation guard.
 */
const METRIC_EXPECTATIONS = {
  total_gmv: { kind: "scalar", value: 1 },
} as const;

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
    // `runMetric` with the right id runs the semantic layer's own SQL, so it
    // is correct by construction — no expectation needed to adjudicate it.
    const out = gradeMetric(q, calls, "GMV is $42", 12, undefined);
    expect(out.status).toBe("pass");
  });

  // ── #5122: metric mode grades the ANSWER, not the SQL's spelling ──
  //
  // The `expect.sql_pattern` needles these tests used to assert on are copies
  // of the metric's own authoritative SQL, so they were vacuous where they were
  // written (the deterministic eval executes that very SQL) and a spelling test
  // when reused here. Every case below is a REAL sequence from the 2026-08-10
  // run that the old grader scored wrong.

  it("passes hand-written SQL that computes the authoritative value a different way (cq-002)", () => {
    // Ran `SELECT COUNT(*) FROM customers` against a metric whose SQL says
    // `COUNT(DISTINCT id)`. Identical on a primary key. The needle
    // `COUNT(DISTINCT id)` failed it.
    const q = metricQuestion("cq-002", "total_customers", ["COUNT(DISTINCT id)", "FROM customers"]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT COUNT(*) AS customer_count FROM customers" },
        { kind: "ok", data: { columns: ["customer_count"], rows: [{ customer_count: "5000" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "5000 customers", 7, { kind: "scalar", value: 5000 });
    expect(out.status).toBe("pass");
  });

  it("passes the same metric answered in a different unit (cq-003)", () => {
    // Ran `AVG(total_cents / 100.0)` — dollars — against a cents-denominated
    // metric. The needle `AVG(total_cents)` failed it on the closing paren
    // alone; cq-001 passed only because ITS `/ 100.0` fell outside the parens.
    const q = metricQuestion("cq-003", "aov", ["AVG(total_cents)", "FROM orders"]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT AVG(total_cents / 100.0) AS aov_dollars FROM orders" },
        { kind: "ok", data: { columns: ["aov_dollars"], rows: [{ aov_dollars: "82.35" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "AOV is $82.35", 7, { kind: "scalar", value: 8235 });
    expect(out.status).toBe("pass");
  });

  it("accepts an answer produced by `query`, the tool the surface recommends (cq-008)", () => {
    // QUERY_TOOL_DESCRIPTION: "This is the recommended path for
    // question-answering". The grader counted only runMetric/executeSQL, so
    // following the surface's own advice scored as a tool_selection failure.
    const q = metricQuestion("cq-008", "top_customers_by_spend");
    const calls = [
      call(
        "query",
        { question: "Who are our top customers by spend?" },
        {
          kind: "ok",
          data: {
            answer: "Ada and Grace lead by spend.",
            sql: ["SELECT ..."],
            data: [{ columns: ["name", "spend"], rows: [{ name: "Ada" }, { name: "Grace" }] }],
          },
        },
      ),
    ];
    const out = gradeMetric(q, calls, "Ada and Grace.", 9, {
      kind: "keyed",
      keys: ["Ada", "Grace"],
    });
    expect(out.status).toBe("pass");
  });

  it("fails a successful answer whose value is wrong — the check is not a formality", () => {
    // The counterpart the old substring grader could not make: SQL that LOOKS
    // canonical (matches every needle) but computes the wrong number, because
    // it dropped the metric's filter. Spelling passes it; the value must not.
    const q = metricQuestion("cq-001", "total_gmv", ["SUM(total_cents)", "FROM orders"]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT SUM(total_cents) FROM orders" }, // missing WHERE status != 'cancelled'
        { kind: "ok", data: { columns: ["sum"], rows: [{ sum: "999999" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "", 7, { kind: "scalar", value: 450485905 });
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("fails a grouped answer that is missing a group", () => {
    const q = metricQuestion("cq-020", "carrier_performance");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT carrier, COUNT(*) FROM shipments WHERE carrier <> 'USPS' GROUP BY carrier" },
        { kind: "ok", data: { columns: ["carrier"], rows: [{ carrier: "UPS" }, { carrier: "FedEx" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "", 7, {
      kind: "keyed",
      keys: ["UPS", "FedEx", "USPS"],
    });
    expect(out.status).toBe("fail");
  });

  it("accepts an answer that differs only in rounding precision (cq-019)", () => {
    // The `return_rate` metric ends in ROUND(…, 1) and publishes 11.2; the
    // model rounded the identical ratio to two places and answered 11.22.
    // The first cut of the VALUE grader rejected this — reintroducing, one
    // layer down, the same "wrong over presentation" defect it replaced.
    const q = metricQuestion("cq-019", "return_rate", ["FROM orders", "LEFT JOIN returns"]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT ROUND(100.0 * ... , 2) AS return_rate FROM orders LEFT JOIN returns ..." },
        { kind: "ok", data: { columns: ["return_rate"], rows: [{ return_rate: "11.22" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "11.22%", 9, { kind: "scalar", value: 11.2 });
    expect(out.status).toBe("pass");
  });

  it("still rejects a value that differs beyond rounding", () => {
    // Guard the guard: the precision rule must not become a blanket tolerance.
    // 11.9 vs 11.2 agree at NO shared precision and must stay a failure.
    const q = metricQuestion("cq-019", "return_rate");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT ... AS return_rate" },
        { kind: "ok", data: { columns: ["return_rate"], rows: [{ return_rate: "11.9" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "", 9, { kind: "scalar", value: 11.2 });
    expect(out.status).toBe("fail");
  });

  it("keeps integer counts exact", () => {
    // A count has no decimal places, so the shared precision is 0 and an
    // off-by-one must not be absorbed as "rounding".
    const q = metricQuestion("cq-002", "total_customers");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT COUNT(*) FROM customers" },
        { kind: "ok", data: { columns: ["c"], rows: [{ c: "7999" }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "", 9, { kind: "scalar", value: 8000 });
    expect(out.status).toBe("fail");
  });

  it("throws rather than grade a successful answer with no ground truth", () => {
    // A missing expectation means the harness never established the right
    // answer. Silently degrading to a weaker check would let the gate stop
    // checking without saying so.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call("executeSQL", { sql: "SELECT 1" }, { kind: "ok", data: { columns: ["v"], rows: [{ v: 1 }] } }),
    ];
    expect(() => gradeMetric(q, calls, "", 7, undefined)).toThrow(/no MetricExpectation/);
  });

  it("emits tool_selection when neither runMetric nor executeSQL is called", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call("searchGlossary", { term: "gmv" }, { kind: "ok", data: { matches: [] } }),
    ];
    const out = gradeMetric(q, calls, "", 3, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("tool_selection");
      expect(out.artifact.summary).toContain("never called an answering tool");
    }
  });

  it("emits tool_selection when the LLM never called any tool (empty sequence)", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const out = gradeMetric(q, [], "", 2, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("tool_selection");
    }
  });

  it("passes when an error envelope is followed by a successful runMetric (recovery sequence)", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "totl_gmv" }, // typo, recovers below
        { kind: "error", envelope: { code: "unknown_metric", hint: "did you mean total_gmv?" } },
      ),
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "ok", data: { id: "total_gmv", sql: "...", columns: ["v"], rows: [{ v: 42 }] } },
      ),
    ];
    const out = gradeMetric(q, calls, "GMV is $42", 14, undefined);
    expect(out.status).toBe("pass");
  });

  it("ignores bystander tool errors when classifying recovery (e.g. searchGlossary error on a metric question)", () => {
    // gradeMetric used to scan ALL toolCalls for error envelopes, so a
    // searchGlossary `ambiguous_term` would surface as a "metric recovery
    // failure" with a glossary envelope in the artifact. Now scoped to
    // runMetric/executeSQL only.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "searchGlossary",
        { term: "revenue" },
        { kind: "error", envelope: { code: "ambiguous_term", hint: "..." } },
      ),
      // No metric/sql call — should be tool_selection, not recovery.
    ];
    const out = gradeMetric(q, calls, "", 5, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
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
    // No successful answering call, so no ground truth is needed to classify.
    const out = gradeMetric(q, calls, "I don't know", 9, undefined);
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
    const out = gradeMetric(q, calls, "", 4, { kind: "scalar", value: 450485905 });
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });
});

// ── Glossary mode ────────────────────────────────────────────────────

describe("gradeGlossary", () => {
  // ── #5122: the contract is "ASK, never silently pick" ──────────────
  //
  // ⚠️ THESE THREE STRINGS ARE THE MODEL'S VERBATIM ANSWERS from the
  // 2026-08-10 run, pasted rather than paraphrased. A hand-written "asks for
  // clarification" fixture would agree with the detector by construction and
  // prove nothing; these are the exact outputs the old grader scored as
  // tool_selection failures, so they falsify it.
  const CAPTURED_CQ013 = "Great! The glossary shows there are multiple ways to measure revenue. **Which type would you like to see?**\n\n- **Gross revenue (GMV)** \u2014 total value of all non-cancelled orders before refunds\n- **Net revenue** \u2014 GMV minus refunded amounts (actual collected revenue)\n- **Seller revenue** \u2014 for marketplace sellers, their take after commission\n\nAlso, just to confirm: are you asking about the **most recent completed quarter**, or a **specific quarter** (like Q4 2024)?";
  const CAPTURED_CQ014 = "I'd be happy to help you filter by status, but I need more context. Could you please clarify:\n\n1. **What data are you looking at?** (e.g., orders, users, transactions, etc.)\n2. **What specific status values** are you interested in? (e.g., \"active\", \"completed\", \"pending\", etc.)\n3. **What question are you trying to answer?** (e.g., \"How many orders are pending?\", \"Show me all active users\", etc.)\n\nOnce you provide these details, I can help you query the data with the appropriate filters.";
  const CAPTURED_CQ015 = "I'd be happy to help you find pricing information, but I need more context. Could you clarify:\n\n1. **What are you asking about?** (e.g., a product, service, subscription plan, or something else)\n2. **Do you have access to a specific data source?** (e.g., a products table, pricing database)\n\nIf you're asking about data in your Atlas workspace, I can help you query it once I understand:\n- Which table or entity contains the pricing information\n- What specific item(s) you want the price for\n- Any filters (e.g., by product name, category, date, etc.)\n\nCould you provide more details?";

  it("passes when the answer surfaces the ambiguity, however the agent got there (cq-013)", () => {
    // Dispatched `query` — which consults the glossary server-side — and then
    // listed the competing definitions and asked which was meant. The old
    // grader failed it for not dispatching `searchGlossary` literally.
    const q = glossaryQuestion("cq-013", "revenue");
    const calls = [
      call("explore", { cmd: "ls" }, { kind: "ok", data: {} }),
      call("query", { question: "Show me revenue last quarter" }, { kind: "ok", data: { answer: "..." } }),
    ];
    const out = gradeGlossary(q, calls, CAPTURED_CQ013, 11);
    expect(out.status).toBe("pass");
  });

  it("passes a clarifying answer that dispatched nothing (cq-014, cq-015)", () => {
    const cases = [
      { q: glossaryQuestion("cq-014", "status"), text: CAPTURED_CQ014 },
      { q: glossaryQuestion("cq-015", "price"), text: CAPTURED_CQ015 },
    ];
    for (const { q, text } of cases) {
      const out = gradeGlossary(q, [], text, 3);
      expect({ id: q.id, status: out.status }).toEqual({ id: q.id, status: "pass" });
    }
  });

  it("still fails an agent that silently picked a mapping and answered", () => {
    // The regression the eval exists to catch, and the reason the clarifying
    // path is gated on "no answering tool ran": a confident number with no
    // disambiguation must stay a failure.
    const q = glossaryQuestion("cq-013", "revenue");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT SUM(total_cents) FROM orders" },
        { kind: "ok", data: { columns: ["v"], rows: [{ v: 1 }] } },
      ),
    ];
    const out = gradeGlossary(q, calls, "Revenue last quarter was $4,504,859.", 9);
    expect(out.status).toBe("fail");
  });

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

  it("emits tool_selection when no tool was called at all (empty sequence)", () => {
    const q = glossaryQuestion("cq-016", "revenue", "ambiguous");
    const out = gradeGlossary(q, [], "", 2);
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
  it("passes a pattern answer whose SQL is phrased differently but returns the right rows (cq-016)", () => {
    // ⚠️ cq-016 PASSED on one run and FAILED on the next — same corpus, same
    // model — because the second time the model phrased the promotion filter
    // differently and stopped matching `WHERE status != 'cancelled'`. A gate
    // that flips on SQL phrasing is not measuring the thing it claims to. The
    // value accept path is ADDITIVE here: it only converts that false negative
    // into a pass, and cannot make a wrong answer pass that the existing
    // substring/structural checks would have caught.
    const q = patternQuestion("cq-016", "Orders", "orders_with_promotions", [
      "WHERE status != 'cancelled'",
      "promotion_id IS NOT NULL",
    ]);
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT CASE WHEN promotion_id IS NOT NULL THEN 'With Promotion' ELSE 'No Promotion' END AS promo_status, COUNT(*) FROM orders WHERE status <> 'cancelled' GROUP BY 1" },
        {
          kind: "ok",
          data: {
            columns: ["promo_status"],
            rows: [{ promo_status: "With Promotion" }, { promo_status: "No Promotion" }],
          },
        },
      ),
    ];
    const out = gradePattern(q, calls, "", 8, {
      kind: "keyed",
      keys: ["With Promotion", "No Promotion"],
    });
    expect(out.status).toBe("pass");
  });

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
    const out = gradePattern(q, calls, "", 6, undefined);
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
    const out = gradePattern(q, calls, "", 5, undefined);
    expect(out.status).toBe("pass");
  });

  it("emits tool_selection when neither describeEntity nor executeSQL was called", () => {
    const q = patternQuestion("cq-019", "orders", "orders_with_promotions");
    const calls = [
      call("listEntities", {}, { kind: "ok", data: { entities: [] } }),
    ];
    const out = gradePattern(q, calls, "", 4, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("emits tool_selection on an empty sequence", () => {
    const q = patternQuestion("cq-019", "orders", "orders_with_promotions");
    const out = gradePattern(q, [], "", 2, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("rejects executeSQL with empty sql_pattern AND no entity reference (false-pass guard)", () => {
    // Without the structural fallback the empty `sql_pattern` accepted
    // any successful executeSQL. The grader now requires the dispatched
    // SQL to mention `q.entity` when no explicit pattern is set.
    const q = patternQuestion("cq-019", "orders", "orders_with_promotions");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT 1" }, // no `orders` reference
        { kind: "ok", data: {} },
      ),
    ];
    const out = gradePattern(q, calls, "", 5, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });
});

// ── Throttle (#5122) ─────────────────────────────────────────────────

describe("rate-limit handling", () => {
  // The eval used to out-dispatch its own OAuth client's quota (~244 weighted
  // units in under 4 minutes against 60/min) and then GRADE the resulting
  // envelope: two questions were scored `recovery` — "the LLM saw error
  // envelopes and did not recover" — for a limit the model would have kept
  // hitting however it behaved. That also made the score move with dispatch
  // timing. A throttle is a harness fault and must stop the run.
  it("aborts the run instead of grading a rate_limited envelope", () => {
    const q = metricQuestion("cq-020", "carrier_performance");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT carrier FROM shipments GROUP BY carrier" },
        {
          kind: "error",
          envelope: {
            code: "rate_limited",
            message: 'OAuth client "abc" exceeded its hosted-MCP quota (60 weighted requests/min).',
            retry_after: 5,
          },
        },
      ),
    ];
    expect(() =>
      __forTesting__.grade({
        question: q,
        toolCalls: calls,
        finalText: "",
        latencyMs: 5,
        baseline: undefined,
        metricExpectations: METRIC_EXPECTATIONS,
        answerExpectations: undefined,
      }),
    ).toThrow(/rate limited|throttling ITSELF/);
  });

  it("does not abort on an ordinary tool error envelope", () => {
    // Guard the guard: the abort must be scoped to `rate_limited`, or every
    // recovery-class regression the eval exists to catch becomes a crash.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "runMetric",
        { id: "total_gmv" },
        { kind: "error", envelope: { code: "unknown_metric", hint: "call listEntities" } },
      ),
    ];
    const out = __forTesting__.grade({
      question: q,
      toolCalls: calls,
      finalText: "",
      latencyMs: 5,
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("recovery");
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
    const out = gradeVirtual(q, calls, "", 8, undefined);
    expect(out.status).toBe("pass");
  });


  it("emits tool_selection when executeSQL was never called", () => {
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket");
    const calls = [
      call("listEntities", {}, { kind: "ok", data: { entities: [] } }),
    ];
    const out = gradeVirtual(q, calls, "", 3, undefined);
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
    const out = gradeVirtual(q, calls, "", 4, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("recovery");
  });

  it("emits tool_selection on an empty sequence", () => {
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket");
    const out = gradeVirtual(q, [], "", 2, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("rejects executeSQL with empty sql_pattern AND no dimension reference (false-pass guard)", () => {
    // Same false-pass guard as the pattern grader — without the
    // structural fallback the empty `sql_pattern` accepted any
    // successful executeSQL. Now requires the dispatched SQL to
    // mention `q.dimension` when no explicit pattern is set.
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT 1" }, // no `order_size_bucket` reference
        { kind: "ok", data: {} },
      ),
    ];
    const out = gradeVirtual(q, calls, "", 5, undefined);
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("passes when error envelope is followed by a successful executeSQL with matching pattern", () => {
    const q = virtualQuestion("cq-013", "orders", "order_size_bucket", [
      "case when",
      "order_size_bucket",
    ]);
    const calls = [
      call(
        "executeSQL",
        { sql: "BROKEN SYNTAX" },
        { kind: "error", envelope: { code: "validation_failed", hint: "fix it" } },
      ),
      call(
        "executeSQL",
        {
          sql: "SELECT CASE WHEN total_cents < 1000 THEN 'small' END AS order_size_bucket FROM orders",
        },
        { kind: "ok", data: { columns: ["order_size_bucket"], rows: [{ order_size_bucket: "small" }] } },
      ),
    ];
    const out = gradeVirtual(q, calls, "OK", 11, undefined);
    expect(out.status).toBe("pass");
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
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
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
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
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
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("pass");
  });

  // Four-corners coverage: (no baseline + over), (baseline + over + mode-fail),
  // (baseline=0 treated as no baseline). Without these, a regression in the
  // latency-skip ordering or the `> 0` guard would silently mis-classify.

  it("does NOT emit latency when there is no baseline at all (latency check skipped)", () => {
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
      latencyMs: 99_999, // arbitrarily slow
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("pass");
  });

  it("returns the mode-grade failure (NOT latency) when both apply", () => {
    // gradeByMode runs first; latency check is layered on top of a passing
    // mode grade. A regression that swaps the order would convert genuine
    // tool_selection failures into misleading latency artifacts.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call("searchGlossary", { term: "gmv" }, { kind: "ok", data: { matches: [] } }),
    ];
    const out = __forTesting__.grade({
      question: q,
      toolCalls: calls,
      finalText: "",
      latencyMs: 9999,
      baseline: { "cq-001": 100 },
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("tool_selection");
  });

  it("treats a zero baseline entry as 'no baseline' (skips the latency check)", () => {
    // A corrupted baseline file with `{ "cq-001": 0 }` would otherwise
    // paint every run red because `latencyMs > Math.round(0 * 1.25) === 0`
    // is always true. The `baselineMs > 0` guard is the only line of
    // defense; pin it.
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
      finalText: "OK",
      latencyMs: 1,
      baseline: { "cq-001": 0 },
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("pass");
  });

  it("classifies a __transport: true envelope as protocol (not recovery)", () => {
    // bindMcpToolsForLlm's transport rethrow path records a synthesized
    // envelope with `__transport: true`. The grader must short-circuit
    // to `protocol` so a transport regression doesn't masquerade as a
    // recovery-class failure of the underlying tool.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls: RecordedToolCall[] = [
      {
        name: "runMetric",
        args: { id: "total_gmv" },
        latencyMs: 3,
        result: {
          kind: "error",
          envelope: {
            __transport: true,
            error: "socket hang up",
            errorName: "AbortError",
          },
        },
      },
    ];
    const out = __forTesting__.grade({
      question: q,
      toolCalls: calls,
      finalText: "",
      latencyMs: 3,
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("protocol");
      expect(out.artifact.summary).toContain("MCP transport threw");
    }
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

  it("resolves --baseline <path> to the supplied path", () => {
    const opts = parseCanonicalEvalOptions([
      "--mcp-llm",
      "--baseline",
      "/tmp/atlas-test-baseline.json",
    ]);
    expect(opts.baselinePath).toBe("/tmp/atlas-test-baseline.json");
  });

  it("falls back to the default baseline path when --baseline is omitted", () => {
    const opts = parseCanonicalEvalOptions(["--mcp-llm"]);
    expect(opts.baselinePath).toContain("mcp-llm-baseline.json");
  });

  it("rejects --questions <nonexistent-path> at parse time", () => {
    expect(() =>
      parseCanonicalEvalOptions([
        "--questions",
        "/nonexistent/path/to/questions.yml",
      ]),
    ).toThrow(/--questions file not found/);
  });

  it("rejects --schema with an unrecognized value", () => {
    expect(() =>
      parseCanonicalEvalOptions(["--schema", "salesforce-but-not-really"]),
    ).toThrow(/Invalid --schema/);
  });

  it("rejects --tool-selection without --mcp-llm", () => {
    expect(() => parseCanonicalEvalOptions(["--tool-selection"])).toThrow(
      /--tool-selection requires --mcp-llm/,
    );
  });

  it("rejects the three-way --llm + --mcp-llm + --tool-selection combination", () => {
    // The mode-mutex check fires first ("--llm and --mcp-llm are mutually
    // exclusive"). Pinning this here so a future refactor that reorders
    // the guards still rejects an obviously incoherent set of flags.
    expect(() =>
      parseCanonicalEvalOptions(["--llm", "--mcp-llm", "--tool-selection"]),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects --tool-selection with --write-baseline", () => {
    expect(() =>
      parseCanonicalEvalOptions(["--mcp-llm", "--tool-selection", "--write-baseline"]),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects --tool-selection-fixture pointing at a missing file", () => {
    expect(() =>
      parseCanonicalEvalOptions([
        "--mcp-llm",
        "--tool-selection",
        "--tool-selection-fixture",
        "/nonexistent/path/to/fixture.json",
      ]),
    ).toThrow(/--tool-selection-fixture file not found/);
  });

  it("accepts --mcp-llm --tool-selection together and defaults the fixture path", () => {
    const opts = parseCanonicalEvalOptions(["--mcp-llm", "--tool-selection"]);
    expect(opts.mode).toBe("mcp-llm");
    expect(opts.toolSelection).toBe(true);
    expect(opts.toolSelectionFixturePath).toContain("tool-selection.json");
  });
});

// ── bindMcpToolsForLlm contract ───────────────────────────────────────

describe("bindMcpToolsForLlm", () => {
  // The recorded fields the grader walks rely on this binder behaving
  // consistently across three input shapes: ok envelope (returned as
  // data), error envelope (returned as data, NOT thrown), and transport
  // failure (re-thrown AND recorded). A regression in any of these
  // would silently change the protocol/recovery classification.

  function fakeCallToolResult(text: string, isError = false): CallToolResult {
    return {
      content: [{ type: "text" as const, text }],
      isError,
    };
  }

  function getRunner(tools: ReturnType<typeof __forTesting__.bindMcpToolsForLlm>, name: string) {
    const t = tools[name];
    if (!t || typeof t.execute !== "function") {
      throw new Error(`tool ${name} not bound or has no execute`);
    }
    return t.execute;
  }

  it("returns ok data and records kind: ok when callTool succeeds", async () => {
    const recorded: RecordedToolCall[] = [];
    const fakeClient = {
      callTool: async () =>
        fakeCallToolResult(
          JSON.stringify({ id: "total_gmv", sql: "...", columns: ["v"], rows: [{ v: 1 }] }),
        ),
    };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    const runner = getRunner(tools, "runMetric");
    const result = (await runner({ id: "total_gmv" }, { toolCallId: "t1", messages: [] })) as {
      id?: string;
    };
    expect(result.id).toBe("total_gmv");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.result.kind).toBe("ok");
  });

  it("returns the error envelope (does NOT throw) when callTool returns an MCP error", async () => {
    const recorded: RecordedToolCall[] = [];
    const fakeClient = {
      callTool: async () =>
        fakeCallToolResult(
          JSON.stringify({ code: "unknown_metric", hint: "call listEntities" }),
          true,
        ),
    };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    const runner = getRunner(tools, "runMetric");
    const result = (await runner({ id: "x" }, { toolCallId: "t1", messages: [] })) as {
      code?: string;
    };
    expect(result.code).toBe("unknown_metric");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.result.kind).toBe("error");
  });

  it("re-throws AND records a __transport envelope when callTool rejects", async () => {
    const recorded: RecordedToolCall[] = [];
    const fakeClient = {
      callTool: async () => {
        const err = new Error("socket hang up");
        err.name = "AbortError";
        throw err;
      },
    };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    const runner = getRunner(tools, "runMetric");
    await expect(runner({ id: "x" }, { toolCallId: "t1", messages: [] })).rejects.toThrow(
      /socket hang up/,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.result.kind).toBe("error");
    if (recorded[0]!.result.kind === "error") {
      const env = recorded[0]!.result.envelope as {
        __transport?: boolean;
        errorName?: string;
        stack?: string;
      };
      expect(env.__transport).toBe(true);
      expect(env.errorName).toBe("AbortError");
      expect(typeof env.stack).toBe("string");
    }
  });
});

// ── Baseline I/O ──────────────────────────────────────────────────────

describe("readBaseline / writeBaseline", () => {
  function tmpPath(): string {
    return path.join(
      os.tmpdir(),
      `atlas-mcp-llm-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
  }

  function fakeOutcomes(latencies: Record<string, number>): McpLlmOutcome[] {
    return Object.entries(latencies).map(([id, latencyMs]) => ({
      questionId: id,
      status: "pass" as const,
      latencyMs,
      toolCalls: [],
      finalText: "",
    }));
  }

  it("returns undefined when the file does not exist", () => {
    expect(readBaseline(tmpPath())).toBeUndefined();
  });

  it("round-trips written entries", () => {
    const p = tmpPath();
    try {
      writeBaseline(p, fakeOutcomes({ "cq-001": 120, "cq-002": 80 }));
      const out = readBaseline(p);
      expect(out).toEqual({ "cq-001": 120, "cq-002": 80 });
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("filters non-positive entries (corrupted baselines stay silent on the latency check)", () => {
    const p = tmpPath();
    try {
      fs.writeFileSync(p, JSON.stringify({ "cq-001": 0, "cq-002": 100, "cq-003": -5 }));
      const out = readBaseline(p);
      expect(out).toEqual({ "cq-002": 100 });
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("throws with file context on malformed JSON", () => {
    const p = tmpPath();
    try {
      fs.writeFileSync(p, "{ this is not valid json }");
      expect(() => readBaseline(p)).toThrow(/Failed to parse baseline file/);
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("throws with file context on an empty file", () => {
    const p = tmpPath();
    try {
      fs.writeFileSync(p, "");
      expect(() => readBaseline(p)).toThrow(/baseline file .* is empty/);
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("wraps writeBaseline FS errors with eval context", () => {
    // Write to a path under a missing parent dir — Node FS raises ENOENT,
    // which writeBaseline wraps with a Tip line.
    const p = path.join(os.tmpdir(), `atlas-no-such-dir-${Date.now()}`, "baseline.json");
    expect(() => writeBaseline(p, fakeOutcomes({ "cq-001": 10 }))).toThrow(
      /Failed to write baseline.*Tip:/s,
    );
  });
});

// Note on integration coverage: end-to-end `runMcpLlmEval` requires a
// real MCP fixture (Bun.serve + Better Auth + JWKS), too heavy for a
// per-file unit test under the isolated runner. The CI `eval-mcp-llm`
// job wires a real LLM against the real route and is the integration
// surface. The `bindMcpToolsForLlm` contract tests above pin the
// recorder thread `runMcpLlmEval` builds on; the per-mode grader tests
// pin the dispatch evaluation. Together these cover every regression
// class the per-question dispatch loop can introduce.
