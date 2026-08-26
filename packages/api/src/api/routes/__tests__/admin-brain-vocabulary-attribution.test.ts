/**
 * The audit rows this router emits carry the ACTOR (#5448).
 *
 * ## Why this file exists beside `admin-brain-vocabulary.test.ts`
 *
 * That file `mock.module`s `@atlas/api/lib/audit` wholesale and asserts the
 * ENTRY OBJECT the route passed in. That object contains no actor: `actor_id`
 * and `actor_email` are resolved inside `logAdminAction`, from the
 * AsyncLocalStorage request context — i.e. inside the very function the double
 * replaces. So those tests prove the route emits a row of the right SHAPE, and
 * prove nothing about attribution.
 *
 * Attribution is the property #5448 was filed about. "The write with the larger
 * consequence is the one absent from the log" is a claim about *who*, and a
 * suite that mocks the actor resolver away cannot fail when the actor goes
 * missing — a request-context regression would drop it and every assertion over
 * there would stay green.
 *
 * So this file follows the shape the issue actually named:
 * `lib/auth/__tests__/databaseHooks-wiring.test.ts` (the invite-hook regression
 * test). It leaves `lib/audit` REAL, lets `logAdminAction` resolve the actor
 * from the request context for itself, captures the `INSERT INTO
 * admin_action_log` statement at the DB seam, and asserts the actor is in the
 * params — exactly as that test asserts `.toContain("user_inviter")`.
 *
 * ⚠️ The one thing that must NOT be mocked here is `@atlas/api/lib/audit`.
 * Mocking it is what made the sibling file blind.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { validationHook } from "../validation-hook";

const CURRENT_ORG = "org-1";
const ACTOR_ID = "user-curator-1";
const ACTOR_EMAIL = "curator@useatlas.dev";

/** Every statement the real `logAdminAction` pushed at the DB seam. */
const statements: Array<{ sql: string; params: unknown[] }> = [];

const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => INTERNAL_DB,
  hasInternalDB: () => true,
  // The seam the real logger writes through. `internalExecute` returns void and
  // swallows its own rejections, so capturing here is the only place the row is
  // observable without a live Postgres.
  internalExecute: (sql: string, params?: unknown[]) => {
    statements.push({ sql, params: params ?? [] });
  },
}));

/**
 * The request context the auth middleware would have populated.
 *
 * ⚠️ `getRequestContext` returns a USER here, unlike the sibling file's logger
 * double which returns `{ requestId }` alone. That user is the entire point:
 * `resolveEntry` reads `ctx.user.id` / `ctx.user.label` into `actor_id` /
 * `actor_email`, and a context without one resolves both to the string
 * `"unknown"` — which is the regression this file is here to catch.
 */
let REQUEST_USER: { id: string; label: string; activeOrganizationId: string } | undefined = {
  id: ACTOR_ID,
  label: ACTOR_EMAIL,
  activeOrganizationId: CURRENT_ORG,
};
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req", user: REQUEST_USER }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: noop,
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

// Mock-ALL-exports, matching the sibling file's factory: the real module also
// exports three error classes, and a partial factory makes `instanceof
// undefined` throw inside the catch that was meant to handle it.
class TestBrainReaderIdentityError extends Error {}
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError: TestBrainReaderIdentityError,
  BrainReaderUnresolvedError: class extends TestBrainReaderIdentityError {},
  BrainRoleUnresolvedError: class extends TestBrainReaderIdentityError {},
  resolveBrainReaderContext: async () => ({
    origin: "authenticated" as const,
    workspaceId: CURRENT_ORG,
    userId: ACTOR_ID,
    role: "owner" as const,
    audienceIds: [] as readonly string[],
  }),
}));

void mock.module("@atlas/api/lib/brain/cardinality", () => ({
  declarePredicateCardinalityForSurface: async () => ({
    ok: true,
    cardinality: "single",
    previous: { kind: "none" },
  }),
  declarePredicateCardinality: async () => ({
    ok: true,
    cardinality: "single",
    previous: { kind: "none" },
  }),
  proposePredicateCardinality: async () => ({ ok: true, cardinality: "single" }),
  decidePredicateCardinality: async () => "single",
  decidePredicateCardinalityForSurface: async () => ({ kind: "decided", cardinality: "single" }),
  readPredicateCardinality: async () => null,
  proposeFromCorrectionEvents: async () => ({}),
  cardinalitySingleSql: () => "TRUE",
  CARDINALITY_SOURCE_CLASSES: ["warehouse_structural", "correction_event", "human"] as const,
  CARDINALITY_STATUSES: ["pending", "approved", "rejected"] as const,
  CORRECTION_REPEAT_THRESHOLD: 3,
  CORRECTION_EVENT_PRODUCER: "brain:correction-event-cardinality",
  CORRECTION_REPEAT_COUNT_SQL: "",
}));

// Mock-ALL-exports, the rule this whole PR is about. A partial factory here
// link-failed on `emptySide` the first time this file ran.
void mock.module("@atlas/api/lib/brain/vocabulary-surfaces", () => ({
  loadObservedSurfaces: async () => ({ surfaces: [], nextCursor: null }),
  loadPairPopulation: async () => ({
    from: { norm: "a", claims: 1 },
    to: { norm: "b", claims: 1 },
    decision: "unscoped" as const,
  }),
  emptySide: () => null,
  OBSERVED_SURFACE_PAGE_MAX: 100,
  SURFACE_FILTER_MAX_CHARS: 200,
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

const { AuthContext, RequestContext } = await import("@atlas/api/lib/effect/services");
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
            user: { id: ACTOR_ID, role: "admin" } as never,
            orgId: CURRENT_ORG,
            trustDeviceIdentifier: undefined,
          }),
        ),
      ) as Effect.Effect<unknown, never, never>,
    ),
}));

const { adminBrainVocabulary } = await import("../admin-brain-vocabulary");

const post = (path: string, body: unknown) =>
  adminBrainVocabulary.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * The `admin_action_log` INSERT, found the way the invite-hook test finds it —
 * by matching the statement text, not by trusting call order.
 */
function auditRow(actionType: string) {
  return statements.find(
    (s) => /INSERT\s+INTO\s+admin_action_log/i.test(s.sql) && s.params.includes(actionType),
  );
}

beforeEach(() => {
  statements.length = 0;
  REQUEST_USER = { id: ACTOR_ID, label: ACTOR_EMAIL, activeOrganizationId: CURRENT_ORG };
});

describe("the audit row carries the ACTOR, not just the shape (#5448)", () => {
  it("POST /cardinality writes a row attributed to the acting admin", async () => {
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(200);

    const row = auditRow("brain_vocabulary.cardinality");
    expect(
      row,
      "POST /cardinality must reach the admin_action_log INSERT — this is the write #5448 measured as absent",
    ).toBeDefined();
    // The two assertions the sibling suite structurally cannot make.
    expect(row?.params, "the row is attributed to the acting admin's id").toContain(ACTOR_ID);
    expect(row?.params, "the row carries the acting admin's email").toContain(ACTOR_EMAIL);
  });

  it("attributes the UN-CURATION to `multi` too — the flip that erases reviewed_by", async () => {
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "multi",
    });
    expect(res.status).toBe(200);

    const row = auditRow("brain_vocabulary.cardinality");
    expect(row?.params, "un-curation is attributed exactly like curation").toContain(ACTOR_ID);
  });

  /**
   * The falsifying case. Without it the two tests above pass on a build where
   * `resolveEntry` never sees a user at all — `"unknown"` is a string, and a
   * `toContain(ACTOR_ID)` that happens to be checked against a row nobody
   * attributed would simply fail, but nothing would say WHY.
   *
   * This pins the failure mode by name: context drops the user, the row still
   * lands, and it lands anonymous. That is the state #5448 describes as
   * "nobody recorded as having asked for it".
   */
  it("a request context with no user produces an ANONYMOUS row — the regression this file guards", async () => {
    REQUEST_USER = undefined;

    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(200);

    const row = auditRow("brain_vocabulary.cardinality");
    expect(row, "the row still lands — losing the actor does not fail the write").toBeDefined();
    expect(
      row?.params,
      "with no user in context the actor resolves to the literal `unknown`",
    ).toContain("unknown");
    expect(
      row?.params,
      "and it emphatically does NOT carry the admin's id",
    ).not.toContain(ACTOR_ID);
  });
});
