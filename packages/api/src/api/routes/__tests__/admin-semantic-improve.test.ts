/**
 * Tests for admin semantic improve routes.
 *
 * Tests the DB-backed amendment review queue and the health endpoint.
 * The streaming chat endpoint requires a full agent mock and is covered
 * by browser tests.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockHasInternalDB = true;

// Mutable fixtures for the DB-backed amendment review path
// (POST /amendments/:id/review) — the route the improve UI actually calls.
// The route delegates to the REAL decide seam
// (lib/semantic/expert/decide.ts, #4506); these stateful claim-helper mocks
// model the DB's atomic conditional updates, so the race tests below exercise
// the seam's actual ordering (claim → apply → stamp) rather than a re-mocked
// approximation of it.
interface MockAmendmentRow {
  id: string;
  source_entity: string;
  connection_group_id: string | null;
  description: string | null;
  confidence: number;
  amendment_payload: Record<string, unknown> | null;
  created_at: string;
}
let mockPendingAmendments: MockAmendmentRow[] = [];
/** Rows currently holding an `applying` claim, by id. */
let claimedRows = new Map<string, MockAmendmentRow>();
let rejectCalls: Array<{ id: string; orgId: string | null }> = [];
let releaseCalls: Array<{ id: string; reason: string }> = [];
let stampCalls: string[] = [];
let applyPayloadCalls: Array<Record<string, unknown>> = [];
// When true, the mocked YAML apply rejects — models the seam's compensation
// path ("approved is stamped only after a successful apply").
let applyShouldThrow = false;
// Shared sequence log: proves claim → apply → stamp ordering.
let callOrder: string[] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  internalExecute: async () => {},
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => ({ id: "mock-amendment-id", autoApprove: false }),
  getPendingAmendmentCount: async () => 0,
  getPendingAmendments: async () => mockPendingAmendments,
  // Atomic conditional claim: pending → applying. Synchronous state flip, so
  // two interleaved requests can never both win — mirroring the SQL's
  // conditional UPDATE.
  claimPendingAmendment: async (id: string, _orgId: string | null, _claimedBy: string) => {
    callOrder.push("claim");
    const idx = mockPendingAmendments.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const [row] = mockPendingAmendments.splice(idx, 1);
    claimedRows.set(id, row);
    return {
      id: row.id,
      source_entity: row.source_entity,
      connection_group_id: row.connection_group_id,
      amendment_payload: row.amendment_payload,
    };
  },
  stampClaimedAmendmentApproved: async (id: string) => {
    callOrder.push("stamp");
    stampCalls.push(id);
    return claimedRows.delete(id);
  },
  releaseClaimedAmendment: async (id: string, reason: string) => {
    callOrder.push("release");
    releaseCalls.push({ id, reason });
    const row = claimedRows.get(id);
    if (!row) return false;
    claimedRows.delete(id);
    mockPendingAmendments.push(row);
    return true;
  },
  // Atomic conditional reject: pending → rejected. Matches zero rows once an
  // approve has claimed the row.
  rejectPendingAmendment: async (id: string, orgId: string | null, _rejectedBy: string) => {
    callOrder.push("reject");
    rejectCalls.push({ id, orgId });
    const idx = mockPendingAmendments.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    mockPendingAmendments.splice(idx, 1);
    return true;
  },
}));

// The seam dynamically imports the YAML-apply helper. Mock it so the tests
// never touch disk / the semantic layer — we assert it was invoked with the
// claimed row between claim and stamp. The mock mirrors the real contract's
// null-payload guard (unit-tested in apply-from-payload.test.ts): a missing
// payload THROWS, it is never silently skipped (#4506). `applyAmendment` /
// `resolveAmendmentBaseline` keep the module mock total (mock-all-exports).
void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentFromPayload: async (args: Record<string, unknown>) => {
    callOrder.push("apply");
    if (applyShouldThrow) throw new Error("yaml apply failed");
    if (!args.rawPayload) {
      throw new Error(`Amendment ${String(args.label)} has no amendment_payload — cannot apply its YAML change.`);
    }
    applyPayloadCalls.push(args);
  },
  applyAmendmentToEntity: async () => {},
  applyAmendment: () => ({}),
  resolveAmendmentBaseline: async () => {
    throw new Error("not used by the review route");
  },
}));

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        mode: "managed",
        label: "admin@test.dev",
        role: "admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => ({ requestId: "test-req-id" }),
  };
});

// Mirror the real runHandler's error-to-HTTP behavior closely enough to
// exercise throw paths: an uncaught throw becomes a 500 with a requestId
// envelope (the real bridge classifies further, but 500 is the fallback). This
// is transparent to the success/validation tests, which never throw.
void mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (
    c: { json: (body: unknown, status?: number) => Response },
    _label: string,
    fn: () => unknown,
  ) => {
    try {
      return await fn();
    } catch (err) {
      return c.json(
        {
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
          requestId: "test-req-id",
        },
        500,
      );
    }
  },
  runEffect: async (_c: unknown, effect: unknown) => effect,
}));

void mock.module("@atlas/api/lib/security/abuse", () => ({
  checkAbuseStatus: () => ({ level: "ok" }),
}));

void mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: async () => ({ allowed: true }),
}));

void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkPlanLimits: async () => ({ allowed: true }),
}));

// Mock the agent and expert registry (not needed for session/proposal tests)
void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: async () => ({
    toUIMessageStream: () => new ReadableStream(),
  }),
}));

void mock.module("@atlas/api/lib/tools/expert-registry", () => ({
  buildExpertRegistry: () => ({
    getAll: () => ({}),
    freeze: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { adminSemanticImprove } from "../admin-semantic-improve";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin-semantic-improve", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockPendingAmendments = [];
    claimedRows = new Map();
    rejectCalls = [];
    releaseCalls = [];
    stampCalls = [];
    applyPayloadCalls = [];
    applyShouldThrow = false;
    callOrder = [];
  });

  // The four in-memory session/proposal routes (GET /sessions,
  // GET /sessions/:id, POST /proposals/:id/approve|reject) were deleted in
  // #4503 — the removed-route guard below pins that they stay gone.

  describe("removed session routes stay removed (#4503)", () => {
    it.each([
      ["GET", "/sessions"],
      ["GET", "/sessions/00000000-0000-0000-0000-000000000000"],
      ["POST", "/proposals/0/approve"],
      ["POST", "/proposals/0/reject"],
    ])("%s %s returns 404", async (method, path) => {
      const res = await adminSemanticImprove.request(path, { method });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /amendments/:id/review — DB-backed review (the path the improve UI calls)", () => {
    // #4484: chat-streamed proposals carry the `learned_patterns` row id and
    // route through this endpoint (not the dead in-memory `/proposals/:index`
    // path). These pin the propose→approve / propose→reject happy paths that
    // no test covered before — only the 404/400 branches were exercised.
    const row = (id: string): MockAmendmentRow => ({
      id,
      source_entity: "orders",
      connection_group_id: null,
      description: "[add_measure] orders: total revenue",
      confidence: 0.9,
      amendment_payload: {
        entityName: "orders",
        amendmentType: "add_measure",
        amendment: { name: "total_revenue", type: "number" },
        rationale: "Frequently aggregated in the audit log.",
      },
      created_at: "2026-07-10T00:00:00Z",
    });

    function review(id: string, decision: "approved" | "rejected") {
      return adminSemanticImprove.request(`/amendments/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    }

    it("approves a proposal: claim → apply → stamp, one identity (#4506)", async () => {
      // Group-scoped row: the seam must thread the STORED row's
      // `connection_group_id` into the apply (#4498) — an interactive
      // proposeAmendment row persists the group its baseline was resolved
      // from, and dropping it here would send the apply through the
      // default-scope → unscoped-fallback path (409 on ambiguous names).
      mockPendingAmendments = [{ ...row("amd-1"), connection_group_id: "eu_prod" }];

      const res = await review("amd-1", "approved");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string; decision: string };
      expect(body).toEqual({ ok: true, id: "amd-1", decision: "approved" });

      // YAML applied from the STORED row's payload — scoped to the row's own
      // Connection group, never NULL for a group-scoped row.
      expect(applyPayloadCalls).toHaveLength(1);
      expect(applyPayloadCalls[0]).toMatchObject({
        sourceEntity: "orders",
        label: "amd-1",
        connectionGroupId: "eu_prod",
      });

      // Ordering invariant (#4506): the row is CLAIMED before the apply, and
      // `approved` is stamped only after the apply succeeds.
      expect(callOrder).toEqual(["claim", "apply", "stamp"]);
      expect(stampCalls).toEqual(["amd-1"]);
    });

    it("approve → YAML apply fails: 500, no stamp, row compensated back to pending with the reason", async () => {
      mockPendingAmendments = [row("amd-3")];
      applyShouldThrow = true;

      const res = await review("amd-3", "approved");

      // The throw maps to a 500 with a requestId envelope.
      expect(res.status).toBe(500);
      const body = (await res.json()) as { requestId?: string };
      expect(body.requestId).toBeDefined();
      // The load-bearing invariant: approved was never stamped, and the seam
      // compensated — the row is back in the pending queue with a visible
      // reason, not stranded in the claim state.
      expect(callOrder).toEqual(["claim", "apply", "release"]);
      expect(stampCalls).toHaveLength(0);
      expect(releaseCalls).toEqual([{ id: "amd-3", reason: "yaml apply failed" }]);
      expect(mockPendingAmendments.map((r) => r.id)).toEqual(["amd-3"]);
    });

    it("approve of a null-payload row: error response, row left pending — never a silent stamp (#4506)", async () => {
      mockPendingAmendments = [{ ...row("amd-null"), amendment_payload: null }];

      const res = await review("amd-null", "approved");

      // Pre-#4506 behavior was `if (payload)` — skip the apply, stamp
      // approved anyway. Now the apply seam throws on the missing payload and
      // the row is compensated back to pending untouched.
      expect(res.status).toBe(500);
      expect(stampCalls).toHaveLength(0);
      expect(applyPayloadCalls).toHaveLength(0);
      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0].reason).toContain("no amendment_payload");
      expect(mockPendingAmendments.map((r) => r.id)).toEqual(["amd-null"]);
    });

    it("concurrent approves of the same amendment: exactly one applies, the loser gets 404 (#4506)", async () => {
      mockPendingAmendments = [row("amd-race")];

      const [res1, res2] = await Promise.all([
        review("amd-race", "approved"),
        review("amd-race", "approved"),
      ]);

      const statuses = [res1.status, res2.status].toSorted((a, b) => a - b);
      expect(statuses).toEqual([200, 404]);
      // Exactly ONE YAML mutation and one stamp — the losing claim never
      // reaches the apply.
      expect(applyPayloadCalls).toHaveLength(1);
      expect(stampCalls).toEqual(["amd-race"]);
      const loser = res1.status === 404 ? res1 : res2;
      const loserBody = (await loser.json()) as { error: string; message: string };
      expect(loserBody.error).toBe("not_found");
      expect(loserBody.message).toContain("already reviewed");
    });

    it("approve racing reject: an applied change is never stamped rejected (#4506)", async () => {
      mockPendingAmendments = [row("amd-ar")];

      const [approveRes, rejectRes] = await Promise.all([
        review("amd-ar", "approved"),
        review("amd-ar", "rejected"),
      ]);

      // Exactly one decision wins; both responses are truthful.
      const statuses = [approveRes.status, rejectRes.status].toSorted((a, b) => a - b);
      expect(statuses).toEqual([200, 404]);
      // The two terminal states cannot coexist: either the approve claimed
      // first (apply ran, reject matched zero rows) or the reject won (no
      // apply at all). "Applied YAML + row stamped rejected" is impossible.
      if (applyPayloadCalls.length === 1) {
        expect(rejectRes.status).toBe(404);
        expect(stampCalls).toEqual(["amd-ar"]);
      } else {
        expect(applyPayloadCalls).toHaveLength(0);
        expect(approveRes.status).toBe(404);
        expect(stampCalls).toHaveLength(0);
      }
    });

    it("returns 404 when rejecting an absent row", async () => {
      mockPendingAmendments = [];

      const res = await review("does-not-exist", "rejected");

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
      expect(applyPayloadCalls).toHaveLength(0);
    });

    it("rejects a proposal: marks the row rejected without applying YAML", async () => {
      mockPendingAmendments = [row("amd-2")];

      const res = await review("amd-2", "rejected");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string; decision: string };
      expect(body).toEqual({ ok: true, id: "amd-2", decision: "rejected" });

      // Rejection never touches the semantic layer.
      expect(applyPayloadCalls).toHaveLength(0);
      expect(rejectCalls).toEqual([{ id: "amd-2", orgId: "org-test" }]);
      expect(mockPendingAmendments).toHaveLength(0);
    });

    it("returns 404 when the amendment row is absent (already reviewed or wrong org)", async () => {
      mockPendingAmendments = [];

      const res = await review("does-not-exist", "approved");

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
      // Missing target short-circuits before any YAML apply.
      expect(applyPayloadCalls).toHaveLength(0);
    });
  });

  describe("GET /health — DB vs disk source selection", () => {
    // Pin the load-bearing branch: when there's an org context + internal
    // DB the endpoint must read from `loadEntitiesForOrg` (which merges DB
    // rows with the per-org disk mirror under the same dedup `listAdminEntities`
    // applies). A refactor that flips back to a DB-only or bundled-disk source
    // would either restore the "13 entities, 100% coverage" conflation that
    // hid empty-DB SaaS workspaces from operators, or re-open the #2503
    // divergence between the Health card and the file tree it lives next to.
    let orgCalls = 0;
    let diskCalls = 0;
    beforeEach(() => {
      orgCalls = 0;
      diskCalls = 0;
      void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
        loadEntitiesForOrg: async () => {
          orgCalls++;
          return { entities: [], totalRows: 0, parseFailures: 0 };
        },
        loadEntitiesFromDisk: async () => {
          diskCalls++;
          return [];
        },
        loadGlossaryFromDisk: async () => [],
      }));
      void mock.module("@atlas/api/lib/semantic/expert/health", () => ({
        computeSemanticHealth: (ctx: { entities: unknown[]; glossary: unknown[] }) => ({
          overall: 0,
          coverage: 0,
          descriptionQuality: 0,
          measureCoverage: 0,
          joinCoverage: 0,
          // Pass through the merged entity count so the parity guard below
          // can assert it against `loadEntitiesForOrg`'s output.
          entityCount: ctx.entities.length,
          dimensionCount: 0,
          measureCount: 0,
          glossaryTermCount: ctx.glossary.length,
        }),
      }));
    });

    it("prefers loadEntitiesForOrg when org context + internal DB present", async () => {
      mockHasInternalDB = true;
      const res = await adminSemanticImprove.request("/health");
      expect(res.status).toBe(200);
      expect(orgCalls).toBe(1);
      expect(diskCalls).toBe(0);
    });

    // Note: the disk-fallback branch (`!orgId || !hasInternalDB()`) requires
    // routing past requireOrgContext which itself depends on the internal
    // DB — exercising that path needs deeper middleware mocking than this
    // suite carries. The branch is small enough that the type system + the
    // single conditional in admin-semantic-improve.ts keeps it honest; the
    // load-bearing assertion is "loadEntitiesForOrg wins when both are
    // present", above.

    it("entityCount surfaces the merged entities count, totalRows surfaces DB rows (parity with Overview)", async () => {
      // #2503: the Health card's "X entities" caption must match the count
      // the file tree above it renders. Both flow from `listAdminEntities`'s
      // DB+disk merge; `loadEntitiesForOrg` is the route's adapter to that
      // same shape. The two numbers below are deliberately distinct: 10 DB
      // rows + 36 disk-mirror entries = 46 merged entities. The route must
      // surface entityCount=46 (merged → user-facing) and totalRows=10
      // (DB-only → corrupt-discriminator denominator). A refactor that
      // collapses either side fails here first.
      mockHasInternalDB = true;
      void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
        loadEntitiesForOrg: async () => ({
          entities: Array.from({ length: 46 }, (_, i) => ({
            name: `e${i}`,
            table: `t${i}`,
            dimensions: [],
            measures: [],
            joins: [],
            query_patterns: [],
          })),
          totalRows: 10,
          parseFailures: 0,
        }),
        loadEntitiesFromDisk: async () => [],
        loadGlossaryFromDisk: async () => [],
      }));
      const res = await adminSemanticImprove.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entityCount: number; totalRows: number };
      expect(body.entityCount).toBe(46);
      expect(body.totalRows).toBe(10);
    });

    it("corrupt status still fires when disk mirror has entries but all DB rows failed parse", async () => {
      // #2503 review (silent-failure-hunter): pre-fix, the route's `corrupt`
      // discriminator compared `parseFailures === entities.length`. A
      // workspace whose every DB row was unparseable but whose disk mirror
      // had healthy entries would have `entities.length > parseFailures` →
      // status degraded to `ok`, hiding the corruption. The route now gates
      // `corrupt` on `totalRows` (DB-rows-considered), so the disk fill-in
      // can't mask the signal.
      mockHasInternalDB = true;
      void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
        loadEntitiesForOrg: async () => ({
          // 5 disk entries merged in despite all DB rows being corrupt.
          entities: Array.from({ length: 5 }, (_, i) => ({
            name: `d${i}`,
            table: `d${i}`,
            dimensions: [],
            measures: [],
            joins: [],
            query_patterns: [],
          })),
          totalRows: 3,
          parseFailures: 3,
        }),
        loadEntitiesFromDisk: async () => [],
        loadGlossaryFromDisk: async () => [],
      }));
      const res = await adminSemanticImprove.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("corrupt");
    });

    it("response includes a status discriminator distinguishing empty from corrupt", async () => {
      mockHasInternalDB = true;
      // Override loader to return totalRows=2, parseFailures=2 (full corruption)
      void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
        loadEntitiesForOrg: async () => ({ entities: [], totalRows: 2, parseFailures: 2 }),
        loadEntitiesFromDisk: async () => [],
        loadGlossaryFromDisk: async () => [],
      }));
      const res = await adminSemanticImprove.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; parseFailures: number; totalRows: number };
      expect(body.status).toBe("corrupt");
      expect(body.parseFailures).toBe(2);
      expect(body.totalRows).toBe(2);
    });
  });
});
