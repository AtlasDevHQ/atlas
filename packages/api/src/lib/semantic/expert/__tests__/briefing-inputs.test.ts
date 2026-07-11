/**
 * Tests for the impure briefing input loader (#4514) — the gather behind the
 * pure `assembleBriefing` seam.
 *
 * The leaf data sources (entities/glossary/audit/rejections, tracked profiles,
 * the amendment queue) are mocked; the REAL orchestration + real health +
 * analyzer + assembler run. This pins:
 *   - the health endpoint's "compute from REAL inputs" contract — profiles and
 *     audit patterns reach the AnalysisContext (not the old empty call),
 *   - tracked-profile staleness ("profiled N days ago") with no live-DB work,
 *   - the pending queue + recent panel decisions mapping,
 *   - the fail-soft `buildBriefingBlock`,
 *   - the shared health-status discriminator.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { TableProfile } from "@useatlas/types";
import type { ParsedEntity } from "../types";

let mockHasInternalDB = true;
let mockEntities: ParsedEntity[] = [];
let mockAuditPatterns: Array<{ sql: string; count: number; tables: string[]; lastSeen: string }> = [];
let mockRejectedKeys = new Set<string>();
let mockStates: Array<Record<string, unknown>> = [];
let mockBaselineProfiles: TableProfile[] = [];
let mockPending: Array<Record<string, unknown>> = [];
let mockDecided: Array<Record<string, unknown>> = [];
let profilesThrow = false;

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  getPendingAmendments: async () => mockPending,
  getRecentlyDecidedAmendments: async () => mockDecided,
}));

void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
  loadEntitiesForOrg: async () => ({ entities: mockEntities, totalRows: mockEntities.length, parseFailures: 0 }),
  loadEntitiesFromDisk: async () => mockEntities,
  loadEntitiesFromDB: async () => ({ entities: mockEntities, totalRows: mockEntities.length, parseFailures: 0 }),
  loadGlossaryFromDisk: async () => [],
  loadAuditPatterns: async () => mockAuditPatterns,
  loadRejectedKeys: async () => mockRejectedKeys,
}));

let mockBaselineNull = false;

void mock.module("@atlas/api/lib/semantic/connection-profile", () => ({
  listConnectionProfileStates: async () => {
    if (profilesThrow) throw new Error("profile state read failed");
    return mockStates;
  },
  // Return null to model a connection whose baseline profiling FAILED (payload
  // never stored) — the loader must still emit an anchor line, just no profiles.
  getBaselineProfiles: async () => (mockBaselineNull ? null : mockBaselineProfiles),
  // Deterministic freshness so the line copy is stable under test; the real
  // helper is unit-tested in connection-profile.test.ts.
  describeProfileFreshness: (iso: string | null) =>
    iso ? { days: 3, label: "profiled 3 days ago" } : null,
  // mock-all-exports: the loader imports only the three above, but the module's
  // other runtime exports must be present so a future co-import doesn't throw
  // "Export named X not found" (caught only in CI).
  upsertBaselineProfile: async () => {},
  recordBaselineError: async () => {},
  recordLlmProfileRun: async () => {},
  getConnectionProfileState: async () => null,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger };
});

import {
  loadBriefingInputs,
  loadAnalysisContext,
  loadTrackedProfiles,
  buildBriefingBlock,
  deriveHealthStatus,
} from "../briefing-inputs";

function makeEntity(overrides: Partial<ParsedEntity> = {}): ParsedEntity {
  return {
    name: "orders",
    table: "orders",
    description: "Order records",
    dimensions: [{ name: "id", sql: "id", type: "number", description: "Primary key" }],
    measures: [{ name: "count", sql: "COUNT(*)", type: "count", description: "Number of orders" }],
    joins: [],
    query_patterns: [],
    ...overrides,
  };
}

function makeProfile(table: string, columns: string[]): TableProfile {
  return {
    table_name: table,
    object_type: "table",
    row_count: 1000,
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    columns: columns.map((name) => ({
      name,
      type: "text",
      nullable: false,
      unique_count: 10,
      null_count: 0,
      sample_values: ["a"],
      is_primary_key: false,
      is_foreign_key: false,
      fk_target_table: null,
      fk_target_column: null,
      is_enum_like: false,
      profiler_notes: [],
    })),
  };
}

beforeEach(() => {
  mockHasInternalDB = true;
  mockEntities = [makeEntity()];
  mockAuditPatterns = [];
  mockRejectedKeys = new Set();
  mockStates = [];
  mockBaselineProfiles = [];
  mockPending = [];
  mockDecided = [];
  profilesThrow = false;
  mockBaselineNull = false;
});

describe("deriveHealthStatus", () => {
  it("flags corruption when every considered DB row failed to parse", () => {
    expect(deriveHealthStatus(3, 3, 0)).toBe("corrupt");
    expect(deriveHealthStatus(3, 3, 5)).toBe("corrupt"); // healthy disk mirror can't mask it
  });
  it("flags empty only when there are truly no entities", () => {
    expect(deriveHealthStatus(0, 0, 0)).toBe("no_entities");
  });
  it("is ok when entities exist and parse cleanly", () => {
    expect(deriveHealthStatus(0, 5, 5)).toBe("ok");
  });
});

describe("loadTrackedProfiles", () => {
  it("reads tracked baseline profiles + freshness lines, no live DB query", async () => {
    mockStates = [
      { installId: "us_prod", connectionGroupId: null, dbType: "postgres", baseline: { profiledAt: "2026-07-08T00:00:00Z", tableCount: 24 }, baselineError: null, llm: null },
    ];
    mockBaselineProfiles = [makeProfile("orders", ["id", "status"])];

    const { profiles, lines } = await loadTrackedProfiles("org-1", new Date("2026-07-11T00:00:00Z"));
    expect(profiles).toHaveLength(1);
    expect(lines).toEqual([
      { connection: "us_prod", dbType: "postgres", freshness: "profiled 3 days ago", tableCount: 24 },
    ]);
  });

  it("falls back to the CLI disk cache with no anchor lines when there's no internal DB", async () => {
    mockHasInternalDB = false;
    const { profiles, lines } = await loadTrackedProfiles(null, new Date());
    // The disk-cache path runs real profile-cache with no cache file present → [].
    expect(profiles).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("emits an anchor line but no profiles when a connection's baseline failed", async () => {
    // A connection whose baseline profiling failed: state present (so an anchor
    // line renders), payload null (so no profiles are pushed) — the health score
    // degrades gracefully rather than throwing.
    mockStates = [
      { installId: "eu_prod", connectionGroupId: null, dbType: "postgres", baseline: null, baselineError: "connect timeout", llm: null },
    ];
    mockBaselineNull = true;

    const { profiles, lines } = await loadTrackedProfiles("org-1", new Date("2026-07-11T00:00:00Z"));
    expect(profiles).toEqual([]);
    expect(lines).toEqual([
      { connection: "eu_prod", dbType: "postgres", freshness: null, tableCount: null },
    ]);
  });
});

describe("loadAnalysisContext — real inputs (#4514 AC4)", () => {
  it("feeds real tracked profiles + audit patterns into the AnalysisContext", async () => {
    mockStates = [
      { installId: "us_prod", connectionGroupId: null, dbType: "postgres", baseline: { profiledAt: "2026-07-08T00:00:00Z", tableCount: 1 }, baselineError: null, llm: null },
    ];
    mockBaselineProfiles = [makeProfile("orders", ["id", "status", "amount"])];
    mockAuditPatterns = [{ sql: "SELECT * FROM orders", count: 5, tables: ["orders"], lastSeen: "2026-07-01" }];

    const { ctx, totalRows, parseFailures } = await loadAnalysisContext("org-1", "published");
    // The old health call hard-coded profiles:[] and auditPatterns:[] — pin that
    // the shared builder now threads the real ones through.
    expect(ctx.profiles).toHaveLength(1);
    expect(ctx.profiles[0].columns).toHaveLength(3);
    expect(ctx.auditPatterns).toHaveLength(1);
    expect(totalRows).toBe(1);
    expect(parseFailures).toBe(0);
  });

  it("falls back to disk entities on the self-hosted / no-internal-DB path", async () => {
    // The `!orgId || !hasInternalDB()` arm: entities come from loadEntitiesFromDisk
    // and totalRows tracks the merged count (parseFailures always 0 off-DB). This
    // is the self-hosted health endpoint + bare-CLI briefing path.
    mockHasInternalDB = false;
    mockEntities = [makeEntity({ name: "a" }), makeEntity({ name: "b" })];

    const { ctx, totalRows, parseFailures } = await loadAnalysisContext(null, "published");
    expect(ctx.entities).toHaveLength(2);
    expect(totalRows).toBe(2);
    expect(parseFailures).toBe(0);
  });
});

describe("loadBriefingInputs", () => {
  it("assembles inputs from tracked profiles, the queue, and recent decisions", async () => {
    mockStates = [
      { installId: "us_prod", connectionGroupId: null, dbType: "postgres", baseline: { profiledAt: "2026-07-08T00:00:00Z", tableCount: 1 }, baselineError: null, llm: null },
    ];
    mockBaselineProfiles = [makeProfile("orders", ["id"])];
    mockRejectedKeys = new Set(["orders:add_measure:x"]);
    mockPending = [
      { id: "p1", source_entity: "orders", connection_group_id: null, description: "desc", confidence: 0.9, amendment_payload: { amendmentType: "add_measure", rationale: "revenue" }, last_apply_error: null, created_at: "2026-07-10" },
    ];
    mockDecided = [
      { id: "d1", source_entity: "customers", connection_group_id: null, amendment_payload: { amendmentType: "add_dimension" }, status: "rejected", reviewed_at: "2026-07-11" },
    ];

    const inputs = await loadBriefingInputs("org-1", new Date("2026-07-11T00:00:00Z"));

    expect(inputs.profiles).toEqual([
      { connection: "us_prod", dbType: "postgres", freshness: "profiled 3 days ago", tableCount: 1 },
    ]);
    expect(inputs.pending).toEqual([
      { entityName: "orders", amendmentType: "add_measure", confidence: 0.9, rationale: "revenue" },
    ]);
    expect(inputs.recentDecisions).toEqual([
      { entityName: "customers", amendmentType: "add_dimension", decision: "rejected" },
    ]);
    expect(inputs.rejectionMemoryCount).toBe(1);
    expect(inputs.health.entityCount).toBe(1);
    expect(inputs.healthStatus).toBe("ok");
  });

  it("maps a pending row's rationale from the payload, falling back to description", async () => {
    mockPending = [
      { id: "p1", source_entity: "orders", connection_group_id: null, description: "fallback desc", confidence: 0.5, amendment_payload: { amendmentType: "add_dimension" }, last_apply_error: null, created_at: "2026-07-10" },
    ];
    const inputs = await loadBriefingInputs("org-1", new Date("2026-07-11T00:00:00Z"));
    expect(inputs.pending[0].rationale).toBe("fallback desc");
  });

  it("tolerates a null/absent amendment payload and non-number confidence", async () => {
    mockPending = [
      // Fully null payload + non-number confidence → amendmentType null, rationale
      // falls back to description, confidence coerces to 0.
      { id: "p1", source_entity: "orders", connection_group_id: null, description: "d", confidence: "oops", amendment_payload: null, last_apply_error: null, created_at: "2026-07-10" },
    ];
    const inputs = await loadBriefingInputs("org-1", new Date("2026-07-11T00:00:00Z"));
    expect(inputs.pending).toEqual([
      { entityName: "orders", amendmentType: null, confidence: 0, rationale: "d" },
    ]);
  });
});

describe("buildBriefingBlock", () => {
  it("renders a block carrying health, the queue, tracked freshness, and a recent rejection (#4514 AC2)", async () => {
    mockStates = [
      { installId: "us_prod", connectionGroupId: null, dbType: "postgres", baseline: { profiledAt: "2026-07-08T00:00:00Z", tableCount: 1 }, baselineError: null, llm: null },
    ];
    mockBaselineProfiles = [makeProfile("orders", ["id"])];
    mockPending = [
      { id: "p1", source_entity: "orders", connection_group_id: null, description: "desc", confidence: 0.9, amendment_payload: { amendmentType: "add_measure", rationale: "revenue" }, last_apply_error: null, created_at: "2026-07-10" },
    ];
    mockDecided = [
      { id: "d1", source_entity: "customers", connection_group_id: null, amendment_payload: { amendmentType: "add_dimension" }, status: "rejected", reviewed_at: "2026-07-11" },
    ];

    const block = await buildBriefingBlock("org-1", new Date("2026-07-11T00:00:00Z"));
    expect(block).toContain("## Semantic layer briefing");
    expect(block).toContain("### Health:");
    expect(block).toContain("us_prod (postgres): profiled 3 days ago");
    expect(block).toContain("### Pending review queue (1)");
    expect(block).toContain("orders · add_measure");
    // The panel rejection is visible without any synthetic transcript message.
    expect(block).toContain("rejected: customers · add_dimension");
  });

  it("fails soft to null when a loader throws — the chat must still start", async () => {
    profilesThrow = true;
    const block = await buildBriefingBlock("org-1", new Date());
    expect(block).toBeNull();
  });
});
