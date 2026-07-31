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
  ADMIN_ACTIONS: {
    brainFact: { retract: "brain_fact.retract", correct: "brain_fact.correct" },
  },
}));

// Records the role lookup so a test can prove the ROLE SOURCE, which is
// otherwise invisible: passing `getUserRole` here instead would still return a
// role and still produce a working queue — just one with fabricated grants.
//
// `reader-context.ts` (#4773) drives the STRICT resolver, so this harness models
// its contract rather than the catching one: a member-table failure THROWS
// `MemberRoleLookupError`, and a role is only a grant when `fromMemberRow`.
// Modelling the failure as `undefined` — which is what the catching resolver
// returns — would exercise a path the reader no longer has.
//
// Both exports are stubbed: `mock.module` is file-global, so a partial factory
// link-fails the moment anything in the graph reaches the missing name.
class MemberRoleLookupError extends Error {}
let effectiveRoleCalls: Array<{ userRole: unknown; userId: string; orgId: string | undefined }> = [];
/** The member row this workspace's lookup finds. `null` models "no member row". */
let memberRoleResult: string | null = "admin";
/** Set to make the member-table lookup FAIL, the arm that must refuse the read. */
let memberLookupFails = false;
void mock.module("@atlas/api/lib/auth/effective-role", () => ({
  resolveEffectiveRole: async (userRole: unknown, userId: string, orgId: string | undefined) => {
    effectiveRoleCalls.push({ userRole, userId, orgId });
    return memberLookupFails ? undefined : (memberRoleResult ?? userRole);
  },
  resolveEffectiveRoleStrict: async (
    userRole: unknown,
    userId: string,
    orgId: string | undefined,
  ) => {
    effectiveRoleCalls.push({ userRole, userId, orgId });
    if (memberLookupFails) throw new MemberRoleLookupError("member lookup failed");
    return memberRoleResult === null
      ? { role: userRole, fromMemberRow: false }
      : { role: memberRoleResult, fromMemberRow: true };
  },
  MemberRoleLookupError,
}));

let listCalls: Array<Record<string, unknown>> = [];
/** Mutable so a test can make the read model emit a schema-violating payload. */
let listResponse: Record<string, unknown> = { candidates: [], total: 0, tensionsTruncated: false };
void mock.module("@atlas/api/lib/brain/candidates", () => ({
  CANDIDATE_PAGE_MAX: 200,
  EPISODE_BODY_MAX_CHARS: 4000,
  TENSION_FANOUT_CAP: 500,
  // SQL fragments, not behaviour — but they must be listed all the same:
  // `mock.module` is file-global, so a partial factory link-fails the moment
  // anything in the graph imports a name this object omits.
  PROVISIONAL_PREDICATE: "(TRUE)",
  TENSION_EXISTS_SELECT: "(TRUE)",
  // The module's re-export — listed so a future importer of it through
  // `candidates` doesn't hit the partial-mock landmine.
  BrainReaderUnresolvedError: class BrainReaderUnresolvedError extends Error {},
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
}));

/**
 * The verb machinery (#4915), stubbed on the same terms as the read model: the
 * route's own obligations — the UUID guard, outcome→HTTP mapping, the audit
 * row, the wire parse — are what these tests exercise. The verbs' semantics
 * are pinned in `lib/brain/__tests__/correction.test.ts` against a fake store
 * and in `candidates-pg.test.ts` §7 against the live schema.
 */
const REFUSAL_REASONS = {
  notAuthorized: "NOT_AUTHORIZED",
  warehouseTarget: "WAREHOUSE_TARGET",
  targetNotPublished: "TARGET_NOT_PUBLISHED",
  validityAlreadyClosed: "VALIDITY_ALREADY_CLOSED",
  replacementMissing: "REPLACEMENT_MISSING",
  replacementIdentical: "REPLACEMENT_IDENTICAL",
  replacementUnpublishable: "REPLACEMENT_UNPUBLISHABLE",
} as const;
let correctCalls: Array<Record<string, unknown>> = [];
let correctionOutcome: Record<string, unknown> = {
  kind: "corrected",
  result: {
    verb: "retract",
    factId: "fact-1",
    correctionEpisodeId: "ep-corr-1",
    invalidatedAt: "2026-07-01T00:00:00.000Z",
    flaggedForReReview: [],
    supersededBy: null,
    validTo: null,
  },
};
void mock.module("@atlas/api/lib/brain/correction", () => ({
  CORRECTION_VERBS: ["retract", "supersede", "re-authority", "pin"],
  CORRECTION_REFUSAL_REASONS: REFUSAL_REASONS,
  CorrectionRefusedError: class CorrectionRefusedError extends Error {},
  CORRECTION_EPISODE_INSERT_SQL: "INSERT",
  RETRACT_FACT_SQL: "UPDATE",
  DERIVES_FROM_EDGE_SQL: "INSERT",
  DEPENDENT_FACTS_SQL: "SELECT",
  MERGE_PROVENANCE_MARKER_SQL: "UPDATE",
  PROMOTE_CORRECTION_FACT_SQL: "UPDATE",
  REPLACEMENT_ROW_SQL: "SELECT",
  correctionTargetSql: () => "SELECT",
  isWarehouseDerived: () => false,
  correctFact: async (request: Record<string, unknown>) => {
    correctCalls.push(request);
    return correctionOutcome;
  },
}));

/**
 * The oversight aggregate, stubbed so the ROUTE's own obligations are what these
 * tests exercise: that it resolves a reader context at all, and that it runs the
 * payload through `checked()` before it goes out. The aggregate's own rules —
 * which tokens may be named, the ordinals, the SQL — are pinned in
 * `lib/brain/__tests__/oversight.test.ts` against the real module.
 *
 * Mutable so a test can make the read model emit a payload the wire schema must
 * refuse; that is the only way to prove `checked()` is load-bearing here rather
 * than decorative.
 */
let oversightResponse: Record<string, unknown> = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 0,
    published: 0,
    retracted: 0,
    provisional: 0,
    inTension: 0,
  },
  reviewableAwaitingReview: 0,
  bucketsTruncated: false,
};
let oversightCalls = 0;
/** The principal context the route handed the aggregate — see the test below. */
let oversightCtx: unknown;
/** The will-supersede half (#4912), stubbed on the same terms as the counts. */
let supersessionPreviewResponse: Record<string, unknown> = {
  total: 0,
  pairs: [],
  withheld: 0,
  truncated: false,
};
let supersessionPreviewCalls = 0;
let supersessionPreviewCtx: unknown;
// EVERY named export, not just the two this route reaches: `mock.module` is
// file-global, so a partial factory link-fails the moment anything else in the
// graph imports one of the omitted names.
void mock.module("@atlas/api/lib/brain/oversight", () => ({
  OVERSIGHT_BUCKET_MAX: 200,
  OVERSIGHT_INSTALL_CONFIGS_SQL: "SELECT config FROM workspace_plugins",
  OVERSIGHT_BUCKETS_SQL: "SELECT token FROM brain_facts",
  OVERSIGHT_TOTALS_SQL: "SELECT 1 FROM brain_facts",
  OVERSIGHT_DISTINCT_TOKENS_SQL: "SELECT 1 FROM brain_facts",
  WILL_SUPERSEDE_PAIR_MAX: 100,
  WILL_SUPERSEDE_TOTAL_SQL: "SELECT 1 FROM brain_facts",
  willSupersedePairsSql: () => "SELECT 1 FROM brain_facts",
  loadConfiguredChannels: async () => new Map(),
  classifyToken: () => ({ kind: "org", labelPolicy: "intrinsic" }),
  loadFactOversight: async (_db: unknown, ctx: unknown) => {
    oversightCalls++;
    oversightCtx = ctx;
    return oversightResponse;
  },
  loadSupersessionPreview: async (_db: unknown, ctx: unknown) => {
    supersessionPreviewCalls++;
    supersessionPreviewCtx = ctx;
    return supersessionPreviewResponse;
  },
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
  memberRoleResult = "admin";
  memberLookupFails = false;
  listCalls = [];
  listResponse = { candidates: [], total: 0, tensionsTruncated: false };
  correctCalls = [];
  correctionOutcome = {
    kind: "corrected",
    result: {
      verb: "retract",
      factId: "fact-1",
      correctionEpisodeId: "ep-corr-1",
      invalidatedAt: "2026-07-01T00:00:00.000Z",
      flaggedForReReview: [],
      supersededBy: null,
      validTo: null,
    },
  };
  AUTH_USER = { id: "user-1", role: "member" };
  ORG_ID = CURRENT_ORG;
  oversightCalls = 0;
  oversightCtx = undefined;
  supersessionPreviewCalls = 0;
  supersessionPreviewCtx = undefined;
  supersessionPreviewResponse = { total: 0, pairs: [], withheld: 0, truncated: false };
  oversightResponse = {
    buckets: [],
    workspaceTotals: {
      awaitingReview: 0,
      published: 0,
      retracted: 0,
      provisional: 0,
      inTension: 0,
    },
    reviewableAwaitingReview: 0,
    countsConsistent: true,
    distinctAudiences: 0,
    bucketsTruncated: false,
  };
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

    // The session role is deliberately NOT passed: the reader asks the member
    // table one narrow question about THIS workspace, so a session role could
    // only give the resolver other ways to answer it (a `platform_admin`
    // short-circuit, a no-member-row fallback) that this surface must not trust.
    expect(effectiveRoleCalls[0]).toEqual({
      userRole: undefined,
      userId: "user-1",
      orgId: CURRENT_ORG,
    });
    // The resolved role reaches the read model as a real principal context —
    // `admin` from the member table, not the `member` on the session — so the
    // queue is scoped to what this reviewer may actually see.
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

  it("refuses to serve a queue narrowed by a FAILED role lookup", async () => {
    // Proceeding would drop this reviewer's `role:` tokens while leaving the
    // context `authenticated` — so the ACL still matches, no
    // BrainReaderUnresolvedError fires, and every `role:`-granted fact silently
    // vanishes from BOTH the queue and the vitals. Self-consistent, plausible,
    // and wrong.
    memberLookupFails = true;
    const res = await adminBrainFacts.request("/");
    expect(res.status).toBe(500);
    expect(listCalls).toHaveLength(0);
  });

  it("serves the queue with NO role grants when the reviewer has no member row", async () => {
    // Distinct from the failure above, and the distinction is the point: "this
    // user is not a member here" is an answer, "the lookup broke" is not. The
    // first narrows correctly, the second must refuse.
    memberRoleResult = null;
    const res = await adminBrainFacts.request("/");
    expect(res.status).toBe(200);
    expect(listCalls[0]?.ctx).toMatchObject({ origin: "authenticated", role: null });
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
    expect((await adminBrainFacts.request("/oversight")).status).toBe(400);
    expect(
      (await adminBrainFacts.request(`/${FACT_ID}/retract`, { method: "POST" })).status,
    ).toBe(400);

    // Nothing reached the read model, so nothing could have been listed or
    // withdrawn across a tenant boundary that was never established.
    expect(listCalls).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
    // `/oversight` counts WITHOUT a reader predicate, so an org-less request
    // reaching it would count some other tenant's facts — the one verb here
    // where a missing tenant boundary is a cross-tenant read rather than an
    // empty one.
    expect(oversightCalls).toBe(0);
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

describe("GET /oversight", () => {
  it("serves per-audience counts alongside this reader's own reviewable total", async () => {
    oversightResponse = {
      buckets: [
        {
          key: "org",
          kind: "org",
          label: "org",
          labelPolicy: "intrinsic",
          awaitingReview: 26,
          published: 40,
          retracted: 2,
          provisional: 3,
          inTension: 1,
        },
        {
          key: "discovered-1",
          kind: "audience",
          labelPolicy: "discovered",
          awaitingReview: 6,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      workspaceTotals: {
        awaitingReview: 32,
        published: 40,
        retracted: 2,
        provisional: 3,
        inTension: 1,
      },
      reviewableAwaitingReview: 26,
      countsConsistent: true,
      distinctAudiences: 2,
      bucketsTruncated: false,
    };

    const res = await adminBrainFacts.request("/oversight");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof oversightResponse;
    // The 26/32 soak reading. The delta IS the disclosure, and it survives the
    // route: a response that flattened the two into one number would restore
    // exactly the false all-clear #4825 recorded.
    expect(body.reviewableAwaitingReview).toBe(26);
    expect((body.workspaceTotals as { awaitingReview: number }).awaitingReview).toBe(32);
  });

  it("merges the will-supersede disclosure into the same response (#4912)", async () => {
    // The strict schema REQUIRES the section, so a route that stopped merging
    // it would 500 rather than quietly retire the disclosure — but the happy
    // path is pinned too: the pairs must actually ship.
    supersessionPreviewResponse = {
      total: 2,
      pairs: [
        {
          draftId: "d1",
          draftLabel: "alice manager bob",
          supersededId: "o1",
          supersededLabel: "alice manager carol",
        },
      ],
      withheld: 1,
      truncated: false,
    };
    const res = await adminBrainFacts.request("/oversight");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { willSupersede: unknown };
    expect(body.willSupersede).toEqual(supersessionPreviewResponse);
    expect(supersessionPreviewCalls).toBe(1);
  });

  it("hands the will-supersede loader the SAME reviewer context as the counts", async () => {
    // The pair labels are content, and the reader context is what scopes them.
    // A route that resolved a second, wider context for this half would hand
    // the disclosure claims the queue itself refuses to show.
    await adminBrainFacts.request("/oversight");
    expect(supersessionPreviewCtx).toEqual(oversightCtx);
    expect(JSON.stringify(supersessionPreviewCtx)).not.toContain("override");
  });

  it("hands the aggregate the reviewer's OWN member-table context", async () => {
    // `reviewableAwaitingReview` is the denominator of the entire disclosure. A
    // route that passed a fabricated or over-broad context — the session role
    // instead of the member-table one, or a context carrying an audit override
    // — would make the scoped count equal the unscoped one and collapse the
    // delta to zero. Self-consistent, plausible, and the exact defect #4825
    // records. Same pin the list route carries, for the same reason.
    await adminBrainFacts.request("/oversight");
    expect(oversightCtx).toEqual({
      origin: "authenticated",
      workspaceId: CURRENT_ORG,
      userId: "user-1",
      role: "admin",
      audienceIds: [],
    });
    expect(JSON.stringify(oversightCtx)).not.toContain("override");
  });

  it("refuses to serve counts narrowed by a FAILED role lookup", async () => {
    // Same posture as the queue: a broken member lookup would produce a
    // plausible `reviewableAwaitingReview` that silently omitted every
    // `role:`-granted draft, making the hidden-backlog delta overstate itself
    // for what is really an infrastructure fault.
    memberLookupFails = true;
    const res = await adminBrainFacts.request("/oversight");
    expect(res.status).toBe(500);
    expect(oversightCalls).toBe(0);
  });

  it("500s rather than shipping a bucket carrying a claim", async () => {
    // THE no-content pin at the route seam. `BrainFactOversightSchema` is
    // `z.strictObject` precisely so an extra key is refused rather than
    // stripped — stripping would ship a response that silently dropped the
    // field in one direction and carried it the day somebody widened the type.
    oversightResponse = {
      ...oversightResponse,
      buckets: [
        {
          key: "org",
          kind: "org",
          label: "org",
          labelPolicy: "intrinsic",
          awaitingReview: 1,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
          subject: "Acme",
          predicate: "uses",
          object: "Snowflake",
        },
      ],
    };
    const res = await adminBrainFacts.request("/oversight");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("Snowflake");
    expect(text).not.toContain("Acme");
  });

  it("500s rather than shipping a `countsConsistent` that contradicts its own operands", async () => {
    // The refinement's probe. Both operands travel beside the flag, and the
    // panel trusts the FLAG while computing the delta from the NUMBERS — so a
    // producer that got the flag wrong renders "-4 drafts are not in your
    // queue". A guard with no probe is one refactor from gone (#4809).
    oversightResponse = {
      ...oversightResponse,
      workspaceTotals: {
        awaitingReview: 5,
        published: 0,
        retracted: 0,
        provisional: 0,
        inTension: 0,
      },
      reviewableAwaitingReview: 9,
      countsConsistent: true,
    };
    expect((await adminBrainFacts.request("/oversight")).status).toBe(500);
  });

  it("500s rather than shipping fewer audiences than buckets", async () => {
    // The other refinement. The buckets ARE a subset of the distinct tokens, so
    // a smaller cardinality understates a number the client renders as exact.
    oversightResponse = {
      ...oversightResponse,
      buckets: [
        {
          key: "org",
          kind: "org",
          label: "org",
          labelPolicy: "intrinsic",
          awaitingReview: 1,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
      distinctAudiences: 0,
    };
    expect((await adminBrainFacts.request("/oversight")).status).toBe(500);
  });

  it("500s rather than shipping a withheld bucket that carries its label", async () => {
    // The discriminated union's whole purpose, at the wire. `discovered` means
    // the token must not travel — a producer that regressed to a flat
    // `label: string | null` and forgot to null it would disclose the private
    // channel this surface just refused to name.
    oversightResponse = {
      ...oversightResponse,
      buckets: [
        {
          key: "discovered-1",
          kind: "audience",
          labelPolicy: "discovered",
          label: "audience:chat-channel:slack:C0SECRET99",
          awaitingReview: 6,
          published: 0,
          retracted: 0,
          provisional: 0,
          inTension: 0,
        },
      ],
    };
    const res = await adminBrainFacts.request("/oversight");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("C0SECRET99");
  });
});

describe("POST /{id}/retract", () => {
  it("runs the retract CORRECTION verb and records the decision in the admin action log", async () => {
    correctionOutcome = {
      kind: "corrected",
      result: {
        verb: "retract",
        factId: FACT_ID,
        correctionEpisodeId: "ep-corr-9",
        invalidatedAt: "2026-07-01T00:00:00.000Z",
        flaggedForReReview: ["dep-1"],
        supersededBy: null,
        validTo: null,
      },
    };
    const res = await adminBrainFacts.request(`/${FACT_ID}/retract`, { method: "POST" });
    expect(res.status).toBe(200);
    // The wire shape is unchanged by the #4915 unification — the richer
    // correction payload is `/correct`'s; this route keeps its contract.
    expect(await res.json()).toEqual({ id: FACT_ID, invalidatedAt: "2026-07-01T00:00:00.000Z" });

    // One code path, not two: the route called the verb machinery.
    expect(correctCalls).toHaveLength(1);
    expect(correctCalls[0]).toMatchObject({ factId: FACT_ID, verb: "retract" });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actionType: "brain_fact.retract",
      targetType: "brainFact",
      targetId: FACT_ID,
      // The tombstone pointer. A retraction is never a delete, so the row this
      // names is still there to be read as-of.
      metadata: {
        invalidatedAt: "2026-07-01T00:00:00.000Z",
        workspaceId: CURRENT_ORG,
        correctionEpisodeId: "ep-corr-9",
        flaggedForReReview: ["dep-1"],
      },
    });
  });

  it("400s a malformed id instead of letting Postgres 500 on the uuid cast", async () => {
    // Otherwise an ordinary bad link lands in the same log bucket as pool
    // exhaustion, and the reviewer is told "Failed to process request".
    const res = await adminBrainFacts.request("/not-a-uuid/retract", { method: "POST" });
    expect(res.status).toBe(400);
    expect(correctCalls).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("answers one 404 for absent, already-retracted, and not-visible alike", async () => {
    correctionOutcome = { kind: "not-found" };
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

  it("409s a warehouse-derived target with the machinery's actionable prose", async () => {
    correctionOutcome = {
      kind: "refused",
      reason: REFUSAL_REASONS.warehouseTarget,
      message: "This fact is warehouse-derived — fix the data or the semantic layer.",
    };
    const res = await adminBrainFacts.request(`/${FACT_ID}/retract`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("semantic layer");
    expect(auditRows).toHaveLength(0);
  });
});

describe("POST /{id}/correct", () => {
  const correct = (body: Record<string, unknown>) =>
    adminBrainFacts.request(`/${FACT_ID}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("applies a verb and ships the correction payload through the wire schema", async () => {
    correctionOutcome = {
      kind: "corrected",
      result: {
        verb: "supersede",
        factId: FACT_ID,
        correctionEpisodeId: "ep-corr-2",
        invalidatedAt: null,
        flaggedForReReview: [],
        supersededBy: "fact-new-1",
        validTo: "2026-07-30T12:00:00.000Z",
      },
    };
    const res = await correct({
      verb: "supersede",
      reason: "Ana left",
      replacement: { object: "Bo" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      verb: "supersede",
      factId: FACT_ID,
      correctionEpisodeId: "ep-corr-2",
      invalidatedAt: null,
      flaggedForReReview: [],
      supersededBy: "fact-new-1",
      validTo: "2026-07-30T12:00:00.000Z",
    });

    expect(correctCalls[0]).toMatchObject({
      factId: FACT_ID,
      verb: "supersede",
      reason: "Ana left",
      replacement: { object: "Bo" },
    });

    // The non-retract verbs share the `correct` audit action, verb in metadata.
    expect(auditRows[0]).toMatchObject({
      actionType: "brain_fact.correct",
      targetType: "brainFact",
      targetId: FACT_ID,
      metadata: {
        verb: "supersede",
        workspaceId: CURRENT_ORG,
        correctionEpisodeId: "ep-corr-2",
        supersededBy: "fact-new-1",
        validTo: "2026-07-30T12:00:00.000Z",
      },
    });
  });

  it("a retract through /correct audits as brain_fact.retract — one verb, one audit vocabulary", async () => {
    const res = await correct({ verb: "retract" });
    expect(res.status).toBe(200);
    expect(auditRows[0]).toMatchObject({ actionType: "brain_fact.retract" });
  });

  it("400s an unknown verb at the schema, before the machinery runs", async () => {
    const res = await correct({ verb: "obliterate" });
    expect(res.status).toBe(400);
    expect(correctCalls).toHaveLength(0);
  });

  it("400s a malformed id instead of letting Postgres 500 on the uuid cast", async () => {
    const res = await adminBrainFacts.request("/not-a-uuid/correct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verb: "pin" }),
    });
    expect(res.status).toBe(400);
    expect(correctCalls).toHaveLength(0);
  });

  it("maps refusals onto their HTTP classes: 403 authority, 400 request shape, 409 target state", async () => {
    const cases: Array<{ reason: string; status: number }> = [
      { reason: REFUSAL_REASONS.notAuthorized, status: 403 },
      { reason: REFUSAL_REASONS.replacementMissing, status: 400 },
      { reason: REFUSAL_REASONS.replacementIdentical, status: 400 },
      { reason: REFUSAL_REASONS.warehouseTarget, status: 409 },
      { reason: REFUSAL_REASONS.targetNotPublished, status: 409 },
      { reason: REFUSAL_REASONS.validityAlreadyClosed, status: 409 },
      { reason: REFUSAL_REASONS.replacementUnpublishable, status: 409 },
    ];
    for (const { reason, status } of cases) {
      auditRows.length = 0;
      correctionOutcome = { kind: "refused", reason, message: "why, and what to do instead" };
      const res = await correct({ verb: "supersede", replacement: { object: "Bo" } });
      expect(res.status).toBe(status);
      // A refusal is not a correction; nothing may be audited as one.
      expect(auditRows).toHaveLength(0);
    }
  });

  it("answers the same indistinguishable 404 as /retract", async () => {
    correctionOutcome = { kind: "not-found" };
    const res = await correct({ verb: "pin" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("may not exist");
  });

  it("refuses to ship a correction payload that violates its own wire schema", async () => {
    // Same `checked()` posture as the list route: a machinery result the
    // schema refuses must become a 500, never reach the browser.
    correctionOutcome = {
      kind: "corrected",
      result: {
        verb: "pin",
        factId: FACT_ID,
        correctionEpisodeId: "ep-corr-3",
        invalidatedAt: 42, // not a string|null — the violation
        flaggedForReReview: [],
        supersededBy: null,
        validTo: null,
      },
    };
    const res = await correct({ verb: "pin" });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("ep-corr-3");
  });
});
