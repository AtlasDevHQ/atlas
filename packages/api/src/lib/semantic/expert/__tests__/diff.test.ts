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
// #4517 — the draft-existence probe `computeAmendmentLiveDiff` runs against the
// entities module. Stateful so a test can toggle "a draft exists" and assert the
// `draftExists` note without touching a DB.
let mockDraftRow: { status: string } | null = null;
let draftProbeCalls: Array<{ group: string | null | undefined }> = [];
// #4518 — the amendment type the payload→result mapping returns, and the glossary
// resolve/mutate stand-ins for the glossary branch of computeAmendmentLiveDiff.
let mockAmendmentType = "add_measure";
let mockGlossaryParsed: Record<string, unknown> = {};
let mockGlossaryUpdated: Record<string, unknown> = {};
let resolveGlossaryCalls: Array<{ orgId: string | null; group: string | undefined }> = [];

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  getDraftEntityForGroup: async (
    _org: string, _type: string, _name: string, group?: string | null,
  ) => {
    draftProbeCalls.push({ group });
    return mockDraftRow;
  },
}));

void mock.module("../apply", () => ({
  analysisResultFromStoredPayload: (params: {
    sourceEntity: string;
    connectionGroupId: string | null;
    rawPayload: unknown;
  }): AnalysisResult => ({
    category: "coverage_gaps",
    entityName: params.sourceEntity,
    group: params.connectionGroupId ?? "default",
    amendmentType: mockAmendmentType as AnalysisResult["amendmentType"],
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
  // #4518 — the glossary branch of computeAmendmentLiveDiff destructures these.
  isGlossaryAmendmentType: (t: string) => t === "add_glossary_term" || t === "update_glossary_term",
  resolveGlossaryBaseline: async (orgId: string | null, group: string | undefined) => {
    resolveGlossaryCalls.push({ orgId, group });
    if (resolveThrows) throw resolveThrows;
    return { row: {}, targetGroupId: mockTargetGroupId, parsed: mockGlossaryParsed };
  },
  applyGlossaryAmendment: () => mockGlossaryUpdated,
  glossaryDiffPath: (group: string | undefined) =>
    group && group !== "default" ? `semantic/groups/${group}/glossary.yml` : "semantic/glossary.yml",
  // mock-all-exports: keeps this suite robust if the seam grows a new call.
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
  mockDraftRow = null;
  draftProbeCalls = [];
  mockAmendmentType = "add_measure";
  mockGlossaryParsed = {};
  mockGlossaryUpdated = {};
  resolveGlossaryCalls = [];
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
    // No draft sibling by default → no note.
    expect(live.draftExists).toBe(false);
  });

  it("flags draftExists when a `draft` sibling exists, probing the resolved group (#4517)", async () => {
    mockParsed = { name: "orders", measures: [] };
    mockUpdated = { name: "orders", measures: [{ name: "total_revenue" }] };
    mockTargetGroupId = "eu_prod";
    mockDraftRow = { status: "draft" };

    const live = await computeAmendmentLiveDiff({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: "eu_prod",
      rawPayload: { amendment: { name: "total_revenue" } },
    });

    expect(live.draftExists).toBe(true);
    // The draft probe is scoped to the baseline's OWN resolved group.
    expect(draftProbeCalls.at(-1)?.group).toBe("eu_prod");
  });

  it("a `draft_delete` tombstone is NOT a draft for the note (draftExists stays false)", async () => {
    mockParsed = { name: "orders", measures: [] };
    mockUpdated = { name: "orders", measures: [{ name: "total_revenue" }] };
    mockDraftRow = { status: "draft_delete" };

    const live = await computeAmendmentLiveDiff({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: { amendment: { name: "total_revenue" } },
    });

    expect(live.draftExists).toBe(false);
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

  it("diffs a glossary amendment against the group GLOSSARY baseline, attributed to glossary.yml (#4518)", async () => {
    // A glossary amendment must resolve + diff the group's glossary document,
    // never the host entity — so GET /pending renders a real live diff instead
    // of falling back to null (the stored diff is dropped from that surface).
    mockAmendmentType = "add_glossary_term";
    mockGlossaryParsed = { terms: { arr: { definition: "Annual Recurring Revenue" } } };
    mockGlossaryUpdated = {
      terms: { arr: { definition: "Annual Recurring Revenue" }, MRR: { definition: "Monthly Recurring Revenue" } },
    };

    const live = await computeAmendmentLiveDiff({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: "eu_prod",
      rawPayload: { amendment: { term: "MRR", definition: "Monthly Recurring Revenue" } },
    });

    // Resolved the GLOSSARY baseline (not the entity), and the diff is attributed
    // to the group glossary.yml and shows the added term.
    expect(resolveGlossaryCalls[0]).toMatchObject({ orgId: "org-1", group: "eu_prod" });
    expect(resolveCalls).toHaveLength(0); // never touched the entity resolver
    expect(live.diff).toContain("semantic/groups/eu_prod/glossary.yml");
    expect(live.diff).toContain("MRR");
    // The hash is of the normalized GLOSSARY baseline.
    expect(live.baselineHash).toBe(hashBaselineYaml(normalizeEntityYaml(mockGlossaryParsed)));
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
