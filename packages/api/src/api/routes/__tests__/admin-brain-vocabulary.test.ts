/**
 * Route-level tests for `admin-brain-vocabulary` (#5087).
 *
 * The library behaviour is pinned against real Postgres in
 * `lib/brain/__tests__/vocabulary-authoring-pg.test.ts`. The assertions HERE are
 * about this router, and specifically about the three things that would be
 * silent if they broke:
 *
 *   - **A refusal is a 4xx**, and its typed code and prose reach the client. A
 *     `200 { outcome: "refused" }` is read as success by every generic client in
 *     the stack — retry middleware, `useAdminMutation`, the SDK — and the seam's
 *     prose is the only thing that names WHICH side of a pair is empty.
 *   - **The status is the RIGHT 4xx.** Authority is 403 and a target-state
 *     mismatch is 409, `admin-brain-facts.ts`'s semantics; a flattened
 *     everything-is-400 would tell an approver to fix their request when what
 *     they need is a different role.
 *   - **No identity key reaches a body.** Every response schema is
 *     `z.strictObject` and every response is parsed through it before it goes
 *     out, so an extra key is REFUSED rather than stripped.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { validationHook } from "../validation-hook";
import type {
  AliasAuthoringOutcome,
  AliasRemovalOutcome,
} from "@atlas/api/lib/brain/vocabulary-decide";
import type { CardinalityDecisionResult } from "@atlas/api/lib/brain/cardinality";

const CURRENT_ORG = "org-1";

// `resolvePrincipalContext` runs FOR REAL against this handle, so the reader
// context the handlers pass down is the real wiring rather than a stub of it.
const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => INTERNAL_DB,
}));

// Mock-ALL-exports. This file cites the rule for its other three factories and
// supplied 2 of `lib/logger`'s 10 here; the same latent link-failure shape.
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

// The reader context. Mocked rather than driven through the member tables
// because THIS file's assertions are about the router's branching, and the
// resolver's own contract is pinned in `reader-context.test.ts`.
let READER_ROLE: "owner" | "admin" | "member" = "owner";
/** The reader ORIGIN, so the self-hosted and unresolved arms are reachable. */
let READER_ORIGIN: "authenticated" | "unauthenticated-local" | "unresolved" = "authenticated";
class TestBrainReaderIdentityError extends Error {}
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  // Mock-ALL-exports. The real module also exports three error classes, and the
  // day this route learns to degrade on `BrainReaderIdentityError` — as
  // `admin-publish-preview.ts` and `search-brain.ts` both do — a partial factory
  // makes `instanceof undefined` throw a TypeError inside the catch that was
  // supposed to handle it.
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

let authorOutcome: AliasAuthoringOutcome = {
  kind: "authored",
  id: "proposal-1",
  convergedOnProposal: false,
};
let removeOutcome: AliasRemovalOutcome = {
  kind: "removed",
  id: "proposal-1",
  memoryCreated: false,
};
const authorCalls: unknown[] = [];
const removeCalls: unknown[] = [];
const decideCalls: unknown[] = [];
let decideOutcome: unknown = { kind: "approved", id: "proposal-1" };

// Mock-all-exports: the route imports two functions and two types from this
// module, and a partial factory link-fails the moment anything else is added.
void mock.module("@atlas/api/lib/brain/vocabulary-decide", () => ({
  authorAliasEdge: async (workspaceId: string, input: unknown) => {
    authorCalls.push({ workspaceId, input });
    return authorOutcome;
  },
  removeInForceAliasEdge: async (workspaceId: string, input: unknown) => {
    removeCalls.push({ workspaceId, input });
    return removeOutcome;
  },
  proposeAliasEdge: async () => ({ kind: "queued", id: "x", autoApprove: false }),
  proposeAliasEdges: async () => ({}),
  decideAliasProposal: async (request: unknown) => {
    decideCalls.push(request);
    return decideOutcome;
  },
  ALIAS_SOURCE_CLASSES: ["warehouse_key", "extractor", "seam", "human"] as const,
  isAliasSourceClass: () => true,
  REKEY_DRIFTED_FACTS_SQL: { subject: "", predicate: "", object: "" },
}));

let surfacesPage = {
  position: "predicate" as const,
  surfaces: [
    { norm: "is priced at", exampleSurface: "is priced at", claims: 2, variants: 1 },
  ],
  truncated: false,
  decision: "unscoped" as const,
};
const surfaceCalls: unknown[] = [];
void mock.module("@atlas/api/lib/brain/vocabulary-surfaces", () => ({
  loadObservedSurfaces: async (_db: unknown, _ctx: unknown, request: unknown) => {
    surfaceCalls.push(request);
    return surfacesPage;
  },
  loadPairPopulation: async () => ({
    from: { norm: "a", claims: 1 },
    to: { norm: "b", claims: 1 },
    decision: "unscoped" as const,
  }),
  emptySide: () => null,
  OBSERVED_SURFACE_PAGE_MAX: 100,
  SURFACE_FILTER_MAX_CHARS: 200,
}));

let inForceOverride: Record<string, unknown> | null = null;
void mock.module("@atlas/api/lib/brain/vocabulary-in-force", () => ({
  loadInForceVocabulary: async () => ({
    edges: [
      {
        position: "predicate" as const,
        fromNorm: "is priced at",
        toNorm: "priced at",
        approvedBy: "user-1",
        approvedAt: "2026-08-08T00:00:00.000Z",
        proposalId: "proposal-1",
      },
    ],
    counts: [
      {
        position: "predicate" as const,
        decision: "unscoped" as const,
        total: 1,
        scoped: 1,
        withheld: 0,
        consistent: true,
      },
    ],
    cardinalities: [],
    cardinalityCounts: {
      position: "predicate" as const,
      decision: "unscoped" as const,
      total: 0,
      scoped: 0,
      withheld: 0,
      consistent: true,
    },
    truncated: false,
    ...(inForceOverride ?? {}),
  }),
  loadVocabularyCoverage: async () => ({
    liveFacts: 47,
    comparableFacts: 0,
    pendingProposals: 0,
    pendingCardinalities: 0,
  }),
  IN_FORCE_PAGE_MAX: 200,
}));

let cardinalityResult: unknown = { ok: true, cardinality: "single" };
const cardinalityCalls: unknown[] = [];
const cardinalityDecideCalls: { workspaceId: string; input: unknown }[] = [];
/**
 * ⚠️ Typed to the union, so the four LEGITIMATE values stay pinned to the seam.
 *
 * The route branches positively on `"decided"` and throws on a `never` default,
 * and that default is the whole point of the three-way result: the earlier shape
 * fell through to SUCCESS, so a new member would have been reported to the
 * approver as *"Curated: … now holds one value at a time"* for a write that may
 * not have happened, on the one verb that arms retroactive supersession.
 *
 * The one hostile value casts AT ITS OWN SITE (`as CardinalityDecisionResult`),
 * which is the point: widening this declaration to `string` also un-pinned the
 * four real arms, so a rename in the seam would stop breaking the mock. One
 * deliberate violation, legible as a violation.
 *
 * Without it the `never` default is unreachable from any test — collapsing it
 * back to the fall-through left all 60 tests in this file green.
 */
let cardinalityDecided: CardinalityDecisionResult = "decided";
void mock.module("@atlas/api/lib/brain/cardinality", () => ({
  declarePredicateCardinalityForSurface: async (
    _db: unknown,
    workspaceId: string,
    input: unknown,
  ) => {
    cardinalityCalls.push({ workspaceId, input });
    return cardinalityResult;
  },
  declarePredicateCardinality: async () => ({ ok: true, cardinality: "single" }),
  proposePredicateCardinality: async () => ({ ok: true, cardinality: "single" }),
  decidePredicateCardinality: async () => true,
  decidePredicateCardinalityForSurface: async (_db: unknown, workspaceId: string, input: unknown) => {
    cardinalityDecideCalls.push({ workspaceId, input });
    return cardinalityDecided;
  },
  readPredicateCardinality: async () => null,
  proposeFromCorrectionEvents: async () => ({}),
  cardinalitySingleSql: () => "TRUE",
  CARDINALITY_SOURCE_CLASSES: ["warehouse_structural", "correction_event", "human"] as const,
  CARDINALITY_STATUSES: ["pending", "approved", "rejected"] as const,
  CORRECTION_REPEAT_THRESHOLD: 3,
  CORRECTION_EVENT_PRODUCER: "brain:correction-event-cardinality",
  CORRECTION_REPEAT_COUNT_SQL: "",
}));

void mock.module("@atlas/api/lib/brain/vocabulary", () => ({
  loadWorkspaceVocabulary: async () => ({
    subject: (n: string) => n,
    predicate: (n: string) => n,
    object: (n: string) => n,
  }),
  loadClaimVocabulary: async () => ({
    subject: (n: string) => n,
    predicate: (n: string) => n,
    object: (n: string) => n,
  }),
  approveAliasEdge: async () => ({ ok: true }),
  removeAliasEdge: async () => true,
  recomputeEffectiveTargets: async () => {},
  VOCABULARY_LOCK_NAMESPACE: 5022,
  VOCABULARY_LOCK_SQL: "",
  MAX_CHAIN_DEPTH: 64,
  VocabularyClosureError: class extends Error {},
}));

let pendingQueue: Record<string, unknown> = {
  entries: [],
  aliasCounts: [],
  cardinalityCounts: {
    position: "predicate" as const,
    decision: "unscoped" as const,
    total: 0,
    scoped: 0,
    withheld: 0,
    consistent: true,
  },
  truncated: false,
  incomplete: false,
};
const pendingCalls: unknown[] = [];
void mock.module("@atlas/api/lib/brain/vocabulary-pending", () => ({
  loadPendingQueue: async (_db: unknown, _ctx: unknown, opts: unknown) => {
    pendingCalls.push(opts);
    return pendingQueue;
  },
  PENDING_PAGE_MAX: 100,
  PENDING_EVIDENCE_SAMPLE_MAX: 5,
  PENDING_ENTRY_KINDS: ["alias", "cardinality"] as const,
}));

let blastRadius: unknown = { kind: "structurally-empty", reason: "object-position" };
const previewCalls: unknown[] = [];
void mock.module("@atlas/api/lib/brain/vocabulary-preview", () => ({
  loadBlastRadius: async (_db: unknown, _ctx: unknown, request: unknown) => {
    previewCalls.push(request);
    return blastRadius;
  },
  BLAST_RADIUS_PAIR_MAX: 50,
  assertPlaceholdersBelowAclBase: () => {},
}));

// The REAL `defaultHook`, not a bare router. The 422 assertions below are about
// the contract a client codes against (`ValidationErrorSchema`'s
// `error: "validation_error"`), and a mock without the hook answers 400 — so the
// tests would pin a status production never returns, and the strict-object
// arms would look like they were passing for the right reason.
void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono({ defaultHook: validationHook }),
  // Mock-all-exports, same rationale as the reader-context factory above.
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
/**
 * What the stubbed `runEffect` rejected with, if anything.
 *
 * ⚠️ Recorded because this stub is NOT the real bridge, and the difference is
 * load-bearing for one test. The real `runEffect` turns a defect into an
 * `HTTPException(500)` whose body carries `{ error, message, requestId }`; this
 * stub is a bare `Effect.runPromise`, so a defect propagates and Hono's built-in
 * handler answers a constant `text/plain` "Internal Server Error". That means
 * asserting on the BODY here proves nothing — every 500 from this router,
 * whatever caused it, produces the identical bytes. The cause is the only thing
 * that separates *"the `never` default fired"* from *"anything at all threw"*.
 */
let lastDefect: string | null = null;
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
    ).catch((err: unknown) => {
      lastDefect = err instanceof Error ? err.message : String(err);
      throw err;
    }),
}));

const { adminBrainVocabulary } = await import("../admin-brain-vocabulary");

const post = (path: string, body: unknown) =>
  adminBrainVocabulary.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  READER_ROLE = "owner";
  READER_ORIGIN = "authenticated";
  ORG_ID = CURRENT_ORG;
  authorCalls.length = 0;
  removeCalls.length = 0;
  surfaceCalls.length = 0;
  previewCalls.length = 0;
  authorOutcome = { kind: "authored", id: "proposal-1", convergedOnProposal: false };
  removeOutcome = { kind: "removed", id: "proposal-1", memoryCreated: false };
  blastRadius = { kind: "structurally-empty", reason: "object-position" };
  cardinalityResult = { ok: true, cardinality: "single" };
  cardinalityCalls.length = 0;
  cardinalityDecideCalls.length = 0;
  cardinalityDecided = "decided";
  lastDefect = null;
  decideCalls.length = 0;
  decideOutcome = { kind: "approved", id: "proposal-1" };
  pendingCalls.length = 0;
  pendingQueue = {
    entries: [],
    aliasCounts: [],
    cardinalityCounts: {
      position: "predicate",
      decision: "unscoped",
      total: 0,
      scoped: 0,
      withheld: 0,
      consistent: true,
    },
    truncated: false,
    incomplete: false,
  };
  inForceOverride = null;
  surfacesPage = {
    position: "predicate",
    surfaces: [{ norm: "is priced at", exampleSurface: "is priced at", claims: 2, variants: 1 }],
    truncated: false,
    decision: "unscoped",
  };
});

describe("GET /surfaces", () => {
  it("returns the picker page with its scope", async () => {
    const res = await adminBrainVocabulary.request("/surfaces?position=predicate");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      position: "predicate",
      surfaces: [{ norm: "is priced at", exampleSurface: "is priced at", claims: 2, variants: 1 }],
      truncated: false,
      // The client renders a different sentence per arm, so the arm has to
      // travel — a client that could not tell them apart would say "scoped to
      // you" over a workspace-wide list.
      scope: "unscoped",
    });
  });

  it("rejects a position outside the vocabulary instead of silently defaulting", async () => {
    // Defaulting to `predicate` would hand an approver a list of relations while
    // they believed they were picking entities, and the authoring call that
    // followed would then be refused for an emptiness that is an artefact of
    // the wrong position.
    //
    // 422 rather than 400 since the declared `request.query` schema became the
    // ENFORCED one: the refusal now comes from the same `validationHook` that
    // guards every body on this surface, instead of from a bespoke branch that
    // duplicated the contract and disagreed with the OpenAPI document.
    const res = await adminBrainVocabulary.request("/surfaces?position=nonsense");
    expect(res.status).toBe(422);
    expect(surfaceCalls).toHaveLength(0);
  });

  it("rejects a limit above the page cap rather than silently clamping it", async () => {
    // The cap is a real bound (the reader controls the cost), and the schema is
    // where it is now stated — so an over-large request is refused rather than
    // quietly answered with a different page than was asked for.
    const res = await adminBrainVocabulary.request("/surfaces?position=predicate&limit=99999");
    expect(res.status).toBe(422);
    expect(surfaceCalls).toHaveLength(0);
  });

  it("passes the filter through as a filter", async () => {
    await adminBrainVocabulary.request("/surfaces?position=predicate&q=priced");
    expect((surfaceCalls[0] as { filter?: string }).filter).toBe("priced");
  });
});

describe("GET /in-force", () => {
  it("projects norms and counts, and no identity key", async () => {
    const res = await adminBrainVocabulary.request("/in-force");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(body);
    for (const key of ["subject_key", "predicate_key", "object_key", "subjectKey", "predicateKey"]) {
      expect(text, `the in-force body carries \`${key}\``).not.toContain(key);
    }
    expect(body.edges).toEqual([
      {
        position: "predicate",
        fromNorm: "is priced at",
        toNorm: "priced at",
        approvedBy: "user-1",
        approvedAt: "2026-08-08T00:00:00.000Z",
        hasRejectionMemory: true,
      },
    ]);
  });

  it("⚠️ REFUSES a key on the pass-through field rather than shipping it", async () => {
    // The assertion above is nearly vacuous on its own: the route maps `edges`
    // field-by-field, so the strict object never sees an extra key there, and
    // the clean mock supplies nothing to catch. `cardinalities` is the ONE field
    // passed through unmapped — so its strict schema is genuinely the only thing
    // between a leaked key and the browser, and this is the arm that proves it
    // fires.
    //
    // A 500 is the correct outcome: the read produced something Atlas cannot
    // stand behind, and `checked()` (not `checkedWrite`) is right here because
    // nothing was written.
    //
    // ⚠️ Caveat on the STATUS specifically: `runEffect` is mocked in this file,
    // so the 500 comes from Hono's default error handling rather than from the
    // app's real error mapping. The load-bearing assertion is therefore the one
    // below — that the key does not reach the body — not the number. The real
    // mapping is pinned in `runEffect`'s own tests.
    inForceOverride = {
      cardinalities: [
        {
          predicateSurface: "reports to",
          cardinality: "single",
          sourceClass: "human",
          proposedBy: "user-1",
          reviewedBy: "user-1",
          reviewedAt: "2026-08-08T00:00:00.000Z",
          claims: 2,
          // The leak, planted.
          predicate_key: "reports to",
        },
      ],
    };
    const res = await adminBrainVocabulary.request("/in-force");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("predicate_key");
  });

  it("carries the coverage counts the empty state needs", async () => {
    const res = await adminBrainVocabulary.request("/in-force");
    const body = (await res.json()) as { coverage: Record<string, number> };
    // `comparableFacts` is the number that turns "no proposals" into "the
    // producer had nothing to read". Without it the empty state can only make
    // the congratulatory claim.
    expect(body.coverage).toEqual({
      liveFacts: 47,
      comparableFacts: 0,
      pendingProposals: 0,
      pendingCardinalities: 0,
    });
  });
});

describe("POST /author", () => {
  it("returns the proposal id the removal will later stamp", async () => {
    const res = await post("/author", {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "authored",
      proposalId: "proposal-1",
      convergedOnProposal: false,
    });
  });

  it("⚠️ reports an already-approved pair WITHOUT inventing convergedOnProposal", async () => {
    // Removing the `already_approved` arm from the response schema left all 41
    // route tests green — the branch had no runtime coverage at all, and it is
    // the one round 1 changed substantively by dropping a hard-coded
    // `convergedOnProposal: true` that lied on the common double-submit.
    //
    // `toEqual` rather than `toMatchObject`: the ABSENT field is the property,
    // and only an exact comparison pins it.
    authorOutcome = { kind: "already_approved", id: "proposal-9" };
    const res = await post("/author", {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "already_approved",
      proposalId: "proposal-9",
    });
  });

  it("refuses an unknown position at the schema rather than in the seam", async () => {
    const res = await post("/author", { position: "verb", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(422);
    expect(authorCalls).toHaveLength(0);
  });

  it("refuses an extra field rather than stripping it", async () => {
    // `z.strictObject` on the REQUEST too. A stripped extra field is how a
    // client sends `predicateKey` and gets a 200 that silently ignored it —
    // and then believes the key was honoured.
    const res = await post("/author", {
      position: "predicate",
      fromNorm: "a",
      toNorm: "b",
      predicateKey: "smuggled",
    });
    expect(res.status).toBe(422);
    expect(authorCalls).toHaveLength(0);
  });

  describe("refusals are 4xx, and the RIGHT 4xx", () => {
    const cases = [
      { refusal: "not-entitled", status: 403 },
      { refusal: "workspace-mismatch", status: 403 },
      { refusal: "empty-population", status: 409 },
      { refusal: "previously-rejected", status: 409 },
      { refusal: "already-aliased", status: 409 },
      { refusal: "would-cycle", status: 409 },
      { refusal: "direction-conflict", status: 409 },
      { refusal: "degenerate-norm", status: 400 },
      { refusal: "self-edge", status: 400 },
    ] as const;

    for (const { refusal, status } of cases) {
      it(`maps ${refusal} to ${status}`, async () => {
        authorOutcome = {
          kind: "refused",
          refusal,
          message: `the seam's own prose for ${refusal}`,
        };
        const res = await post("/author", {
          position: "predicate",
          fromNorm: "a",
          toNorm: "b",
        });
        expect(res.status).toBe(status);
        const body = (await res.json()) as { error: string; message: string };
        // The typed code AND the prose. A client branching on the code still
        // renders the message, because the message is what names which side of
        // the pair is empty — and a client that authored its own sentence would
        // be a second spelling of a rule the server owns.
        expect(body.error).toBe(refusal);
        expect(body.message).toContain(refusal);
      });
    }

    // (The "never returns 200 for a refusal" assertion that used to sit here was
    // a restatement: the table above already pins an exact status for all nine
    // refusals, so it added no independent failure mode while inflating the
    // apparent coverage of the property it named.)
  });

  it("reports an in-flight decision as 409 rather than retrying it", async () => {
    authorOutcome = { kind: "not_decidable", id: "proposal-9" };
    const res = await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(409);
  });
});

describe("⚠️ a COMMITTED write whose response cannot be described", () => {
  // `checkedWrite` had no test of any kind: replacing both its call sites with
  // plain `checked()` left all 35 route tests green, which reinstates the round-1
  // defect verbatim — "Failed to author…" over a write that landed, followed by
  // a retry the approver reads as a second failure.
  //
  // The lever is an outcome whose shape the response schema refuses. The write
  // has already committed by the time the body is built, so the ONLY correct
  // report is "it landed, and we could not describe it".

  it("does not report an authored edge as a failed authoring", async () => {
    authorOutcome = {
      kind: "authored",
      id: "proposal-1",
      convergedOnProposal: "yes" as unknown as boolean,
    };
    const res = await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("response_schema_mismatch");
    // THE property: it says the change landed, and it does NOT say the verb
    // failed. A generic client reads the status; a human reads this.
    expect(body.message).toMatch(/succeeded and is in force/);
    expect(body.message).not.toMatch(/Failed to author/i);
    // …and it does not tell them to avoid retrying, because both write paths
    // are idempotent and answer 200 on a repeat.
    expect(body.message).toMatch(/retrying is safe/i);
    expect(body.requestId).toBe("test-req");
  });

  it("does the same for a committed removal", async () => {
    removeOutcome = {
      kind: "removed",
      id: "proposal-1",
      memoryCreated: "no" as unknown as boolean,
    };
    const res = await post("/remove", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("response_schema_mismatch");
    expect(body.message).toMatch(/succeeded and is in force/);
  });

  it("does the same for a committed curation, and calls it a PREDICATE", async () => {
    // The third committed write, and the one that was still on plain `checked()`
    // — it arms retroactive supersession for every future claim in the slot.
    cardinalityResult = { ok: true, cardinality: "sometimes" };
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("response_schema_mismatch");
    // ⚠️ A curation has NO PROPOSAL — it is an upsert on
    // `brain_predicate_cardinality`. The flat context rendered "proposal reports
    // to", handing the approver a nonexistent identifier from inside the helper
    // whose entire job is not lying to them about a committed write.
    expect(body.message).toContain('predicate "reports to"');
    expect(body.message).not.toContain("proposal");
  });

  it("POSITIVE CONTROL — a describable write is still a plain 200", async () => {
    // Without this, a `checkedWrite` that returned `ok: false` unconditionally
    // would satisfy all three assertions above and every write would 500.
    const res = await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(200);
  });
});

describe("POST /remove", () => {
  it("reports whether the rejection memory had to be created", async () => {
    removeOutcome = { kind: "removed", id: "proposal-1", memoryCreated: true };
    const res = await post("/remove", {
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "removed",
      proposalId: "proposal-1",
      memoryCreated: true,
    });
  });

  it("treats an already-removed pair as a 200, not a failure", async () => {
    // A double-clicked confirm button must not read as an error: the pair is in
    // the state the caller asked for, and `outcome` is what distinguishes it
    // from a removal that ran.
    removeOutcome = { kind: "already_removed", id: "proposal-1" };
    const res = await post("/remove", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("already_removed");
  });

  it("maps not-in-force to 409", async () => {
    removeOutcome = { kind: "refused", refusal: "not-in-force", message: "nothing to remove" };
    const res = await post("/remove", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(409);
  });
});

describe("POST /preview", () => {
  it("passes the request through and returns the discriminated union intact", async () => {
    const res = await post("/preview", {
      kind: "alias-approval",
      position: "predicate",
      fromNorm: "a",
      toNorm: "b",
    });
    expect(res.status).toBe(200);
    // ⚠️ The union must SURVIVE the wire. Flattened into one record with a
    // nullable reason, a client that read `floor` before checking the reason
    // renders "at least 0 today, and every future claim in this slot" for an
    // object-position alias — false, and the exact confident all-clear the
    // preview exists to prevent.
    expect(await res.json()).toEqual({
      radius: { kind: "structurally-empty", reason: "object-position" },
    });
  });

  it("returns a computed radius with its floor flag", async () => {
    blastRadius = {
      kind: "computed",
      arming: { total: 3, pairs: [], withheld: 3, truncated: false, countsConsistent: true },
      disarming: { total: 0, pairs: [], withheld: 0, truncated: false, countsConsistent: true },
      floor: true,
      subtreeTruncated: false,
    };
    const res = await post("/preview", { kind: "cardinality-flip", predicateSurface: "reports to" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { radius: { floor: boolean } };
    expect(body.radius.floor).toBe(true);
  });

  it("refuses a preview request carrying a predicate KEY", async () => {
    // `BlastRadiusRequest`'s own docstring calls a key-accepting request type
    // "the seam through which one reaches a route body", and this file is that
    // route body. The union is strict on every arm, so the key is refused
    // rather than ignored.
    const res = await post("/preview", { kind: "cardinality-flip", predicateKey: "reports to" });
    expect(res.status).toBe(422);
    expect(previewCalls).toHaveLength(0);
  });
});

describe("POST /cardinality", () => {
  it("curates a predicate through the surface-addressed seam", async () => {
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cardinality: "single" });
    // Addressed by SURFACE, never by key — `keys-not-on-the-wire.test.ts`'s
    // prohibition applied to a route body, and the reason the derivation lives
    // in `cardinality.ts` rather than here.
    expect(cardinalityCalls).toHaveLength(1);
    const call = cardinalityCalls[0] as { input: Record<string, unknown> };
    expect(call.input.predicateSurface).toBe("reports to");
    expect(call.input).not.toHaveProperty("predicateKey");
    // The workspace's OWN vocabulary is threaded through, not an identity
    // stand-in: curating an aliased spelling must land on its canonical target.
    expect(typeof call.input.predicateAlias).toBe("function");
  });

  it("⚠️ refuses a plain member, and never reaches the store", async () => {
    // THE gate this suite previously declared a knob for and never turned.
    // A `single` entry arms retroactive supersession for every future claim in
    // the slot, so an entitlement regression here is the gravest one on the
    // surface — and it was, until now, entirely uncovered.
    READER_ROLE = "member";
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not-entitled");
    expect(body.message).toContain("owner or admin");
    // Refused BEFORE the write, not after it.
    expect(cardinalityCalls).toHaveLength(0);
  });

  it("POSITIVE CONTROL — an admin clears the same bar", async () => {
    // Without this, a route that 403'd every caller would satisfy the arm above.
    READER_ROLE = "admin";
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(200);
    expect(cardinalityCalls).toHaveLength(1);
  });

  it("admits the local operator on a no-auth deployment", async () => {
    // `unauthenticated-local` is the DEFAULT self-hosted deploy mode. A
    // regression here makes predicate curation impossible on every self-hosted
    // install, and nothing else in this suite exercises the origin.
    READER_ORIGIN = "unauthenticated-local";
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(200);
    const call = cardinalityCalls[0] as { input: Record<string, unknown> };
    // `local-operator`, not null and not a user id — migration 0192's sentinel,
    // so an audit of a retroactive re-key can tell a human from a machine.
    expect(call.input.authoredBy).toBe("local-operator");
  });

  it("refuses an unresolved reader, and says that is why", async () => {
    READER_ORIGIN = "unresolved";
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "single",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/resolved reader identity/);
    expect(cardinalityCalls).toHaveLength(0);
  });

  it("maps the two reachable store refusals to 400", async () => {
    // `degenerate-key` and `unattributed` are the only refusals direct authoring
    // can produce — `DeclarationResult` narrows to exactly those, which is why
    // this route declares no 409.
    for (const refusal of ["degenerate-key", "unattributed"] as const) {
      cardinalityCalls.length = 0;
      cardinalityResult = { ok: false, refusal, message: `prose for ${refusal}` };
      const res = await post("/cardinality", {
        predicateSurface: "reports to",
        cardinality: "single",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(refusal);
    }
  });

  it("un-curates with `multi` — the adjudicated record that values coexist", async () => {
    cardinalityResult = { ok: true, cardinality: "multi" };
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "multi",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cardinality: "multi" });
  });

  it("refuses a cardinality outside the two-member vocabulary", async () => {
    const res = await post("/cardinality", {
      predicateSurface: "reports to",
      cardinality: "sometimes",
    });
    expect(res.status).toBe(422);
    expect(cardinalityCalls).toHaveLength(0);
  });

  it("refuses a request carrying a predicate KEY instead of a surface", async () => {
    const res = await post("/cardinality", { predicateKey: "reports to", cardinality: "single" });
    expect(res.status).toBe(422);
    expect(cardinalityCalls).toHaveLength(0);
  });
});

describe("entitlement on the alias verbs", () => {
  it("a member's authoring is refused by the seam, and the route reports 403", async () => {
    // The route delegates the bar to `authorAliasEdge`, so this pins the
    // MAPPING rather than the rule — but the knob is now genuinely exercised at
    // both roles, which it was not before.
    READER_ROLE = "member";
    authorOutcome = {
      kind: "refused",
      refusal: "not-entitled",
      message: "Authoring an alias needs the owner or admin entitlement",
    };
    const res = await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(403);
  });
});

describe("the org guard", () => {
  it("400s every route when there is no active organization", async () => {
    ORG_ID = undefined;
    // `requireOrgContext` already 400s an org-less request; these arms keep the
    // reads from ever running without a tenant boundary if that guard moves.
    expect((await adminBrainVocabulary.request("/in-force")).status).toBe(400);
    expect((await adminBrainVocabulary.request("/surfaces?position=predicate")).status).toBe(400);
    expect((await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" })).status).toBe(
      400,
    );
    expect(authorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The Pending queue and its decide verb (#5088)
// ---------------------------------------------------------------------------

/** One pending alias entry as the loader produces it. */
const pendingAlias = (over: Record<string, unknown> = {}) => ({
  kind: "alias" as const,
  id: "proposal-7",
  position: "predicate" as const,
  pair: ["is priced at", "priced at"] as [string, string],
  direction: null,
  sourceClass: "seam",
  proposedBy: "brain:alias-proposal",
  proposedAt: "2026-08-09T00:00:00.000Z",
  rank: 0.67,
  evidence: {
    kind: "structural" as const,
    subjects: 2,
    scopedSubjects: 2,
    withheld: 0,
    examples: [
      { subject: "widget", object: "10 USD", fromPredicate: "is priced at", toPredicate: "priced at" },
    ],
    threshold: 2,
    countsConsistent: true,
  },
  ...over,
});

describe("GET /pending", () => {
  it("passes the shared filters through and reports the disclosure counts", async () => {
    pendingQueue = {
      ...pendingQueue,
      entries: [pendingAlias()],
      aliasCounts: [
        {
          position: "predicate",
          decision: "unscoped",
          total: 3,
          scoped: 1,
          withheld: 2,
          consistent: false,
        },
      ],
    };
    const res = await adminBrainVocabulary.request(
      "/pending?kind=alias&position=predicate&limit=10",
    );
    expect(res.status).toBe(200);
    expect(pendingCalls[0]).toMatchObject({ kind: "alias", position: "predicate", limit: 10 });
    const body = (await res.json()) as {
      entries: { direction: unknown }[];
      aliasCounts: Record<string, unknown>[];
    };
    // ⚠️ The wire renames `decision` → `scope` and `consistent` →
    // `countsConsistent`. The In-force pane maps the same four numbers, and one
    // mapper does both — a second copy is how one pane ends up saying
    // "workspace-wide" for a read the other calls "scoped to you".
    expect(body.aliasCounts[0]).toEqual({
      position: "predicate",
      scope: "unscoped",
      total: 3,
      scoped: 1,
      withheld: 2,
      countsConsistent: false,
    });
    // ⚠️ `null` survives the wire. The whole direction AC rests on a client
    // having nothing to prefill from, and a schema that dropped the field or
    // defaulted it would be invisible until an approver approved a guess.
    expect(body.entries[0]!.direction).toBeNull();
  });

  it("refuses an unknown kind at the schema rather than in the loader", async () => {
    const res = await adminBrainVocabulary.request("/pending?kind=everything");
    expect(res.status).toBe(422);
    expect(pendingCalls).toHaveLength(0);
  });

  it("REFUSES a response carrying an identity key rather than stripping it", async () => {
    // Every response object on this surface is `z.strictObject` precisely
    // because the extra key those exist to refuse is a norm-adjacent identity
    // KEY — `z.object` would strip it and ship a 200 that silently dropped the
    // field, and `keys-not-on-the-wire.test.ts` cannot see a runtime shape.
    pendingQueue = {
      ...pendingQueue,
      entries: [pendingAlias({ predicateKey: "priced at" })],
    };
    const res = await adminBrainVocabulary.request("/pending");
    expect(res.status).toBe(500);
  });
});

describe("POST /decide", () => {
  it("⚠️ sends NO direction when the client sent none — never the stored pair", async () => {
    // THE falsifier for the AC. `resolveDirection` refuses an undirected
    // proposal that supplies no direction; a route with a `?? entry.pair`
    // fallback would satisfy that refusal with an ordering nobody chose, and no
    // test of the SEAM could ever see it because the seam would receive a
    // perfectly valid direction.
    decideOutcome = {
      kind: "refused",
      id: "proposal-7",
      refusal: "direction-required",
      message: "Proposal proposal-7 is undirected — approval must supply the direction",
    };
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "approved",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("direction-required");
    expect(body.message).toContain("undirected");
    expect(decideCalls).toHaveLength(1);
    expect((decideCalls[0] as { direction?: unknown }).direction).toBeUndefined();
  });

  it("passes a supplied direction through verbatim", async () => {
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "approved",
      direction: { fromNorm: "is priced at", toNorm: "priced at" },
    });
    expect(res.status).toBe(200);
    expect(decideCalls[0]).toMatchObject({
      id: "proposal-7",
      decision: "approved",
      direction: { fromNorm: "is priced at", toNorm: "priced at" },
    });
    expect(await res.json()).toEqual({ outcome: "approved", proposalId: "proposal-1" });
  });

  it("maps direction-conflict to 409 — a directed proposal is never flipped", async () => {
    decideOutcome = {
      kind: "refused",
      id: "proposal-7",
      refusal: "direction-conflict",
      message: "A directed proposal is not flipped at approval",
    };
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "approved",
      direction: { fromNorm: "priced at", toNorm: "is priced at" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("direction-conflict");
  });

  it("refuses a direction sent with a REJECTION at the schema", async () => {
    // `AliasDecisionRequest` splits the two arms so a direction is not
    // representable on a rejection: *a field that is representable-and-ignored
    // is a field a caller will eventually believe in.* The wire schema makes the
    // same split rather than accepting and discarding it.
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "rejected",
      direction: { fromNorm: "a", toNorm: "b" },
    });
    expect(res.status).toBe(422);
    expect(decideCalls).toHaveLength(0);
  });

  it("reports a REMOVAL distinctly from a plain rejection", async () => {
    decideOutcome = { kind: "rejected", id: "proposal-7", removedEdge: true };
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "rejected",
    });
    expect(res.status).toBe(200);
    // Both transitions leave permanent rejection memory; only this one dropped
    // an edge and re-keyed the corpus, and an approver told merely "rejected"
    // would not know that happened.
    expect(await res.json()).toEqual({
      outcome: "rejected",
      proposalId: "proposal-7",
      removedEdge: true,
    });
  });

  it("⚠️ a REJECTION is never described as an authoring in force", async () => {
    // `checkedWrite`'s 500 arm, reached by making the response fail its own
    // schema: `removedEdge` must be a boolean, so a string trips `safeParse`
    // after the transaction has committed. That is the ONE path that renders the
    // verb, and it is why this defect survived two rounds — the route tests
    // covered `/author`, `/remove` and `/cardinality`, and no test reached the
    // alias-rejection arm at all.
    //
    // The verb matters because the approver REJECTED a pair. Told "The authoring
    // succeeded and is in force — proposal abc", they read a workspace-wide
    // re-key that did not happen: the worst-direction misreport of a committed
    // write, which is the single thing `checkedWrite` exists to prevent.
    decideOutcome = {
      kind: "rejected",
      id: "proposal-7",
      // ⚠️ FALSY and non-boolean. `""` picks the `rejection` verb (the route
      // branches on truthiness) and still fails `z.boolean()`. A truthy string
      // would take the `removal` arm and test the wrong sentence — which is what
      // the first cut of this test did.
      removedEdge: "" as unknown as boolean,
    };
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "rejected",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("response_schema_mismatch");
    expect(body.message).toContain("The rejection was recorded");
    // ⚠️ Both halves. A verb fix that left the sentence saying "is in force"
    // would swap one false claim for another.
    expect(body.message).not.toContain("authoring");
    expect(body.message).not.toContain("is in force");
  });

  it("a REMOVAL keeps its own verb — it really did drop an edge", async () => {
    // The control: `removedEdge: true` is a removal, not a rejection, and it DID
    // put something back. Without this, mapping every rejection to "rejection"
    // would satisfy the test above while losing the distinction.
    decideOutcome = {
      kind: "rejected",
      id: "proposal-7",
      removedEdge: 1 as unknown as boolean,
    };
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "rejected",
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toContain("The removal succeeded");
  });

  it("reports a lost race as `nothing_to_decide` with a 200", async () => {
    decideOutcome = { kind: "not_decidable", id: "proposal-7" };
    const res = await post("/decide", {
      kind: "alias",
      proposalId: "proposal-7",
      decision: "approved",
      direction: { fromNorm: "a", toNorm: "b" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "nothing_to_decide" });
  });

  describe("the cardinality arm", () => {
    it("applies the owner/admin bar AT THE ROUTE and 403s a member", async () => {
      // `decidePredicateCardinality` has no entitlement check and says so —
      // *"Entitlement is the CALLER's to enforce"* — so the bar lives here, at
      // the same level `/cardinality` applies it. Deleting this branch is a
      // silent authority hole: the seam would decide happily.
      READER_ROLE = "member";
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "reports to",
        decision: "approved",
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("not-entitled");
      expect(cardinalityDecideCalls).toHaveLength(0);
    });

    it("addresses the row by SURFACE and answers `nothing_to_decide` on a lost race", async () => {
      cardinalityDecided = "not-pending";
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "reports to",
        decision: "approved",
      });
      expect(res.status).toBe(200);
      // ⚠️ Never the verb the caller asked for. `WHERE status = 'pending'` makes
      // two reviewers racing one proposal produce one decision and one no-op,
      // and reporting the no-op as `approved` would credit the loser with
      // arming retroactive supersession.
      // ⚠️ No `removedEdge`. The union carries it only on the `rejected` arm, so
      // the route cannot invent `false` here — which is what the flat shape
      // forced it to do on three of its four paths.
      expect(await res.json()).toEqual({
        outcome: "nothing_to_decide",
        proposalId: null,
      });
      expect(cardinalityDecideCalls[0]!.input).toMatchObject({
        predicateSurface: "reports to",
        verdict: "approved",
      });
    });

    it("refuses a request carrying a predicate KEY rather than stripping it", async () => {
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "reports to",
        decision: "approved",
        predicateKey: "smuggled",
      });
      expect(res.status).toBe(422);
      expect(cardinalityDecideCalls).toHaveLength(0);
    });

    it("⚠️ an UNADDRESSABLE surface is a 400, never `nothing_to_decide`", async () => {
      // The seam's three-way result exists for this: a surface that norms away
      // addresses no row, and folding it into the race arm made the client say
      // "someone else got there first" — a confident, specific, wrong
      // explanation for a request that never reached a row at all.
      cardinalityDecided = "unaddressable";
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "---",
        decision: "approved",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("degenerate-key");
      expect(body.message).toContain("normalizes away");
    });

    it("a COMMITTED curation answers 200 with the approved arm", async () => {
      // ⚠️ Renamed. It was called "…when its response will not build" and never
      // made the response fail to build — `checkedWrite`'s 500 arm is not
      // reachable from here, so the old title described coverage the test did
      // not have. What it does measure is the split: `checkedWrite` on the arm
      // that WROTE, `checked` on the one that did not.
      cardinalityDecided = "decided";
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "reports to",
        decision: "approved",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "approved", proposalId: null });
    });

    it("⚠️ a REJECTION answers the rejected arm, and reaches the seam as a rejection", async () => {
      // ⚠️ Every other test in this block sends `decision: "approved"` — the 403,
      // the lost race, the key-smuggling 422, the `unaddressable` 400, the
      // committed 200 and the `never` default. Collapsing this arm to always
      // answer `{ outcome: "approved" }` left all 61 of them green.
      //
      // That is verbatim the defect a round-3 commit fixed on the ALIAS half,
      // whose own message reads: *"An alias REJECTION was described as an
      // authoring in force… It survived two rounds because no test reached the
      // alias-rejection arm at all."* The fix landed on both halves. The
      // falsifier landed on one.
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "reports to",
        decision: "rejected",
      });
      expect(res.status).toBe(200);
      // ⚠️ `removedEdge: false` and NOT absent: the wire union carries the field
      // on the rejected arm only, so this is the one arm where it is readable —
      // and a cardinality rejection removes no edge, which is what it says.
      expect(await res.json()).toEqual({
        outcome: "rejected",
        proposalId: null,
        removedEdge: false,
      });
      // …and the verdict reached the seam as itself rather than as the route's
      // default. A rejection recorded as an approval arms retroactive
      // supersession for every future claim in the slot.
      expect(cardinalityDecideCalls).toHaveLength(1);
      expect((cardinalityDecideCalls[0]!.input as { verdict: string }).verdict).toBe("rejected");
    });

    it("⚠️ a result this route does not recognise REFUSES, never falls through to success", async () => {
      // The `never` default, exercised. A fourth member of
      // `CardinalityDecisionResult` is what this models — the seam growing a
      // result the route has not been taught — and the honest answer to it is a
      // 500 with a requestId, not the strongest success string in the file.
      //
      // Reachable only because the mock's field is typed `string`; with the
      // union's own type nothing can inject this, which is exactly why the
      // branch was unfalsified.
      cardinalityDecided = "quantum-superposed" as CardinalityDecisionResult;
      const res = await post("/decide", {
        kind: "cardinality",
        predicateSurface: "reports to",
        decision: "approved",
      });
      expect(res.status).toBe(500);
      // ⚠️ The CAUSE, not the body. An earlier version of this test asserted
      // `not.toContain("approved")` on the body and explained the missing
      // `requestId` envelope as `app.onError` not being mounted. Both were
      // wrong: the envelope comes from `runEffect` (`lib/effect/hono.ts`), which
      // THIS FILE mocks away — so the body is Hono's constant `text/plain`
      // "Internal Server Error" for every possible cause, and an assertion on it
      // can never fail while the status is 500. The cause is what distinguishes
      // "the `never` default fired" from "something threw".
      expect(lastDefect).toContain("Unhandled cardinality decision result");
      expect(lastDefect).toContain("quantum-superposed");
    });
  });
});

describe("the queue response cannot fabricate a count for a kind nobody asked about", () => {
  it("⚠️ carries `cardinalityCounts: null` rather than a zeroed record", async () => {
    // The loader returns `null` when the caller filtered the cardinality half
    // out. Zeroed, the client rendered "curated predicates · 0 of 0" with a
    // clean scope badge — a fabricated zero asserted as a fact, on the surface
    // whose whole purpose is what is awaiting a decision.
    pendingQueue = { ...pendingQueue, cardinalityCounts: null };
    const res = await adminBrainVocabulary.request("/pending?kind=alias");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cardinalityCounts: null });
  });

  it("reports a CAPPED page and a DROPPED row as different facts", async () => {
    // Two remedies: filtering reaches a capped page and reaches nothing that was
    // dropped for failing to narrow. One boolean made the client state the first
    // remedy for both.
    pendingQueue = { ...pendingQueue, truncated: true, incomplete: true };
    const body = (await (await adminBrainVocabulary.request("/pending")).json()) as {
      truncated: boolean;
      incomplete: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.incomplete).toBe(true);
  });
});
