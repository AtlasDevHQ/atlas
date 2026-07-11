/**
 * Unit tests for the PURE briefing assembler (#4514 AC1).
 *
 * The seam under test does no I/O — every input is supplied directly, so these
 * tests never touch a DB, an LLM, or the clock. They pin the load-bearing
 * behaviors: the health discriminator (corrupt vs. empty), the tracked-profile
 * "no live query" contract, the pending queue + recent decisions surfacing, and
 * the bounded rendering.
 */

import { describe, it, expect } from "bun:test";
import { assembleBriefing, type BriefingInputs } from "../briefing";
import type { SemanticHealthScore } from "../health";
import type { AnalysisResult, AuditPattern } from "../types";

function makeHealth(overrides: Partial<SemanticHealthScore> = {}): SemanticHealthScore {
  return {
    overall: 82,
    coverage: 90,
    descriptionQuality: 80,
    measureCoverage: 70,
    joinCoverage: 85,
    entityCount: 12,
    dimensionCount: 48,
    measureCount: 9,
    glossaryTermCount: 4,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    category: "missing_measures",
    entityName: "orders",
    amendmentType: "add_measure",
    amendment: { name: "total_revenue" },
    rationale: "orders.amount is aggregated in 40 audit queries but has no measure.",
    impact: 0.9,
    confidence: 0.8,
    staleness: 0,
    score: 0.72,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<BriefingInputs> = {}): BriefingInputs {
  return {
    health: makeHealth(),
    healthStatus: "ok",
    parseFailures: 0,
    totalRows: 12,
    profiles: [],
    findings: [],
    auditPatterns: [],
    pending: [],
    recentDecisions: [],
    rejectionMemoryCount: 0,
    ...overrides,
  };
}

describe("assembleBriefing", () => {
  it("front-loads the health score, counts, and the no-tool-call framing", () => {
    const block = assembleBriefing(makeInputs());
    expect(block).toContain("## Semantic layer briefing");
    expect(block).toContain("### Health: 82/100");
    expect(block).toContain("Coverage 90% · Descriptions 80% · Measures 70% · Joins 85%");
    expect(block).toContain("12 entities · 48 dimensions · 9 measures · 4 glossary terms");
    // AC5 framing: the agent should NOT need tools to learn health/findings/queue.
    expect(block).toContain("do NOT need a tool call");
  });

  it("distinguishes a parse-failure zero from a no-data zero (#4514 AC4)", () => {
    const corrupt = assembleBriefing(
      makeInputs({
        healthStatus: "corrupt",
        parseFailures: 3,
        totalRows: 3,
        health: makeHealth({ overall: 0, entityCount: 0 }),
      }),
    );
    expect(corrupt).toContain("3 of 3 entity rows failed to parse");
    expect(corrupt).toContain("corrupt, not empty");

    const empty = assembleBriefing(
      makeInputs({
        healthStatus: "no_entities",
        totalRows: 0,
        health: makeHealth({ overall: 100, entityCount: 0 }),
      }),
    );
    expect(empty).toContain("no entities yet");
    expect(empty).toContain("empty, not corrupt");
    expect(empty).not.toContain("failed to parse");
  });

  it("renders tracked profiles with staleness and the no-live-query contract (#4514 AC3)", () => {
    const block = assembleBriefing(
      makeInputs({
        profiles: [
          { connection: "us_prod", dbType: "postgres", freshness: "profiled 3 days ago", tableCount: 24 },
          { connection: "eu_prod", dbType: "postgres", freshness: null, tableCount: null },
        ],
      }),
    );
    expect(block).toContain("us_prod (postgres): profiled 3 days ago, 24 tables");
    expect(block).toContain("eu_prod (postgres): never profiled");
    expect(block).toContain("no live customer-database query was run");
  });

  it("lists the top findings, capped, with impact and confidence", () => {
    const findings = Array.from({ length: 7 }, (_, i) =>
      makeFinding({ entityName: `e${i}`, rationale: `finding ${i}` }),
    );
    const block = assembleBriefing(makeInputs({ findings }));
    expect(block).toContain("1. [missing_measures] e0: finding 0 (impact 90%, confidence 80%)");
    // Capped at 5, with an overflow note for the remaining 2.
    expect(block).toContain("e4: finding 4");
    expect(block).not.toContain("e5: finding 5");
    expect(block).toContain("…and 2 more.");
  });

  it("says so plainly when the analyzer surfaced nothing", () => {
    const block = assembleBriefing(makeInputs({ findings: [] }));
    expect(block).toContain("None — the analyzer surfaced no improvements");
  });

  it("summarises audit patterns into most-queried tables by total count", () => {
    const auditPatterns: AuditPattern[] = [
      { sql: "SELECT * FROM orders", count: 40, tables: ["orders"], lastSeen: "2026-07-01" },
      { sql: "SELECT * FROM orders o JOIN customers c", count: 10, tables: ["orders", "customers"], lastSeen: "2026-07-02" },
    ];
    const block = assembleBriefing(makeInputs({ auditPatterns }));
    // orders = 40 + 10 = 50, customers = 10 → orders first.
    expect(block).toContain("Most-queried tables: orders (50), customers (10)");
  });

  it("surfaces the pending queue count and rows; says empty when none", () => {
    const withPending = assembleBriefing(
      makeInputs({
        pending: [
          { entityName: "orders", amendmentType: "add_measure", confidence: 0.9, rationale: "revenue" },
        ],
      }),
    );
    expect(withPending).toContain("### Pending review queue (1)");
    expect(withPending).toContain("orders · add_measure · 90% — revenue");

    const empty = assembleBriefing(makeInputs({ pending: [] }));
    expect(empty).toContain("### Pending review queue (0)");
    expect(empty).toContain("Empty — nothing is awaiting");
  });

  it("caps the pending queue with its own overflow copy", () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({
      entityName: `e${i}`,
      amendmentType: "add_measure",
      confidence: 0.5,
      rationale: "r",
    }));
    const block = assembleBriefing(makeInputs({ pending }));
    expect(block).toContain("### Pending review queue (10)");
    expect(block).toContain("e7 · add_measure"); // 8th (index 7) shown
    expect(block).not.toContain("e8 · add_measure"); // capped at 8
    expect(block).toContain("…and 2 more queued.");
  });

  it("clamps out-of-range/non-finite scores and truncates a long rationale", () => {
    const block = assembleBriefing(
      makeInputs({
        findings: [
          makeFinding({ impact: 1.5, confidence: -0.2, rationale: "x".repeat(300) }),
        ],
      }),
    );
    // impact clamps to 100%, confidence to 0%.
    expect(block).toContain("(impact 100%, confidence 0%)");
    // The 300-char rationale is truncated with an ellipsis (≤160 chars).
    expect(block).toContain("…");
    expect(block).not.toContain("x".repeat(200));
  });

  it("reflects recent panel decisions so the agent learns them without synthetic messages (#4514 AC2)", () => {
    const block = assembleBriefing(
      makeInputs({
        recentDecisions: [
          { entityName: "orders", amendmentType: "add_measure", decision: "rejected" },
          { entityName: "customers", amendmentType: "add_dimension", decision: "approved" },
        ],
      }),
    );
    expect(block).toContain("### Recent panel decisions");
    expect(block).toContain("rejected: orders · add_measure");
    expect(block).toContain("approved: customers · add_dimension");
  });

  it("omits the recent-decisions section entirely when there are none", () => {
    const block = assembleBriefing(makeInputs({ recentDecisions: [] }));
    expect(block).not.toContain("### Recent panel decisions");
  });

  it("notes suppressed rejection memory only when non-zero", () => {
    expect(assembleBriefing(makeInputs({ rejectionMemoryCount: 2 }))).toContain(
      "2 previously-rejected changes are suppressed",
    );
    expect(assembleBriefing(makeInputs({ rejectionMemoryCount: 0 }))).not.toContain(
      "Rejection memory",
    );
  });

  it("is a pure function of its inputs — identical inputs render identical blocks", () => {
    const inputs = makeInputs({
      findings: [makeFinding()],
      pending: [{ entityName: "orders", amendmentType: "add_measure", confidence: 0.9, rationale: "r" }],
      recentDecisions: [{ entityName: "orders", amendmentType: "add_measure", decision: "rejected" }],
    });
    expect(assembleBriefing(inputs)).toBe(assembleBriefing(inputs));
  });
});
