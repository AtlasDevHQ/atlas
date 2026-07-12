import { describe, expect, test } from "bun:test";
import {
  LearnedPatternSchema,
  LearnedPatternsListResponseSchema,
  LearnedPatternsSummaryResponseSchema,
  AmendmentPayloadSchema,
  LEARNED_PATTERN_SORT_KEYS,
  LEARNED_PATTERN_SORT_DIRECTIONS,
} from "../learned-pattern";
import {
  LEARNED_PATTERN_STATUSES,
  LEARNED_PATTERN_SOURCES,
  LEARNED_PATTERN_TYPES,
} from "@useatlas/types";

const validPattern = {
  id: "pat-1",
  orgId: "org-1",
  connectionGroupId: null,
  patternSql: "SELECT COUNT(*) FROM orders",
  description: "Order count",
  sourceEntity: "orders",
  sourceQueries: ["audit-1"],
  confidence: 0.8,
  repetitionCount: 5,
  status: "pending" as const,
  proposedBy: "agent" as const,
  reviewedBy: null,
  reviewedByLabel: null,
  createdAt: "2026-03-18T00:00:00Z",
  updatedAt: "2026-03-18T00:00:00Z",
  reviewedAt: null,
  type: "query_pattern" as const,
  amendmentPayload: null,
  autoPromoted: false,
  avgDurationMs: null,
  injectionCount: 0,
};

const validListResponse = {
  patterns: [validPattern, { ...validPattern, id: "pat-2" }],
  total: 2,
  limit: 50,
  offset: 0,
};

describe("happy-path parses", () => {
  test("LearnedPatternSchema parses a query_pattern row", () => {
    expect(LearnedPatternSchema.parse(validPattern)).toEqual(validPattern);
  });

  test("LearnedPatternsListResponseSchema parses the list envelope", () => {
    expect(LearnedPatternsListResponseSchema.parse(validListResponse)).toEqual(
      validListResponse,
    );
  });

  test("round-trip (parse → serialize → parse) preserves fields", () => {
    const parsed = LearnedPatternSchema.parse(validPattern);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(LearnedPatternSchema.parse(serialized)).toEqual(validPattern);
  });

  test("resolves reviewer to a label and carries the connection group (#4578)", () => {
    const reviewed = {
      ...validPattern,
      reviewedBy: "user-abc",
      reviewedByLabel: "Ada Lovelace",
      connectionGroupId: "prod",
      status: "approved" as const,
      reviewedAt: "2026-03-19T00:00:00Z",
    };
    const parsed = LearnedPatternSchema.parse(reviewed);
    expect(parsed.reviewedByLabel).toBe("Ada Lovelace");
    expect(parsed.connectionGroupId).toBe("prod");
  });

  test("LearnedPatternsSummaryResponseSchema parses the cockpit summary (#4578)", () => {
    const summary = {
      stats: { total: 9, pending: 4, approved: 3, rejected: 2 },
      entities: ["customers", "orders"],
      multiGroup: true,
    };
    expect(LearnedPatternsSummaryResponseSchema.parse(summary)).toEqual(summary);
  });

  test("parses a semantic_amendment row with a structured amendmentPayload", () => {
    const amendment = {
      ...validPattern,
      id: "amd-1",
      type: "semantic_amendment" as const,
      amendmentPayload: {
        entityName: "orders",
        amendmentType: "add_measure" as const,
        amendment: { name: "total_revenue", sql: "SUM(amount)" },
        rationale: "Frequently requested aggregate.",
        diff: "+ measure: total_revenue",
        confidence: 0.9,
      },
    };
    expect(LearnedPatternSchema.parse(amendment)).toEqual(amendment);
  });
});

describe("enum-tuple coverage", () => {
  test("every LEARNED_PATTERN_STATUSES value parses", () => {
    for (const status of LEARNED_PATTERN_STATUSES) {
      expect(LearnedPatternSchema.parse({ ...validPattern, status }).status).toBe(
        status,
      );
    }
  });

  test("every LEARNED_PATTERN_SOURCES value parses", () => {
    for (const proposedBy of LEARNED_PATTERN_SOURCES) {
      expect(
        LearnedPatternSchema.parse({ ...validPattern, proposedBy }).proposedBy,
      ).toBe(proposedBy);
    }
  });

  test("every LEARNED_PATTERN_TYPES value parses", () => {
    for (const type of LEARNED_PATTERN_TYPES) {
      const row =
        type === "semantic_amendment"
          ? { ...validPattern, type, amendmentPayload: null }
          : { ...validPattern, type };
      expect(LearnedPatternSchema.parse(row).type).toBe(type);
    }
  });
});

// ---------------------------------------------------------------------------
// Drift rejection — the whole point of the migration. The cockpit page
// previously consumed this endpoint through the unvalidated table variant with
// an `as` cast, so a wire rename surfaced as a silently empty table. Pinning
// the shape here means drift fails parse and surfaces a `schema_mismatch`
// banner instead.
// ---------------------------------------------------------------------------

describe("drift rejection", () => {
  test("unknown status fails parse", () => {
    const drifted = { ...validPattern, status: "archived" };
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown proposedBy source fails parse", () => {
    const drifted = { ...validPattern, proposedBy: "cron-job" };
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("renamed pattern field (patternSql → sql) fails parse", () => {
    const { patternSql: _drop, ...rest } = validPattern;
    const drifted = { ...rest, sql: "SELECT 1" };
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("non-numeric confidence fails parse", () => {
    const drifted = { ...validPattern, confidence: "0.8" };
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("a row missing connectionGroupId fails parse (the new field is required, #4578)", () => {
    const { connectionGroupId: _drop, ...drifted } = validPattern;
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("a row missing reviewedByLabel fails parse (the new field is required, #4578)", () => {
    const { reviewedByLabel: _drop, ...drifted } = validPattern;
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("a row missing injectionCount fails parse (the new field is required, #4573)", () => {
    const { injectionCount: _drop, ...drifted } = validPattern;
    expect(LearnedPatternSchema.safeParse(drifted).success).toBe(false);
  });

  test("a negative injectionCount fails parse (a count is a non-negative int, #4573)", () => {
    expect(LearnedPatternSchema.safeParse({ ...validPattern, injectionCount: -1 }).success).toBe(false);
    expect(LearnedPatternSchema.safeParse({ ...validPattern, injectionCount: 1.5 }).success).toBe(false);
  });

  test("summary with a string count fails parse (#4578)", () => {
    const drifted = {
      stats: { total: "9", pending: 4, approved: 3, rejected: 2 },
      entities: ["orders"],
      multiGroup: false,
    };
    expect(LearnedPatternsSummaryResponseSchema.safeParse(drifted).success).toBe(false);
  });

  test("list envelope with a string total fails parse (the classic silent-empty drift)", () => {
    const drifted = { ...validListResponse, total: "2" };
    expect(LearnedPatternsListResponseSchema.safeParse(drifted).success).toBe(false);
  });

  test("list envelope with a drifted pattern element fails parse", () => {
    const drifted = {
      ...validListResponse,
      patterns: [{ ...validPattern, status: "archived" }],
    };
    expect(LearnedPatternsListResponseSchema.safeParse(drifted).success).toBe(false);
  });

  test("amendmentPayload missing a required field fails parse", () => {
    const drifted = {
      entityName: "orders",
      amendmentType: "add_measure",
      amendment: {},
      // rationale intentionally omitted
      diff: "+ measure",
      confidence: 0.5,
    };
    expect(AmendmentPayloadSchema.safeParse(drifted).success).toBe(false);
  });

  test("amendmentPayload with an unknown amendmentType fails parse", () => {
    const drifted = {
      entityName: "orders",
      amendmentType: "delete_entity",
      amendment: {},
      rationale: "x",
      diff: "y",
      confidence: 0.5,
    };
    expect(AmendmentPayloadSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("learned-pattern sort vocabulary", () => {
  test("exposes the whitelisted sort keys as the shared wire contract", () => {
    // The route's SORT_COLUMN_BY_KEY (satisfies Record<LearnedPatternSortKey,…>)
    // and the cockpit's SORT_PARAM_BY_COLUMN values both derive from this tuple;
    // pinning it here makes an accidental reorder/rename a visible change.
    expect(LEARNED_PATTERN_SORT_KEYS).toEqual(["confidence", "repetition", "latency", "created"]);
  });

  test("exposes the two sort directions", () => {
    expect(LEARNED_PATTERN_SORT_DIRECTIONS).toEqual(["asc", "desc"]);
  });
});
