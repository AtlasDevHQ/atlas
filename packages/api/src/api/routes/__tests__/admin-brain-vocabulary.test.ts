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

const CURRENT_ORG = "org-1";

// `resolvePrincipalContext` runs FOR REAL against this handle, so the reader
// context the handlers pass down is the real wiring rather than a stub of it.
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

// The reader context. Mocked rather than driven through the member tables
// because THIS file's assertions are about the router's branching, and the
// resolver's own contract is pinned in `reader-context.test.ts`.
let READER_ROLE: "owner" | "admin" | "member" = "owner";
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  resolveBrainReaderContext: async () => ({
    origin: "authenticated" as const,
    workspaceId: CURRENT_ORG,
    userId: "user-1",
    role: READER_ROLE,
    audienceIds: [] as readonly string[],
  }),
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
  decideAliasProposal: async () => ({ kind: "not_decidable", id: "x" }),
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
    truncated: false,
  }),
  loadVocabularyCoverage: async () => ({
    liveFacts: 47,
    comparableFacts: 0,
    pendingProposals: 0,
    pendingCardinalities: 0,
  }),
  IN_FORCE_PAGE_MAX: 200,
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

const { adminBrainVocabulary } = await import("../admin-brain-vocabulary");

const post = (path: string, body: unknown) =>
  adminBrainVocabulary.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  READER_ROLE = "owner";
  ORG_ID = CURRENT_ORG;
  authorCalls.length = 0;
  removeCalls.length = 0;
  surfaceCalls.length = 0;
  previewCalls.length = 0;
  authorOutcome = { kind: "authored", id: "proposal-1", convergedOnProposal: false };
  removeOutcome = { kind: "removed", id: "proposal-1", memoryCreated: false };
  blastRadius = { kind: "structurally-empty", reason: "object-position" };
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
    const res = await adminBrainVocabulary.request("/surfaces?position=nonsense");
    expect(res.status).toBe(400);
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
    // The response is parsed through a `z.strictObject` on the way out, so a
    // producer that attached a key would 500 here rather than shipping it.
    // Asserting the serialized text keeps that true for nested objects too.
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

    it("never returns 200 for a refusal", async () => {
      // THE property. A failed write behind a 200 is read as success by every
      // generic client in the stack.
      authorOutcome = { kind: "refused", refusal: "empty-population", message: "nope" };
      const res = await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" });
      expect(res.status).not.toBe(200);
    });
  });

  it("reports an in-flight decision as 409 rather than retrying it", async () => {
    authorOutcome = { kind: "not_decidable", id: "proposal-9" };
    const res = await post("/author", { position: "predicate", fromNorm: "a", toNorm: "b" });
    expect(res.status).toBe(409);
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
    expect((await res.json()).outcome).toBe("already_removed");
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
