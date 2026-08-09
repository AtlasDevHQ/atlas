/**
 * The **Claim Vocabulary** admin surface — direct authoring and the *In force*
 * pane (#5087, ADR-0037 §6, umbrella #5025).
 *
 * Mounted under `/api/v1/admin/brain-vocabulary`:
 *
 *   GET  /surfaces     — the authoring picker: norms the corpus actually produced
 *   GET  /in-force     — approved edges + curated cardinalities, plus coverage
 *   POST /preview      — one decision's blast radius (child 1's engine)
 *   POST /author       — write an alias edge directly
 *   POST /remove       — take one back out
 *   POST /cardinality  — curate or un-curate a canonical predicate
 *
 * ## What this surface is FOR, and why it ships before the queue
 *
 * The Pending queue is empty on day one: `#5034`'s producer fires only on claims
 * with a non-null `object_cmp`, and *"on day one it returns zero rows"*.
 * Cardinality needs three correction events. **Direct authoring works from day
 * one** and is, per T7 §6, the only route by which #5000's own entry
 * (`is priced at → priced at`) is ever written — the structural proposer
 * provably cannot propose it, and that zero is pinned as a test.
 *
 * So this half does something the day it ships, and #5000 closes on **prod
 * verification**, which needs a surface that can show the edge in force.
 *
 * ## Two authorities, and both are enforced
 *
 * `adminAuth` gates the router at admin/owner/platform_admin. That is coarse —
 * it reads the SESSION's role — so every write also passes the workspace's own
 * re-resolved principal (`resolveBrainReaderContext`, which re-resolves
 * `member.role` against the workspace being written, #2890) to the seam, where
 * `authorEntitled` applies ADR-0037 §6's owner/admin bar. Neither is redundant:
 * the router keeps a non-admin session out of the surface, the seam keeps an
 * admin of ANOTHER workspace out of this one's vocabulary.
 *
 * ## Refusals are 4xx, never a 200 carrying `outcome: "refused"`
 *
 * `refusalStatus` below maps every typed refusal onto a status, and the seam's
 * prose travels verbatim in `ErrorSchema.message`. Two reasons, and the second
 * is the load-bearing one: a failed write behind a 200 is read as success by
 * every generic client in the stack; and the messages name WHICH side of a pair
 * is empty, WHICH norm is already aliased, and what to do instead — so a client
 * that mapped a code to its own sentence would be a second spelling of a rule
 * the server owns.
 *
 * ## No key ever reaches a body
 *
 * Every request and response here speaks SURFACES and NORMS.
 * `keys-not-on-the-wire.test.ts` is the guard and ADR-0037 §6 is the rule: a
 * consumer that can branch on a claim's identity key makes the vocabulary a
 * compatibility surface, at which point an alias stops being removable. The
 * cardinality routes take a `predicateSurface` and derive the key server-side
 * for exactly that reason — `BlastRadiusRequest`'s own docstring calls a
 * key-accepting request type *"the seam through which one reaches a route
 * body"*, and this file is that route body.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { isSlotPosition, type SlotPosition } from "@atlas/api/lib/brain/identity";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import {
  OBSERVED_SURFACE_PAGE_MAX,
  loadObservedSurfaces,
} from "@atlas/api/lib/brain/vocabulary-surfaces";
import {
  loadInForceVocabulary,
  loadVocabularyCoverage,
} from "@atlas/api/lib/brain/vocabulary-in-force";
import { loadBlastRadius } from "@atlas/api/lib/brain/vocabulary-preview";
import {
  authorAliasEdge,
  removeInForceAliasEdge,
  type AliasAuthoringRefusal,
  type AliasRemovalRefusal,
} from "@atlas/api/lib/brain/vocabulary-decide";
import {
  declarePredicateCardinalityForSurface,
  type CardinalityRefusal,
} from "@atlas/api/lib/brain/cardinality";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { AuthMode } from "@useatlas/types";
import {
  BRAIN_VOCABULARY_SLOT_POSITIONS,
  BrainVocabularyAuthorRequestSchema,
  BrainVocabularyAuthorResponseSchema,
  BrainVocabularyCardinalityRequestSchema,
  BrainVocabularyCardinalityWriteResponseSchema,
  BrainVocabularyInForceResponseSchema,
  BrainVocabularyPreviewRequestSchema,
  BrainVocabularyPreviewResponseSchema,
  BrainVocabularyRemoveRequestSchema,
  BrainVocabularyRemoveResponseSchema,
  BrainVocabularySurfaceListSchema,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";

/**
 * Every response is parsed through its own wire schema before it goes out.
 *
 * `admin-brain-facts.ts`'s `checked` verbatim, and for its reason: Hono does not
 * validate responses, so without this the shared schema is a promise the API
 * makes and never checks — and the browser is where it fails, as a
 * `schema_mismatch` that blanks the surface with no server-side trace.
 *
 * It matters more here than there. Every response object on this surface is
 * `z.strictObject`, and the extra key those strict objects exist to refuse is a
 * norm-adjacent identity KEY: an EXTRA field is normally stripped by `z.object`
 * and would ship silently.
 */
function checked<T>(schema: { parse: (value: unknown) => T }, payload: unknown): T {
  return schema.parse(payload);
}

/** The workspace-resolved principal every read and write on this surface uses. */
function approverContext(
  mode: AuthMode,
  user: AtlasUser | undefined,
  orgId: string,
  requestId: string,
) {
  return Effect.tryPromise({
    try: () =>
      resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

/**
 * Refusal → HTTP status.
 *
 * `admin-brain-facts.ts`'s `refusalStatus` shape and its semantics: request
 * shape is 400, authority is 403, and a target-state mismatch is 409 — *"try
 * again after fixing the target"*, because the state can change out from under
 * the client.
 *
 * `previously-rejected` is the one that reads oddly as a 409 and is one anyway:
 * 0190's rejection memory is PERMANENT (#4507), so nothing the client does
 * clears it — but it is still a statement about the target rather than about the
 * request, and the message says the recovery is a database console. It shares
 * that shape with `warehouseTarget` next door, which is likewise not
 * client-fixable.
 */
function refusalStatus(
  refusal: AliasAuthoringRefusal | AliasRemovalRefusal | CardinalityRefusal,
): 400 | 403 | 409 {
  switch (refusal) {
    case "not-entitled":
    case "workspace-mismatch":
      return 403;
    case "degenerate-norm":
    case "self-edge":
    case "confidence-out-of-range":
    case "warehouse-key-at-predicate":
    case "degenerate-key":
    case "unattributed":
    case "producer-proposed-multi":
      return 400;
    case "empty-population":
    case "previously-rejected":
    case "already-aliased":
    case "would-cycle":
    case "direction-conflict":
    case "direction-not-in-pair":
    case "not-in-force":
    case "already-decided":
      return 409;
    default: {
      // A new refusal member must be MAPPED, not defaulted. A `?? 400` here
      // would give an authority denial the status of a typo the first time
      // somebody adds one — which is the wrong direction for a surface whose
      // refusals are the only thing standing between an admin and a
      // workspace-wide re-key.
      const unexpected: never = refusal;
      throw new Error(`Unhandled vocabulary refusal: ${JSON.stringify(unexpected)}`);
    }
  }
}

/** The refusal body — the seam's own prose, its code, and a requestId. */
function refusalBody(
  refusal: AliasAuthoringRefusal | AliasRemovalRefusal | CardinalityRefusal,
  message: string,
  requestId: string,
) {
  return { error: refusal, message, requestId };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const commonResponses = {
  400: {
    description: "Invalid request — malformed norms, or no active organization",
    content: { "application/json": { schema: ErrorSchema } },
  },
  401: {
    description: "Authentication required",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  403: {
    description:
      "Forbidden — direct authoring and removal need the owner or admin entitlement (ADR-0037 §6), re-resolved against the workspace being written rather than read off the session",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  404: {
    description: "Internal database not configured",
    content: { "application/json": { schema: ErrorSchema } },
  },
  500: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const surfacesRoute = createRoute({
  method: "get",
  path: "/surfaces",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Norms the corpus has actually produced at a slot position",
  description:
    "The authoring picker. Returns the lexical norms present in live `brain_facts` rows at one slot position, each with the most common surface that folds into it, its live claim count, and how many distinct spellings it merges. " +
    "⚠️ Authoring is a PICKER and never a norm text box, and this endpoint is why. `lexicalNorm` is ASCII-only case folding with a specific separator class, so a human cannot reliably predict what the pipeline produced from `499 a month` vs `499 A Month` vs `499-a-month` — and a wrong guess authors an edge whose `from_norm` no fact has ever produced. It inserts cleanly, the closure recomputes, the re-key moves zero rows and the preview reads 0: indistinguishable from a merge that worked. `q` FILTERS this list; it never supplies a value. " +
    "Scoped by the positional-visibility rule: predicate-position surfaces are workspace-scoped only (a verb phrase discloses nothing an approver could not guess), entity-position surfaces are gated by the reader's own fail-closed visibility predicate. `truncated` means the corpus has more norms than this page carries — filter rather than concluding a spelling is absent.",
  request: {
    query: z.object({
      position: z
        .string()
        .openapi({ description: `One of: ${BRAIN_VOCABULARY_SLOT_POSITIONS.join(", ")}` }),
      q: z
        .string()
        .optional()
        .openapi({ description: "Case-insensitive substring filter over the surface and the norm" }),
      limit: z
        .string()
        .optional()
        .openapi({ description: `Maximum norms (default and max ${OBSERVED_SURFACE_PAGE_MAX})` }),
    }),
  },
  responses: {
    200: {
      description: "Norms observed at this position, most-used first",
      content: { "application/json": { schema: BrainVocabularySurfaceListSchema } },
    },
    ...commonResponses,
  },
});

const inForceRoute = createRoute({
  method: "get",
  path: "/in-force",
  tags: ["Admin — Claim Vocabulary"],
  summary: "What is currently shaping identity",
  description:
    "Approved alias edges and curated predicate cardinalities currently in force, plus the coverage numbers the empty state needs. " +
    "Carries the SAME positional-visibility rule the pending queue uses, applied to populations: predicate-position edges unscoped, entity-position edges reader-scoped on BOTH sides — re-derived at read time by joining `brain_facts` on the two norms, because `brain_vocabulary_proposal` stores no fact ids and the vocabulary is permanently ACL-less (ADR-0037 §6, correcting T11 §5(b)). " +
    "`counts` carries a WITHHELD count per position, never a silent omission: the vocabulary is workspace-global, so its SIZE is not a secret even when its contents are, and an approver must be able to tell \"12 entity edges you cannot see\" from \"none\". `countsConsistent` reports a concurrent write that made the two statements disagree, rather than clamping the delta to a reassuring zero. " +
    "⚠️ An entity edge invisible to you is also UN-REMOVABLE by you. That hole is fail-closed and correct, and it is logged server-side rather than skipped silently — a workspace whose only admin cannot see a bad edge's populations has no in-product recovery path. " +
    "`coverage` is what makes the empty state a coverage statement rather than a congratulation: there is no caught-up state for a vocabulary, only what has been decided and what has not yet been observed. `comparableFacts` is why Pending is empty specifically — the structural proposer fires only on claims with comparable objects.",
  responses: {
    200: {
      description: "Edges, cardinalities, per-position disclosure counts, and coverage",
      content: { "application/json": { schema: BrainVocabularyInForceResponseSchema } },
    },
    ...commonResponses,
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  tags: ["Admin — Claim Vocabulary"],
  summary: "One decision's blast radius",
  description:
    "The counterfactual behind every approval and every removal on this surface (#5086): what becomes supersedable if you do this, and what becomes safe again. A removal is a re-key too, so it carries the same preview an approval does — on the `disarming` side. " +
    "The answer is a DISCRIMINATED union. `structurally-empty` means the counterfactual cannot produce pairs by construction and says which of five reasons — an object-position alias (the collision never reads `object_key`, so such an alias changes what corroborates, not what supersedes), a predicate already curated `single`, a predicate never curated at all, a surface that norms away to nothing, or a removal naming a norm with no approved parent. Those are NOT zeros: \"0 pairs\" and \"this decision cannot produce pairs\" are the same number and opposite facts. " +
    "`computed` carries both deltas, each with a workspace-wide `total`, a reader-scoped bounded sample gated on BOTH sides, a `withheld` count, and `countsConsistent`. `floor` is always true and must be rendered as one: a cardinality flip is not a batch — it applies to every future claim in the slot. `subtreeTruncated` means the alias subtree walk hit the depth bound, so both sides describe a smaller population than was asked about. " +
    "Takes a predicate SURFACE, never a predicate key.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyPreviewRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The blast radius",
      content: { "application/json": { schema: BrainVocabularyPreviewResponseSchema } },
    },
    ...commonResponses,
  },
});

const authorRoute = createRoute({
  method: "post",
  path: "/author",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Write an alias edge directly",
  description:
    "Direct human authoring (ADR-0037 §6) — the only route by which #5000's own entry is ever written, since the structural proposer provably cannot propose it. " +
    "Writes THROUGH the proposal table: a `human`-sourced proposal decided `approved` in the SAME transaction. Writing the edge directly would be one line shorter and would leave a later removal with no row to stamp `rejected` on, so the next producer run re-proposes the pair a human just deleted — #4507's failure returning through the one path authoring exists to serve. " +
    "Atomic: the proposal row, the edge, the closure rebuild and the workspace-wide drift re-key commit together or not at all. A failing re-key leaves no proposal row and no edge. " +
    "REFUSED when either norm has no live claim at that position, and the refusal names which side is empty — an alias for a norm the corpus has never produced is indistinguishable from a merge that worked. Also refused for a pair carrying permanent rejection memory: authoring over a removal would make every removal undoable by the next producer run. " +
    "Converges on an existing pending proposal rather than inserting a second row — migration 0190's unordered-pair constraint makes that not a choice — and refuses to silently flip a producer's directed proposal.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyAuthorRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "The edge is approved and in force. `convergedOnProposal` says whether the decision landed on a proposal a producer had already queued",
      content: { "application/json": { schema: BrainVocabularyAuthorResponseSchema } },
    },
    ...commonResponses,
    409: {
      description:
        "The edge cannot be authored — a side with no live claim, a pair carrying permanent rejection memory, a norm that already has an approved parent, an edge that would close a cycle, or a direction that contradicts an existing directed proposal. The message says which and what to do instead",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const removeRoute = createRoute({
  method: "post",
  path: "/remove",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Take an alias edge back out of force",
  description:
    "Removal is a RECOMPUTATION rather than a destructive write (ADR-0037 §6): the edge is dropped, the position's closure is rebuilt from what remains — so an edge this one was hiding lands back on its prior target — and every affected claim is re-keyed from its SURFACE, which is the only expression that gets the undo direction right. " +
    "It leaves permanent rejection memory, and that is what makes it stick: without it a producer re-writes what a human removed. An edge the region importer copied travels without its proposal row (#5035), so this route CREATES the memory in that case rather than removing an edge nothing can remember — `memoryCreated` says when it did. " +
    "Addressed by PAIR, in either order: the edge's own stored order decides which norm is the child. Needs the same owner/admin entitlement authoring does — a removal is the graver verb of the two.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyRemoveRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The edge is gone, the closure is rebuilt, and the corpus is re-keyed",
      content: { "application/json": { schema: BrainVocabularyRemoveResponseSchema } },
    },
    ...commonResponses,
    409: {
      description: "No approved edge joins this pair at this position",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const cardinalityRoute = createRoute({
  method: "post",
  path: "/cardinality",
  tags: ["Admin — Claim Vocabulary"],
  summary: "Curate or un-curate a canonical predicate",
  description:
    "Direct human authoring of a predicate's cardinality (ADR-0037 §3(d)3) — the human IS the approval, so this writes `approved` in one step. " +
    "⚠️ **The blast radius is retroactive.** Flipping a predicate to `single` makes every existing published pair in that slot supersedable at the NEXT publish, with no per-row record of the regime each fact was written under — so call `/preview` with `cardinality-flip` first and render its count as the FLOOR it is. " +
    "`multi` is the un-curation: the adjudicated record that values coexist, and the only way to take a predicate back out of `single` short of deletion. Absent from the table already MEANS `multi`, so a stored `multi` is a human declining the question. " +
    "Takes a predicate SURFACE. The canonical key is derived server-side through the workspace's own vocabulary, so the alias closure is applied — curating `is priced at` after `is priced at → priced at` is approved correctly curates `priced at`.",
  request: {
    body: {
      content: { "application/json": { schema: BrainVocabularyCardinalityRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The entry is approved and in force",
      content: { "application/json": { schema: BrainVocabularyCardinalityWriteResponseSchema } },
    },
    ...commonResponses,
    409: {
      description:
        "The predicate already carries an entry this write may not overwrite. Reachable through `declarePredicateCardinality`'s shared refusal contract; the message says which",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminBrainVocabulary = createAdminRouter();

adminBrainVocabulary.use(requireOrgContext());

adminBrainVocabulary.openapi(surfacesRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const url = new URL(c.req.raw.url);
      const rawPosition = url.searchParams.get("position");
      if (!isSlotPosition(rawPosition)) {
        return c.json(
          {
            error: "bad_request",
            message: `Invalid position. Must be one of: ${BRAIN_VOCABULARY_SLOT_POSITIONS.join(", ")}.`,
            requestId,
          },
          400,
        );
      }
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const page = yield* Effect.tryPromise({
        try: () =>
          loadObservedSurfaces(getInternalDB(), ctx, {
            position: rawPosition,
            filter: url.searchParams.get("q") ?? undefined,
            limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
            requestId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(
        checked(BrainVocabularySurfaceListSchema, {
          position: page.position,
          surfaces: page.surfaces,
          truncated: page.truncated,
          scope: page.decision,
        }),
        200,
      );
    }),
    { label: "list brain vocabulary surfaces" },
  );
});

adminBrainVocabulary.openapi(inForceRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const payload = yield* Effect.tryPromise({
        try: async () => {
          // One request, two loaders — `/oversight`'s "one request, not one
          // snapshot" contract. The coverage counts are workspace-wide and
          // content-free; the in-force view is scoped. Merging them here keeps
          // each loader's own contract (and its own tests) intact.
          const db = getInternalDB();
          const [view, coverage] = await Promise.all([
            loadInForceVocabulary(db, ctx, { requestId }),
            loadVocabularyCoverage(db, orgId),
          ]);
          return {
            edges: view.edges.map((e) => ({
              position: e.position,
              fromNorm: e.fromNorm,
              toNorm: e.toNorm,
              approvedBy: e.approvedBy,
              approvedAt: e.approvedAt,
              hasRejectionMemory: e.proposalId !== null,
            })),
            counts: view.counts.map((n) => ({
              position: n.position,
              scope: n.decision,
              total: n.total,
              scoped: n.scoped,
              withheld: n.withheld,
              countsConsistent: n.consistent,
            })),
            cardinalities: view.cardinalities,
            coverage,
            truncated: view.truncated,
          };
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainVocabularyInForceResponseSchema, payload), 200);
    }),
    { label: "load brain vocabulary in force" },
  );
});

adminBrainVocabulary.openapi(previewRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const radius = yield* Effect.tryPromise({
        try: () => loadBlastRadius(getInternalDB(), ctx, body, { requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainVocabularyPreviewResponseSchema, { radius }), 200);
    }),
    { label: "preview brain vocabulary blast radius" },
  );
});

adminBrainVocabulary.openapi(authorRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const outcome = yield* Effect.tryPromise({
        try: () => authorAliasEdge(orgId, body, ctx),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "authored":
          return c.json(
            checked(BrainVocabularyAuthorResponseSchema, {
              outcome: "authored",
              proposalId: outcome.id,
              convergedOnProposal: outcome.convergedOnProposal,
            }),
            200,
          );
        case "already_approved":
          return c.json(
            checked(BrainVocabularyAuthorResponseSchema, {
              outcome: "already_approved",
              proposalId: outcome.id,
              convergedOnProposal: true,
            }),
            200,
          );
        case "not_decidable":
          return c.json(
            {
              error: "conflict",
              message:
                `A decision on that pair is already in flight (proposal ${outcome.id}). ` +
                "Reload the surface — retrying would be a second apply of a decision that is " +
                "already being made.",
              requestId,
            },
            409,
          );
        case "refused":
          return c.json(
            refusalBody(outcome.refusal, outcome.message, requestId),
            refusalStatus(outcome.refusal),
          );
      }
    }),
    { label: "author brain vocabulary alias edge" },
  );
});

adminBrainVocabulary.openapi(removeRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const outcome = yield* Effect.tryPromise({
        try: () => removeInForceAliasEdge(orgId, body, ctx),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "removed":
          return c.json(
            checked(BrainVocabularyRemoveResponseSchema, {
              outcome: "removed",
              proposalId: outcome.id,
              memoryCreated: outcome.memoryCreated,
            }),
            200,
          );
        case "already_removed":
          // 200, not 409. The pair is in the state the caller asked for, and a
          // double-click on a confirm button must not read as a failure — the
          // `outcome` field is what distinguishes it from a removal that ran.
          return c.json(
            checked(BrainVocabularyRemoveResponseSchema, {
              outcome: "already_removed",
              proposalId: outcome.id,
              memoryCreated: false,
            }),
            200,
          );
        case "refused":
          return c.json(
            refusalBody(outcome.refusal, outcome.message, requestId),
            refusalStatus(outcome.refusal),
          );
      }
    }),
    { label: "remove brain vocabulary alias edge" },
  );
});

adminBrainVocabulary.openapi(cardinalityRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const body = c.req.valid("json");
      const ctx = yield* approverContext(mode, user, orgId, requestId);

      // §6's owner/admin gate, applied HERE because
      // `declarePredicateCardinality` says so in as many words: *"Entitlement is
      // the CALLER's to enforce — §6's owner/admin gate lives at the route,
      // beside every other entitlement decision, rather than being re-derived by
      // a store primitive that has no request context."* Same bar as authoring
      // an alias, and for the same reason: a `single` entry re-keys nothing but
      // arms supersession for every future claim in the slot.
      const author = recordedAuthor(ctx);
      if (author === null) {
        return c.json(
          refusalBody(
            "not-entitled",
            ctx.origin === "authenticated"
              ? `Curating a predicate needs the owner or admin entitlement; this reader is ` +
                  `"${ctx.role ?? "no org role"}". A \`single\` entry makes every existing published ` +
                  "pair in that slot supersedable at the next publish, retroactively."
              : `Curating a predicate needs a resolved reader identity; this one is "${ctx.origin}".`,
            requestId,
          ),
          403,
        );
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          const db = getInternalDB();
          // The canonical key is derived INSIDE `cardinality.ts` rather than
          // here, and that is a guard rather than a preference:
          // `keys-not-on-the-wire.test.ts` refuses to see an identity key named
          // in any discovered read surface — a total prohibition in the ORM
          // spelling, deliberately over-broad — and a route body is precisely
          // where one must not appear. This file speaks surfaces; the module
          // keyed on `predicate_key` does the rest.
          //
          // The workspace's OWN vocabulary, not `identityVocabulary`: curating
          // `is priced at` once `is priced at → priced at` is approved must land
          // on `priced at`, the slot the claims actually occupy.
          const vocabulary = await loadWorkspaceVocabulary(orgId);
          return declarePredicateCardinalityForSurface(db, orgId, {
            predicateSurface: body.predicateSurface,
            cardinality: body.cardinality,
            authoredBy: author,
            predicateAlias: vocabulary.predicate,
          });
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (!result.ok) {
        return c.json(
          refusalBody(result.refusal, result.message, requestId),
          refusalStatus(result.refusal),
        );
      }
      return c.json(
        checked(BrainVocabularyCardinalityWriteResponseSchema, {
          cardinality: result.cardinality,
        }),
        200,
      );
    }),
    { label: "declare brain predicate cardinality" },
  );
});

/**
 * The author id to record, or `null` when this reader may not author at all.
 *
 * Switched on the ORIGIN rather than written `ctx.userId ?? SENTINEL`, for
 * `recordedApprover`'s reason exactly: `??` applies the local-operator sentinel
 * to every origin whose `userId` happens to be null, so a future
 * `BrainPrincipalContext` arm would silently inherit "the declared local
 * operator" — an audit falsification one origin over, on the column migration
 * 0192 calls the first thing an audit of a retroactive re-key reads.
 */
function recordedAuthor(ctx: BrainPrincipalContext): string | null {
  switch (ctx.origin) {
    case "authenticated":
      return (ctx.role === "owner" || ctx.role === "admin") && ctx.userId ? ctx.userId : null;
    case "unauthenticated-local":
      return "local-operator";
    case "unresolved":
      return null;
  }
}

/** Compile-time pin: the router only ever speaks the three known positions. */
type _PositionsAreSlotPositions = [
  Exclude<(typeof BRAIN_VOCABULARY_SLOT_POSITIONS)[number], SlotPosition>,
] extends [never]
  ? true
  : never;
const _positionsAreSlotPositions: _PositionsAreSlotPositions = true;
void _positionsAreSlotPositions;

export { adminBrainVocabulary };
