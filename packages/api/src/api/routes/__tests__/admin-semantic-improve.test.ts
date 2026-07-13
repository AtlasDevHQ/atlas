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
/** Rejected rows the Rejected view lists + Reconsider lifts (#4512). */
interface MockRejectedRow extends MockAmendmentRow {
  reviewed_at: string | null;
  reviewed_by: string | null;
}
let mockRejectedAmendments: MockRejectedRow[] = [];
/** Rows currently holding an `applying` claim, by id. */
let claimedRows = new Map<string, MockAmendmentRow>();
let rejectCalls: Array<{ id: string; orgId: string | null }> = [];
let reconsiderCalls: Array<{ id: string; orgId: string | null }> = [];
let releaseCalls: Array<{ id: string; reason: string | null }> = [];
let stampCalls: string[] = [];
let applyPayloadCalls: Array<Record<string, unknown>> = [];
// When true, the mocked YAML apply rejects — models the seam's compensation
// path ("approved is stamped only after a successful apply").
let applyShouldThrow = false;
// #4511 — when set, the apply raises a StaleBaselineError (hash-carried claim,
// baseline changed since render). The seam returns the `stale` outcome.
let applyStale: { diff: string; baselineHash: string } | null = null;
// #4511 — when set, the apply raises an AmbiguousEntityError carrying these
// candidate groups UNLESS a disambiguation group was threaded in (models a
// legacy cross-group-ambiguous row that the group picker resolves).
let applyAmbiguousGroups: Array<string | null> | null = null;
// #4511 — the live diff `GET /pending` renders per row. An Error value makes
// `computeAmendmentLiveDiff` throw (baseline unresolvable → null diff/hash).
let mockLiveDiff:
  | { diff: string; baselineHash: string; targetGroupId: string | null; draftExists: boolean }
  | Error = {
  diff: "--- a\n+++ b\n@@\n+live",
  baselineHash: "live-hash",
  targetGroupId: null,
  draftExists: false,
};
// Shared sequence log: proves claim → apply → stamp ordering.
let callOrder: string[] = [];

// #4511 — the real StaleBaselineError / AmbiguousEntityError are Effect/plain
// classes; the seam and the runHandler mock branch on `instanceof`, so the
// apply mock must raise the SAME class the mocked `../diff` exports and the
// runHandler mock checks. One definition, referenced everywhere.
class TestStaleBaselineError extends Error {
  readonly entityName: string;
  readonly diff: string;
  readonly baselineHash: string;
  constructor(p: { entityName: string; diff: string; baselineHash: string }) {
    super(`Entity "${p.entityName}" changed since the diff was rendered`);
    this.name = "StaleBaselineError";
    this.entityName = p.entityName;
    this.diff = p.diff;
    this.baselineHash = p.baselineHash;
  }
}
class TestAmbiguousEntityError extends Error {
  readonly entityName: string;
  readonly entityType = "entity";
  readonly groups: Array<string | null>;
  constructor(entityName: string, groups: Array<string | null>) {
    super(`Entity "${entityName}" is ambiguous across groups`);
    this.name = "AmbiguousEntityError";
    this.entityName = entityName;
    this.groups = groups;
  }
}

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  internalExecute: async () => {},
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => ({ id: "mock-amendment-id", autoApprove: false }),
  getPendingAmendmentCount: async () => 0,
  getPendingAmendments: async () => mockPendingAmendments,
  // #4514 — the briefing loader reads recent panel decisions. Empty here; the
  // dedicated briefing seam test (admin-semantic-improve-briefing.test.ts) drives
  // the turn-one + rejection-reflected behavior.
  getRecentlyDecidedAmendments: async () => [],
  getRejectedAmendments: async () => mockRejectedAmendments,
  // Atomic conditional rejected → pending flip (#4512). Models the DB: only a
  // currently-rejected row moves, and it re-enters the pending queue cleared of
  // its reviewer fields — so a subsequent GET /pending shows it "like any other".
  reconsiderRejectedAmendment: async (id: string, orgId: string | null) => {
    reconsiderCalls.push({ id, orgId });
    const idx = mockRejectedAmendments.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    const [row] = mockRejectedAmendments.splice(idx, 1);
    mockPendingAmendments.push({
      id: row.id,
      source_entity: row.source_entity,
      connection_group_id: row.connection_group_id,
      description: row.description,
      confidence: row.confidence,
      amendment_payload: row.amendment_payload,
      created_at: row.created_at,
    });
    return true;
  },
  // Atomic conditional claim: pending → applying. Synchronous state flip, so
  // two interleaved requests can never both win — mirroring the SQL's
  // conditional UPDATE. Returns the claim token stamp/release require.
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
      claimed_at: `claimed-${row.id}`,
    };
  },
  stampClaimedAmendmentApproved: async (id: string, claimedAt: string) => {
    callOrder.push("stamp");
    if (claimedAt !== `claimed-${id}`) return false;
    stampCalls.push(id);
    return claimedRows.delete(id);
  },
  releaseClaimedAmendment: async (id: string, claimedAt: string, reason: string | null) => {
    callOrder.push("release");
    if (claimedAt !== `claimed-${id}`) return false;
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
    // #4511 — a stale baseline (hash mismatch) raises StaleBaselineError; the
    // seam converts it to the `stale` outcome, never an apply.
    if (applyStale) {
      throw new TestStaleBaselineError({
        entityName: String(args.sourceEntity),
        diff: applyStale.diff,
        baselineHash: applyStale.baselineHash,
      });
    }
    // #4511 — a legacy cross-group-ambiguous row 409s UNLESS the admin picked a
    // disambiguation group (which the picker threads through).
    if (applyAmbiguousGroups && args.disambiguationGroup === undefined) {
      throw new TestAmbiguousEntityError(String(args.sourceEntity), applyAmbiguousGroups);
    }
    if (applyShouldThrow) throw new Error("yaml apply failed");
    if (!args.rawPayload) {
      throw new Error(`Amendment ${String(args.label)} has no amendment_payload — cannot apply its YAML change.`);
    }
    applyPayloadCalls.push(args);
  },
  applyAmendmentToEntity: async () => {},
  applyAmendment: () => ({}),
  applyAmendmentMutation: () => ({}),
  applyGlossaryAmendment: () => ({}),
  isGlossaryAmendmentType: (t: string) =>
    t === "add_glossary_term" || t === "update_glossary_term",
  glossaryDiffPath: () => "semantic/glossary.yml",
  analysisResultFromStoredPayload: () => ({}),
  resolveAmendmentBaseline: async () => {
    throw new Error("not used by the review route");
  },
  resolveGlossaryBaseline: async () => {
    throw new Error("not used by the review route");
  },
  GLOSSARY_DOC_NAME: "glossary",
}));

// #4511 — the live-diff module. `GET /pending` renders `computeAmendmentLiveDiff`
// output; the seam imports `StaleBaselineError` from here (must be the SAME
// class the apply mock raises so the seam's `instanceof` fires).
void mock.module("@atlas/api/lib/semantic/expert/diff", () => ({
  computeAmendmentLiveDiff: async () => {
    if (mockLiveDiff instanceof Error) throw mockLiveDiff;
    return mockLiveDiff;
  },
  StaleBaselineError: TestStaleBaselineError,
  normalizeEntityYaml: (o: Record<string, unknown>) => JSON.stringify(o),
  hashBaselineYaml: (s: string) => `hash:${s.length}`,
  computeEntityDiff: (_e: string, before: string, after: string) => `${before}=>${after}`,
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

// #4508 — the chat handler re-enters withRequestContext to stamp the agent
// origin; capture the ctx it stamps so the origin/user-binding assertions can
// read it. The route's call is the innermost, so it wins `lastRequestContext`.
let lastRequestContext: Record<string, unknown> | undefined;

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (ctx: Record<string, unknown>, fn: () => unknown) => {
      lastRequestContext = ctx;
      return fn();
    },
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
      // #4511 — mirror the real bridge's AmbiguousEntityError → 409 mapping
      // (entities.ts throws it; hono.ts maps it) so the group-picker contract is
      // testable: the response carries the candidate `groups`.
      if (err instanceof TestAmbiguousEntityError) {
        return c.json(
          {
            error: "entity_ambiguous",
            message: err.message,
            groups: err.groups,
            entityName: err.entityName,
            entityType: err.entityType,
            requestId: "test-req-id",
          },
          409,
        );
      }
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

// Mock the agent and expert registry. The chat-endpoint tests (#4508) capture
// the runAgent options to assert the persona seam and that the retired
// hardcoded `maxSteps: 15` is gone — the route now defers to runAgent's default
// (`stepCountIs(getAgentMaxSteps())`), whose workspace-knob + bounds resolution
// is pinned by agent-max-steps.test.ts and whose loop-capping is pinned by
// agent-integration.test.ts.
let runAgentArgs: Record<string, unknown> | undefined;

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: async (args: Record<string, unknown>) => {
    runAgentArgs = args;
    return {
      toUIMessageStream: () => new ReadableStream(),
    };
  },
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

import { adminSemanticImprove, isExpectedLiveDiffError } from "../admin-semantic-improve";
import { EXPERT_PERSONA_PROMPT } from "@atlas/api/lib/semantic/expert/persona";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin-semantic-improve", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockPendingAmendments = [];
    mockRejectedAmendments = [];
    claimedRows = new Map();
    rejectCalls = [];
    reconsiderCalls = [];
    releaseCalls = [];
    stampCalls = [];
    applyPayloadCalls = [];
    applyShouldThrow = false;
    applyStale = null;
    applyAmbiguousGroups = null;
    mockLiveDiff = { diff: "--- a\n+++ b\n@@\n+live", baselineHash: "live-hash", targetGroupId: null, draftExists: false };
    callOrder = [];
    runAgentArgs = undefined;
    lastRequestContext = undefined;
  });

  describe("POST /chat — expert is a mode (#4508)", () => {
    async function postChat(): Promise<Response> {
      return adminSemanticImprove.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "Improve the orders entity." }] },
          ],
        }),
      });
    }

    it("attaches CORS headers to the streamed response (raw Response bypasses the middleware)", async () => {
      // The streaming Response created by createUIMessageStreamResponse skips the
      // CORS middleware (whose queued headers only merge onto c.json/c.body), so
      // a cross-origin POST would arrive without Access-Control-Allow-Origin and
      // the browser blocks it even though the preflight passed. Regression guard
      // for the improve chat missing the corsResponseHeaders() spread chat.ts/
      // demo.ts both carry (#2037).
      const res = await adminSemanticImprove.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://app.useatlas.dev" },
        body: JSON.stringify({
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      });
      expect(res.status).toBe(200);
      // Present (either the echoed origin or the wildcard, per the resolved config).
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    });

    it("runs the expert agent with the persona in the role position, never as a warning", async () => {
      const res = await postChat();
      expect(res.status).toBe(200);

      // The expert persona is passed as the first-class ROLE section (the
      // `persona` seam), NOT smuggled into `warnings` — the model gets one
      // identity. This is the route-seam half of the "expert is a mode" fix;
      // the prompt-assembly half is agent-expert-persona-prompt.test.ts.
      expect(runAgentArgs?.persona).toBe(EXPERT_PERSONA_PROMPT);
      expect(runAgentArgs?.warnings).toBeUndefined();
    });

    it("passes no hardcoded step cap — defers to runAgent's workspace-knob default", async () => {
      const res = await postChat();
      expect(res.status).toBe(200);

      // The retired `maxSteps: 15` is gone: the route passes no override, so
      // runAgent's `stepCountIs(getAgentMaxSteps())` default governs the loop,
      // resolving the workspace agent-max-steps knob (with bounds) from the
      // active org on the request-context frame the route stamps. The knob
      // resolution itself is pinned by agent-max-steps.test.ts.
      expect(runAgentArgs?.maxSteps).toBeUndefined();
    });

    it("stamps agentOrigin 'chat' and binds the requester so origin-scoped approval rules apply", async () => {
      const res = await postChat();
      expect(res.status).toBe(200);

      // Without this frame agentOrigin is undefined and origin-scoped approval
      // rules (#2072) silently no-op for the expert agent's executeSQL. The
      // requester (approval binding) is bound from authResult.
      expect(lastRequestContext?.agentOrigin).toBe("chat");
      expect(lastRequestContext?.user).toBeDefined();
    });
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

    function review(
      id: string,
      decision: "approved" | "rejected",
      extra?: { baselineHash?: string; group?: string | null },
    ) {
      return adminSemanticImprove.request(`/amendments/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...extra }),
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

    it("approves a group-scoped glossary amendment: threads the glossary payload + group into the apply (#4518)", async () => {
      // A glossary Amendment approved through the SAME review route: the seam
      // applies from the STORED row, so the glossary payload and its Connection
      // group flow into applyAmendmentFromPayload — which writes the group's
      // glossary document (the write itself is unit-tested in
      // expert/apply-glossary.test.ts). This pins the route → decide → apply
      // path for the glossary type that used to silently no-op.
      mockPendingAmendments = [{
        id: "amd-gloss",
        source_entity: "orders",
        connection_group_id: "eu_prod",
        description: "[add_glossary_term] orders: define MRR",
        confidence: 0.9,
        amendment_payload: {
          entityName: "orders",
          amendmentType: "add_glossary_term",
          amendment: { term: "MRR", definition: "Monthly Recurring Revenue" },
          rationale: "MRR appears in columns but is not defined in the glossary.",
        },
        created_at: "2026-07-10T00:00:00Z",
      }];

      const res = await review("amd-gloss", "approved");

      expect(res.status).toBe(200);
      // Applied from the STORED row, scoped to the row's own group.
      expect(applyPayloadCalls).toHaveLength(1);
      expect(applyPayloadCalls[0]).toMatchObject({
        sourceEntity: "orders",
        connectionGroupId: "eu_prod",
        label: "amd-gloss",
      });
      // The payload the apply receives IS the glossary amendment.
      const raw = applyPayloadCalls[0].rawPayload as {
        amendmentType: string;
        amendment: { term: string };
      };
      expect(raw.amendmentType).toBe("add_glossary_term");
      expect(raw.amendment.term).toBe("MRR");
      expect(callOrder).toEqual(["claim", "apply", "stamp"]);
      expect(stampCalls).toEqual(["amd-gloss"]);
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

    // ── #4511 — hash-carried claim + stale-confirm + group picker ──────────
    it("threads the hash-carried claim + disambiguation group into the seam", async () => {
      mockPendingAmendments = [row("amd-hash")];

      const res = await review("amd-hash", "approved", { baselineHash: "h1", group: "eu_prod" });

      expect(res.status).toBe(200);
      expect(applyPayloadCalls).toHaveLength(1);
      expect(applyPayloadCalls[0]).toMatchObject({
        expectedBaselineHash: "h1",
        disambiguationGroup: "eu_prod",
      });
    });

    it("stale baseline → 409 stale_baseline carrying the fresh diff; row back to pending, no scary reason", async () => {
      mockPendingAmendments = [row("amd-stale")];
      applyStale = { diff: "--- a\n+++ b\n@@\n+region", baselineHash: "fresh-hash" };

      const res = await review("amd-stale", "approved", { baselineHash: "stale-hash" });

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        diff: string;
        baselineHash: string;
        message: string;
      };
      expect(body.error).toBe("stale_baseline");
      expect(body.diff).toContain("+region");
      expect(body.baselineHash).toBe("fresh-hash");
      expect(body.message).toContain("changed while you were reviewing");
      // Not stamped; released CLEANLY (null reason) and back in the queue.
      expect(stampCalls).toHaveLength(0);
      expect(releaseCalls).toEqual([{ id: "amd-stale", reason: null }]);
      expect(mockPendingAmendments.map((r) => r.id)).toContain("amd-stale");
    });

    it("stale-confirm: re-submitting with the FRESH hash applies (one extra click completes the flow)", async () => {
      mockPendingAmendments = [row("amd-confirm")];

      // First approve renders stale.
      applyStale = { diff: "--- a\n+++ b\n@@\n+region", baselineHash: "fresh-hash" };
      const stale = await review("amd-confirm", "approved", { baselineHash: "old-hash" });
      expect(stale.status).toBe(409);

      // The card confirms with the fresh hash; the baseline now matches.
      applyStale = null;
      const confirm = await review("amd-confirm", "approved", { baselineHash: "fresh-hash" });
      expect(confirm.status).toBe(200);
      const body = (await confirm.json()) as { ok: boolean; decision: string };
      expect(body).toMatchObject({ ok: true, decision: "approved" });
      expect(stampCalls).toEqual(["amd-confirm"]);
    });

    it("legacy cross-group-ambiguous row → 409 entity_ambiguous with candidate groups; row back to pending", async () => {
      mockPendingAmendments = [row("amd-amb")];
      applyAmbiguousGroups = ["us_prod", "eu_prod"];

      const res = await review("amd-amb", "approved");

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; groups: Array<string | null> };
      expect(body.error).toBe("entity_ambiguous");
      expect(body.groups).toEqual(["us_prod", "eu_prod"]);
      expect(stampCalls).toHaveLength(0);
      // Compensated back to pending so the picker retry can re-claim it.
      expect(mockPendingAmendments.map((r) => r.id)).toContain("amd-amb");
    });

    it("group picker retry: re-submitting with a picked group disambiguates and applies", async () => {
      mockPendingAmendments = [row("amd-pick")];
      applyAmbiguousGroups = ["us_prod", "eu_prod"];

      // No group → 409.
      const ambiguous = await review("amd-pick", "approved");
      expect(ambiguous.status).toBe(409);

      // Admin picks eu_prod → the apply is threaded the group and succeeds.
      const picked = await review("amd-pick", "approved", { group: "eu_prod" });
      expect(picked.status).toBe(200);
      expect(applyPayloadCalls).toHaveLength(1);
      expect(applyPayloadCalls[0]).toMatchObject({ disambiguationGroup: "eu_prod" });
      expect(stampCalls).toEqual(["amd-pick"]);
    });
  });

  describe("GET /pending — live diff (#4511)", () => {
    const liveRow = (id: string): MockAmendmentRow => ({
      id,
      source_entity: "orders",
      connection_group_id: null,
      description: "[add_measure] orders: total revenue",
      confidence: 0.9,
      amendment_payload: {
        entityName: "orders",
        amendmentType: "add_measure",
        amendment: { name: "total_revenue", type: "number" },
        rationale: "r",
        // A STORED propose-time diff — must NEVER be what the panel renders.
        diff: "STORED-PROPOSE-TIME-DIFF",
      },
      created_at: "2026-07-10T00:00:00Z",
    });

    it("renders the LIVE diff + baseline hash + draftExists, never the stored propose-time diff", async () => {
      mockPendingAmendments = [liveRow("amd-live")];
      mockLiveDiff = { diff: "LIVE-DIFF-AGAINST-CURRENT", baselineHash: "bh-1", targetGroupId: null, draftExists: true };

      const res = await adminSemanticImprove.request("/pending");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        amendments: Array<{ id: string; diff: string | null; baselineHash: string | null; draftExists: boolean }>;
      };
      const a = body.amendments.find((x) => x.id === "amd-live");
      expect(a?.diff).toBe("LIVE-DIFF-AGAINST-CURRENT");
      expect(a?.diff).not.toBe("STORED-PROPOSE-TIME-DIFF");
      expect(a?.baselineHash).toBe("bh-1");
      // #4517 — the draft-exists note flows through to the card.
      expect(a?.draftExists).toBe(true);
    });

    it("falls back to null diff/hash + draftExists=false (never 500) when the baseline can't be resolved (e.g. cross-group-ambiguous legacy row)", async () => {
      mockPendingAmendments = [liveRow("amd-unresolvable")];
      mockLiveDiff = new Error("Entity \"orders\" is ambiguous across groups");

      const res = await adminSemanticImprove.request("/pending");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        amendments: Array<{ id: string; diff: string | null; baselineHash: string | null; draftExists: boolean }>;
      };
      const a = body.amendments.find((x) => x.id === "amd-unresolvable");
      expect(a?.diff).toBeNull();
      expect(a?.baselineHash).toBeNull();
      expect(a?.draftExists).toBe(false);
    });
  });

  // The pure predicate behind GET /pending's log-classification (#4511): an
  // EXPECTED unresolvable row (routine — debug) vs a real read-path fault
  // (surfaced — warn). Tested directly so an inverted condition fails a test.
  describe("isExpectedLiveDiffError (#4511)", () => {
    it("treats a cross-group AmbiguousEntityError as expected (routine legacy row)", () => {
      const err = Object.assign(new Error("orders exists in 2 environments"), {
        name: "AmbiguousEntityError",
      });
      expect(isExpectedLiveDiffError(err)).toBe(true);
    });

    it("treats absent-entity / non-mapping / corrupt-payload messages as expected", () => {
      expect(isExpectedLiveDiffError(new Error('Entity "orders" not found for org x'))).toBe(true);
      expect(isExpectedLiveDiffError(new Error('parse YAML: expected a mapping'))).toBe(true);
      expect(isExpectedLiveDiffError(new Error("Corrupt amendment_payload JSON for amendment y"))).toBe(true);
      expect(isExpectedLiveDiffError(new Error("Amendment z payload is missing a valid `amendment` object"))).toBe(true);
    });

    it("treats a real read-path fault (DB outage / TypeError / non-Error) as UNEXPECTED", () => {
      expect(isExpectedLiveDiffError(new Error("connection refused: analytics DB unreachable"))).toBe(false);
      expect(isExpectedLiveDiffError(new TypeError("x is not a function"))).toBe(false);
      expect(isExpectedLiveDiffError("a bare string throw")).toBe(false);
    });
  });

  describe("GET /pending — applyError surfacing (#4506)", () => {
    it("maps the row's last_apply_error to applyError so a bounced approval is never silent", async () => {
      mockPendingAmendments = [
        {
          ...((): MockAmendmentRow => ({
            id: "amd-err",
            source_entity: "orders",
            connection_group_id: null,
            description: "[add_measure] orders: total revenue",
            confidence: 0.9,
            amendment_payload: {
              entityName: "orders",
              amendmentType: "add_measure",
              amendment: { name: "total_revenue", type: "number" },
              rationale: "r",
            },
            created_at: "2026-07-10T00:00:00Z",
          }))(),
          last_apply_error: "Version snapshot failed for entity \"orders\": versions table unavailable",
        } as MockAmendmentRow & { last_apply_error: string },
        {
          id: "amd-clean",
          source_entity: "orders",
          connection_group_id: null,
          description: null,
          confidence: 0.5,
          amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
          created_at: "2026-07-10T00:00:00Z",
        },
      ];

      const res = await adminSemanticImprove.request("/pending");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { amendments: Array<{ id: string; applyError: string | null }> };
      const byId = new Map(body.amendments.map((a) => [a.id, a]));
      expect(byId.get("amd-err")?.applyError).toContain("Version snapshot failed");
      // Rows that never bounced report null, not undefined — the wire schema
      // pins the field as nullable.
      expect(byId.get("amd-clean")?.applyError).toBeNull();
    });
  });

  describe("GET /rejected — the Rejected view (#4512)", () => {
    const rejectedRow = (id: string): MockRejectedRow => ({
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
        diff: "--- a\n+++ b\n+measure",
      },
      created_at: "2026-07-10T00:00:00Z",
      reviewed_at: "2026-07-10T01:00:00Z",
      reviewed_by: "admin",
    });

    it("lists rejected amendments with payload-derived fields + rejection metadata", async () => {
      mockRejectedAmendments = [rejectedRow("amd-r1")];

      const res = await adminSemanticImprove.request("/rejected");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        amendments: Array<{
          id: string;
          entityName: string;
          amendmentType: string | null;
          diff: string | null;
          rejectedAt: string | null;
          rejectedBy: string | null;
        }>;
      };
      expect(body.amendments).toHaveLength(1);
      const a = body.amendments[0];
      // Shares the exact payload-derivation of the Pending view (one helper).
      expect(a).toMatchObject({
        id: "amd-r1",
        entityName: "orders",
        amendmentType: "add_measure",
        diff: "--- a\n+++ b\n+measure",
        rejectedAt: "2026-07-10T01:00:00Z",
        rejectedBy: "admin",
      });
    });

    it("returns an empty list when nothing is rejected", async () => {
      mockRejectedAmendments = [];
      const res = await adminSemanticImprove.request("/rejected");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { amendments: unknown[] };
      expect(body.amendments).toEqual([]);
    });
  });

  describe("POST /amendments/:id/reconsider — lift a rejection (#4512)", () => {
    const rejectedRow = (id: string): MockRejectedRow => ({
      id,
      source_entity: "orders",
      connection_group_id: null,
      description: "[add_measure] orders: total revenue",
      confidence: 0.9,
      amendment_payload: {
        entityName: "orders",
        amendmentType: "add_measure",
        amendment: { name: "total_revenue", type: "number" },
        rationale: "r",
      },
      created_at: "2026-07-10T00:00:00Z",
      reviewed_at: "2026-07-10T01:00:00Z",
      reviewed_by: "admin",
    });

    function reconsider(id: string) {
      return adminSemanticImprove.request(`/amendments/${id}/reconsider`, { method: "POST" });
    }

    it("returns the rejected row to pending — it then appears in the Pending queue", async () => {
      mockRejectedAmendments = [rejectedRow("amd-r1")];

      const res = await reconsider("amd-r1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string };
      expect(body).toEqual({ ok: true, id: "amd-r1" });
      expect(reconsiderCalls).toEqual([{ id: "amd-r1", orgId: "org-test" }]);

      // AC #3 — the reconsidered Amendment is now in the Pending queue, rendered
      // like any other pending row (same diff/payload derivation, no applyError).
      const pending = await adminSemanticImprove.request("/pending");
      const pendingBody = (await pending.json()) as {
        amendments: Array<{ id: string; applyError: string | null }>;
      };
      expect(pendingBody.amendments.map((p) => p.id)).toContain("amd-r1");
      expect(pendingBody.amendments.find((p) => p.id === "amd-r1")?.applyError).toBeNull();
      // And it is gone from the Rejected view (removed from rejection memory).
      const rejected = await adminSemanticImprove.request("/rejected");
      const rejectedBody = (await rejected.json()) as { amendments: Array<{ id: string }> };
      expect(rejectedBody.amendments).toHaveLength(0);
    });

    it("returns 404 when the amendment is absent or not currently rejected", async () => {
      mockRejectedAmendments = [];

      const res = await reconsider("does-not-exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
      // No row moved into pending.
      expect(mockPendingAmendments).toHaveLength(0);
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
        // #4514 — loadAnalysisContext (the shared real-inputs builder the health
        // route now uses) also reads audit patterns + rejection memory.
        loadAuditPatterns: async () => [],
        loadRejectedKeys: async () => new Set(),
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
        // #4514 — loadAnalysisContext (the shared real-inputs builder the health
        // route now uses) also reads audit patterns + rejection memory.
        loadAuditPatterns: async () => [],
        loadRejectedKeys: async () => new Set(),
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
        // #4514 — loadAnalysisContext (the shared real-inputs builder the health
        // route now uses) also reads audit patterns + rejection memory.
        loadAuditPatterns: async () => [],
        loadRejectedKeys: async () => new Set(),
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
        // #4514 — loadAnalysisContext (the shared real-inputs builder the health
        // route now uses) also reads audit patterns + rejection memory.
        loadAuditPatterns: async () => [],
        loadRejectedKeys: async () => new Set(),
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
