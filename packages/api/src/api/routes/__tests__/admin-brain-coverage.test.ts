/**
 * Route-level tests for `admin-brain-coverage` (#5215, ADR-0041).
 *
 * The composition's own honesty rules are pinned against fixtures in
 * `lib/brain/__tests__/coverage.test.ts`, and the wire schema's refusals in
 * `packages/schemas/src/__tests__/brain-coverage.test.ts`. What is asserted HERE
 * is the four things this router owns, each of which would be silent if it
 * broke:
 *
 *   - **A statement Atlas cannot stand behind never ships.** The response is
 *     parsed through `BrainCoverageSchema` on the way out, so a producer whose
 *     freshness tally under-reports how much of a class is stale — or whose
 *     denominator is not its own two states — is a 500 here rather than a page
 *     rendering the flattering reading of its own disagreement.
 *   - **The one false-all-clear reaches the client as a failure.** A class that
 *     declares an enumerable universe but holds no roster in this deploy makes
 *     `loadCoverage` throw. A route that swallowed it would serve a coverage
 *     statement with a whole class quietly missing, which is the exact shape
 *     ADR-0041 refuses.
 *   - **No tenant boundary, no read.** Without an active org the route answers
 *     400 and never reaches the loader — a coverage statement composed across
 *     an unestablished boundary is worse than none.
 *   - **The reader identity is re-resolved, and a failed resolution refuses.**
 *     The authority arm carries one reader-scoped number; serving the workspace
 *     shape to a session Atlas could not identify is `admin-brain-facts.ts`'s
 *     refusal, and it must hold on this door too.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { validationHook } from "../validation-hook";

const CURRENT_ORG = "org-coverage";

const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async () => [] as unknown[],
  }),
  getInternalDB: () => INTERNAL_DB,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: noop,
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

let readerResolveFails = false;
class TestBrainReaderIdentityError extends Error {}
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError: TestBrainReaderIdentityError,
  BrainReaderUnresolvedError: class extends TestBrainReaderIdentityError {},
  BrainRoleUnresolvedError: class extends TestBrainReaderIdentityError {},
  resolveBrainReaderContext: async () => {
    if (readerResolveFails) throw new TestBrainReaderIdentityError("role lookup broke");
    return {
      origin: "authenticated" as const,
      workspaceId: CURRENT_ORG,
      userId: "user-1",
      role: "admin" as const,
      audienceIds: [] as readonly string[],
    };
  },
}));

/** The loader is the seam. Its own composition is tested against fixtures. */
let loadCalls: { workspaceId: string; requestId: string | undefined }[] = [];
let coverageResult: () => unknown = () => healthyCoverage();
class TestCoverageCompositionError extends Error {}
void mock.module("@atlas/api/lib/brain/coverage", () => ({
  COVERAGE_UNITS_MAX: 200,
  CoverageCompositionError: TestCoverageCompositionError,
  loadCoverage: async (
    _db: unknown,
    ctx: { workspaceId: string },
    requestId?: string,
  ): Promise<unknown> => {
    loadCalls.push({ workspaceId: ctx.workspaceId, requestId });
    return coverageResult();
  },
}));

const { AuthContext, RequestContext } = await import("@atlas/api/lib/effect/services");
let ORG_ID: string | undefined = CURRENT_ORG;
void mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: (_c: unknown, program: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(
      Effect.provide(
        program,
        Layer.mergeAll(
          Layer.succeed(RequestContext, {
            requestId: "test-req",
            startTime: 0,
            atlasMode: "published" as const,
          }),
          Layer.succeed(AuthContext, {
            mode: "managed" as const,
            user: { id: "user-1", role: "admin" } as never,
            orgId: ORG_ID,
            trustDeviceIdentifier: undefined,
          }),
        ),
      ) as Effect.Effect<unknown, never, never>,
    ),
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono({ defaultHook: validationHook }),
  createPlatformRouter: () => new OpenAPIHono({ defaultHook: validationHook }),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  enforcePermission: async () => null,
  NO_INTERNAL_DB_MESSAGE: "No internal database configured.",
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

const AUTHORITY = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 4,
    published: 12,
    retracted: 1,
    provisional: 2,
    inTension: 0,
  },
  reviewableAwaitingReview: 3,
  countsConsistent: true,
  distinctAudiences: 0,
  bucketsTruncated: false,
};

function chatArm() {
  return {
    state: "enumerated",
    asOf: "2026-08-19T02:00:00.000Z",
    ratio: {
      surveyed: 1,
      enumerated: 1,
      enumerable: 2,
      inPerimeterWithoutEvidence: 0,
      unit: "chat-channel-roster",
    },
    freshness: { current: 1, stale: 0, unverified: 0 },
    units: [
      {
        state: "surveyed",
        unitId: "C0001",
        label: "#general",
        clause: "vendor-public",
        newestEvidenceAt: "2026-08-18T09:00:00.000Z",
        freshness: { kind: "current", checkedAt: "2026-08-19T01:00:00.000Z" },
      },
    ],
    unitsWithheld: 1,
    unitsTruncated: false,
    mapEdges: ["chat-public-roster-truncated"],
    unavailable: null,
  };
}

function healthyCoverage(overrides: Record<string, unknown> = {}) {
  return {
    availability: {
      chat: chatArm(),
      transcript: {
        state: "never-enumerated",
        reason: "no-cycle-recorded",
        lastAttemptAt: null,
        unavailableReason: null,
      },
      email: {
        state: "never-enumerated",
        reason: "no-successful-cycle",
        lastAttemptAt: "2026-08-19T02:00:00.000Z",
        unavailableReason: "Microsoft Graph refused the mailbox listing.",
      },
      warehouse: {
        state: "enumerated",
        asOf: "2026-08-19T02:00:00.000Z",
        ratio: {
          surveyed: 3,
          enumerated: 5,
          enumerable: 8,
          inPerimeterWithoutEvidence: 2,
          unit: "semantic-layer-enrollment",
        },
        freshness: { current: 0, stale: 0, unverified: 3 },
        units: [],
        unitsWithheld: 8,
        unitsTruncated: false,
        mapEdges: [],
        unavailable: null,
      },
      human: { state: "not-surveyable", reason: "non-surveyable-class" },
      ...(overrides.availability as Record<string, unknown> | undefined),
    },
    authority: AUTHORITY,
    countsConsistent: true,
  };
}

const { adminBrainCoverage } = await import("../admin-brain-coverage");

beforeEach(() => {
  ORG_ID = CURRENT_ORG;
  readerResolveFails = false;
  loadCalls = [];
  coverageResult = () => healthyCoverage();
});

describe("GET /", () => {
  it("serves both arms, with every class accounted for and the map edges intact", async () => {
    const res = await adminBrainCoverage.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof healthyCoverage>;

    // Totality is the property this surface is keyed on: a class with nothing
    // to say and a class silently absent are opposite statements.
    expect(Object.keys(body.availability).sort()).toEqual(
      ["chat", "email", "human", "transcript", "warehouse"].sort(),
    );
    expect(body.availability.chat).toMatchObject({
      mapEdges: ["chat-public-roster-truncated"],
      unitsWithheld: 1,
    });
    // The authority arm travels through unchanged — the old overview's backlog
    // counts, inside the one statement rather than beside it.
    expect(body.authority.workspaceTotals.awaitingReview).toBe(4);
    expect(loadCalls).toEqual([{ workspaceId: CURRENT_ORG, requestId: "test-req" }]);
  });

  /**
   * ⚠️ What the 500 arms below do and do NOT prove.
   *
   * `runEffect` is stubbed in this file (a bare `Effect.runPromise`), so a
   * rejected effect reaches Hono's default `onError` and the body is the literal
   * string `Internal Server Error`. The 500-plus-requestId ENVELOPE is the real
   * `runEffect`'s job and is pinned in its own tests — asserting "the body does
   * not contain the payload" against that string would be vacuous, so these arms
   * assert the two things they can actually falsify: the request did not succeed,
   * and the refusal happened at the seam it is supposed to happen at. The same
   * split, and the same reason, as `admin-brain-facts.test.ts`.
   */
  it("refuses to ship counts its own wire schema rejects", async () => {
    // The freshness tally is where a WITHHELD unit's staleness is disclosed, so
    // a short tally under-reports how much of a class is stale while the page
    // renders a confident ratio beside it. Without this seam the drift lands in
    // the browser as a blanked surface with no server-side trace.
    coverageResult = () =>
      healthyCoverage({
        availability: { chat: { ...chatArm(), freshness: { current: 0, stale: 0, unverified: 0 } } },
      });
    const res = await adminBrainCoverage.request("/");
    expect(res.status).toBe(500);
    // The loader RAN and the composition came back — so the refusal is the
    // outbound parse rather than something failing earlier for another reason,
    // which is the distinction that makes this arm about the seam at all.
    expect(loadCalls).toHaveLength(1);
  });

  it("re-applies the authority arm's own cross-checks rather than trusting them", async () => {
    // `BrainFactOversightSchema` cannot be the field on this envelope (it
    // requires the two publish previews `loadCoverage` never composes), so its
    // cross-checks are restated on the coverage schema. Without them this route
    // would serve 200 for a payload `/brain-facts/oversight` 500s on — and the
    // symptom is silent: a reader total above the workspace total makes the
    // hidden backlog compute negative, and the page's `<= 0` guard then drops
    // the one disclosure it was built to make.
    coverageResult = () => {
      const payload = healthyCoverage();
      return {
        ...payload,
        authority: { ...payload.authority, reviewableAwaitingReview: 12 },
      };
    };
    const res = await adminBrainCoverage.request("/");
    expect(res.status).toBe(500);
    expect(loadCalls).toHaveLength(1);
  });

  it("fails the request on the one false-all-clear the composer throws for", async () => {
    // A class declaring an enumerable universe with no roster behind it in this
    // deploy. Every available answer is a false statement in the flattering
    // direction, so the request fails rather than rendering a page that omits a
    // whole class.
    coverageResult = () => {
      throw new TestCoverageCompositionError("class chat declares a universe with no roster");
    };
    const res = await adminBrainCoverage.request("/");
    expect(res.status).toBe(500);
    // Not a 200 with a class quietly missing: nothing was serialized at all.
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });
});

describe("the boundaries this door holds", () => {
  it("refuses to compose a statement without a tenant boundary", async () => {
    ORG_ID = undefined;
    const res = await adminBrainCoverage.request("/");
    expect(res.status).toBe(400);
    expect(loadCalls).toHaveLength(0);
  });

  it("refuses to serve the workspace's shape when the reader cannot be resolved", async () => {
    // The authority arm carries one reader-scoped number, and a resolution that
    // BROKE is not an answer. Serving anyway would pair a workspace-wide count
    // with a fabricated reader total and render a hidden-backlog delta nobody
    // measured.
    readerResolveFails = true;
    const res = await adminBrainCoverage.request("/");
    expect(res.status).toBe(500);
    expect(loadCalls).toHaveLength(0);
  });
});
