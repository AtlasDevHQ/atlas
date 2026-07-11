/**
 * Unit tests for the live-diff + baseline-hash primitives (#4511).
 *
 * Pins the three invariants the review-integrity feature rests on:
 *   - normalization is deterministic (a diff shows content, not formatting);
 *   - the baseline hash is stable across re-dumps and changes iff the content
 *     changes (so a hash-carried claim is neither falsely stale nor blind);
 *   - `computeAmendmentLiveDiff` composes them against the CURRENT baseline read
 *     through the shared resolver — never the stored propose-time diff.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AnalysisResult } from "../types";

// The `./apply` seam `computeAmendmentLiveDiff` composes: the payload→result
// mapping, the shared baseline resolver, and the pure `applyAmendment`. Mock it
// statefully so the diff module is exercised in isolation from DB/YAML I/O.
let mockParsed: Record<string, unknown> = {};
let mockUpdated: Record<string, unknown> = {};
let mockTargetGroupId: string | null = null;
let resolveThrows: Error | null = null;
let resolveCalls: Array<{ orgId: string | null; entity: string; group: string | undefined }> = [];

void mock.module("../apply", () => ({
  analysisResultFromStoredPayload: (params: {
    sourceEntity: string;
    connectionGroupId: string | null;
    rawPayload: unknown;
  }): AnalysisResult => ({
    category: "coverage_gaps",
    entityName: params.sourceEntity,
    group: params.connectionGroupId ?? "default",
    amendmentType: "add_measure",
    amendment: { name: "total_revenue" },
    rationale: "",
    confidence: 0,
    impact: 0,
    score: 0,
    staleness: 0,
  }),
  resolveAmendmentBaseline: async (orgId: string | null, entity: string, group: string | undefined) => {
    resolveCalls.push({ orgId, entity, group });
    if (resolveThrows) throw resolveThrows;
    return { row: {}, targetGroupId: mockTargetGroupId, parsed: mockParsed };
  },
  applyAmendment: () => mockUpdated,
  // mock-all-exports: computeAmendmentLiveDiff only destructures the three above,
  // but a complete mock keeps this suite robust if the seam grows a new call.
  applyAmendmentToEntity: async () => {},
  applyAmendmentFromPayload: async () => {},
}));

const {
  normalizeEntityYaml,
  hashBaselineYaml,
  computeEntityDiff,
  computeAmendmentLiveDiff,
  StaleBaselineError,
} = await import("../diff");

beforeEach(() => {
  mockParsed = {};
  mockUpdated = {};
  mockTargetGroupId = null;
  resolveThrows = null;
  resolveCalls = [];
});

describe("normalizeEntityYaml", () => {
  it("is deterministic for the same object", () => {
    const obj = { name: "orders", measures: [{ name: "total", sql: "sum(x)" }] };
    expect(normalizeEntityYaml(obj)).toBe(normalizeEntityYaml({ ...obj }));
  });

  it("normalizes formatting so only content differences surface in a diff", () => {
    // Two objects with identical content produce byte-identical YAML.
    const a = { name: "orders", dimensions: [{ name: "region", type: "string" }] };
    const b = { name: "orders", dimensions: [{ name: "region", type: "string" }] };
    expect(normalizeEntityYaml(a)).toBe(normalizeEntityYaml(b));
  });
});

describe("hashBaselineYaml", () => {
  it("is stable for identical normalized content", () => {
    const yaml = normalizeEntityYaml({ name: "orders" });
    expect(hashBaselineYaml(yaml)).toBe(hashBaselineYaml(yaml));
  });

  it("changes when the content changes", () => {
    const before = hashBaselineYaml(normalizeEntityYaml({ name: "orders", description: "old" }));
    const after = hashBaselineYaml(normalizeEntityYaml({ name: "orders", description: "new" }));
    expect(before).not.toBe(after);
  });

  it("returns a hex sha256 digest", () => {
    expect(hashBaselineYaml("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeEntityDiff", () => {
  it("produces a unified diff naming the entity file, showing the change", () => {
    const before = normalizeEntityYaml({ name: "orders" });
    const after = normalizeEntityYaml({ name: "orders", description: "The orders table" });
    const diff = computeEntityDiff("orders", before, after);
    expect(diff).toContain("semantic/entities/orders.yml");
    expect(diff).toContain("+description: The orders table");
  });

  it("is empty-bodied when nothing changed", () => {
    const yaml = normalizeEntityYaml({ name: "orders" });
    const diff = computeEntityDiff("orders", yaml, yaml);
    // No hunk markers when before === after.
    expect(diff).not.toContain("@@");
  });
});

describe("computeAmendmentLiveDiff", () => {
  it("diffs the amendment against the CURRENT baseline and hashes that baseline", async () => {
    mockParsed = { name: "orders", measures: [] };
    mockUpdated = { name: "orders", measures: [{ name: "total_revenue" }] };
    mockTargetGroupId = "eu_prod";

    const live = await computeAmendmentLiveDiff({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: "eu_prod",
      rawPayload: { amendment: { name: "total_revenue" } },
    });

    // The diff reflects the applied change against the resolved baseline.
    expect(live.diff).toContain("total_revenue");
    // The hash is of the NORMALIZED baseline the diff was computed against.
    expect(live.baselineHash).toBe(hashBaselineYaml(normalizeEntityYaml(mockParsed)));
    // Resolution used the payload-derived group (NULL group → "default").
    expect(resolveCalls[0]).toMatchObject({ orgId: "org-1", entity: "orders", group: "eu_prod" });
  });

  it("propagates a resolution failure (e.g. cross-group ambiguity) to the caller", async () => {
    resolveThrows = new Error("Entity \"orders\" is ambiguous across groups");
    await expect(
      computeAmendmentLiveDiff({
        orgId: "org-1",
        sourceEntity: "orders",
        connectionGroupId: null,
        rawPayload: { amendment: { name: "x" } },
      }),
    ).rejects.toThrow("ambiguous");
  });
});

describe("StaleBaselineError", () => {
  it("carries the fresh diff + baseline hash for inline update-and-confirm", () => {
    const err = new StaleBaselineError({
      entityName: "orders",
      diff: "--- a\n+++ b\n+x",
      baselineHash: "abc123",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StaleBaselineError");
    expect(err.entityName).toBe("orders");
    expect(err.diff).toContain("+x");
    expect(err.baselineHash).toBe("abc123");
    expect(err.message).toContain("changed");
  });
});
