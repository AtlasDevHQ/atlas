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
  keyedExpectationFrom,
  readBaseline,
  writeBaseline,
  type MetricExpectation,
  type McpLlmOutcome,
  type RecordedToolCall,
} from "./canonical-eval-mcp-llm";
import { classifyToolContract } from "@atlas/mcp/eval/tool-contract";
import { parseCanonicalEvalOptions } from "./canonical-eval-run";
import type { Question } from "./canonical-eval";

const { grade, gradeMetric, gradeGlossary, gradePattern, gradeVirtual, labelDriftNote } =
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

/**
 * Build a recorded call. `contract` defaults to `"json"` — the strict
 * contract every typed tool carries — so a fixture only opts into `"text"`
 * where the tool's declared output really is free-form (#5131). Defaulting
 * the OTHER way would make every existing grader fixture silently exempt
 * from the protocol check.
 */
function call(
  name: string,
  args: Record<string, unknown>,
  result: RecordedToolCall["result"],
  latencyMs = 5,
  contract: RecordedToolCall["contract"] = "json",
): RecordedToolCall {
  return { name, args, contract, latencyMs, result };
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
            data: [
              {
                columns: ["name", "spend"],
                rows: [
                  { name: "Ada", spend: "48210.5" },
                  { name: "Grace", spend: "31905.75" },
                ],
              },
            ],
          },
        },
      ),
    ];
    // The fixture carries `spend` because the metric's own SQL does — a keyed
    // expectation is graded on its MEASURES now (#5128), and a `query` answer
    // reaches them through the nested `data` array like any other.
    //
    // ⚠️ TWO GROUPS HERE; THE LIVE EXPECTATION HAS TWENTY. `top_customers_by_spend`
    // ends `LIMIT 20` — the only LIMIT in the corpus — so a model that lists its
    // top 10 is short 10 groups and fails. That is the `top-N` entry in
    // `keyedResultMatches`' known-limits block, and it failed identically under
    // the rule this PR replaces. This fixture is deliberately reduced to keep
    // the test about `query`'s nested `data` reaching the comparison at all.
    const out = gradeMetric(q, calls, "Ada and Grace.", 9, {
      kind: "keyed",
      groups: [
        { label: "ada", measures: [48210.5] },
        { label: "grace", measures: [31905.75] },
      ],
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
    // ⚠️ THE ANSWER CARRIES A THIRD, WRONGLY-LABELLED ROW so that ONLY the
    // per-group measure rule can fail it. An earlier version returned two rows,
    // which made the cardinality rule fail too — and a fixture that trips both
    // conditions proves neither. Here `other`'s 55 satisfies the cardinality
    // check (three distinct carriers) while USPS's 96 appears nowhere.
    const q = metricQuestion("cq-020", "carrier_performance");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT carrier, COUNT(*) FROM shipments WHERE carrier <> 'USPS' GROUP BY carrier" },
        {
          kind: "ok",
          data: {
            columns: ["carrier", "shipments"],
            rows: [
              { carrier: "UPS", shipments: 412 },
              { carrier: "FedEx", shipments: 288 },
              { carrier: "other", shipments: 55 },
            ],
          },
        },
      ),
    ];
    const out = gradeMetric(q, calls, "", 7, {
      kind: "keyed",
      groups: [
        { label: "ups", measures: [412] },
        { label: "fedex", measures: [288] },
        { label: "usps", measures: [96] },
      ],
    });
    expect(out.status).toBe("fail");
  });

  it("passes a grouped METRIC answer that relabels its groups (cq-020, the gate path)", () => {
    // ⚠️ METRIC MODE IS WHERE THE VALUE CHECK IS THE GATE, not an additive
    // accept path layered over `sql_pattern` — `gradeMetric` has no substring
    // fallback at all. Every other keyed test calls its grader DIRECTLY, so
    // without this one the `grade` → `gradeByMode` → `metricExpectations`
    // routing arm is unprobed: rewriting it to read `answerExpectations` left
    // the whole suite green.
    const q = metricQuestion("cq-020", "carrier_performance");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT UPPER(carrier) AS shipper, COUNT(*) AS n FROM shipments GROUP BY 1" },
        {
          kind: "ok",
          data: {
            columns: ["shipper", "n"],
            rows: [
              { shipper: "UNITED PARCEL", n: 412 },
              { shipper: "FEDERAL EXPRESS", n: 288 },
              { shipper: "US POSTAL", n: 96 },
            ],
          },
        },
      ),
    ];
    const out = grade({
      question: q,
      toolCalls: calls,
      finalText: "",
      latencyMs: 7,
      baseline: undefined,
      metricExpectations: {
        carrier_performance: {
          kind: "keyed",
          groups: [
            { label: "ups", measures: [412] },
            { label: "fedex", measures: [288] },
            { label: "usps", measures: [96] },
          ],
        },
      },
      answerExpectations: undefined,
    });
    expect(out.status).toBe("pass");
  });

  it("passes a grouped metric answered in DOLLARS against cents ground truth", () => {
    // UNIT_SCALINGS is brand new on the keyed path (#5128) and was previously
    // pinned only for scalars: removing it from `keyedResultMatches` — and
    // widening it to ±1000x — both left the suite green.
    const q = metricQuestion("cq-007", "revenue_dtc_vs_marketplace");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT channel, SUM(total_cents)/100.0 AS revenue FROM orders GROUP BY 1" },
        {
          kind: "ok",
          data: {
            columns: ["channel", "revenue"],
            rows: [
              { channel: "dtc", revenue: "1284.01" },
              { channel: "marketplace", revenue: "642.5" },
            ],
          },
        },
      ),
    ];
    const centsGroundTruth = {
      kind: "keyed",
      groups: [
        { label: "dtc", measures: [128401] },
        { label: "marketplace", measures: [64250] },
      ],
    } as const satisfies MetricExpectation;
    expect(gradeMetric(q, calls, "", 7, centsGroundTruth).status).toBe("pass");
  });

  it("does NOT rescue a grouped answer that is off by 1000x", () => {
    // Guards the guard: UNIT_SCALINGS is cents-vs-dollars and nothing wider.
    const q = metricQuestion("cq-007", "revenue_dtc_vs_marketplace");
    const calls = [
      call(
        "executeSQL",
        { sql: "SELECT channel, SUM(total_cents)/1000.0 AS revenue FROM orders GROUP BY 1" },
        {
          kind: "ok",
          data: {
            columns: ["channel", "revenue"],
            rows: [
              { channel: "dtc", revenue: "128.401" },
              { channel: "marketplace", revenue: "64.25" },
            ],
          },
        },
      ),
    ];
    const out = gradeMetric(q, calls, "", 7, {
      kind: "keyed",
      groups: [
        { label: "dtc", measures: [128401] },
        { label: "marketplace", measures: [64250] },
      ],
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
            columns: ["promo_status", "order_count"],
            rows: [
              { promo_status: "With Promotion", order_count: 1240 },
              { promo_status: "No Promotion", order_count: 3105 },
            ],
          },
        },
      ),
    ];
    // The pass must come from the VALUE path, not from `sql_pattern`: the
    // fixture SQL spells the filter `status <> 'cancelled'` and so misses the
    // needle `WHERE status != 'cancelled'`. That is one token of margin — and
    // the SQL DOES carry the other needle verbatim — so pin the provenance
    // rather than trusting it: with no expectation the same calls must FAIL.
    expect(gradePattern(q, calls, "", 8, undefined).status).toBe("fail");
    const out = gradePattern(q, calls, "", 8, {
      kind: "keyed",
      groups: [
        { label: "with promotion", measures: [1240] },
        { label: "no promotion", measures: [3105] },
      ],
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

// ── Keyed comparison: substance, not labels (#5128) ───────────────────

/**
 * The `orders_with_promotions` pattern's authoritative result, as
 * `keyedExpectationFrom` reduces it. Written out ONCE and reused so every case
 * below argues against the same ground truth.
 *
 * The labels are the pattern SQL's own hand-written `CASE … THEN 'With Promo'`;
 * the measures are its `COUNT(*)`, `AVG(total_cents)/100.0` and
 * `SUM(total_cents)/100.0` for each group. Deliberately six distinct values
 * across two groups — never `{n, n}`, and no value is a x100 or /100 of any
 * other — so no assertion below can be satisfied by two states that the fixture
 * happened to make equal, nor rescued by `UNIT_SCALINGS`.
 *
 * Hand-written rather than produced by `keyedExpectationFrom`: an oracle built
 * by the code it grades agrees with it by construction and cannot falsify it.
 * The factory gets its own tests further down.
 */
const PROMO_GROUND_TRUTH = {
  kind: "keyed",
  groups: [
    { label: "With Promo", measures: [1240, 118.4, 146816] },
    { label: "No Promo", measures: [3105, 92.7, 287833.5] },
  ],
} as const satisfies MetricExpectation;

function sqlAnswer(
  sql: string,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): RecordedToolCall {
  return call("executeSQL", { sql }, { kind: "ok", data: { columns, rows } });
}

/**
 * cq-016's reproducing answer, minus the richer breakdown: the authoritative
 * numbers exactly, under the model's own group labels.
 */
function relabelledPromoAnswer(): RecordedToolCall[] {
  return [
    sqlAnswer(
      "SELECT CASE WHEN promotion_id IS NOT NULL THEN 'With Promotion' ELSE 'No Promotion' END AS promo_status, " +
        "COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, SUM(total_cents)/100.0 AS revenue " +
        "FROM orders WHERE status != 'cancelled' GROUP BY 1",
      ["promo_status", "orders", "aov", "revenue"],
      [
        { promo_status: "With Promotion", orders: 1240, aov: 118.4, revenue: 146816 },
        { promo_status: "No Promotion", orders: 3105, aov: 92.7, revenue: 287833.5 },
      ],
    ),
  ];
}

describe("keyed comparison — substance over labels (#5128)", () => {
  const q = patternQuestion("cq-016", "Orders", "orders_with_promotions", [
    "WHERE status != 'cancelled'",
    "promotion_id IS NOT NULL",
  ]);

  it("passes cq-016's reproducing answer: relabelled groups AND a richer breakdown", () => {
    // ⚠️ THE REPRODUCING CASE, VERBATIM IN SHAPE. The model computed the same
    // categorisation (`promotion_id IS NOT NULL`), the same filter and the same
    // measures, wrote `'With Promotion'` / `'No Promotion'` instead of the
    // pattern author's `'With Promo'` / `'No Promo'`, and added a
    // per-promotion-type breakdown on top. The label-set rule failed it on the
    // display text alone — the third presentation check in a row to produce a
    // false negative (#5122 → #5127 → this).
    //
    // Note the FIVE rows against a two-group ground truth: "group count equals
    // row count" is the obvious spelling of this fix and it regresses exactly
    // here. `promo_status` still has two DISTINCT values, which is what is
    // actually being asserted.
    const calls = [
      sqlAnswer(
        "SELECT CASE WHEN promotion_id IS NOT NULL THEN 'With Promotion' ELSE 'No Promotion' END AS promo_status, " +
          "promotion_type, COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, SUM(total_cents)/100.0 AS revenue " +
          "FROM orders WHERE status <> 'cancelled' GROUP BY 1, 2 WITH ROLLUP",
        ["promo_status", "promotion_type", "orders", "aov", "revenue"],
        [
          { promo_status: "With Promotion", promotion_type: "ALL", orders: 1240, aov: 118.4, revenue: 146816 },
          { promo_status: "No Promotion", promotion_type: "ALL", orders: 3105, aov: 92.7, revenue: 287833.5 },
          { promo_status: "With Promotion", promotion_type: "percent_off", orders: 800, aov: 120.1, revenue: 96080 },
          { promo_status: "With Promotion", promotion_type: "free_shipping", orders: 300, aov: 110, revenue: 33000 },
          { promo_status: "With Promotion", promotion_type: "bogo", orders: 140, aov: 126.9, revenue: 17766 },
        ],
      ),
    ];
    expect(gradePattern(q, calls, "", 8, PROMO_GROUND_TRUTH).status).toBe("pass");
  });

  it("fails a dropped filter even though the labels match EXACTLY", () => {
    // ⚠️ THIS IS THE TRADE THE FIX MAKES, AND IT GOES BOTH WAYS. The answer
    // uses the pattern's own labels verbatim and splits into the same two
    // groups — so the OLD label-set rule PASSED it — but it forgot
    // `WHERE status != 'cancelled'`, so every measure is inflated. Substance
    // catches what labels could not.
    const calls = [
      sqlAnswer(
        "SELECT CASE WHEN promotion_id IS NOT NULL THEN 'With Promo' ELSE 'No Promo' END AS promo_status, " +
          "COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, SUM(total_cents)/100.0 AS revenue FROM orders GROUP BY 1",
        ["promo_status", "orders", "aov", "revenue"],
        [
          { promo_status: "With Promo", orders: 1301, aov: 117.2, revenue: 152477.2 },
          { promo_status: "No Promo", orders: 3260, aov: 91.4, revenue: 297964 },
        ],
      ),
    ];
    // `sql_pattern` must not rescue it either — the SQL genuinely lacks the
    // `WHERE status != 'cancelled'` needle, so this is a clean fail.
    expect(gradePattern(q, calls, "", 8, PROMO_GROUND_TRUTH).status).toBe("fail");
  });

  it("passes an answer that publishes ONE measure per group and drops the rest", () => {
    // ⚠️ THIS IS INSTANCE #4, CAUGHT IN REVIEW BEFORE IT SHIPPED. The first cut
    // of this fix required every authoritative measure CELL to appear. The
    // corpus's grouped metrics publish auxiliary columns no natural answer
    // includes — `revenue_by_category` gives revenue + order_count + units_sold
    // for a question that asks only for revenue, `monthly_gmv_trend` gives
    // order_count + gmv + aov for a question that asks only for GMV — so that
    // rule flips currently-PASSING questions to fail, over an exhaustiveness
    // difference rather than a substantive one. Per GROUP, not per cell.
    const calls = [
      sqlAnswer(
        "SELECT CASE WHEN COALESCE(promotion_id, 0) <> 0 THEN 'Promo' ELSE 'None' END AS s, " +
          "COUNT(*) AS orders FROM orders WHERE status <> 'cancelled' GROUP BY 1",
        ["s", "orders"],
        [
          { s: "Promo", orders: 1240 },
          { s: "None", orders: 3105 },
        ],
      ),
    ];
    expect(gradePattern(q, calls, "", 8, undefined).status).toBe("fail");
    expect(gradePattern(q, calls, "", 8, PROMO_GROUND_TRUTH).status).toBe("pass");
  });

  it("fails when one whole GROUP is unrepresented", () => {
    // The other side of per-group: `every` still means every. The With-Promo
    // group is reproduced exactly; the No-Promo group's three numbers are all
    // wrong, and none of the wrong values is a x100 or /100 of an authoritative
    // one, so UNIT_SCALINGS cannot rescue it.
    //
    // The SQL misses BOTH needles — `COALESCE(promotion_id, 0) <> 0` rather than
    // `promotion_id IS NOT NULL`, and `status <> 'cancelled'` rather than
    // `status != 'cancelled'` — and `findSqlMatch` requires EVERY needle, so
    // either miss suffices. `gradePattern` layers the value check OVER
    // `sql_pattern`, and a fixture satisfying the needles would pass on the
    // substring alone and prove nothing about measures. The
    // `undefined`-expectation assertion pins that provenance rather than
    // trusting the spelling to stay put.
    const calls = [
      sqlAnswer(
        "SELECT CASE WHEN COALESCE(promotion_id, 0) <> 0 THEN 'With Promo' ELSE 'No Promo' END AS promo_status, " +
          "COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, SUM(total_cents)/100.0 AS revenue " +
          "FROM orders WHERE status <> 'cancelled' GROUP BY 1",
        ["promo_status", "orders", "aov", "revenue"],
        [
          { promo_status: "With Promo", orders: 1240, aov: 118.4, revenue: 146816 },
          { promo_status: "No Promo", orders: 2911, aov: 88.3, revenue: 257041.3 },
        ],
      ),
    ];
    expect(gradePattern(q, calls, "", 8, undefined).status).toBe("fail");
    expect(gradePattern(q, calls, "", 8, PROMO_GROUND_TRUTH).status).toBe("fail");
  });

  it("fails a wrong grouping whose numbers happen to CONTAIN the authoritative ones", () => {
    // ⚠️ THE CASE THE PER-GROUP MEASURE RULE CANNOT CATCH ALONE, which is why
    // the cardinality condition exists. Both authoritative groups are
    // represented — 1240 and 3105 are both present — but the model grouped by
    // shipping region, into five groups rather than two, and no column here
    // carries two distinct values.
    const calls = [
      sqlAnswer(
        "SELECT region, COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, SUM(total_cents)/100.0 AS revenue " +
          "FROM orders WHERE status <> 'cancelled' GROUP BY region",
        ["region", "orders", "aov", "revenue"],
        [
          { region: "us-east", orders: 1240, aov: 118.4, revenue: 146816 },
          { region: "us-west", orders: 3105, aov: 92.7, revenue: 287833.5 },
          { region: "emea", orders: 610, aov: 101.3, revenue: 61793 },
          { region: "apac", orders: 455, aov: 99.8, revenue: 45409 },
          { region: "latam", orders: 190, aov: 88.2, revenue: 16758 },
        ],
      ),
    ];
    expect(gradePattern(q, calls, "", 8, PROMO_GROUND_TRUTH).status).toBe("fail");
  });

  it("a BYSTANDER column no longer satisfies the shape check (#5143)", () => {
    // ⚠️ THIS TEST WAS INVERTED BY #5143 — it asserted the opposite, as a pinned
    // limitation, and the fix was required to make it go red deliberately.
    //
    // The old condition 2 accepted if ANY column carried the authoritative
    // distinct count, including a column with nothing to do with the grouping.
    // The wrong-grouping fixture above failed ONLY because none of its columns
    // happened to carry two distinct values — so this is the same wrong grouping
    // with one plausible bystander (`domestic: yes/no`) added, and it used to
    // pass.
    //
    // What closes it is not a guess about which column is the key — that is the
    // presentation-level move #5128 exists to stop making. `domestic` gives BOTH
    // represented rows (`us-east`, `us-west`) the value `"yes"`, so it cannot
    // tell the two authoritative groups apart, and separating them is the whole
    // job of a grouping key. The column earns the role or it does not count.
    const calls = [
      sqlAnswer(
        "SELECT region, domestic, COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, " +
          "SUM(total_cents)/100.0 AS revenue FROM orders WHERE status <> 'cancelled' GROUP BY 1, 2",
        ["region", "domestic", "orders", "aov", "revenue"],
        [
          { region: "us-east", domestic: "yes", orders: 1240, aov: 118.4, revenue: 146816 },
          { region: "us-west", domestic: "yes", orders: 3105, aov: 92.7, revenue: 287833.5 },
          { region: "emea", domestic: "no", orders: 610, aov: 101.3, revenue: 61793 },
          { region: "apac", domestic: "no", orders: 455, aov: 99.8, revenue: 45409 },
          { region: "latam", domestic: "no", orders: 190, aov: 88.2, revenue: 16758 },
        ],
      ),
    ];
    expect(gradePattern(q, calls, "", 8, PROMO_GROUND_TRUTH).status).toBe("fail");
  });

  const NO_MEASURES = {
    kind: "keyed",
    groups: [
      { label: "shipped", measures: [] },
      { label: "delivered", measures: [] },
      { label: "returned", measures: [] },
    ],
  } as const satisfies MetricExpectation;
  const statusQ = patternQuestion("cq-021", "Orders", "order_statuses", [
    "nothing-matches-this",
  ]);

  it("still compares LABELS when the authoritative result has no measures", () => {
    // A `SELECT DISTINCT status`-shaped ground truth: the key column IS the
    // data, not a display label, and cardinality alone would pass any result
    // with three distinct values. The old label-set rule is kept for exactly
    // this case rather than deleted, so it must still bite.
    const wrongValues = [
      sqlAnswer("SELECT DISTINCT status FROM orders", ["status"], [
        { status: "shipped" },
        { status: "delivered" },
        { status: "cancelled" },
      ]),
    ];
    const rightValues = [
      sqlAnswer("SELECT DISTINCT status FROM orders", ["status"], [
        { status: "RETURNED" },
        { status: "shipped" },
        { status: "delivered" },
      ]),
    ];
    expect(gradePattern(statusQ, wrongValues, "", 8, NO_MEASURES).status).toBe("fail");
    expect(gradePattern(statusQ, rightValues, "", 8, NO_MEASURES).status).toBe("pass");
  });

  it("fails a SUPERSET of the authoritative labels on the measure-less path", () => {
    // The label rule is set EQUALITY, not containment: a spurious extra group is
    // as wrong as a missing one. Nothing pinned the superset direction before.
    const extraValue = [
      sqlAnswer("SELECT DISTINCT status FROM orders", ["status"], [
        { status: "shipped" },
        { status: "delivered" },
        { status: "returned" },
        { status: "pending" },
      ]),
    ];
    expect(gradePattern(statusQ, extraValue, "", 8, NO_MEASURES).status).toBe("fail");
  });

  it("passes an identical answer when the authoritative grouping has a NULL key", () => {
    // ⚠️ REGRESSION PIN FOR A FALSE NEGATIVE FOUND IN REVIEW. Harvest used to
    // stringify a NULL grouping key to the label `"null"` and count it toward
    // the cardinality, while the observed side skips nullish cells — so the
    // model returning the BYTE-IDENTICAL authoritative rows graded `fail`. That
    // is this issue's own defect class, one layer down. Both sides now reduce a
    // cell through `cellKey` and neither counts a NULL as a distinct value.
    const withNullGroup = {
      kind: "keyed",
      groups: [
        { label: "percent_off", measures: [] },
        { label: "free_shipping", measures: [] },
        { label: null, measures: [] },
      ],
    } as const satisfies MetricExpectation;
    const identical = [
      sqlAnswer(
        "SELECT DISTINCT promotion_type FROM orders",
        ["promotion_type"],
        [
          { promotion_type: "percent_off" },
          { promotion_type: "free_shipping" },
          { promotion_type: null },
        ],
      ),
    ];
    const pq = patternQuestion("cq-022", "Orders", "promo_types", ["nothing-matches-this"]);
    expect(gradePattern(pq, identical, "", 8, withNullGroup).status).toBe("pass");
  });

  it("a COALESCE-rendered NULL group now passes the shape check (#5143)", () => {
    // ⚠️ THE SECOND TEST #5143 INVERTED. It asserted the opposite as a pinned
    // limitation — specifically the one a reader assumes the NULL fix closed and
    // it did not.
    //
    // The disagreement is manufactured by the two sides' own conventions rather
    // than by anything the model did wrong: `authoritativeLabels` DROPS the NULL
    // group (the observed side cannot produce a nullish cell), while
    // `COALESCE(promotion_type, 'unknown')` RENDERS it as an ordinary value. So
    // ground truth counts 2 and a byte-correct answer shows 3.
    //
    // The fix says exactly that and nothing more: an expectation carrying a NULL
    // group accepts N−1 or N. It is licensed by a fact about the AUTHORITATIVE
    // side, so it is unavailable to an expectation with no NULL group — pinned
    // directly below.
    const withNullGroup = {
      kind: "keyed",
      groups: [
        { label: "percent_off", measures: [800] },
        { label: "free_shipping", measures: [300] },
        { label: null, measures: [3105] },
      ],
    } as const satisfies MetricExpectation;
    const coalesced = [
      sqlAnswer(
        "SELECT COALESCE(promotion_type, 'unknown') AS t, COUNT(*) AS orders FROM orders GROUP BY 1",
        ["t", "orders"],
        [
          { t: "percent_off", orders: 800 },
          { t: "free_shipping", orders: 300 },
          { t: "unknown", orders: 3105 },
        ],
      ),
    ];
    const pq = patternQuestion("cq-022", "Orders", "promo_types", ["nothing-matches-this"]);
    // Condition 1 is satisfied — all three groups are represented — so this is
    // condition 2 alone, which is what made it a shape disagreement rather than
    // a grading one.
    expect(gradePattern(pq, coalesced, "", 8, withNullGroup).status).toBe("pass");
  });

  it("does NOT extend the same tolerance to an expectation with no NULL group", () => {
    // ⚠️ THE OTHER HALF OF THE COALESCE FIX, AND THE ONLY TEST THAT CAN FALSIFY
    // ITS CONDITION. Ground truth here is the same two labelled groups with the
    // NULL group REMOVED, against the identical three-row answer — so a blanket
    // `N + 1` tolerance passes it, and one licensed by a NULL group on the
    // authoritative side does not. Without this, deleting the `hasNullGroup`
    // guard is an equivalent mutation: every currently-green test still passes.
    //
    // The verdict is also the right one on its own terms: nothing in ground
    // truth explains the third group, so the answer is grouped more finely than
    // the question was asked.
    const noNullGroup = {
      kind: "keyed",
      groups: [
        { label: "percent_off", measures: [800] },
        { label: "free_shipping", measures: [300] },
      ],
    } as const satisfies MetricExpectation;
    const threeGroups = [
      sqlAnswer(
        "SELECT COALESCE(promotion_type, 'unknown') AS t, COUNT(*) AS orders FROM orders GROUP BY 1",
        ["t", "orders"],
        [
          { t: "percent_off", orders: 800 },
          { t: "free_shipping", orders: 300 },
          { t: "unknown", orders: 3105 },
        ],
      ),
    ];
    const pq = patternQuestion("cq-022", "Orders", "promo_types", ["nothing-matches-this"]);
    expect(gradePattern(pq, threeGroups, "", 8, noNullGroup).status).toBe("fail");
  });

  it("passes a correct answer when SOME authoritative groups have no measures", () => {
    // ⚠️ REGRESSION PIN, AND THE REGRESSION WAS THIS PR'S OWN. Condition 1
    // exempts a measure-less group — "nothing to match; carried by the
    // cardinality check alone" — and the first cut of the separation rule did
    // not, so `rowsRepresenting` handed it an empty candidate set, no column
    // could ever be assigned a representative for it, and condition 2 became
    // UNSATISFIABLE. A byte-correct answer graded FAIL, which `origin/main`
    // passed. Two reviewers measured it independently.
    //
    // Reachable from real ground truth: `keyedExpectationFrom` builds `measures`
    // through `numericValues`, which drops NULL and non-numeric cells, so an
    // `AVG` over an all-NULL subset produces exactly this. The ALL-measure-less
    // case is caught upstream by `labelSetMatches`; only the MIXED case lands
    // here, and no fixture in this file had one.
    const mixed = {
      kind: "keyed",
      groups: [
        { label: "north", measures: [10, 100] },
        { label: "south", measures: [20, 200] },
        { label: "west", measures: [] },
      ],
    } as const satisfies MetricExpectation;
    const correct = [
      sqlAnswer("SELECT region, SUM(a) AS a, SUM(b) AS b FROM t GROUP BY 1", ["region", "a", "b"], [
        { region: "north", a: 10, b: 100 },
        { region: "south", a: 20, b: 200 },
        { region: "west", a: null, b: null },
      ]),
    ];
    const mq = patternQuestion("cq-030", "Orders", "mixed_measures", ["nothing-matches-this"]);
    expect(gradePattern(mq, correct, "", 8, mixed).status).toBe("pass");

    // ⚠️ THE OTHER DIRECTION, so the fix cannot be "stop checking condition 2 on
    // a mixed expectation". `region` still has to carry THREE distinct values —
    // the measure-less group is exempt from being SEPARATED, not from being
    // COUNTED — so a two-group answer with both measured groups right still
    // fails on shape.
    const undersplit = [
      sqlAnswer("SELECT region, SUM(a) AS a, SUM(b) AS b FROM t GROUP BY 1", ["region", "a", "b"], [
        { region: "north", a: 10, b: 100 },
        { region: "south", a: 20, b: 200 },
      ]),
    ];
    expect(gradePattern(mq, undersplit, "", 8, mixed).status).toBe("fail");
  });

  it("THROWS when too few groups both carry a label and carry measures", () => {
    // ⚠️ THE ROUND-1 FIX'S OWN DEFECT, INVERTED. Skipping measure-less groups
    // stopped condition 2 being unsatisfiable — and when the skips remove ALL
    // groups, `hasDistinctRepresentatives([])` is VACUOUSLY TRUE on a
    // zero-iteration loop, so condition 2 collapsed to the bystander rule it
    // replaced. Measured: this exact expectation PASSED the ungrouped one-row
    // answer below, a false POSITIVE created by the fix for a false negative.
    //
    // An empty candidate SET cannot be assigned; an empty candidate LIST is
    // satisfied by having nothing to ask. That asymmetry is the whole bug.
    const nothingAdjudicable = {
      kind: "keyed",
      groups: [
        { label: null, measures: [412] },
        { label: "ups", measures: [] },
      ],
    } as const satisfies MetricExpectation;
    const ungrouped = [
      sqlAnswer("SELECT COUNT(*) AS n FROM orders", ["n"], [{ n: 412 }]),
    ];
    const nq = patternQuestion("cq-031", "Orders", "unadjudicable", ["nothing-matches-this"]);
    // A THROW, not a `fail`: this is ground truth that cannot adjudicate, which
    // gets the same disposition as the empty-groups and all-NULL-key cases.
    // Grading it `fail` would blame the model for a harness fault; grading it
    // `pass` — what the round-1 fix did — accepts an answer that never grouped.
    expect(() => gradePattern(nq, ungrouped, "", 8, nothingAdjudicable)).toThrow(
      /no pair left for a column to tell apart/,
    );

    // ⚠️ AND THE THRESHOLD IS TWO, NOT ONE — the first cut of this guard used
    // `size === 0` and a fix-vs-finding pass REPRODUCED the defect against it.
    // This is a PAIRWISE-distinctness gate: one surviving label forms no pair,
    // so `hasDistinctRepresentatives` imposes nothing and condition 2 collapses
    // to bare cardinality just as completely as at zero.
    //
    // The fixture is this file's own bystander case — the five-region wrong
    // grouping with a `domestic: yes/no` bystander — with ONE authoritative
    // group made measure-less. Under `size === 0` the guard stayed quiet,
    // `domestic` satisfied a candidate list of length 1, and the wrong grouping
    // PASSED again.
    const oneSeparableLabel = {
      kind: "keyed",
      groups: [
        { label: "With Promo", measures: [1240, 118.4, 146816] },
        { label: "No Promo", measures: [] },
      ],
    } as const satisfies MetricExpectation;
    const bystanderAnswer = [
      sqlAnswer(
        "SELECT region, domestic, COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, " +
          "SUM(total_cents)/100.0 AS revenue FROM orders WHERE status <> 'cancelled' GROUP BY 1, 2",
        ["region", "domestic", "orders", "aov", "revenue"],
        [
          { region: "us-east", domestic: "yes", orders: 1240, aov: 118.4, revenue: 146816 },
          { region: "us-west", domestic: "yes", orders: 3105, aov: 92.7, revenue: 287833.5 },
          { region: "emea", domestic: "no", orders: 610, aov: 101.3, revenue: 61793 },
        ],
      ),
    ];
    expect(() => gradePattern(q, bystanderAnswer, "", 8, oneSeparableLabel)).toThrow(
      /only 1 authoritative group\(s\) both carry a label and carry measures/,
    );
  });

  it("does NOT throw on a genuine ONE-label expectation — there is no pair to want", () => {
    // ⚠️ THE FALSIFIER FOR `Math.min(2, labelCount)` RATHER THAN A FLAT 2, and
    // without it the `min` is decoration: replacing it with `2` left every other
    // test green. A grouped metric whose grouping key takes ONE value in the data
    // — `GROUP BY status` on a table where every row is `shipped` — is a
    // legitimate run, and aborting it would be a harness fault invented by the
    // guard rather than found by it.
    //
    // This is the weak case the doc block already admits: at one group there is
    // no partition to disagree about, so bare cardinality is the honest answer.
    // Pinned so the admission stays true.
    const single = {
      kind: "keyed",
      groups: [{ label: "shipped", measures: [4345] }],
    } as const satisfies MetricExpectation;
    const answer = [
      sqlAnswer("SELECT status, COUNT(*) AS n FROM orders GROUP BY 1", ["status", "n"], [
        { status: "shipped", n: 4345 },
      ]),
    ];
    const sq = patternQuestion("cq-032", "Orders", "single_group", ["nothing-matches-this"]);
    expect(gradePattern(sq, answer, "", 8, single).status).toBe("pass");
  });

  it("still grades a NULL-labelled group's MEASURES on condition 1 alone", () => {
    // ⚠️ THE ONE PLACE CONDITION 1 IS INDEPENDENTLY LOAD-BEARING, and without
    // this test it is unfalsifiable: `if (false && !everyGroupRepresented)` left
    // the whole file green, because for every non-null label an unrepresented
    // group also produces an empty candidate set and condition 2 rejects it
    // anyway. `separatesAuthoritativeGroups` SKIPS null-labelled groups, which is
    // what lets the two conditions disagree here.
    //
    // NOT the only such shape — a case-folded label PAIR is another, since the
    // folded class inherits its represented sibling's rows, so condition 2
    // accepts while condition 1 rejects the unrepresented member. Said because an
    // earlier version of this comment claimed "the only shape", which is a stated
    // absolute and was false. This is the shape PINNED; it is not the shape space.
    //
    // Same fixture as the COALESCE case above with the null group's number made
    // wrong. Condition 2 is satisfied outright — `t` carries three distinct
    // values against a target of {2, 3} and separates both labelled groups — so
    // the only thing that can fail it is the missing 3105.
    const withNullGroup = {
      kind: "keyed",
      groups: [
        { label: "percent_off", measures: [800] },
        { label: "free_shipping", measures: [300] },
        { label: null, measures: [3105] },
      ],
    } as const satisfies MetricExpectation;
    const wrongNullGroup = [
      sqlAnswer(
        "SELECT COALESCE(promotion_type, 'unknown') AS t, COUNT(*) AS orders FROM orders GROUP BY 1",
        ["t", "orders"],
        [
          { t: "percent_off", orders: 800 },
          { t: "free_shipping", orders: 300 },
          { t: "unknown", orders: 99999 },
        ],
      ),
    ];
    const pq = patternQuestion("cq-022", "Orders", "promo_types", ["nothing-matches-this"]);
    expect(gradePattern(pq, wrongNullGroup, "", 8, withNullGroup).status).toBe("fail");
  });

  it("finds a valid assignment the group ORDER would have hidden from a greedy walk", () => {
    // ⚠️ THIS IS THE ONLY TEST THAT DISTINGUISHES THE MATCHING FROM A GREEDY
    // WALK, and the distinction is not academic: the two disagree on this exact
    // family, and which one you get depends on the order the expectation happens
    // to list its groups in.
    //
    // `beta`'s measures are carried by BOTH rows; `alpha`'s only by the first.
    // Listed beta-first, a greedy walk hands row 0 to beta and then has nothing
    // left for alpha — even though beta could have taken row 1. Augmenting
    // re-homes it. Reverse the two groups and greedy succeeds, which is what
    // makes an order-dependent rule indefensible rather than merely weaker.
    //
    // Both candidate columns (`k` and `m`) present the same family, so a greedy
    // implementation fails this in every column and the whole grade goes red.
    const overlapping = {
      kind: "keyed",
      groups: [
        { label: "beta", measures: [10, 20] },
        { label: "alpha", measures: [10] },
      ],
    } as const satisfies MetricExpectation;
    const answer = [
      sqlAnswer("SELECT k, SUM(v) AS m FROM t GROUP BY 1", ["k", "m"], [
        { k: "a", m: 10 },
        { k: "b", m: 20 },
      ]),
    ];
    const oq = patternQuestion("cq-026", "Orders", "overlapping", ["nothing-matches-this"]);
    expect(gradePattern(oq, answer, "", 8, overlapping).status).toBe("pass");
  });

  it("a label whose rows are NULL in the candidate column is not separated by it", () => {
    // `cellKeysAt` drops nullish cells, so `alpha` — represented only by the row
    // whose key is NULL — offers no value to be assigned and the column fails to
    // separate. A `String(cell)` spelling would hand it the value `"null"`,
    // which separates cleanly and passes: the same two-spellings defect
    // `cellKey` exists to prevent, one layer over.
    //
    // `k` is the only column at the target cardinality (`m` carries three
    // distinct values), so nothing else can rescue the answer.
    const twoGroups = {
      kind: "keyed",
      groups: [
        { label: "alpha", measures: [100] },
        { label: "beta", measures: [200] },
      ],
    } as const satisfies MetricExpectation;
    const nullKeyed = [
      sqlAnswer("SELECT k, SUM(v) AS m FROM t GROUP BY 1", ["k", "m"], [
        { k: null, m: 100 },
        { k: "b", m: 200 },
        { k: "c", m: 999 },
      ]),
    ];
    const nq = patternQuestion("cq-027", "Orders", "null_key_column", ["nothing-matches-this"]);
    expect(gradePattern(nq, nullKeyed, "", 8, twoGroups).status).toBe("fail");
  });

  it("throws rather than failing the model when ground truth has no groups", () => {
    // An empty expectation means the harness never established ground truth.
    // Returning `false` would print a `tool_selection` artifact blaming the
    // model for a harness fault, 40 minutes into a paid run.
    const empty = { kind: "keyed", groups: [] } as const satisfies MetricExpectation;
    expect(() => gradePattern(q, relabelledPromoAnswer(), "", 8, empty)).toThrow(
      /ground truth was not established/,
    );
  });

  it("throws when EVERY authoritative grouping key is NULL", () => {
    // ⚠️ THE SIBLING DISPOSITION, AND AN EARLIER CUT GOT IT BACKWARDS. This
    // branch returned `true` so condition 1 could stand alone — which passes the
    // ungrouped answer condition 2 exists to reject, AND disagreed with
    // `labelSetMatches`, which returns `false` on the identical predicate. Which
    // way a degenerate expectation went was then decided by whether any measure
    // happened to parse as a number. It is a harness fault either way, so it
    // gets the harness fault's disposition.
    const allNull = {
      kind: "keyed",
      groups: [
        { label: null, measures: [4345] },
        { label: null, measures: [1207] },
      ],
    } as const satisfies MetricExpectation;
    const ungrouped = [
      sqlAnswer("SELECT COUNT(*) AS a, COUNT(DISTINCT id) AS b FROM orders", ["a", "b"], [
        { a: 4345, b: 1207 },
      ]),
    ];
    const nq = patternQuestion("cq-024", "Orders", "null_keyed", ["nothing-matches-this"]);
    expect(() => gradePattern(nq, ungrouped, "", 8, allNull)).toThrow(
      /every authoritative grouping key is NULL/,
    );
  });

  it("pins the DISTINCT-label cardinality without a bystander column to lean on", () => {
    // ⚠️ THE ONLY TEST THAT SEPARATES `labels.size` FROM `groups.length` WITHOUT
    // a coincidence. Ground truth is three rows collapsing to two labels; the
    // answer has two rows, and — deliberately — NO column carrying three
    // distinct values, so the row-count spelling cannot be satisfied by a
    // bystander. Without this, the row-count mutation was killed only by the
    // COALESCE limitation test, which #5143 is expected to invert.
    const collapsing = {
      kind: "keyed",
      groups: [
        { label: "In Stock", measures: [90] },
        { label: "in stock ", measures: [12] },
        { label: "Out of Stock", measures: [5] },
      ],
    } as const satisfies MetricExpectation;
    const answer = [
      sqlAnswer(
        "SELECT LOWER(stock_status) AS s, SUM(a) AS a, SUM(b) AS b FROM inventory_levels GROUP BY 1",
        ["s", "a", "b"],
        [
          { s: "in stock", a: 90, b: 12 },
          { s: "out of stock", a: 5, b: 5 },
        ],
      ),
    ];
    const invQ = patternQuestion("cq-025", "Products", "stock_health", ["nothing-matches-this"]);
    // Column distinct counts are s:2, a:2, b:2 — nothing is 3.
    expect(gradePattern(invQ, answer, "", 8, collapsing).status).toBe("pass");
  });
});

/**
 * The three shapes #5143 listed that this fix does NOT close, pinned so the
 * claim in `keyedResultMatches`' doc block is falsifiable rather than asserted.
 *
 * ⚠️ WITHOUT THESE, "we chose not to fix pivoted / rollup / top-N" and "we
 * accidentally fixed them and never noticed" are the same green suite. Each
 * says WHY it is not closed, and each is a test that should be DELETED — not
 * edited — by whoever closes it.
 */
describe("keyed comparison — the shapes #5143 leaves open", () => {
  const pq = patternQuestion("cq-016", "Orders", "orders_with_promotions", [
    "nothing-matches-this",
  ]);

  it("still fails a PIVOTED answer, and could not accept one without deleting condition 2", () => {
    // The grouping key became the COLUMN NAMES, so every column of the single
    // row has exactly one distinct value and none can separate anything. That is
    // indistinguishable from the ungrouped answer condition 2 exists to reject:
    // `SELECT COUNT(*) a, COUNT(*) b` whose two numbers happen to hit both
    // groups presents the identical shape. A rule that admits one admits both.
    const pivoted = [
      sqlAnswer(
        "SELECT COUNT(*) FILTER (WHERE promotion_id IS NOT NULL) AS with_promo, " +
          "COUNT(*) FILTER (WHERE promotion_id IS NULL) AS no_promo, " +
          "AVG(total_cents) FILTER (WHERE promotion_id IS NOT NULL)/100.0 AS aov_promo, " +
          "AVG(total_cents) FILTER (WHERE promotion_id IS NULL)/100.0 AS aov_none " +
          "FROM orders WHERE status != 'cancelled'",
        ["with_promo", "no_promo", "aov_promo", "aov_none"],
        [{ with_promo: 1240, no_promo: 3105, aov_promo: 118.4, aov_none: 92.7 }],
      ),
    ];
    // Condition 1 is satisfied — both groups' numbers are present — so this is
    // condition 2 alone, which is what makes it a shape limit and not a grading
    // disagreement.
    expect(gradePattern(pq, pivoted, "", 8, PROMO_GROUND_TRUTH).status).toBe("fail");
  });

  it("still fails a ROLLUP answer, whose extra Total row reads as an extra group", () => {
    // Telling `Total` apart from a genuinely finer grouping means recognising
    // the extra row as a SUM of the others — new machinery, and a sixth
    // heuristic on a comparison whose first five were all wrong. The NULL-group
    // tolerance deliberately cannot be borrowed for it: ground truth here has no
    // NULL group, so the target stays exactly 2.
    const rolledUp = {
      kind: "keyed",
      groups: [
        { label: "percent_off", measures: [100] },
        { label: "free_shipping", measures: [200] },
      ],
    } as const satisfies MetricExpectation;
    const answer = [
      sqlAnswer("SELECT t, SUM(v) AS m FROM promos GROUP BY ROLLUP(t)", ["t", "m"], [
        { t: "percent_off", m: 100 },
        { t: "free_shipping", m: 200 },
        { t: "Total", m: 300 },
      ]),
    ];
    const rq = patternQuestion("cq-028", "Orders", "promo_rollup", ["nothing-matches-this"]);
    expect(gradePattern(rq, answer, "", 8, rolledUp).status).toBe("fail");
  });

  it("rejects a TRUNCATED top-N, and NOT on the cardinality #5143 blamed", () => {
    // ⚠️ #5143's table blames the cardinality: "10 distinct ≠ 20". That is not
    // what rejects this. `k` carries THREE distinct values here — exactly the
    // authoritative count — so the cardinality is satisfied and the answer still
    // fails, because `gamma`'s number appears nowhere.
    //
    // ⚠️ AN EARLIER VERSION OF THIS COMMENT SAID CONDITION 2 WAS SATISFIED
    // OUTRIGHT AND ONLY CONDITION 1 REJECTED IT. That was wrong, and the test
    // cannot tell the difference — it asserts `status === "fail"` and both
    // conditions reject. `gamma` has measures and no representing row, so it
    // reaches `separatesAuthoritativeGroups` with an empty candidate set, which
    // no column can be assigned; condition 1 short-circuits first, but deleting
    // it leaves this red anyway. The two conditions are separable ONLY for a
    // NULL-labelled group, which `separatesAuthoritativeGroups` skips — that is
    // the case pinned above, and it is the only falsifier condition 1 has.
    //
    // What survives from #5143's entry is the useful half: a truncated top-N is
    // rejected for MISSING GROUPS, not for counting wrong, so no amount of
    // loosening the cardinality could have unblocked it.
    const topN = {
      kind: "keyed",
      groups: [
        { label: "alpha", measures: [100] },
        { label: "beta", measures: [200] },
        { label: "gamma", measures: [300] },
      ],
    } as const satisfies MetricExpectation;
    const truncated = [
      sqlAnswer("SELECT k, SUM(v) AS m FROM t GROUP BY 1 ORDER BY 2 DESC LIMIT 3", ["k", "m"], [
        { k: "alpha", m: 100 },
        { k: "beta", m: 200 },
        { k: "beta-runner-up", m: 201 },
      ]),
    ];
    const tq = patternQuestion("cq-029", "Orders", "top_n", ["nothing-matches-this"]);
    expect(gradePattern(tq, truncated, "", 8, topN).status).toBe("fail");
  });
});

describe("labelDriftNote — reports a relabel without gating it (#5128)", () => {
  const q = patternQuestion("cq-016", "Orders", "orders_with_promotions", [
    "nothing-matches-this",
  ]);
  const relabelled = relabelledPromoAnswer();

  it("reports the drift on a question it just PASSED", () => {
    const out = gradePattern(q, relabelled, "", 8, PROMO_GROUND_TRUTH);
    expect(out.status).toBe("pass");
    const note = labelDriftNote(out, PROMO_GROUND_TRUTH);
    expect(note).toContain("cq-016");
    expect(note).toContain("relabelled");
    // ⚠️ THE WHOLE BRACKETED LIST, NOT `toContain("With Promo")` — that string is
    // a PREFIX of the model's own label `"With Promotion"`, so the assertion
    // passed against a mutant that printed the OBSERVED labels back, producing
    // the self-contradictory "none of [With Promotion, …] appears in any result
    // column". A substring assertion on one label cannot tell the two apart.
    expect(note).toContain("[With Promo, No Promo]");
    expect(note).not.toContain("With Promotion");
  });

  it("says nothing when the answer did not match ground truth at all", () => {
    // ⚠️ THE NOTE MUST NOT SPEAK FOR A PASS IT HAD NOTHING TO DO WITH. A pattern
    // question can pass on `sql_pattern` while its RESULT is wrong; without the
    // empty-match guard the note would print "grouped answer matched the
    // authoritative measures and 2 group(s), but relabelled them" over a result
    // that matched nothing — a false statement in the one channel whose whole
    // job is keeping a relabel visible.
    const passesOnSql = patternQuestion("cq-016", "Orders", "orders_with_promotions", [
      "FROM orders",
    ]);
    const wrongNumbers = [
      sqlAnswer(
        "SELECT promo, COUNT(*) AS n FROM orders GROUP BY 1",
        ["promo", "n"],
        [
          { promo: "yes", n: 11 },
          { promo: "no", n: 22 },
        ],
      ),
    ];
    const out = gradePattern(passesOnSql, wrongNumbers, "", 8, PROMO_GROUND_TRUTH);
    expect(out.status).toBe("pass");
    expect(labelDriftNote(out, PROMO_GROUND_TRUTH)).toBeNull();
  });

  it("says nothing when the answer used the authoritative labels", () => {
    const onLabel = [
      sqlAnswer(
        "SELECT CASE WHEN promotion_id IS NOT NULL THEN 'With Promo' ELSE 'No Promo' END AS promo_status, " +
          "COUNT(*) AS orders, AVG(total_cents)/100.0 AS aov, SUM(total_cents)/100.0 AS revenue " +
          "FROM orders WHERE status != 'cancelled' GROUP BY 1",
        ["promo_status", "orders", "aov", "revenue"],
        [
          { promo_status: "With Promo", orders: 1240, aov: 118.4, revenue: 146816 },
          { promo_status: "No Promo", orders: 3105, aov: 92.7, revenue: 287833.5 },
        ],
      ),
    ];
    const out = gradePattern(q, onLabel, "", 8, PROMO_GROUND_TRUTH);
    expect(out.status).toBe("pass");
    expect(labelDriftNote(out, PROMO_GROUND_TRUTH)).toBeNull();
  });

  it("says nothing on a FAIL whose answer WOULD have matched — a note is a report, not a second verdict", () => {
    // ⚠️ THE FIXTURE HAS TO FAIL FOR A REASON OTHER THAN THE COMPARISON, or it
    // proves nothing: an answer whose measures are simply wrong returns `null`
    // from the substance check and would satisfy this assertion with the
    // pass-only guard deleted. A mutation confirmed exactly that.
    //
    // ⚠️ THIS USED TO RIDE ON `latency`, and #5039 removed that route. Latency
    // now warns instead of failing, so the old construction returns `pass` —
    // and the assertion below is `toBeNull()`, which a passing outcome can
    // satisfy for an entirely different reason. Left alone it would not have
    // gone red; it would have gone VACUOUS, still green, testing nothing.
    //
    // `protocol` (transport) is now the cheapest of the two remaining places a
    // keyed answer can match on substance and still be graded `fail`; both
    // return before `gradeByMode`. The note is suppressed on all of them: the
    // artifact already carries the expectation, and a "matched but relabelled"
    // line beside a failure verdict reads as a second, contrary verdict.
    const out = grade({
      question: q,
      toolCalls: [
        ...relabelled,
        {
          name: "explore",
          args: { command: "ls -la" },
          contract: "text",
          latencyMs: 3,
          result: {
            kind: "error",
            envelope: { __transport: true, error: "socket hang up", errorName: "AbortError" },
          },
        },
      ],
      finalText: "",
      latencyMs: 9_000,
      baseline: undefined,
      metricExpectations: undefined,
      answerExpectations: { "cq-016": PROMO_GROUND_TRUTH },
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") expect(out.artifact.category).toBe("protocol");
    expect(labelDriftNote(out, PROMO_GROUND_TRUTH)).toBeNull();
  });
});

describe("keyedExpectationFrom — harvesting ground truth (#5128)", () => {
  it("keeps each group's measures WITH its label, and excludes a numeric key", () => {
    // `month` is a grouping label that happens to be a number. Harvesting it as
    // a measure would force the model to reproduce `3` somewhere in its result
    // — a spelling test on a calendar. And the measures must stay attached to
    // the group that produced them: the comparison grades PER GROUP, so a flat
    // list would make "which group is unrepresented" unanswerable.
    const e = keyedExpectationFrom(
      "month",
      ["orders", "revenue"],
      [
        { month: 1, orders: 410, revenue: 39221.5 },
        { month: 2, orders: 388, revenue: 35907.25 },
        { month: 3, orders: 502, revenue: 47118 },
      ],
    );
    expect(e.groups).toEqual([
      { label: "1", measures: [410, 39221.5] },
      { label: "2", measures: [388, 35907.25] },
      { label: "3", measures: [502, 47118] },
    ]);
  });

  it("parses Postgres `numeric` measures, which arrive as strings", () => {
    const e = keyedExpectationFrom(
      "channel",
      ["gmv"],
      [
        { channel: "dtc", gmv: "128401.75" },
        { channel: "marketplace", gmv: "64200.5" },
      ],
    );
    expect(e.groups.map((g) => g.measures)).toEqual([[128401.75], [64200.5]]);
  });

  it("keeps labels VERBATIM, and the cardinality collapses them at comparison time", () => {
    // Three rows spelling two groups. `groups.length` is 3 and the labels are
    // untouched — an operator greps the pattern SQL for `'In Stock'`, not
    // `in stock` — while the shape check the model is measured against is
    // DISTINCT normalized labels, i.e. 2. Asserting that through `gradePattern`
    // rather than off the field is the only way to see the collapse happen:
    // reading `groups.length` would silently pass a row-count spelling.
    const e = keyedExpectationFrom(
      "stock_status",
      ["skus"],
      [
        { stock_status: "In Stock", skus: 90 },
        { stock_status: "in stock ", skus: 12 },
        { stock_status: "Out of Stock", skus: 5 },
      ],
    );
    expect(e.groups).toHaveLength(3);
    expect(e.groups.map((g) => g.label)).toEqual(["In Stock", "in stock ", "Out of Stock"]);

    const invQ = patternQuestion("cq-023", "Products", "stock_health", ["nothing-matches-this"]);
    const twoGroupAnswer = [
      sqlAnswer(
        "SELECT LOWER(stock_status) AS status, warehouse, COUNT(*) AS skus " +
          "FROM inventory_levels GROUP BY 1, 2",
        ["status", "warehouse", "skus"],
        [
          { status: "in stock", warehouse: "west", skus: 90 },
          { status: "in stock", warehouse: "east", skus: 12 },
          { status: "out of stock", warehouse: "west", skus: 5 },
        ],
      ),
    ];
    // `status` carries exactly TWO distinct values — the collapsed cardinality,
    // not the three harvested rows.
    //
    // ⚠️ THE STATED MUTATION RESULTS HERE WERE WRONG AND WERE CHECKED, NOT
    // REASONED. An earlier comment claimed a row-count spelling "would demand 3"
    // and a case-sensitive fold "would see 2 vs 2 by luck". Both were measured
    // green: `skus` is `90, 12, 5` — three distinct values — so a BYSTANDER
    // column satisfies either mutant. What this test actually proves is that a
    // 3-row / 2-label harvest passes against a 2-group answer. The row-count and
    // case-folding spellings are killed by `a COALESCE-rendered NULL group` and
    // `still compares LABELS when the authoritative result has no measures`
    // respectively.
    expect(gradePattern(invQ, twoGroupAnswer, "", 8, e).status).toBe("pass");
  });

  it("harvests a NULL grouping key as `null`, never as the string \"null\"", () => {
    // ⚠️ `String(cell)` HERE WAS A FALSE NEGATIVE. `"null"` counts toward a
    // cardinality the observed side can never reach, because `columnValueSets`
    // skips nullish cells — so the model returning the identical rows failed.
    const e = keyedExpectationFrom(
      "promotion_type",
      ["orders"],
      [
        { promotion_type: "percent_off", orders: 800 },
        { promotion_type: null, orders: 3105 },
      ],
    );
    expect(e.groups.map((g) => g.label)).toEqual(["percent_off", null]);
  });

  it("yields no measures when the authoritative result is key-only", () => {
    const e = keyedExpectationFrom(
      "status",
      [],
      [{ status: "shipped" }, { status: "delivered" }],
    );
    expect(e.groups).toEqual([
      { label: "shipped", measures: [] },
      { label: "delivered", measures: [] },
    ]);
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

  // ── Text-contract tools and the protocol check (#5131) ───────────────
  //
  // Five of the eight failures on the eval's first real CI run were one
  // `explore` call each: a successful `ls -la` graded as
  // "MCP tool explore returned non-JSON content". `explore` is a sandboxed
  // shell — text IS its output contract.
  //
  // ⚠️ THE FIX IS AT THE RECORDING SEAM, NOT HERE. `interpretResult` records a
  // successful text-contract call as `ok`, so `grade()` never needs to know
  // about contracts and these tests pin the grader's side of that: a recorded
  // `unparseable` is a regression for EVERY tool, text-contract or not. The
  // classifier's own falsifiers live in the `bindMcpToolsForLlm` block below.

  it("passes a question whose text-contract call was recorded as ok, keeping it in the sequence", () => {
    const q = metricQuestion("cq-001", "total_gmv");
    const listing = "total 4\ndrwxr-xr-x 1 user user 0 Jan 1 00:00 .\nentities/\nmetrics/\n";
    const calls = [
      call("explore", { command: "ls -la" }, { kind: "ok", data: listing }, 5, "text"),
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
      latencyMs: 10,
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("pass");
    // The exemption must mean "not GRADED as a regression", never "dropped
    // from the record" — a fix that passed by deleting the call would lose the
    // forensic trail every failure artifact is built from.
    expect(out.toolCalls.map((c) => c.name)).toContain("explore");
  });

  it("STILL fails a JSON-contract tool recorded unparseable — same body as an exempt call, and a good answer present", () => {
    // ⚠️ THIS FIXTURE IS BUILT TO DISCRIMINATE. All three levers a sloppier
    // fix could key on are held constant or present:
    //   - the exempt call and the failing call carry the IDENTICAL body, so a
    //     content heuristic ("looks like shell output") cannot pass this;
    //   - a successful answering call IS present, so "only report unparseable
    //     when the run produced no answer" cannot pass this;
    //   - a text-contract call IS present, so "skip the check when the run
    //     touched a text tool" cannot pass this.
    // The only thing that differs between the exempt and failing calls is the
    // recorded `contract`.
    const q = metricQuestion("cq-001", "total_gmv");
    const listing = "entities/\nmetrics/\n";
    const calls = [
      call("explore", { command: "ls -la" }, { kind: "ok", data: listing }, 5, "text"),
      call("describeEntity", { name: "orders" }, { kind: "unparseable", raw: listing }),
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
      latencyMs: 10,
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("protocol");
      // The tool NAMED must be the JSON one — a fix that reported `explore`
      // here would be blaming the shell for the typed tool's regression.
      expect(out.artifact.tool).toBe("describeEntity");
    }
  });

  it("STILL fails a TEXT-contract tool recorded unparseable — the grader must stay contract-blind", () => {
    // ⚠️ THIS IS THE COMPOSITION TEST, and it exists because a mutation
    // survived without it. `interpretResult` only ever records a text-contract
    // call as `unparseable` for the two cases that are NOT shell output: a
    // server-flagged error, and empty content. So re-adding a
    // `contract === "json"` clause to `isUnparseable` would reopen both holes
    // — and every other test here would stay green, because none of them
    // presents the grader with a text-contract `unparseable`.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls = [
      call(
        "explore",
        { command: "ls -la" },
        { kind: "unparseable", raw: "Error: sandbox failed to start" },
        5,
        "text",
      ),
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
      latencyMs: 10,
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.category).toBe("protocol");
      expect(out.artifact.tool).toBe("explore");
      // ⚠️ THE REMEDY MUST NOT BE THE JSON ONE. "Add it to TEXT_CONTRACT_TOOLS"
      // is provably a no-op here — the anchor guarantees `explore` is already
      // in the list or the run would not have booted — so printing it would be
      // instructing an operator to do nothing.
      expect(out.artifact.summary).toContain("already there");
      expect(out.artifact.summary).not.toMatch(/add it to TEXT_CONTRACT_TOOLS/i);
    }
  });

  it("DOES tell a json-contract tool to declare itself — the case the anchor cannot detect", () => {
    // The mirror of the test above, and the reason the branch exists rather
    // than one message serving both. The anchor proves declared ⊆ discovered,
    // never the reverse, so a newly-added prose-returning tool lands here and
    // "add it to TEXT_CONTRACT_TOOLS" is exactly the right advice.
    const out = __forTesting__.grade({
      question: metricQuestion("cq-001", "total_gmv"),
      toolCalls: [call("someNewTool", {}, { kind: "unparseable", raw: "plain prose" })],
      finalText: "",
      latencyMs: 5,
      baseline: undefined,
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("fail");
    if (out.status === "fail") {
      expect(out.artifact.summary).toMatch(/add it to TEXT_CONTRACT_TOOLS/i);
      expect(out.artifact.summary).not.toContain("already there");
    }
  });

  describe("throttle remedy", () => {
    // ⚠️ THE DISCRIMINATOR IS THE ENVELOPE, NOT THE TOOL'S CONTRACT, and an
    // earlier cut got this exactly backwards — it told anyone whose `explore`
    // dispatch was throttled that raising EVAL_CLIENT_REQUESTS_PER_MINUTE
    // "will not help". The hosted per-OAuth-client quota runs ahead of EVERY
    // tool body and charges `explore` weight 5, so that is the DOMINANT case
    // and the advice was confidently wrong on it.
    //
    // The four cases below cross the two levers — contract × limiter — so
    // neither can be mistaken for the other. A remedy keyed on contract fails
    // the two off-diagonal cases; one keyed on nothing fails two of the four.
    const q = metricQuestion("cq-001", "total_gmv");
    // The hosted limiter always sets `retry_after` (rate-limit/middleware.ts).
    const hostedQuota = {
      kind: "error" as const,
      envelope: {
        code: "rate_limited",
        message: 'OAuth client "eval" exceeded its hosted-MCP quota (250 weighted requests/min).',
        retry_after: 30,
      },
    };
    // The sandbox/datasource paths build their envelope with no extras.
    const downstream = {
      kind: "error" as const,
      envelope: { code: "rate_limited", message: "pool capacity reached" },
    };
    const gradeWith = (c: RecordedToolCall) => () =>
      __forTesting__.grade({
        question: q,
        toolCalls: [c],
        finalText: "",
        latencyMs: 5,
        baseline: undefined,
        metricExpectations: METRIC_EXPECTATIONS,
        answerExpectations: undefined,
      });

    // ⚠️ ASSERT ON ARM-UNIQUE PHRASES, NOT ON THE KNOB'S NAME. Both arms
    // mention EVAL_CLIENT_REQUESTS_PER_MINUTE — one says to raise it, the other
    // says raising it will not help — so matching the identifier matches BOTH
    // and cannot tell the arms apart. A mutation pinning the remedy to the
    // downstream message survived a battery on exactly that substring double.
    const RAISE_IT = /Raise it via liftEvalClientRateLimit/;
    const WONT_HELP = /will not help/;

    it("names the eval client's quota for a hosted-quota envelope — on a TEXT tool too", () => {
      for (const c of [
        call("explore", { command: "ls" }, hostedQuota, 5, "text"),
        call("runMetric", { id: "total_gmv" }, hostedQuota),
      ]) {
        expect(gradeWith(c)).toThrow(RAISE_IT);
        expect(gradeWith(c)).not.toThrow(WONT_HELP);
      }
    });

    it("points AWAY from the eval client's quota for a downstream envelope — on a JSON tool too", () => {
      for (const c of [
        call("explore", { command: "ls" }, downstream, 5, "text"),
        call("runMetric", { id: "total_gmv" }, downstream),
      ]) {
        expect(gradeWith(c)).toThrow(WONT_HELP);
        expect(gradeWith(c)).not.toThrow(RAISE_IT);
      }
    });
  });

  it("STILL fails a text-contract tool whose TRANSPORT hung up", () => {
    // The exemption is scoped to "non-JSON body", not to the tool. A socket
    // hang-up on `explore` is a protocol regression exactly as it is on
    // `runMetric` — a fix that exempted the tool wholesale would pass this
    // question and lose a real signal.
    const q = metricQuestion("cq-001", "total_gmv");
    const calls: RecordedToolCall[] = [
      {
        name: "explore",
        args: { command: "ls -la" },
        contract: "text",
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
      expect(out.artifact.tool).toBe("explore");
    }
  });

  // ⚠️ This asserted `status === "fail"` until #5039. Latency now WARNS instead
  // of gating: a slow answer is still an answer, and a single-sample baseline
  // measured -29%..+71% run-to-run cannot decide a release. The signal has to
  // survive that change, so the assertion moved from the verdict to the
  // warning rather than being deleted with the failure it used to ride on.
  it("warns — but does NOT fail — when dispatch exceeds baseline by >25%", () => {
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
    expect(out.status).toBe("pass");
    if (out.status === "pass") {
      expect(out.latencyWarning).toBeDefined();
      expect(out.latencyWarning?.summary).toContain("exceeded baseline");
      expect(out.latencyWarning?.baselineMs).toBe(100);
      expect(out.latencyWarning?.ceilingMs).toBe(125);
    }
  });

  // The other half of the pair. Without it, a grader that attached the warning
  // unconditionally would satisfy the case above.
  it("attaches no latency warning when dispatch is within 25% of baseline", () => {
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
      latencyMs: 110,
      baseline: { "cq-001": 100 },
      metricExpectations: METRIC_EXPECTATIONS,
      answerExpectations: undefined,
    });
    expect(out.status).toBe("pass");
    if (out.status === "pass") expect(out.latencyWarning).toBeUndefined();
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
        contract: "json",
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
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
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
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
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
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
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

  // ── Contract classification happens HERE, not in the grader (#5131) ──
  //
  // These drive the real binder rather than hand-stamping `contract` on a
  // fixture, so they falsify `classifyToolContract` and `interpretResult`
  // themselves: point the name list at the wrong tool, drop the stamp, or
  // remove the text branch, and they go red. The grader tests above cannot
  // reach any of that.

  /** The identical body every tool in these fixtures answers with. */
  const LISTING = "total 4\ndrwxr-xr-x 1 user user 0 Jan 1 00:00 .\nentities/\nmetrics/\n";

  it("records a text tool's output as ok and hands it back verbatim; the SAME body from a json tool is unparseable", async () => {
    const recorded: RecordedToolCall[] = [];
    // ⚠️ Both tools answer the IDENTICAL body, so the tool NAME is the only
    // differentiator. A binder that keyed on what the body looks like rather
    // than on which tool produced it cannot pass this.
    const fakeClient = { callTool: async () => fakeCallToolResult(LISTING) };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [
        { name: "explore", description: "Shell over the semantic layer." },
        { name: "describeEntity", description: "Describe an entity." },
      ],
      recorded,
    );

    // The model gets the listing it asked for — NOT a fabricated
    // `{ error: "unparseable" }` for a call that succeeded.
    expect(
      await getRunner(tools, "explore")({ command: "ls -la" }, { toolCallId: "t1", messages: [] }),
    ).toBe(LISTING);

    const describeResult = (await getRunner(tools, "describeEntity")(
      { name: "orders" },
      { toolCallId: "t2", messages: [] },
    )) as { error?: string; raw?: string };
    expect(describeResult.error).toBe("unparseable");
    expect(describeResult.raw).toBe(LISTING);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.contract).toBe("text");
    expect(recorded[0]!.result).toEqual({ kind: "ok", data: LISTING });
    expect(recorded[1]!.contract).toBe("json");
    expect(recorded[1]!.result.kind).toBe("unparseable");
  });

  it("keeps a server-FLAGGED error on a text tool in the protocol lane", async () => {
    // `extractToolJson` reaches its `unparseable` arm from the JSON.parse
    // catch, BEFORE it consults `isError` — so a flagged error with a prose
    // body is shaped exactly like shell output. Exempting it would turn
    // #5131's loud false FAIL into a silent false PASS, with the model reading
    // an internal error message as directory contents.
    const recorded: RecordedToolCall[] = [];
    const fakeClient = {
      callTool: async () => fakeCallToolResult("Error: sandbox failed to start", true),
    };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    const result = (await getRunner(tools, "explore")(
      { command: "ls" },
      { toolCallId: "t1", messages: [] },
    )) as { error?: string };
    expect(result.error).toBe("unparseable");
    expect(recorded[0]!.contract).toBe("text");
    expect(recorded[0]!.result.kind).toBe("unparseable");
  });

  it("records a text tool's TYPED envelope as an error, and that record still aborts the run", async () => {
    // ⚠️ THIS IS THE PRODUCTION-DOMINANT `explore` FAILURE SHAPE, and it was
    // the untested one: the prose-body case above comes from the SDK's generic
    // `createToolError`, but Atlas's own registration lifts every `Error:`
    // line into a typed envelope first (tools.ts → toEnvelopeResult), so a real
    // sandbox failure arrives as isError + JSON. Collapsing the fallback to a
    // flat `unparseable` would pass every other test here while silently
    // turning a throttle abort into a `protocol` grade — the #5122 class.
    //
    // The second half is a COMPOSITION check: the record fed to `grade()` is
    // the one the binder actually produced, not a hand-built fixture. That is
    // what proves the throttle branch is reachable rather than merely correct.
    const recorded: RecordedToolCall[] = [];
    const fakeClient = {
      callTool: async () =>
        fakeCallToolResult(
          JSON.stringify({ code: "rate_limited", message: "pool capacity reached" }),
          true,
        ),
    };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    const result = (await getRunner(tools, "explore")(
      { command: "ls" },
      { toolCallId: "t1", messages: [] },
    )) as { code?: string };
    expect(result.code).toBe("rate_limited");
    expect(recorded[0]!.result.kind).toBe("error");
    expect(recorded[0]!.contract).toBe("text");

    expect(() =>
      __forTesting__.grade({
        question: metricQuestion("cq-001", "total_gmv"),
        toolCalls: recorded,
        finalText: "",
        latencyMs: 5,
        baseline: undefined,
        metricExpectations: METRIC_EXPECTATIONS,
        answerExpectations: undefined,
      }),
    ).toThrow(/rate limited on explore.*will not help/s);
  });

  it("keeps an EMPTY result on a text tool in the protocol lane", async () => {
    // `explore` cannot return "": it normalises a silent command to
    // "(no output)" and every failure path returns an `Error:`-prefixed
    // string. An empty `content` array is a protocol anomaly for every tool.
    const recorded: RecordedToolCall[] = [];
    const fakeClient = { callTool: async () => ({ content: [] }) as CallToolResult };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    const result = (await getRunner(tools, "explore")(
      { command: "ls" },
      { toolCallId: "t1", messages: [] },
    )) as { error?: string };
    expect(result.error).toBe("unparseable");
    expect(recorded[0]!.result.kind).toBe("unparseable");
  });

  it("hands back a text tool's output verbatim even when it happens to parse as JSON", async () => {
    // `grep -c revenue entities/` prints `3`. Parsing it would make the SAME
    // tool record under two different arms depending on what the directory
    // contained — the accidental-shape dependence #5131 was.
    const recorded: RecordedToolCall[] = [];
    const fakeClient = { callTool: async () => fakeCallToolResult("3\n") };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "explore", description: "Shell." }, { name: "runMetric", description: "Run a metric." }],
      recorded,
    );
    expect(
      await getRunner(tools, "explore")(
        { command: "grep -c revenue entities/" },
        { toolCallId: "t1", messages: [] },
      ),
    ).toBe("3\n");
    expect(recorded[0]!.result).toEqual({ kind: "ok", data: "3\n" });
  });

  it("stamps the contract on the TRANSPORT-failure record too", async () => {
    // Otherwise the field is write-only on this path and free to drift into a
    // lie in the failure artifact the operator actually reads.
    const recorded: RecordedToolCall[] = [];
    const fakeClient = {
      callTool: async () => {
        throw new Error("socket hang up");
      },
    };
    const tools = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [
        { name: "explore", description: "Shell." },
        { name: "runMetric", description: "Run a metric." },
      ],
      recorded,
    );
    await expect(
      getRunner(tools, "explore")({ command: "ls" }, { toolCallId: "t1", messages: [] }),
    ).rejects.toThrow(/socket hang up/);
    await expect(
      getRunner(tools, "runMetric")({ id: "x" }, { toolCallId: "t2", messages: [] }),
    ).rejects.toThrow(/socket hang up/);
    expect(recorded.map((c) => c.contract)).toEqual(["text", "json"]);
  });

  it("classifies explore as text and every typed semantic tool as json", () => {
    // Both arms live here so the describe block, not the binder test, carries
    // the classifier's positive case. `listEntities`, `describeEntity` and
    // `searchGlossary` declare no MCP `outputSchema` — within `semantic-tools.ts`
    // only `runMetric` does — so an exemption keyed on `outputSchema` would have
    // silently let these three out of the protocol check.
    expect(classifyToolContract("explore")).toBe("text");
    for (const name of [
      "runMetric",
      "executeSQL",
      "query",
      "describeEntity",
      "searchGlossary",
      "listEntities",
      "searchBrain",
    ]) {
      expect(classifyToolContract(name)).toBe("json");
    }
  });
});

// ── Text-contract anchoring ───────────────────────────────────────────

describe("text-contract anchoring", () => {
  // The exemption is spelled as a NAME. Rename `explore` and the name stops
  // matching, the exemption becomes a no-op, and every successful shell call
  // is graded as a protocol regression again — silently. This anchor is what
  // turns that into a loud stop at boot, BEFORE any paid LLM token is spent.
  //
  // ⚠️ EVERY CASE BELOW GOES THROUGH `bindMcpToolsForLlm`, NOT THE ASSERT
  // DIRECTLY — testing the assert alone leaves its WIRING untested, and
  // `runMcpLlmEval` has no test to catch an unanchored bind.

  const fakeClient = { callTool: async () => ({ content: [] }) as CallToolResult };

  it("binds every discovered tool when the anchor holds", () => {
    const bound = __forTesting__.bindMcpToolsForLlm(
      fakeClient,
      [{ name: "explore" }, { name: "runMetric" }],
      [],
    );
    expect(Object.keys(bound).sort()).toEqual(["explore", "runMetric"]);
  });

  it("refuses to bind, naming the missing tool and the surface, when one was renamed away", () => {
    expect(() =>
      __forTesting__.bindMcpToolsForLlm(fakeClient, [{ name: "shell" }, { name: "runMetric" }], []),
    ).toThrow(/text-contract tool\(s\) not on the MCP surface: explore.*Discovered:.*shell/s);
  });

  it("refuses to bind an EMPTY surface, and says tools/list returned nothing", () => {
    // Driven through the binder rather than the assert on purpose: guarding
    // the call as `if (tools.length > 0) assert(...)` is a plausible edit, and
    // an empty surface would then bind cleanly and grade every question as
    // `tool_selection` instead of stopping.
    expect(() => __forTesting__.bindMcpToolsForLlm(fakeClient, [], [])).toThrow(
      /Discovered: \(empty — tools\/list returned no tools\)/,
    );
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

  // ⚠️ Asserts the COMMITTED baseline, not a fixture — the only test here that
  // does. Every other case builds its own file, so all of them stayed green
  // for the entire period the real baseline was the 3 bytes `{}` it was
  // created with (#5039). `readBaseline` treats a missing entry as "no
  // baseline yet" and says nothing, so an emptied or truncated baseline
  // degrades the latency early-warning signal SILENTLY: the job keeps
  // passing, and the only symptom is a regression it can no longer see.
  //
  // Seeded from the `v0.2.5` tag run (merged code, valid JSON only after
  // #5148 fixed stdout) — never from a local run, which #5122-era history
  // shows were taken on a broken whitelist or a mid-flight grader.
  describe("the committed baseline", () => {
    const committed = path.resolve(
      __dirname,
      "../../../eval/canonical-questions/mcp-llm-baseline.json",
    );

    it("is populated, and every entry survives readBaseline's filter", () => {
      const out = readBaseline(committed);
      expect(out).toBeDefined();
      const entries = Object.entries(out ?? {});
      expect(entries.length).toBeGreaterThan(0);
      // `readBaseline` drops non-finite and <= 0 values. If the committed file
      // ever disagrees with what it yields, some entries are being silently
      // discarded and the signal is thinner than the file suggests.
      const onDisk = JSON.parse(fs.readFileSync(committed, "utf-8")) as Record<string, unknown>;
      expect(entries.length).toBe(Object.keys(onDisk).length);
      for (const [id, ms] of entries) {
        expect(id).toMatch(/^cq-\d{3}$/);
        expect(ms).toBeGreaterThan(0);
      }
    });

    it("covers every canonical question", () => {
      const yml = fs.readFileSync(
        path.resolve(__dirname, "../../../eval/canonical-questions/questions.yml"),
        "utf-8",
      );
      const asked = [...new Set([...yml.matchAll(/^\s*-?\s*id:\s*"?(cq-\d{3})"?/gm)].map((m) => m[1]))];
      expect(asked.length).toBeGreaterThan(0);
      const covered = Object.keys(readBaseline(committed) ?? {});
      // A question added without regenerating the baseline has no latency
      // signal at all, and nothing else would say so.
      expect(covered.sort()).toEqual(asked.sort());
    });
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
// pin the dispatch evaluation.
//
// ⚠️ WHAT IS NOT COVERED, stated rather than implied. This note used to
// claim the two together "cover every regression class the per-question
// dispatch loop can introduce", and that was false in the way that
// matters: `runMcpLlmEval`'s own body — the ORDER it composes those
// pieces in — has no test at all. That is why the text-contract anchor
// lives inside `bindMcpToolsForLlm` rather than in a wrapper around it:
// anything the loop must not be able to skip has to be unskippable by
// construction, because nothing here would notice the skip.

// ── Token usage (#5123) ───────────────────────────────────────────────

/**
 * Every spend figure this lane has ever quoted was a guess — including the
 * workflow's own *"under $0.05 per run"*, which was never measured, and
 * order-of-magnitude arithmetic on a 20-question / 124-tool-call run that puts
 * it nearer $0.50–$2.00 and is also not a measurement.
 *
 * These pin the two properties that keep the recorded number from becoming
 * another one of those: totals are DERIVED from the per-question records, and a
 * question the provider did not measure is NAMED rather than counted as free.
 */
const { summarizeTokenUsage } = __forTesting__;

describe("summarizeTokenUsage", () => {
  const u = (i: number, o: number, t: number) => ({
    inputTokens: i,
    outputTokens: o,
    totalTokens: t,
  });

  it("sums each field independently", () => {
    // ⚠️ NINE DISTINCT NUMBERS, NO TWO SUMS EQUAL. With `{100,100,200}` twice,
    // swapping `inputTokens` for `outputTokens` in the reducer passes. Here
    // every field's total is unique, so any cross-wiring is visible.
    const out = summarizeTokenUsage([
      { questionId: "cq-001", usage: u(100, 20, 130) },
      { questionId: "cq-002", usage: u(3000, 400, 3450) },
    ]);
    expect(out.totals).toEqual({
      inputTokens: 3100,
      outputTokens: 420,
      totalTokens: 3580,
    });
  });

  it("keeps a provider totalTokens that EXCEEDS input + output", () => {
    // The provider's own total is authoritative and need not equal the sum, so
    // an always-derive implementation loses it. 130 ≠ 120 is the whole assertion.
    // (An earlier version of this comment explained the gap as reasoning tokens
    // "counted in totalTokens and in neither of the others" — false for the
    // pinned SDK, where they sit inside `outputTokens`. Same correction as
    // `toTokenUsage`'s docstring; this copy was missed the first time.)
    const out = summarizeTokenUsage([{ questionId: "cq-001", usage: u(100, 20, 130) }]);
    expect(out.totals.totalTokens).toBe(130);
    expect(out.totals.inputTokens + out.totals.outputTokens).toBe(120);
  });

  it("EXCLUDES an unmeasured question from the totals and names it", () => {
    // The failure this prevents is a total that is quietly short. A `null`
    // treated as `{0,0,0}` produces the same totals with no signal at all —
    // which is why the ids are asserted beside them.
    const out = summarizeTokenUsage([
      { questionId: "cq-001", usage: u(100, 20, 130) },
      { questionId: "cq-002", usage: null },
      { questionId: "cq-003", usage: null },
    ]);
    expect(out.totals).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 130 });
    expect(out.unreported).toEqual(["cq-002", "cq-003"]);
  });

  it("reports zero totals and every id when NOTHING was measured", () => {
    // The shape a provider that reports no usage at all produces. Zeros here are
    // honest only because `unreported` says all three questions are missing —
    // asserted together for that reason.
    const out = summarizeTokenUsage([
      { questionId: "cq-001", usage: null },
      { questionId: "cq-002", usage: null },
    ]);
    expect(out.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(out.unreported).toEqual(["cq-001", "cq-002"]);
  });

  it("carries the per-question records through unchanged", () => {
    // `byQuestion` is what makes the totals auditable — and what answers *which*
    // question was expensive. A summarizer that returned only totals would pass
    // every test above.
    const byQuestion = [
      { questionId: "cq-001", usage: u(100, 20, 130) },
      { questionId: "cq-002", usage: null },
    ];
    expect(summarizeTokenUsage(byQuestion).byQuestion).toEqual(byQuestion);
  });

  it("is empty, not undefined, for a run that graded no questions", () => {
    const out = summarizeTokenUsage([]);
    expect(out.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(out.unreported).toEqual([]);
    expect(out.byQuestion).toEqual([]);
  });
});

/**
 * The boundary narrow. The AI SDK types every field of `LanguageModelUsage` as
 * `number | undefined`, so a provider may report all, some or none of them.
 */
describe("toTokenUsage", () => {
  const { toTokenUsage } = __forTesting__;

  it("passes a fully reported usage through, keeping the provider's total", () => {
    expect(toTokenUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 130 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 130,
    });
  });

  it("derives totalTokens ONLY when the provider omitted it", () => {
    // 130 above vs 120 here — the two branches produce different numbers on
    // deliberately-chosen inputs, so an implementation that always derived (or
    // always trusted) fails one of them.
    expect(
      toTokenUsage({ inputTokens: 100, outputTokens: 20, totalTokens: undefined }),
    ).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  });

  it("returns null for a PARTIAL report rather than zero-filling it", () => {
    // ⚠️ THE RULE THAT KEEPS THIS A MEASUREMENT. `{inputTokens: 5000,
    // outputTokens: 0}` reads as a very cheap question; `null` reads as an
    // unmeasured one, and `summarizeTokenUsage` then NAMES it. Input and output
    // are priced differently by roughly 5x, so a half-report cannot be costed.
    expect(toTokenUsage({ inputTokens: 5000, outputTokens: undefined, totalTokens: 5000 })).toBeNull();
    expect(toTokenUsage({ inputTokens: undefined, outputTokens: 20, totalTokens: 20 })).toBeNull();
  });

  it("returns null when the provider reported no usage object at all", () => {
    expect(toTokenUsage(undefined)).toBeNull();
  });

  it("keeps a genuine ZERO, which is not the same as unreported", () => {
    // A question that dispatched nothing can legitimately cost 0 output tokens.
    // A truthiness check (`if (!outputTokens) return null`) passes every case
    // above and fails here — which is why this case exists.
    // `totalTokens: 55` rather than `40 + 0`, so the trust-vs-derive branch
    // stays live in this fixture too — with the provider's total equal to the
    // derived one, an always-derive mutant passes here as well.
    expect(toTokenUsage({ inputTokens: 40, outputTokens: 0, totalTokens: 55 })).toEqual({
      inputTokens: 40,
      outputTokens: 0,
      totalTokens: 55,
    });
  });
});

/**
 * #5123 — which SDK field the run's cost is read from.
 *
 * ⚠️ THE PRIMARY GUARD IS THE PARAMETER TYPE, NOT THIS TEST. `result.usage` and
 * `result.totalUsage` are both `LanguageModelUsage`, so the first cut read the
 * LAST STEP of a ~7-step tool loop and reported a run cost roughly 7x low —
 * green against every test here, because they pin the narrowing rather than the
 * source. `runTokenUsage`'s parameter names only `totalUsage`, so `await
 * result.usage` no longer compiles; `bun run type` is what fails.
 *
 * These add the runtime half: given an object carrying BOTH, which is read.
 */
describe("runTokenUsage", () => {
  const { runTokenUsage } = __forTesting__;

  it("reads totalUsage when both fields are present and DIFFER", () => {
    // ⚠️ THE TWO MUST BE DIFFERENT AND MUST NOT BE MULTIPLES OF EACH OTHER, or
    // a fixture where the last step happens to equal the sum makes the whole
    // assertion inert — which is the real-world shape of a ONE-step question.
    const result = {
      totalUsage: Promise.resolve({ inputTokens: 9000, outputTokens: 700, totalTokens: 9700 }),
      // Present on purpose: the shape the SDK actually hands us. The parameter
      // type does not mention it, so reaching for it is a compile error.
      usage: Promise.resolve({ inputTokens: 1200, outputTokens: 90, totalTokens: 1290 }),
    };
    return runTokenUsage(result).then((usage) => {
      expect(usage).toEqual({ inputTokens: 9000, outputTokens: 700, totalTokens: 9700 });
    });
  });

  it("still returns null for a partial report", () => {
    // The narrowing rule survives the extraction — `runTokenUsage` must not
    // become a second place where a half-measurement is accepted.
    return runTokenUsage({
      totalUsage: Promise.resolve({
        inputTokens: 9000,
        outputTokens: undefined,
        totalTokens: 9000,
      }),
    }).then((usage) => {
      expect(usage).toBeNull();
    });
  });
});
