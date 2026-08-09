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
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { SlotPosition } from "@atlas/api/lib/brain/identity";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import {
  OBSERVED_SURFACE_PAGE_MAX,
  SURFACE_FILTER_MAX_CHARS,
  loadObservedSurfaces,
} from "@atlas/api/lib/brain/vocabulary-surfaces";
import {
  loadInForceVocabulary,
  loadVocabularyCoverage,
} from "@atlas/api/lib/brain/vocabulary-in-force";
import {
  loadBlastRadius,
  type StructurallyEmptyReason,
} from "@atlas/api/lib/brain/vocabulary-preview";
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
import type { PositionalDecision } from "@atlas/api/lib/brain/vocabulary-visibility";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type {
  AuthMode,
  BrainVocabularyAuthorResponse,
  BrainVocabularyCardinalityWriteResponse,
  BrainVocabularyRemoveResponse,
  BrainVocabularyScope,
  BrainVocabularyStructurallyEmptyReason,
} from "@useatlas/types";
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

const log = createLogger("admin-brain-vocabulary");

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

/**
 * The same guard on a WRITE route, where a failure means something different.
 *
 * ⚠️ On a read, `checked()` throwing is exactly right: nothing happened, and a
 * 500 is the honest answer. On the three WRITE routes the transaction has
 * **already committed** — the edge is in force and the corpus has been re-keyed,
 * or the predicate is curated — so the same throw produces *"Failed to author
 * brain vocabulary alias edge."* over a write that succeeded. An approver reads
 * that as "it did not work".
 *
 * That is the mirror image of the rule this file's header already states about
 * refusals behind a 200 — a write's outcome must not be misreported in either
 * direction. So the describe-it step is separated from the do-it step: the write
 * is reported as having LANDED, with the description problem named as the
 * server-side defect it is.
 *
 * ⚠️ **The message says RELOAD, not "do not retry".** An earlier cut of this
 * docstring justified the helper by claiming a retry "is refused with
 * `already-aliased`, which reads as a second failure" — and that claim was
 * itself false, sitting one paragraph above its own refutation. Re-POSTing
 * `/author` finds the approved proposal and returns `already_approved` → 200;
 * `/remove` finds the rejected row and returns `already_removed` → 200. Both
 * paths are idempotent by construction, which is what the
 * converge-on-an-existing-row design buys. `/cardinality` is idempotent too —
 * `declarePredicateCardinality` is `ON CONFLICT DO UPDATE` — but it answers a
 * plain `{ cardinality }` with no "already applied" arm, so on that route the
 * shared message's *"will simply report the change as already applied"* is the
 * weaker claim *a retry re-asserts the same value and is a no-op*; the reload is
 * still the right instruction, and the outcome is still safe. Telling an approver not to retry a
 * safe operation was a smaller lie than the one this helper replaced, and still
 * one — recorded here because a docstring that means two things is worth nothing
 * on the one that matters, and this is the helper whose entire job is honesty.
 *
 * The 500 status stays. A body that says "landed" behind a 200 is read as
 * success by exactly the generic clients this file's header worries about, and
 * the status is what stops that; the message is what stops the human reading it
 * as "nothing happened".
 */
function checkedWrite<T>(
  schema: { parse: (value: unknown) => T },
  payload: unknown,
  /**
   * ⚠️ DISCRIMINATED on the verb, because the three writes do not share an
   * identifier.
   *
   * A flat `{ verb, proposalId }` rendered *"The curation succeeded and is in
   * force — proposal is priced at"* for a cardinality write, which has no
   * proposal at all: it is an upsert on `brain_predicate_cardinality`. That
   * handed the approver a nonexistent identifier for the one write that arms
   * retroactive supersession, from inside the helper written to stop lying to
   * them about committed writes.
   */
  context: (
    | { readonly verb: "authoring" | "removal"; readonly proposalId: string }
    | { readonly verb: "curation"; readonly predicateSurface: string }
  ) & { readonly requestId: string },
):
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly body: { readonly error: string; readonly message: string; readonly requestId: string };
    } {
  try {
    return { ok: true, body: schema.parse(payload) };
  } catch (err) {
    const subject =
      context.verb === "curation"
        ? `predicate "${context.predicateSurface}"`
        : `proposal ${context.proposalId}`;
    log.error(
      {
        ...(context.verb === "curation"
          ? { predicateSurface: context.predicateSurface }
          : { proposalId: context.proposalId }),
        verb: context.verb,
        requestId: context.requestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "brain vocabulary: a COMMITTED write could not be described by its own response schema — the write landed; the projection drifted",
    );
    return {
      ok: false,
      body: {
        error: "response_schema_mismatch",
        message:
          `The ${context.verb} succeeded and is in force — ${subject} — but Atlas could not ` +
          "build a response describing it, which is a defect on our side. Reload the page to see " +
          "the current state; retrying is safe and will simply report the change as already " +
          "applied.",
        requestId: context.requestId,
      },
    };
  }
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

/**
 * The DIRECT-AUTHORING refusal statuses — both 400, and exhaustively so.
 *
 * Separate from {@link refusalStatus} rather than a call into it, because that
 * function's return type is the wide `400 | 403 | 409` for every input and the
 * cardinality route declares no 409 (its seam cannot produce one — see
 * `DeclarationResult`). Narrowing here is what lets the route's declared
 * responses and its reachable ones agree at COMPILE time rather than by
 * inspection; the `never` default is what keeps them agreeing when the seam
 * grows an arm.
 *
 * ⚠️ **Swapping this back to {@link refusalStatus} is undetectable at runtime by
 * construction** — both map the two reachable refusals to 400, so no test can
 * tell them apart. Stated so a reviewer does not go hunting for the falsifier
 * that cannot exist: the guarantee lives in the return TYPE and in the
 * committed `openapi.json` (which records no 409 on this route), and the
 * openapi-drift gate is what enforces it.
 */
function declarationRefusalStatus(
  refusal: Extract<CardinalityRefusal, "degenerate-key" | "unattributed">,
): 400 {
  switch (refusal) {
    case "degenerate-key":
    case "unattributed":
      return 400;
    default: {
      const unexpected: never = refusal;
      throw new Error(`Unhandled declaration refusal: ${JSON.stringify(unexpected)}`);
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
    description:
      "Invalid request — a norm that normalizes away to nothing, a pair that normalizes to one norm, or no active organization",
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
    // ⚠️ This schema is ENFORCED, not decorative. The handler used to declare it
    // and then hand-parse `c.req.raw.url` — two statements of one contract, of
    // which only the hand-rolled one ran, and the declared one (the weaker of
    // the two) was what the OpenAPI document advertised. `position` is an enum
    // here, so an unknown value is refused by the same `validationHook` that
    // guards every body on this surface rather than by a bespoke branch.
    query: z.object({
      position: z
        .enum(BRAIN_VOCABULARY_SLOT_POSITIONS)
        .openapi({ description: `One of: ${BRAIN_VOCABULARY_SLOT_POSITIONS.join(", ")}` }),
      q: z
        .string()
        .max(SURFACE_FILTER_MAX_CHARS)
        .optional()
        .openapi({ description: "Case-insensitive substring filter over the surface and the norm" }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(OBSERVED_SURFACE_PAGE_MAX)
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
    "⚠️ An entity edge withheld because you cannot READ its populations is also un-removable by you. That hole is fail-closed and correct, and it is logged server-side rather than skipped silently — a workspace whose only admin cannot see a bad edge's populations has no in-product recovery path. An edge withheld only because its claims have all been retracted is NOT in that position: the removal gate counts retracted claims, so it stays recoverable. " +
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
    // No 409 here. `declarePredicateCardinality` is `ON CONFLICT DO UPDATE` — a
    // human authoring over their own workspace's earlier decision is the thing
    // the gate is FOR — so it returns only `degenerate-key`, `unattributed` or
    // success. `already-decided` and `producer-proposed-multi` belong to the
    // PRODUCER path and cannot arise here, and advertising them was the same
    // defect the `AliasAuthoringRefusal` narrowing removed one route over.
    500: {
      description:
        "Internal server error. `response_schema_mismatch` is the one case where the write LANDED and only its description failed — reload rather than treating it as a failed write",
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

      const query = c.req.valid("query");

      const ctx = yield* approverContext(mode, user, orgId, requestId);
      const page = yield* Effect.tryPromise({
        try: () =>
          loadObservedSurfaces(getInternalDB(), ctx, {
            position: query.position,
            filter: query.q,
            limit: query.limit,
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
            cardinalityCounts: {
              position: view.cardinalityCounts.position,
              scope: view.cardinalityCounts.decision,
              total: view.cardinalityCounts.total,
              scoped: view.cardinalityCounts.scoped,
              withheld: view.cardinalityCounts.withheld,
              countsConsistent: view.cardinalityCounts.consistent,
            },
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
        try: () => authorAliasEdge(orgId, body, ctx, { requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "authored": {
          // ANNOTATED, not a bare object literal. `checked`/`checkedWrite` take
          // `payload: unknown`, so without this the discriminated union bought
          // nothing at compile time — re-adding `convergedOnProposal` to the
          // `already_approved` arm below compiled cleanly and failed as a 500.
          // Excess-property checking plus discriminant narrowing do the job the
          // union was written for.
          const body: BrainVocabularyAuthorResponse = {
            outcome: "authored",
            proposalId: outcome.id,
            convergedOnProposal: outcome.convergedOnProposal,
          };
          const described = checkedWrite(
            BrainVocabularyAuthorResponseSchema,
            body,
            { verb: "authoring", proposalId: outcome.id, requestId },
          );
          return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
        }
        case "already_approved": {
          // Plain `checked()`, not `checkedWrite()`: nothing was written on this
          // arm, so a schema failure here is an ordinary 500 about a read.
          //
          // No `convergedOnProposal` — the union does not carry it on this arm,
          // and the annotation is what makes adding it back a compile error. It
          // used to be hard-coded `true`, which is FALSE whenever the
          // pre-existing approved row was itself hand-authored (the common
          // double-submit case), and that field decides what the approver is
          // told the audit trail will say.
          const body: BrainVocabularyAuthorResponse = {
            outcome: "already_approved",
            proposalId: outcome.id,
          };
          return c.json(checked(BrainVocabularyAuthorResponseSchema, body), 200);
        }
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
        try: () => removeInForceAliasEdge(orgId, body, ctx, { requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      switch (outcome.kind) {
        case "removed": {
          const body: BrainVocabularyRemoveResponse = {
            outcome: "removed",
            proposalId: outcome.id,
            memoryCreated: outcome.memoryCreated,
          };
          const described = checkedWrite(
            BrainVocabularyRemoveResponseSchema,
            body,
            { verb: "removal", proposalId: outcome.id, requestId },
          );
          return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
        }
        case "already_removed":
          // 200, not 409. The pair is in the state the caller asked for, and a
          // double-click on a confirm button must not read as a failure — the
          // `outcome` field is what distinguishes it from a removal that ran.
          //
          // No `memoryCreated`: nothing was written, so the field has no value
          // to report rather than a false one. The union is what makes that
          // expressible.
          {
            const body: BrainVocabularyRemoveResponse = {
              outcome: "already_removed",
              proposalId: outcome.id,
            };
            return c.json(checked(BrainVocabularyRemoveResponseSchema, body), 200);
          }
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
        // LOGGED, like `authorAliasEdge` and `removeInForceAliasEdge` both do
        // for the identical denial. A `single` entry arms retroactive
        // supersession for every future claim in the slot, so an attempt to set
        // one without the entitlement is exactly the event `acl.ts` says you
        // want in the log — and the refusal message travels out in the response,
        // which is the caller's copy, not a server-side record.
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Predicate cardinality write refused — the reader does not clear the owner/admin bar",
        );
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
          declarationRefusalStatus(result.refusal),
        );
      }
      // `checkedWrite`, not `checked`: `declarePredicateCardinalityForSurface`
      // has COMMITTED by the time this body is built, and the write it describes
      // arms retroactive supersession for every future claim in the slot. The
      // third committed write on this surface, and it was the one still reporting
      // a landed change as a plain failure.
      // ANNOTATED like the other two writes. Round 2's own rationale — the
      // discriminated unions buy nothing while the payload is `unknown` —
      // reached `/author` and `/remove` and skipped this one, so an extra key
      // here still compiled and failed at runtime as the 500 the annotation
      // exists to prevent.
      const cardinalityBody: BrainVocabularyCardinalityWriteResponse = {
        cardinality: result.cardinality,
      };
      const described = checkedWrite(
        BrainVocabularyCardinalityWriteResponseSchema,
        cardinalityBody,
        { verb: "curation", predicateSurface: body.predicateSurface, requestId },
      );
      return described.ok ? c.json(described.body, 200) : c.json(described.body, 500);
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

/**
 * ⚠️ Compile-time pin: every internal {@link PositionalDecision} has a wire
 * spelling. THE mapping this file performs with no other check.
 *
 * `scope: page.decision` and `scope: n.decision` below convert the seam's union
 * into `BrainVocabularyScope`, and the two were written independently in two
 * packages with nothing tying them together — the only enforcement was a
 * runtime `z.enum` inside `checked()`, which fails as a 500 on the whole pane
 * rather than as a type error.
 *
 * That is not hypothetical: `vocabulary-visibility.ts` already contemplates
 * splitting `audit-override` out of `reader-scoped` so an approver can tell "you
 * can see everything" from "an override was in force". Under the old shape that
 * change compiled and broke `/in-force` at runtime. Here it stops compiling.
 *
 * Directional on purpose. This pin catches a NEW internal arm with no wire
 * spelling; `BRAIN_VOCABULARY_SCOPES`' own `Exclude` pin (in `@useatlas/schemas`)
 * catches the reverse. Neither alone is enough, because `satisfies` cannot see a
 * schema enum that is narrower than its type.
 */
type _DecisionsHaveWireScopes = [Exclude<PositionalDecision, BrainVocabularyScope>] extends [never]
  ? true
  : never;
const _decisionsHaveWireScopes: _DecisionsHaveWireScopes = true;
void _decisionsHaveWireScopes;

/**
 * ⚠️ The SAME pin for the blast-radius reason, which is the seam the one above
 * was written for and then not applied to.
 *
 * `/preview` hands the engine's `BlastRadius` straight to `checked()`, so
 * `StructurallyEmptyReason` (engine) and `BrainVocabularyStructurallyEmptyReason`
 * (wire) were two independently hand-written five-member unions with nothing
 * between them. Rename `"no-such-edge"` in the engine and `/preview` 500s the
 * whole panel at runtime — the exact failure the scope pin's own docstring
 * argues about, one route over.
 *
 * It matters more here than there, because this is the branch whose entire
 * purpose is SAYING WHICH: a reason the client cannot name degrades to "a reason
 * this page does not recognise", and that arm has to stay rare enough to be
 * believed.
 */
type _EngineReasonsHaveWireSpellings = [
  Exclude<StructurallyEmptyReason, BrainVocabularyStructurallyEmptyReason>,
] extends [never]
  ? true
  : never;
const _engineReasonsHaveWireSpellings: _EngineReasonsHaveWireSpellings = true;
void _engineReasonsHaveWireSpellings;

export { adminBrainVocabulary };
