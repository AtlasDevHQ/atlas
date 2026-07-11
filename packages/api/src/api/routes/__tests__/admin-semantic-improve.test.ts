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
let reviewedCalls: Array<{ id: string; orgId: string | null; decision: string }> = [];
let revertedIds: string[] = [];
let applyPayloadCalls: Array<Record<string, unknown>> = [];
// When true, the mocked YAML apply rejects — models the decide seam's
// claim-then-apply compensation: the claim is reverted to pending on failure.
let applyShouldThrow = false;
// Ids already claimed (conditional UPDATE moved them out of `pending`). A
// second claim for the same id returns null — the atomic-claim race loser.
let claimedIds: Set<string> = new Set();
// Shared sequence log: proves the route CLAIMS the row *before* applying YAML
// (claim-then-apply, the #4506 ordering).
let callOrder: string[] = [];

// reviewSemanticAmendment is the atomic claim/reject primitive the decide seam
// builds on: it transitions a still-`pending` row and returns it, or null when
// the row is no longer pending (not found, or already claimed by a racing
// caller). Modeled here as claim-once so "concurrent approves → one winner" is
// observable at the route seam.
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  internalExecute: async () => {},
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
  getPendingAmendments: async () => mockPendingAmendments,
  reviewSemanticAmendment: async (
    id: string,
    orgId: string | null,
    decision: "approved" | "rejected",
  ) => {
    callOrder.push("claim");
    const row = mockPendingAmendments.find((r) => r.id === id);
    if (!row || claimedIds.has(id)) return null;
    claimedIds.add(id);
    reviewedCalls.push({ id, orgId, decision });
    return {
      id: row.id,
      source_entity: row.source_entity,
      connection_group_id: row.connection_group_id,
      amendment_payload: row.amendment_payload,
    };
  },
  revertAmendmentToPending: async (id: string) => {
    revertedIds.push(id);
    // The compensating revert re-opens the row for a retry.
    claimedIds.delete(id);
    return true;
  },
}));

// The decide seam dynamically imports the YAML-apply helper. Mock it so the
// happy-path test never touches disk / the semantic layer — we only assert it
// was invoked with the claimed row after the claim. `applyAmendment` /
// `applyAmendmentToEntity` are included to keep the module mock total
// (mock-all-exports discipline) even though the seam only reaches the helper
// below.
void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentFromPayload: async (args: Record<string, unknown>) => {
    callOrder.push("apply");
    if (applyShouldThrow) throw new Error("yaml apply failed");
    applyPayloadCalls.push(args);
  },
  applyAmendmentToEntity: async () => {},
  applyAmendment: () => ({}),
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
    reviewedCalls = [];
    revertedIds = [];
    applyPayloadCalls = [];
    applyShouldThrow = false;
    claimedIds = new Set();
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

    it("approves a proposal: CLAIMS the row then applies the YAML (claim-then-apply, one identity)", async () => {
      // Group-scoped row: the seam must thread the CLAIMED row's
      // `connection_group_id` into the apply (#4498) — an interactive
      // proposeAmendment row persists the group its baseline was resolved
      // from, and dropping it here would send the apply through the
      // default-scope → unscoped-fallback path (409 on ambiguous names).
      mockPendingAmendments = [{ ...row("amd-1"), connection_group_id: "eu_prod" }];

      const res = await adminSemanticImprove.request("/amendments/amd-1/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string; decision: string };
      expect(body).toEqual({ ok: true, id: "amd-1", decision: "approved" });

      // YAML applied from the CLAIMED row's payload — scoped to the row's own
      // Connection group, never NULL for a group-scoped row.
      expect(applyPayloadCalls).toHaveLength(1);
      expect(applyPayloadCalls[0]).toMatchObject({
        sourceEntity: "orders",
        label: "amd-1",
        connectionGroupId: "eu_prod",
      });

      // The same learned_patterns row is claimed → approved — no stale pending
      // row left behind, and never reverted (apply succeeded).
      expect(reviewedCalls).toEqual([{ id: "amd-1", orgId: "org-test", decision: "approved" }]);
      expect(revertedIds).toHaveLength(0);

      // Ordering invariant: the conditional claim happens strictly BEFORE the
      // YAML apply (#4506 — claim-then-apply, not apply-then-flip).
      expect(callOrder).toEqual(["claim", "apply"]);
    });

    it("concurrent approves: exactly one applies; the loser gets a truthful already-reviewed 404 and no YAML mutation", async () => {
      // Two approves of the same amendment. The claim is atomic (claim-once), so
      // the first request wins the pending→approved transition + applies; the
      // second finds the row no longer pending and mutates nothing.
      mockPendingAmendments = [row("amd-race")];

      const first = await adminSemanticImprove.request("/amendments/amd-race/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      const second = await adminSemanticImprove.request("/amendments/amd-race/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(404);
      const loser = (await second.json()) as { error: string };
      expect(loser.error).toBe("not_found");

      // Exactly one apply, one claim, zero reverts — the loser touched no YAML.
      expect(applyPayloadCalls).toHaveLength(1);
      expect(reviewedCalls).toHaveLength(1);
      expect(revertedIds).toHaveLength(0);
    });

    it("approve wins, then a racing reject of the same id cannot un-apply or stamp it rejected", async () => {
      // Criterion 2: approve racing reject. The approve claims + applies; the
      // subsequent reject finds the row no longer pending → already-reviewed 404,
      // and must not touch the applied YAML or flip the row to rejected.
      mockPendingAmendments = [row("amd-ar")];

      const approve = await adminSemanticImprove.request("/amendments/amd-ar/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      const reject = await adminSemanticImprove.request("/amendments/amd-ar/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });

      expect(approve.status).toBe(200);
      expect(((await approve.json()) as { decision: string }).decision).toBe("approved");
      expect(reject.status).toBe(404);
      // Exactly one transition + one apply; the reject never applied or reverted.
      expect(applyPayloadCalls).toHaveLength(1);
      expect(reviewedCalls).toEqual([{ id: "amd-ar", orgId: "org-test", decision: "approved" }]);
      expect(revertedIds).toHaveLength(0);
    });

    it("reject wins, then a racing approve of the same id applies nothing", async () => {
      // The reverse ordering: reject wins the claim; the later approve finds the
      // row non-pending → 404, and never touches YAML.
      mockPendingAmendments = [row("amd-ra")];

      const reject = await adminSemanticImprove.request("/amendments/amd-ra/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      const approve = await adminSemanticImprove.request("/amendments/amd-ra/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      expect(reject.status).toBe(200);
      expect(((await reject.json()) as { decision: string }).decision).toBe("rejected");
      expect(approve.status).toBe(404);
      expect(applyPayloadCalls).toHaveLength(0);
    });

    it("approve → apply fails: 500 apply_failed and the claim is reverted to pending (never left approved-but-unapplied)", async () => {
      // Claim-then-apply: the claim stamps `approved`, the apply throws, and the
      // seam compensates by reverting the row to pending. Pin that the route
      // surfaces a truthful `apply_failed` 500 AND the row was reverted — the
      // invariant "approved means applied" holds because an unapplied row can
      // never stay approved. A snapshot failure surfaces on this exact path
      // (the apply throws when it can't take a rollback snapshot).
      mockPendingAmendments = [row("amd-3")];
      applyShouldThrow = true;

      const res = await adminSemanticImprove.request("/amendments/amd-3/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(body.error).toBe("apply_failed");
      expect(body.message).toContain("returned to the pending queue");
      expect(body.requestId).toBeDefined();
      // The claim ran, the apply ran, then the compensating revert ran.
      expect(callOrder).toEqual(["claim", "apply"]);
      expect(revertedIds).toEqual(["amd-3"]);
    });

    it("returns 404 when rejecting an absent row", async () => {
      // Reject is a single atomic transition; an absent/non-pending row returns
      // null from the claim primitive → already_reviewed → 404, no YAML.
      mockPendingAmendments = [];

      const res = await adminSemanticImprove.request("/amendments/does-not-exist/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
      expect(applyPayloadCalls).toHaveLength(0);
    });

    it("rejects a proposal: marks the row rejected without applying YAML", async () => {
      mockPendingAmendments = [row("amd-2")];

      const res = await adminSemanticImprove.request("/amendments/amd-2/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string; decision: string };
      expect(body).toEqual({ ok: true, id: "amd-2", decision: "rejected" });

      // Rejection never touches the semantic layer.
      expect(applyPayloadCalls).toHaveLength(0);
      expect(reviewedCalls).toEqual([{ id: "amd-2", orgId: "org-test", decision: "rejected" }]);
    });

    it("returns 404 when the amendment row is absent (already reviewed or wrong org)", async () => {
      mockPendingAmendments = [];

      const res = await adminSemanticImprove.request("/amendments/does-not-exist/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
      // A lost claim short-circuits before any YAML apply.
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
