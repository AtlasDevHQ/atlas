/**
 * Route-level tests for `admin-brain-enrollment` (#5196, ADR-0039).
 *
 * The storage seam's behaviour is pinned against real Postgres in
 * `lib/brain/__tests__/enrollment-pg.test.ts`. The assertions HERE are about
 * this router, and specifically about the four things that would be silent if
 * they broke:
 *
 *   - **The owner/admin bar is applied on BOTH verbs.** Enrolling widens what
 *     the Atlas may hold claims about and un-enrolling narrows it; a lower bar
 *     on either lets a non-admin decide, and the narrowing verb is the one a
 *     reviewer's eye slides past.
 *   - **A pair the semantic layer does not contain is REFUSED, not stored.** A
 *     stored pair the producer never matches sits in the list looking live and
 *     reaches nothing — indistinguishable from a working enrollment for a quiet
 *     warehouse.
 *   - **Un-enrolling does NOT re-check the semantic layer.** The mirror of the
 *     rule above, and it is a real asymmetry rather than an oversight: the pairs
 *     that most need clearing are exactly the ones whose entity has since
 *     disappeared, so the enroll verb's check applied here would strand them.
 *   - **`changed: false` reaches the client.** It is the difference between
 *     "your enrollment took effect" and "someone else's did, and the recorded
 *     author is theirs".
 *
 * ## What is deliberately NOT here
 *
 * There is no test for a bulk-enroll endpoint because there is no such endpoint.
 * `enrollment-writers.test.ts` is what keeps that true — a route test can only
 * assert about handlers that exist.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { BRAIN_ENROLLMENT_NAME_MAX } from "@useatlas/schemas";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { validationHook } from "../validation-hook";
import type { EnrollmentRow } from "@atlas/api/lib/brain/enrollment";
import type { EnrollmentCandidate } from "@atlas/api/lib/brain/enrollment-candidates";

const CURRENT_ORG = "org-1";

const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => INTERNAL_DB,
}));

// Mock-ALL-exports — a partial factory link-fails the moment the route reaches
// for anything else in the module.
/**
 * Captured `log.error` payloads.
 *
 * The logger was all-noop here, which made one line un-assertable: `checkedRun`'s
 * drift log is the ONLY record of a post-commit serialization failure, and the
 * response it returns tells the operator to go and read it. A version of that line
 * that logged `issues: [""]` for every possible drift was green against this suite.
 */
const loggedErrors: { payload: unknown; message: string }[] = [];
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: (payload: unknown, message?: unknown) =>
      loggedErrors.push({ payload, message: typeof message === "string" ? message : "" }),
    debug: noop,
    child: () => logger,
  };
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

let READER_ROLE: "owner" | "admin" | "member" = "owner";
let READER_ORIGIN: "authenticated" | "unauthenticated-local" | "unresolved" = "authenticated";
class TestBrainReaderIdentityError extends Error {}
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError: TestBrainReaderIdentityError,
  BrainReaderUnresolvedError: class extends TestBrainReaderIdentityError {},
  BrainRoleUnresolvedError: class extends TestBrainReaderIdentityError {},
  resolveBrainReaderContext: async () =>
    READER_ORIGIN === "authenticated"
      ? {
          origin: "authenticated" as const,
          workspaceId: CURRENT_ORG,
          userId: "user-1",
          role: READER_ROLE,
          audienceIds: [] as readonly string[],
        }
      : {
          origin: READER_ORIGIN,
          workspaceId: CURRENT_ORG,
          userId: null,
          role: null,
          audienceIds: [] as readonly string[],
        },
}));

let enrollments: EnrollmentRow[] = [];
let enrollChanged = true;
let unenrollChanged = true;
let namingChanged = true;
/** When set, `setNamingDimension` throws it — the not-enrolled refusal. */
let namingThrows: Error | null = null;
const enrollCalls: unknown[] = [];
const unenrollCalls: unknown[] = [];
const namingCalls: unknown[] = [];

class TestInvalidEnrollmentPairError extends Error {
  override readonly name = "InvalidEnrollmentPairError";
}

void mock.module("@atlas/api/lib/brain/enrollment", () => ({
  // Mock-ALL-exports, and this list is pinned against the real module's by
  // `lib/brain/__tests__/enrollment-writers.test.ts` — so a new export breaks
  // that tripwire rather than link-failing here at some later date.
  // NOT a literal `200`. This factory replaces the real module, so a
  // hand-written number here is a fixture that agrees by construction and can
  // never disagree — which is exactly the defect the seam's own docstring
  // records, reproduced in the file that mocks it.
  ENROLLMENT_NAME_MAX: BRAIN_ENROLLMENT_NAME_MAX,
  InvalidEnrollmentPairError: TestInvalidEnrollmentPairError,
  UnattributedEnrollmentError: class extends Error {},
  makeProducerReach: (pairs: readonly unknown[]) => ({
    pairs,
    entities: [],
    has: () => false,
  }),
  normalizeEnrollmentPair: (entity: string, dimension: string) => {
    const e = entity.trim();
    const d = dimension.trim();
    if (e === "" || d === "") {
      throw new TestInvalidEnrollmentPairError(
        "An enrollment names an entity and a dimension; both are required.",
      );
    }
    return { entity: e, dimension: d };
  },
  listEnrollments: async () => enrollments,
  loadProducerReach: async () => ({ pairs: [], entities: [], has: () => false }),
  enrollPair: async (params: unknown) => {
    enrollCalls.push(params);
    return enrollChanged;
  },
  unenrollPair: async (params: unknown) => {
    unenrollCalls.push(params);
    return unenrollChanged;
  },
  setNamingDimension: async (params: unknown) => {
    namingCalls.push(params);
    if (namingThrows !== null) throw namingThrows;
    return namingChanged;
  },
}));

let entityOptions = [{ name: "accounts", table: "public.accounts", description: null }];
let dimensionOptions: EnrollmentCandidate[] | null = [
  { name: "arr_band", kind: "dimension", type: "string", description: null },
  { name: "mrr", kind: "measure", type: "number", description: null },
];
const dimensionCalls: string[] = [];
void mock.module("@atlas/api/lib/brain/enrollment-candidates", () => ({
  loadEnrollableEntities: async () => entityOptions,
  loadEnrollableDimensions: async (_orgId: string, entity: string) => {
    dimensionCalls.push(entity);
    return dimensionOptions;
  },
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
            user: { id: "user-1", role: "admin" } as never,
            orgId: ORG_ID,
            trustDeviceIdentifier: undefined,
          }),
        ),
      ) as Effect.Effect<unknown, never, never>,
    ),
}));

/**
 * The producer, replaced.
 *
 * The route imports exactly two bindings from it — `runWarehouseProducer` and a
 * TYPE, which is erased — so this factory is complete for the route's graph. It
 * also keeps `reconcile.ts`/`cardinality.ts` out of this suite's module graph,
 * which the real import would otherwise pull in for a router test.
 */
let produceCalls: { workspaceId: string; triggeredBy: string; requestId?: string }[] = [];
let produceReport: Record<string, unknown> = {};
void mock.module("@atlas/api/lib/brain/warehouse-producer", () => ({
  runWarehouseProducer: async (ctx: { workspaceId: string; triggeredBy: string; requestId?: string }) => {
    produceCalls.push(ctx);
    return produceReport;
  },
}));

const { adminBrainEnrollment } = await import("../admin-brain-enrollment");

const post = (path: string, body: unknown) =>
  adminBrainEnrollment.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const row = (
  entity: string,
  dimension: string,
  enrolledBy = "user-1",
  naming = false,
): EnrollmentRow => ({
  entity,
  dimension,
  enrolledAt: "2026-08-14T00:00:00.000Z",
  enrolledBy,
  note: null,
  naming,
});

beforeEach(() => {
  READER_ROLE = "owner";
  READER_ORIGIN = "authenticated";
  ORG_ID = CURRENT_ORG;
  enrollments = [];
  enrollChanged = true;
  unenrollChanged = true;
  namingChanged = true;
  namingThrows = null;
  enrollCalls.length = 0;
  unenrollCalls.length = 0;
  namingCalls.length = 0;
  dimensionCalls.length = 0;
  loggedErrors.length = 0;
  produceCalls = [];
  produceReport = {
    workspaceId: CURRENT_ORG,
    snapshotAt: "2026-08-14T10:00:00.000Z",
    enrolled: 1,
    entities: [],
    refusals: [],
    created: 0,
    corroborated: 0,
    entityEdges: null,
  };
  entityOptions = [{ name: "accounts", table: "public.accounts", description: null }];
  dimensionOptions = [
    { name: "arr_band", kind: "dimension", type: "string", description: null },
    { name: "mrr", kind: "measure", type: "number", description: null },
  ];
});

describe("GET / — what is enrolled", () => {
  it("reports the distinct entity count, not the pair count", async () => {
    // THREE pairs across TWO entities. Equal numbers would be satisfied by a
    // handler that returned `enrollments.length` for both.
    enrollments = [
      // `arr_band` NAMES its entity (#5043), so the flag has a true value to
      // carry. All three `false` would let a handler that hardcoded `false`
      // pass the round-trip assertion below.
      row("accounts", "arr_band", "user-1", true),
      row("accounts", "tier"),
      row("subscriptions", "plan"),
    ];
    const res = await adminBrainEnrollment.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enrollments: Record<string, unknown>[];
      entityCount: number;
    };
    expect(body.enrollments).toHaveLength(3);
    expect(body.entityCount).toBe(2);
    // The whole row reaches the client, not just its count. `strictObject`
    // throws on a MISSING key, so this is about the values arriving intact —
    // `enrolledBy` in particular, which is the column an audit of "who
    // authorized this?" reads first.
    expect(body.enrollments[0]).toEqual({
      entity: "accounts",
      dimension: "arr_band",
      enrolledAt: "2026-08-14T00:00:00.000Z",
      enrolledBy: "user-1",
      note: null,
      naming: true,
    });
    // The other two carry `false` on the same call — so `naming: true` above is
    // the row's own value rather than a constant the handler stamps.
    expect(body.enrollments[1]).toMatchObject({ dimension: "tier", naming: false });
  });
});

describe("GET /dimensions — the picker", () => {
  it("flags the enrolled candidate and not its sibling", async () => {
    enrollments = [row("accounts", "arr_band")];
    const res = await adminBrainEnrollment.request("/dimensions?entity=accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dimensions: { name: string; enrolled: boolean }[];
    };
    // NEGATIVE and POSITIVE CONTROL in the same response. Either alone is
    // satisfied by a handler that hardcodes the flag.
    expect(body.dimensions.find((d) => d.name === "arr_band")?.enrolled).toBe(true);
    expect(body.dimensions.find((d) => d.name === "mrr")?.enrolled).toBe(false);
  });

  it("does not leak another entity's enrollment onto this one's candidates", async () => {
    // `subscriptions / arr_band` is enrolled; `accounts / arr_band` is not. A
    // handler that built its set from every enrollment's DIMENSION — dropping
    // the entity half — would flag it, which is the pair-versus-entity
    // conflation one layer up from the seam.
    enrollments = [row("subscriptions", "arr_band")];
    const res = await adminBrainEnrollment.request("/dimensions?entity=accounts");
    const body = (await res.json()) as { dimensions: { name: string; enrolled: boolean }[] };
    expect(body.dimensions.find((d) => d.name === "arr_band")?.enrolled).toBe(false);
  });

  it("404s an entity the published semantic layer does not have", async () => {
    dimensionOptions = null;
    const res = await adminBrainEnrollment.request("/dimensions?entity=ghosts");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "entity-not-found" });
  });

  it("200s with an empty list for an entity that declares nothing", async () => {
    // Distinct from the 404 above, deliberately: "we have never heard of that
    // entity" and "that entity has no columns you could enroll" are different
    // facts, and only one of them is a mistake the caller made.
    dimensionOptions = [];
    const res = await adminBrainEnrollment.request("/dimensions?entity=accounts");
    expect(res.status).toBe(200);
    expect((await res.json()) as { dimensions: unknown[] }).toMatchObject({ dimensions: [] });
  });
});

describe("POST /enroll", () => {
  it("refuses a pair the published semantic layer does not contain, and writes nothing", async () => {
    const res = await post("/enroll", { entity: "accounts", dimension: "not_a_column" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toMatchObject({ error: "pair-not-found" });
    // The DIMENSION half failed, so the case-sensitivity advice is the right
    // advice — see the sibling test for why it is wrong on the other half.
    expect(body.message).toContain("case-sensitive");
    // ⚠️ The assertion that matters. A 404 returned AFTER the write would look
    // identical from the status line and would have stored a pair that reaches
    // nothing.
    expect(enrollCalls).toHaveLength(0);
  });

  it("does not blame case when the ENTITY is what failed to resolve", async () => {
    // One message for two causes sent an admin hunting a dimension typo that
    // does not exist, while the real causes — not published, or ambiguous
    // across connection groups — went unnamed.
    dimensionOptions = null;
    const res = await post("/enroll", { entity: "ghosts", dimension: "arr_band" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("is not an entity");
    expect(body.message).not.toContain("case-sensitive");
    expect(enrollCalls).toHaveLength(0);
  });

  it("writes a pair the semantic layer does contain", async () => {
    // The positive control for the arm above: without it, a handler that
    // refused everything passes.
    const res = await post("/enroll", { entity: "accounts", dimension: "arr_band", note: "why" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entity: "accounts", dimension: "arr_band", changed: true });
    expect(enrollCalls).toHaveLength(1);
    expect(enrollCalls[0]).toMatchObject({
      workspaceId: CURRENT_ORG,
      entity: "accounts",
      dimension: "arr_band",
      note: "why",
      actor: "user-1",
    });
    // The control for the un-enroll asymmetry test's `dimensionCalls` zero. That
    // assertion says "it did not even ASK"; without a run in which the counter
    // DOES populate, it is satisfied by a harness where nothing ever records —
    // a renamed export in the candidates factory, or a `beforeEach` reset moved
    // after the request.
    expect(dimensionCalls).toEqual(["accounts"]);
  });

  it("reports the no-op rather than flattening it into success", async () => {
    enrollChanged = false;
    const res = await post("/enroll", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { changed: boolean }).toMatchObject({ changed: false });
  });

  it("403s a member, and does not write", async () => {
    READER_ROLE = "member";
    const res = await post("/enroll", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not-entitled" });
    expect(enrollCalls).toHaveLength(0);
  });

  it("403s an unresolved principal rather than filing the decision under the local operator", async () => {
    READER_ORIGIN = "unresolved";
    const res = await post("/enroll", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(403);
    expect(enrollCalls).toHaveLength(0);
  });

  it("records the local operator on a self-hosted unauthenticated deploy", async () => {
    // The positive control for the two 403 arms. Without it, `recordedAuthor`
    // returning null for EVERY origin passes both of them.
    READER_ORIGIN = "unauthenticated-local";
    const res = await post("/enroll", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(200);
    expect(enrollCalls[0]).toMatchObject({ actor: "local-operator" });
  });

  it("422s an empty half before any handler logic runs", async () => {
    const res = await post("/enroll", { entity: "accounts", dimension: "" });
    expect(res.status).toBe(422);
    expect(enrollCalls).toHaveLength(0);
  });
});

describe("POST /unenroll", () => {
  it("removes the pair", async () => {
    const res = await post("/unenroll", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entity: "accounts", dimension: "arr_band", changed: true });
    expect(unenrollCalls).toHaveLength(1);
  });

  it("does NOT re-check the semantic layer — a vanished entity must stay clearable", async () => {
    // The asymmetry with `/enroll`, asserted rather than left as a comment. The
    // pairs an admin most needs to clear are the ones whose entity has since
    // been deleted, so applying the enroll verb's check here would strand
    // exactly those.
    dimensionOptions = null;
    const res = await post("/unenroll", { entity: "ghosts", dimension: "arr_band" });
    expect(res.status).toBe(200);
    expect(unenrollCalls).toHaveLength(1);
    // And it did not even ASK. A handler that looked and then ignored the
    // answer would pass the status assertion while coupling the narrowing verb
    // to a semantic-layer read that can fail.
    expect(dimensionCalls).toHaveLength(0);
  });

  it("reports the no-op", async () => {
    unenrollChanged = false;
    const res = await post("/unenroll", { entity: "accounts", dimension: "arr_band" });
    expect((await res.json()) as { changed: boolean }).toMatchObject({ changed: false });
  });

  it("refuses a note rather than silently discarding it", async () => {
    // Un-enrolment leaves no row behind to carry a reason (migration 0199), so
    // accepting the field and dropping it would read as "Atlas recorded why I
    // stopped this" — the one thing this table does not store.
    const res = await post("/unenroll", {
      entity: "accounts",
      dimension: "arr_band",
      note: "because",
    });
    expect(res.status).toBe(422);
    expect(unenrollCalls).toHaveLength(0);
  });

  it("403s a member on the NARROWING verb too, and does not write", async () => {
    // Gated on the same bar as enrolling. A lower bar here would let a
    // non-admin undo an admin's decision about what the Atlas may learn.
    READER_ROLE = "member";
    const res = await post("/unenroll", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(403);
    expect(unenrollCalls).toHaveLength(0);
  });
});

describe("POST /naming — which column names an entity (#5043)", () => {
  it("names a dimension, and says what that does rather than what it toggles", async () => {
    const res = await post("/naming", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entity: "accounts",
      dimension: "arr_band",
      changed: true,
    });
    expect(namingCalls).toEqual([
      { workspaceId: CURRENT_ORG, entity: "accounts", dimension: "arr_band" },
    ]);
  });

  it("clears it on an explicit null, and the null reaches the seam", async () => {
    const res = await post("/naming", { entity: "accounts", dimension: null });
    expect(res.status).toBe(200);
    // `null` on the way OUT too. A handler echoing the entity name here would
    // tell an admin they had named the entity after itself.
    expect(await res.json()).toEqual({ entity: "accounts", dimension: null, changed: true });
    expect(namingCalls).toEqual([
      { workspaceId: CURRENT_ORG, entity: "accounts", dimension: null },
    ]);
  });

  it("refuses an OMITTED dimension — clearing is too destructive to be a default", async () => {
    // `.nullable()` and not `.nullish()`: on a `strictObject` an omitted field
    // and an explicit `null` would otherwise mean the same thing, and clearing
    // re-keys every fact about the entity workspace-wide.
    const res = await post("/naming", { entity: "accounts" });
    expect(res.status).toBe(422);
    expect(namingCalls).toHaveLength(0);
  });

  it("reports the no-op", async () => {
    namingChanged = false;
    const res = await post("/naming", { entity: "accounts", dimension: "arr_band" });
    expect((await res.json()) as { changed: boolean }).toMatchObject({ changed: false });
  });

  it("400s when the dimension is not enrolled, carrying the seam's own sentence", async () => {
    // The snapshot query names the ENROLLED columns only, so naming an
    // unenrolled one would look set and reach nothing — the silent failure
    // ADR-0039 warns is indistinguishable from success. The prose is the
    // SEAM's, verbatim: a second wording in the route would drift from the rule.
    namingThrows = new TestInvalidEnrollmentPairError(
      '"name" is not enrolled for "accounts", so the producer never reads that column.',
    );
    const res = await post("/naming", { entity: "accounts", dimension: "name" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("is not enrolled");
  });

  it("403s a member, and does not write", async () => {
    // The STRICTEST of the three write verbs by consequence: enrolling widens
    // what may be emitted, un-enrolling narrows it, and this one re-keys facts
    // that are already published.
    READER_ROLE = "member";
    const res = await post("/naming", { entity: "accounts", dimension: "arr_band" });
    expect(res.status).toBe(403);
    expect(namingCalls).toHaveLength(0);
  });
});

describe("POST /produce — running the producer", () => {
  it("403s a member, and does not run the producer", async () => {
    // ⚠️ The verb that actually READS the customer's warehouse and fills the
    // review queue an admin has to drain. Both write verbs had a 403 test; this
    // one had none, so deleting its guard let any authenticated member trigger
    // both. Asserting the STATUS alone is not enough — a handler that refuses
    // after running would look identical from the status line.
    READER_ROLE = "member";
    const res = await post("/produce", {});
    expect(res.status).toBe(403);
    expect(produceCalls).toHaveLength(0);
  });

  it("403s an unresolved principal", async () => {
    READER_ORIGIN = "unresolved";
    const res = await post("/produce", {});
    expect(res.status).toBe(403);
    expect(produceCalls).toHaveLength(0);
  });

  it("runs for an owner and records WHO triggered it", async () => {
    // The positive control for the two refusals above: without it, a handler that
    // 403s everyone passes both.
    const res = await post("/produce", {});
    expect(res.status).toBe(200);
    expect(produceCalls).toEqual([
      { workspaceId: CURRENT_ORG, triggeredBy: "user-1", requestId: "test-req" },
    ]);
  });

  it("records the local operator on a no-auth deployment", async () => {
    READER_ORIGIN = "unauthenticated-local";
    const res = await post("/produce", {});
    expect(res.status).toBe(200);
    expect(produceCalls[0]?.triggeredBy).toBe("local-operator");
  });

  it("returns the report through its wire schema", async () => {
    produceReport = {
      workspaceId: CURRENT_ORG,
      snapshotAt: "2026-08-14T10:00:00.000Z",
      enrolled: 3,
      entities: [
        {
          entity: "accounts",
          rows: 7,
          candidates: 5,
          created: 4,
          corroborated: 1,
          blocked: 0,
          comparable: 2,
          unidentifiedRows: 1,
          collidingSubjectRows: 0,
          unsurfaceableCells: 3,
          unsurfaceableKeyRows: 2,
          cardinalityProposed: ["arr_band"],
          // #5043, and every number distinct from its neighbours for this
          // block's stated reason.
          entitiesStored: 6,
          unnamedRows: 9,
        },
      ],
      refusals: [
        { entity: "contracts", dimension: "status", reason: "ambiguous-dimension", message: "…" },
      ],
      created: 4,
      corroborated: 1,
      // Non-null here, `null` in the `beforeEach` default — so both arms of the
      // nullable field cross the wire in this file, and a schema that dropped
      // the section would go red on one of them.
      entityEdges: {
        queued: 8,
        autoApproved: 10,
        deduped: 11,
        alreadyApproved: 12,
        rejected: 13,
        refused: 14,
      },
    };
    const res = await post("/produce", {});
    expect(res.status).toBe(200);
    // Every distinct number, so a handler that reordered or duplicated fields
    // cannot pass. `reportComplete: true` is the discriminant that makes this arm
    // distinguishable from the degraded one below — without it a caller cannot tell
    // a real result from a report the server could not serialize.
    expect(await res.json()).toEqual({ ...produceReport, reportComplete: true });
  });

  it("reports a COMMITTED run rather than a failure when the report cannot be serialized", async () => {
    // ⚠️ The post-commit posture. The drafts are already in the review queue, so a
    // 500 saying "Failed to run" invites the one retry that doubles the queue —
    // and the drift is deterministic, so the admin would see it forever.
    produceReport = {
      // ⚠️ DIFFERENT from `CURRENT_ORG`, deliberately. A drifted report is this
      // arm's own premise, so while the two were equal, taking `workspaceId` from
      // the REPORT — which is what the version this fix condemned did — was
      // indistinguishable from taking it from the route.
      workspaceId: "org-drifted",
      snapshotAt: "2026-08-14T10:00:00.000Z",
      enrolled: 2,
      entities: [{ nonsense: true }],
      // A NON-EMPTY refusals list, deliberately: the first cut of this arm returned
      // `refusals: []` and the counts, which is a confident all-clear for a run that
      // may have refused every pair — worse than the 500 it replaced.
      refusals: [{ entity: "accounts", dimension: "tier", reason: "snapshot-failed", message: "…" }],
      created: 9,
      corroborated: 0,
    };
    const res = await post("/produce", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The degraded arm says NOTHING about the run — no counts to misread, no empty
    // lists to mistake for "nothing was refused". Only what the ROUTE knows.
    // The ROUTE's workspace, never the drifted report's.
    expect(body).toEqual({
      reportComplete: false,
      workspaceId: CURRENT_ORG,
      requestId: "test-req",
      message: expect.stringContaining("could not"),
    });
    expect(body.workspaceId).not.toBe("org-drifted");

    // ⚠️ And the log the response points at must actually NAME the drift. Parsing
    // the response UNION instead of the report schema yields a single
    // `invalid_union` issue at `path: []`, so every drift logs `[""]` — the one
    // diagnostic for a deterministic-under-retry failure, empty.
    const drifts = loggedErrors.filter((l) => l.message.includes("report shape drifted"));
    expect(drifts).toHaveLength(1);
    const [drift] = drifts;
    if (drift === undefined) throw new Error("no drift line was logged");
    const { issues } = drift.payload as { issues: { path: string }[] };
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.path).join(",")).toContain("entities");
  });
});

describe("no active organization", () => {
  it("400s every verb rather than writing against an absent workspace", async () => {
    ORG_ID = undefined;
    for (const res of await Promise.all([
      adminBrainEnrollment.request("/"),
      adminBrainEnrollment.request("/entities"),
      adminBrainEnrollment.request("/dimensions?entity=accounts"),
      post("/enroll", { entity: "accounts", dimension: "arr_band" }),
      post("/unenroll", { entity: "accounts", dimension: "arr_band" }),
      post("/produce", {}),
    ])) {
      expect(res.status).toBe(400);
    }
    expect(enrollCalls).toHaveLength(0);
    expect(unenrollCalls).toHaveLength(0);
    expect(produceCalls).toHaveLength(0);
  });
});
