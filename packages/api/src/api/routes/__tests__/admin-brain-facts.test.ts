/**
 * Route-level tests for `admin-brain-facts` (#4772).
 *
 * The read model's behaviour is pinned in `lib/brain/__tests__/candidates.test.ts`;
 * here the assertions are about THIS router — the filter guard, the deliberately
 * ambiguous retract 404, the audit row, and the two seams that would be silent
 * if they broke:
 *
 *   - the reviewer's principal context is built from `resolveEffectiveRole`,
 *     never a back-filled auth-mode default (which mints `role:admin` for every
 *     holder of a shared API key);
 *   - no audit override is ever requested, so a review queue can never become a
 *     routine workspace-wide grant bypass.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const CURRENT_ORG = "org-1";

// `resolvePrincipalContext` runs FOR REAL against this handle — the audience
// expansion is one SELECT, and letting it run is what makes the reviewer-context
// assertions below test the real wiring instead of a stub of it.
const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => INTERNAL_DB,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test-req" }) };
});

const auditRows: Array<Record<string, unknown>> = [];
void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => auditRows.push(entry),
  ADMIN_ACTIONS: { brainFact: { retract: "brain_fact.retract" } },
}));

// Records the role it was handed so a test can prove the ROLE SOURCE, which is
// otherwise invisible: passing `getUserRole` here instead would still return a
// role and still produce a working queue — just one with fabricated grants.
let effectiveRoleCalls: Array<{ userRole: unknown; userId: string; orgId: string | undefined }> = [];
/** `undefined` models the fail-closed arm `resolveEffectiveRole` takes on a DB error. */
let roleLookupResult: string | undefined = "admin";
void mock.module("@atlas/api/lib/auth/effective-role", () => ({
  resolveEffectiveRole: async (userRole: unknown, userId: string, orgId: string | undefined) => {
    effectiveRoleCalls.push({ userRole, userId, orgId });
    return roleLookupResult;
  },
}));

let listCalls: Array<Record<string, unknown>> = [];
/** Mutable so a test can make the read model emit a schema-violating payload. */
let listResponse: Record<string, unknown> = { candidates: [], total: 0, tensionsTruncated: false };
let retractResult: { id: string; invalidatedAt: string } | null = {
  id: "fact-1",
  invalidatedAt: "2026-07-01T00:00:00.000Z",
};
void mock.module("@atlas/api/lib/brain/candidates", () => ({
  CANDIDATE_PAGE_MAX: 200,
  EPISODE_BODY_MAX_CHARS: 4000,
  TENSION_FANOUT_CAP: 500,
  projectProvenance: () => ({}),
  loadFactCandidates: async (_db: unknown, options: Record<string, unknown>) => {
    listCalls.push(options);
    return listResponse;
  },
  loadFactCandidateSummary: async () => ({
    draftTotal: 2,
    provisionalTotal: 1,
    inTensionTotal: 0,
    publishedTotal: 7,
  }),
  retractFactCandidate: async () => retractResult,
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  // The real constant + body shape, so the canonical-message assertion tests
  // the router's copy rather than this file's idea of it.
  NO_ACTIVE_ORG_MESSAGE: "No active organization. Set an active org first.",
  noActiveOrgBody: (requestId: string) => ({
    error: "no_active_org",
    message: "No active organization. Set an active org first.",
    requestId,
  }),
  requireOrgContext:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
      await next();
    },
}));

// The bridge is a passthrough that provides the two Context Tags the handlers
// read. The real one's error-to-HTTP mapping is pinned in its own tests.
const { AuthContext, RequestContext } = await import("@atlas/api/lib/effect/services");
let AUTH_USER: { id: string; role?: string } | undefined = { id: "user-1", role: "member" };
// Mutable so the org-less arm each handler guards is reachable under test —
// otherwise the guard is dead code that inverting would break nothing.
let ORG_ID: string | undefined = CURRENT_ORG;
void mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: (_c: unknown, program: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(
      Effect.provide(
        program as Effect.Effect<unknown, unknown, never>,
        Layer.mergeAll(
          Layer.succeed(RequestContext, {
            requestId: "test-req",
            startTime: 0,
            atlasMode: "published" as const,
          }),
          Layer.succeed(AuthContext, {
            mode: "managed" as const,
            user: AUTH_USER as never,
            orgId: ORG_ID,
            trustDeviceIdentifier: undefined,
          }),
        ),
      ) as Effect.Effect<unknown, never, never>,
    ),
}));

const { adminBrainFacts } = await import("../admin-brain-facts");

beforeEach(() => {
  auditRows.length = 0;
  effectiveRoleCalls = [];
  roleLookupResult = "admin";
  listCalls = [];
  listResponse = { candidates: [], total: 0, tensionsTruncated: false };
  retractResult = { id: "fact-1", invalidatedAt: "2026-07-01T00:00:00.000Z" };
  AUTH_USER = { id: "user-1", role: "member" };
  ORG_ID = CURRENT_ORG;
});

const FACT_ID = "11111111-2222-4333-8444-555555555555";

describe("GET /", () => {
  it("defaults to the draft review queue", async () => {
    const res = await adminBrainFacts.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [], total: 0, tensionsTruncated: false });
    expect(listCalls[0]?.status).toBe("draft");
  });

  it("rejects a status outside the vocabulary instead of silently defaulting", async () => {
    const res = await adminBrainFacts.request("/?status=approved");
    expect(res.status).toBe(400);
    // Silently falling back to `draft` would show a reviewer a different queue
    // than the URL they are looking at claims.
    expect(listCalls).toHaveLength(0);
  });

  it("threads the narrowing filters through verbatim", async () => {
    await adminBrainFacts.request("/?status=all&provisional=true&tension=true&q=Acme");
    expect(listCalls[0]).toMatchObject({
      status: "all",
      provisionalOnly: true,
      inTensionOnly: true,
      search: "Acme",
    });
  });

  it("treats anything but `true` as off, so a typo cannot widen the queue", async () => {
    await adminBrainFacts.request("/?provisional=1&tension=yes");
    expect(listCalls[0]).toMatchObject({ provisionalOnly: false, inTensionOnly: false });
  });

  it("caps the page size at the read model's ceiling", async () => {
    await adminBrainFacts.request("/?limit=5000");
    expect(Number(listCalls[0]?.limit)).toBeLessThanOrEqual(200);
  });
});

describe("reviewer identity", () => {
  it("derives the principal set from the effective role, with the org it came from", async () => {
    await adminBrainFacts.request("/");

    expect(effectiveRoleCalls[0]).toEqual({
      userRole: "member",
      userId: "user-1",
      orgId: CURRENT_ORG,
    });
    // The resolved role reaches the read model as a real principal context —
    // `admin` from `resolveEffectiveRole`, not the `member` on the session — so
    // the queue is scoped to what this reviewer may actually see.
    expect(listCalls[0]?.ctx).toEqual({
      origin: "authenticated",
      workspaceId: CURRENT_ORG,
      userId: "user-1",
      role: "admin",
      audienceIds: [],
    });
  });

  it("skips the role lookup entirely when there is no user to resolve", async () => {
    // An authenticated mode with no user is `unresolved` — the read model
    // throws on it rather than reporting an empty queue, and the route must not
    // manufacture a role on the way there.
    AUTH_USER = undefined;
    await adminBrainFacts.request("/");

    expect(effectiveRoleCalls).toHaveLength(0);
    expect(listCalls[0]?.ctx).toMatchObject({ origin: "unresolved", userId: null });
  });

  it("refuses to serve a queue narrowed by a failed role lookup", async () => {
    // `resolveEffectiveRole` CATCHES a member-table failure and returns
    // undefined. Proceeding would drop this reviewer's `role:` tokens while
    // leaving the context `authenticated` — so the ACL still matches, no
    // BrainReaderUnresolvedError fires, and every `role:`-granted fact silently
    // vanishes from BOTH the queue and the vitals. Self-consistent, plausible,
    // and wrong.
    roleLookupResult = undefined;
    const res = await adminBrainFacts.request("/");
    expect(res.status).toBe(500);
    expect(listCalls).toHaveLength(0);
  });

  it("never requests an audit override", async () => {
    // The override is a workspace-wide grant bypass. A review queue that took
    // one by default would show an admin private-channel evidence as a matter
    // of routine — the leak this whole slice is shaped to avoid.
    await adminBrainFacts.request("/");
    expect(JSON.stringify(listCalls[0])).not.toContain("override");
  });
});

describe("response validation", () => {
  it("500s rather than shipping a payload its own wire schema rejects", async () => {
    // Without this seam the drift lands in the BROWSER as a schema_mismatch —
    // a blanked queue with no server-side trace. What matters here is that the
    // violating payload NEVER SHIPS; the 500-plus-requestId envelope is the
    // real `runEffect`'s job (stubbed in this file) and is pinned in its tests.
    listResponse = { candidates: [], total: -1, tensionsTruncated: false };
    const res = await adminBrainFacts.request("/");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("candidates");
  });
});

describe("no active organization", () => {
  it("refuses every verb rather than reading without a tenant boundary", async () => {
    ORG_ID = undefined;

    expect((await adminBrainFacts.request("/")).status).toBe(400);
    expect((await adminBrainFacts.request("/summary")).status).toBe(400);
    expect(
      (await adminBrainFacts.request(`/${FACT_ID}/retract`, { method: "POST" })).status,
    ).toBe(400);

    // Nothing reached the read model, so nothing could have been listed or
    // withdrawn across a tenant boundary that was never established.
    expect(listCalls).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("uses the canonical org-less body, with the requestId", async () => {
    // `admin-router` owns this message so it can't drift into per-handler
    // variants; dropping the requestId would break log correlation for a 400
    // the admin will actually hit.
    ORG_ID = undefined;
    const body = (await (await adminBrainFacts.request("/")).json()) as {
      message: string;
      requestId?: string;
    };
    expect(body.message).toContain("Set an active org first");
    expect(body.requestId).toBe("test-req");
  });
});

describe("GET /summary", () => {
  it("returns queue vitals", async () => {
    const res = await adminBrainFacts.request("/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draftTotal: 2,
      provisionalTotal: 1,
      inTensionTotal: 0,
      publishedTotal: 7,
    });
  });
});

describe("POST /{id}/retract", () => {
  it("retracts and records the decision in the admin action log", async () => {
    retractResult = { id: FACT_ID, invalidatedAt: "2026-07-01T00:00:00.000Z" };
    const res = await adminBrainFacts.request(`/${FACT_ID}/retract`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: FACT_ID, invalidatedAt: "2026-07-01T00:00:00.000Z" });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actionType: "brain_fact.retract",
      targetType: "brainFact",
      targetId: FACT_ID,
      // The tombstone pointer. A retraction is never a delete, so the row this
      // names is still there to be read as-of.
      metadata: { invalidatedAt: "2026-07-01T00:00:00.000Z", workspaceId: CURRENT_ORG },
    });
  });

  it("400s a malformed id instead of letting Postgres 500 on the uuid cast", async () => {
    // Otherwise an ordinary bad link lands in the same log bucket as pool
    // exhaustion, and the reviewer is told "Failed to process request".
    const res = await adminBrainFacts.request("/not-a-uuid/retract", { method: "POST" });
    expect(res.status).toBe(400);
    expect(auditRows).toHaveLength(0);
  });

  it("answers one 404 for absent, already-retracted, and not-visible alike", async () => {
    retractResult = null;
    const res = await adminBrainFacts.request(`/${FACT_ID}/retract`, { method: "POST" });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { message: string };
    // Distinguishing the three would confirm the existence of a fact this
    // reader is not allowed to know about.
    expect(body.message).toContain("may not exist");
    expect(body.message).toContain("already be retracted");
    expect(body.message).toContain("not be visible to you");
    // …and nothing was audited, because nothing happened.
    expect(auditRows).toHaveLength(0);
  });
});
