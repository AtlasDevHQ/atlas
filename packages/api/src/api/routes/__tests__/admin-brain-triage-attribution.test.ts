/**
 * The re-queue's audit row carries the ACTOR (#5534, on #5448's shape).
 *
 * ## Why this file exists beside `admin-brain-triage.test.ts`
 *
 * That file `mock.module`s `@atlas/api/lib/audit` wholesale and asserts the
 * ENTRY OBJECT the route passed in. That object contains no actor: `actor_id`
 * and `actor_email` are resolved inside `logAdminActionAwait`, from the
 * AsyncLocalStorage request context — i.e. inside the very function the double
 * replaces. So those tests prove the route emits a row of the right SHAPE, and
 * prove nothing about attribution.
 *
 * ⚠️ **Here that gap is not a shortfall against a general principle, it is the
 * criterion.** #5534's second acceptance criterion is "who re-queued, which
 * rule scope, how many rows", and this route's own header argues at length that
 * the admin surface is the right home *because it can name the human* where an
 * operator subcommand cannot. Re-queueing sets `triaged_out_at` and
 * `triage_reason` back to NULL, so after the write nothing in `brain_episodes`
 * records that those rows were ever triaged: this row is the whole record. A
 * suite that mocks the actor resolver away cannot fail when the actor goes
 * missing — the load-bearing claim of the entire change would be unfalsifiable.
 *
 * So this follows `admin-brain-vocabulary-attribution.test.ts` (#5448) exactly:
 * leave `lib/audit` REAL, let it resolve the actor from the request context for
 * itself, capture the `INSERT INTO admin_action_log` at the DB seam, and assert
 * the actor is in the params.
 *
 * ⚠️ The one thing that must NOT be mocked here is `@atlas/api/lib/audit`.
 * Mocking it is what makes the sibling file blind.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { validationHook } from "../validation-hook";

const CURRENT_ORG = "org-1";
const ACTOR_ID = "user-admin-1";
const ACTOR_EMAIL = "admin@useatlas.dev";

/** Every statement the real `logAdminActionAwait` pushed at the DB seam. */
const statements: Array<{ sql: string; params: unknown[] }> = [];

const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    // ⚠️ `internalQuery`, NOT `internalExecute` — and the difference is the
    // whole reason this file nearly shipped green-on-nothing. The #5448
    // precedent captures `internalExecute` because `logAdminAction` (the
    // fire-and-forget helper) writes through it. This route deliberately uses
    // `logAdminActionAwait`, which writes through `internalQuery`
    // (`lib/audit/admin.ts:157`) so a rejection reaches the caller. Capturing
    // the other seam yields zero statements and every assertion below fails —
    // which is how this was caught, but a laxer assertion (`?.params` optional
    // chaining alone, no `toBeDefined`) would have passed on nothing.
    internalQuery: async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params: params ?? [] });
      return [];
    },
  }),
  getInternalDB: () => INTERNAL_DB,
  hasInternalDB: () => true,
}));

/**
 * The request context the auth middleware would have populated. The USER is the
 * entire point: `resolveEntry` reads `ctx.user.id` / `ctx.user.label` into
 * `actor_id` / `actor_email`, and a context without one resolves both to the
 * string `"unknown"`.
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

// Mock-ALL-exports, matching the sibling attribution file's factory: the real
// module also exports three error classes, and a partial factory makes
// `instanceof undefined` throw inside the catch that was meant to handle it.
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

/** The store, stubbed: this file is about the audit row, not the SQL. */
let requeued = 0;
void mock.module("@atlas/api/lib/brain/triage-requeue", () => ({
  TRIAGE_BACKLOG_SQL: "SELECT triage_reason FROM brain_episodes",
  REQUEUE_TRIAGED_COUNTED_SQL: "WITH requeued AS (UPDATE brain_episodes)",
  isKnownTriageRule: (rule: string) =>
    ["below_min_length", "pure_reaction", "known_ack"].includes(rule),
  loadTriageBacklog: async () => ({ total: 0, byRule: [], degraded: false }),
  requeueTriagedEpisodes: async () => ({ requeued }),
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

const { adminBrainTriage } = await import("../admin-brain-triage");

const post = (body: unknown) =>
  adminBrainTriage.request("/requeue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * The `admin_action_log` INSERT, found by matching the statement text rather
 * than by trusting call order.
 */
function auditRow(actionType: string) {
  return statements.find(
    (s) => /INSERT\s+INTO\s+admin_action_log/i.test(s.sql) && s.params.includes(actionType),
  );
}

beforeEach(() => {
  statements.length = 0;
  requeued = 12;
  REQUEST_USER = { id: ACTOR_ID, label: ACTOR_EMAIL, activeOrganizationId: CURRENT_ORG };
});

describe("the re-queue's audit row carries the ACTOR, not just the shape", () => {
  it("attributes an all-rules re-queue to the acting admin", async () => {
    const res = await post({});
    expect(res.status).toBe(200);

    const row = auditRow("brain.triage_requeue");
    expect(
      row,
      "POST /requeue must reach the admin_action_log INSERT — this row is the ONLY record of the act",
    ).toBeDefined();
    // The two assertions the sibling suite structurally cannot make.
    expect(row?.params, "the row is attributed to the acting admin's id").toContain(ACTOR_ID);
    expect(row?.params, "the row carries the acting admin's email").toContain(ACTOR_EMAIL);
  });

  it("attributes a per-rule re-queue identically, and records the scope and the count", async () => {
    // AC2 in one assertion: WHO (actor id + email), WHICH SCOPE (`rule`), HOW
    // MANY (`requeued`). The last two ride the JSONB metadata param, so they are
    // asserted against the serialized column rather than the params list.
    const res = await post({ rule: "known_ack" });
    expect(res.status).toBe(200);

    const row = auditRow("brain.triage_requeue");
    expect(row?.params).toContain(ACTOR_ID);

    const metadata = row?.params.find(
      (p): p is string => typeof p === "string" && p.includes("requeued"),
    );
    expect(metadata, "metadata reaches the INSERT as serialized JSON").toBeDefined();
    const parsed = JSON.parse(metadata!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ workspaceId: CURRENT_ORG, rule: "known_ack", requeued: 12 });
  });

  it("attributes a re-queue that moved nothing", async () => {
    // The zero-row run is audited for `tensionSweep`'s reason, and it must be
    // attributed for the same reason as any other: "an admin re-queued and
    // nothing moved" is only interpretable if you know which admin.
    requeued = 0;
    expect((await post({ rule: "known_ack" })).status).toBe(200);
    expect(auditRow("brain.triage_requeue")?.params).toContain(ACTOR_ID);
  });

  /**
   * The falsifying case. Without it the tests above pass on a build where
   * `resolveEntry` never sees a user at all — `"unknown"` is a string, and a
   * failing `toContain(ACTOR_ID)` would say nothing about WHY.
   *
   * This pins the failure mode by name: context drops the user, the row still
   * lands, and it lands anonymous. For this act that is the worst state
   * available — the marks are gone and nobody is recorded as having cleared
   * them, which is precisely the outcome the route's header claims an admin
   * surface avoids and an operator subcommand cannot.
   */
  it("a request context with no user produces an ANONYMOUS row — the regression this file guards", async () => {
    REQUEST_USER = undefined;

    const res = await post({});
    expect(res.status).toBe(200);

    const row = auditRow("brain.triage_requeue");
    expect(row, "the row still lands — losing the actor does not fail the write").toBeDefined();
    expect(
      row?.params,
      "with no request-context user the act is recorded as `unknown` — episodes re-queued by nobody",
    ).toContain("unknown");
    expect(row?.params).not.toContain(ACTOR_ID);
  });
});
