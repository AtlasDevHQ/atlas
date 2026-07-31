/**
 * Admin fact-review routes — the human end of the company-brain wedge
 * (#4772, ADR-0036).
 *
 * Mounted under `/api/v1/admin/brain-facts`:
 *
 *   GET  /          — the review queue, paginated and filterable
 *   GET  /summary   — queue vitals for the stats bar
 *   GET  /oversight — per-audience counts, workspace-wide, with no content
 *   POST /:id/retract — reject a candidate (the `retract` correction verb)
 *   POST /:id/correct — apply a `correct_fact` verb (#4915)
 *
 * `/retract` and `/correct {verb: "retract"}` are the SAME code path
 * (`correctFact` in `lib/brain/correction.ts`) — one retract semantics, not
 * two. Both stamp the tombstone AND materialize the immutable human-authored
 * correction episode; the older route survives as the review surface's
 * spelling of the verb.
 *
 * ## There is no approve verb here, and that is the design
 *
 * Approval is `/api/v1/admin/publish`. `brain_facts.status` has exactly one
 * writer — the atomic publish endpoint's exotic content-mode adapter — and
 * `scripts/check-brain-fact-promotion.sh` refuses every other status-writing
 * shape in the repository. A per-fact "approve" button that stamped `published`
 * would be a second gate writer, bypassing no-provenance-no-promotion and
 * no-grant-no-promotion for the row it touched.
 *
 * So the reviewer's loop is: retract what you do not trust, then publish. What
 * survives the queue is what gets promoted, inside the publish transaction,
 * with the same refusals applied. The web surface says this in as many words
 * and opens the shared publish modal — which already renders `refusedDrafts[]`
 * with their prose `detail`, so a publish that half-worked is never reported as
 * an unqualified success.
 *
 * ## Reads are per-reviewer, not per-admin
 *
 * Every read composes the fail-closed ACL predicate against the REVIEWER's own
 * principal set. The audit override in `aclVisibilityClause` is deliberately
 * NOT wired up here: it is a workspace-wide grant bypass, and a review queue
 * that silently granted one would show an admin evidence from private channels
 * as a matter of routine. An admin who needs that has to invoke the override
 * through a surface that records a reason.
 *
 * ## `/oversight` is the ONE unscoped read here, and it carries no content
 *
 * `GET /oversight` (#4825) counts every fact in the workspace regardless of
 * reader, which is the point: publish is workspace-scoped, so an admin needs to
 * be able to tell a clean queue from a hidden backlog before they press the
 * button. It is not a widening of the override above — it never returns a
 * claim, an episode, or a provenance chain, only numbers and the grant tokens
 * `lib/brain/oversight.ts` rules disclosable. That module's header states the
 * rule; `z.strictObject` on its wire schema plus `checked()` below are what
 * make a producer that broke it fail here rather than at the browser.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import {
  CANDIDATE_PAGE_MAX,
  loadFactCandidateSummary,
  loadFactCandidates,
} from "@atlas/api/lib/brain/candidates";
import {
  CORRECTION_REFUSAL_REASONS,
  correctFact,
  type CorrectionOutcome,
  type CorrectionRefusalReason,
} from "@atlas/api/lib/brain/correction";
import { loadFactOversight, loadSupersessionPreview } from "@atlas/api/lib/brain/oversight";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { AuthMode } from "@useatlas/types";
import {
  BRAIN_FACT_STATUS_FILTERS,
  BrainFactCandidateListResponseSchema,
  BrainFactCandidateSummarySchema,
  BrainFactCorrectRequestSchema,
  BrainFactCorrectionResponseSchema,
  BrainFactOversightSchema,
  BrainFactRetractResponseSchema,
  isBrainFactStatusFilter,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";

const DEFAULT_LIMIT = 50;

/** Longest `?q=` honoured. See the call site. */
const MAX_SEARCH_CHARS = 200;

/**
 * A fact id is a `uuid` at rest. Validated at the seam so a typo is a 400
 * rather than a Postgres `invalid input syntax for type uuid` surfacing as a
 * 500 — which would put ordinary client error in the same log bucket as pool
 * exhaustion, and hand the reviewer "Failed to process request" for what is
 * simply a bad link. Rejecting it here also cannot leak: a malformed id can
 * never name a real fact, so a distinct answer confirms nothing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every response is parsed through its own wire schema before it goes out.
 *
 * Not ceremony, and not only about types. Hono does not validate responses, so
 * without this the shared schema is a promise the API makes to the browser and
 * never checks — and the browser is where it fails, as a `schema_mismatch` that
 * blanks the whole queue with no server-side trace. Parsing here turns a
 * MISSING or MISTYPED field into a 500 with a requestId, which is the correct
 * place to notice that Atlas produced a response it cannot stand behind. An
 * EXTRA field is stripped rather than refused (the envelope schemas are
 * `z.object`), so this catches drift in one direction only.
 *
 * It also makes the three withheld arms (episode, tension counterpart, attribution) enforceable
 * rather than conventional: both are `z.strictObject`, so a future producer
 * that attached a body to a `visible: false` variant fails HERE — at the ACL
 * boundary — instead of shipping the payload it was supposed to withhold.
 */
function checked<T>(schema: { parse: (value: unknown) => T }, payload: unknown): T {
  return schema.parse(payload);
}

/**
 * Resolve the reviewer's principal context for one request.
 *
 * The resolution itself lives in `lib/brain/reader-context.ts` (#4773), shared
 * with `searchBrain`: it re-resolves the role against the workspace being read
 * (`member.role` is per-org, #2890), and it THROWS rather than degrading when a
 * session that carries a role cannot have it re-resolved — the silent partial
 * ACL narrowing that would otherwise render as a smaller, entirely plausible
 * backlog with a publish button above it. That module's header has the full
 * reasoning; duplicating it in two route files is how the two would drift into
 * handling it differently.
 *
 * All this wrapper adds is the Effect boundary: the thrown error becomes a
 * typed failure `runEffect` maps to a 500 with a requestId.
 */
function reviewerContext(
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const commonResponses = {
  400: {
    description: "Invalid request — bad filter value or no active organization",
    content: { "application/json": { schema: ErrorSchema } },
  },
  401: {
    description: "Authentication required",
    content: { "application/json": { schema: AuthErrorSchema } },
  },
  403: {
    description: "Forbidden — admin role required",
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

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Brain Facts"],
  summary: "List fact candidates awaiting review",
  description:
    "Returns a paginated page of company-brain fact candidates with everything the reconcile stage attached: the SPO claim, the provenance chain back to its episode, the derived grant, the corroboration count (distinct provenance edges), provisional-entity flags, and advisory in-tension-with hints. " +
    "Results are gated by the reviewer's own fail-closed visibility predicate; the provenance episode is gated INDEPENDENTLY, so evidence a reviewer is not entitled to is reported as withheld rather than omitted. " +
    "`provenance.attribution` is gated on a THIRD grant — the one the fact held before publish-time widening. A reviewer who can see a claim only because it was restated under some principal they hold receives `{ visible: false }` instead of its first episode's `sourceId`, `actor` and `occurredAt`; anyone entitled to the original grant receives all three. " +
    "Block-class extraction failures (no provenance, no usable grant, unattributable actor, malformed claim) never appear here — they were refused upstream. Retracted facts are excluded.",
  request: {
    query: z.object({
      status: z
        .string()
        .optional()
        .openapi({ description: "draft (default), published, archived, or all" }),
      provisional: z
        .string()
        .optional()
        .openapi({ description: "Set to 'true' to show only provisional-entity candidates — the quality queue" }),
      tension: z
        .string()
        .optional()
        .openapi({ description: "Set to 'true' to show only candidates carrying an advisory in-tension-with edge" }),
      q: z
        .string()
        .optional()
        .openapi({ description: "Case-insensitive substring match across subject, predicate, and object" }),
      limit: z.string().optional().openapi({ description: `Maximum results (default ${DEFAULT_LIMIT}, max ${CANDIDATE_PAGE_MAX})` }),
      offset: z.string().optional().openapi({ description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated fact candidates",
      content: { "application/json": { schema: BrainFactCandidateListResponseSchema } },
    },
    ...commonResponses,
  },
});

const summaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Admin — Brain Facts"],
  summary: "Fact review queue vitals",
  description:
    "Counts for the review queue's stats bar, scoped to what this reviewer can see. `draftTotal` may therefore be smaller than `/api/v1/mode` draftCounts.brainFacts, which counts every draft in the workspace regardless of reader.",
  responses: {
    200: {
      description: "Queue vitals",
      content: { "application/json": { schema: BrainFactCandidateSummarySchema } },
    },
    ...commonResponses,
  },
});

const oversightRoute = createRoute({
  method: "get",
  path: "/oversight",
  tags: ["Admin — Brain Facts"],
  summary: "Where the workspace's facts stand, as counts",
  description:
    "Counts every fact in the workspace grouped by the grant tokens it carries, regardless of who is asking — the deliberate counterpart to the reader-scoped review queue, so an admin can tell a clean queue from a backlog federated to somebody else. " +
    "The WORKSPACE-WIDE half returns numbers only: no subject, predicate, object, provenance, episode body, or fact id reaches the counts, the buckets, or the totals. The ONE exception is `willSupersede.pairs` below, which carries claims and fact ids — and is therefore reader-scoped, never workspace-wide. " +
    "A bucket is labelled with its grant token only when naming it discloses nothing the admin does not already hold — `org` and `role:*` always, an `audience:` for a channel present in this workspace's install config, and never a `user:` or an audience Atlas discovered rather than the admin configured; those carry an opaque handle. " +
    "`reviewableAwaitingReview` restates this reader's own queue total in the same response, so the hidden-backlog delta cannot flicker between two client fetches. The statements are not transactionally consistent, so a brief ingest race can still invert them — `countsConsistent` reports that rather than clamping the delta to a reassuring zero. `distinctAudiences` is the true audience cardinality even when `buckets` is capped. " +
    "`willSupersede` discloses what the next publish will supersede (#4912): promoting a single-cardinality draft that collides with a live published fact stamps the old fact's `valid_to` atomically with the promotion. The pairs list both claims and is gated by the reader's own visibility predicate on BOTH sides; supersessions the reader may not see travel as `willSupersede.withheld` — a count, never content.",
  responses: {
    200: {
      description: "Per-audience counts by state, plus workspace totals",
      content: { "application/json": { schema: BrainFactOversightSchema } },
    },
    ...commonResponses,
  },
});

const retractRoute = createRoute({
  method: "post",
  path: "/{id}/retract",
  tags: ["Admin — Brain Facts"],
  summary: "Reject a fact candidate",
  description:
    "Rejects a candidate by stamping `invalidated_at` — the review gate's negative verb, which since #4915 is the `retract` correction verb: the same call also materializes an immutable human-authored correction episode and flags any `derives-from` dependents for re-review (never a cascade). It never writes `status`: `brain_facts.status` has exactly one writer (the atomic publish endpoint), and ADR-0036 makes withdrawal a tombstone rather than a demotion, so the claim stays readable to an as-of query while leaving the review queue, the publish preview, and draftCounts. Approval is `/api/v1/admin/publish`; there is no per-fact approve verb.",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Fact id" }),
    }),
  },
  responses: {
    200: {
      description: "The candidate was retracted",
      content: { "application/json": { schema: BrainFactRetractResponseSchema } },
    },
    // Spread FIRST so the specific 404 copy below overrides the shared
    // "internal database not configured" one rather than being overwritten
    // by it.
    ...commonResponses,
    404: {
      description:
        "No such fact, already retracted, or not visible to this reviewer — deliberately indistinguishable, so the response cannot confirm the existence of a fact the reader may not see",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "The fact cannot be retracted — it is warehouse-derived (tier-1), which has no correction path; fix the data or the semantic layer instead",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const correctRoute = createRoute({
  method: "post",
  path: "/{id}/correct",
  tags: ["Admin — Brain Facts"],
  summary: "Apply a correct_fact verb to a fact",
  description:
    "Applies one of the four correction verbs (#4915, ADR-0036 §Temporal) — the second human-authoritative entry point beside the review gate. Every correction materializes an immutable, actor-attributed correction episode and lands authoritative immediately, without the draft queue. " +
    "`retract` stamps `invalidated_at` (the only tombstone path and the GDPR-erasure verb) and flags `derives-from` dependents for re-review — never a cascade. " +
    "`supersede` publishes the human's replacement claim (same subject and predicate, the corrected `replacement.object`) through the ordinary reconcile seam and stamps the target's `valid_to` plus the `supersedes` edge via the publish gate's own machinery (#4912). " +
    "`re-authority` and `pin` attach the correction episode as fresh human evidence, resetting the staleness clock and recording who vouched. " +
    "Tier-1 warehouse-derived facts are refused for every verb: fix the data or the semantic layer, not the brain.",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Fact id" }),
    }),
    body: {
      content: { "application/json": { schema: BrainFactCorrectRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The correction was applied",
      content: { "application/json": { schema: BrainFactCorrectionResponseSchema } },
    },
    ...commonResponses,
    404: {
      description:
        "No such fact, already retracted, or not visible to this admin — deliberately indistinguishable, so the response cannot confirm the existence of a fact the reader may not see",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "The verb cannot apply to this target — a warehouse-derived (tier-1) fact, a supersede on an unpublished or already-superseded fact, or an unpublishable replacement. The message says which and what to do instead.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

/**
 * Correction refusal → HTTP status. Request-shape mistakes are 400s, authority
 * is 403, and target-state mismatches are 409s — the state can change out from
 * under the client, so "try again after fixing the target" is the semantics.
 */
function refusalStatus(reason: CorrectionRefusalReason): 400 | 403 | 409 {
  switch (reason) {
    case CORRECTION_REFUSAL_REASONS.notAuthorized:
      return 403;
    case CORRECTION_REFUSAL_REASONS.replacementMissing:
    case CORRECTION_REFUSAL_REASONS.replacementIdentical:
      return 400;
    case CORRECTION_REFUSAL_REASONS.warehouseTarget:
    case CORRECTION_REFUSAL_REASONS.targetNotPublished:
    case CORRECTION_REFUSAL_REASONS.validityAlreadyClosed:
    case CORRECTION_REFUSAL_REASONS.replacementUnpublishable:
      return 409;
    default: {
      const unexpected: never = reason;
      throw new Error(`Unhandled correction refusal reason: ${JSON.stringify(unexpected)}`);
    }
  }
}

/** The one 404 body for the deliberately indistinguishable trio. */
function correctionNotFoundBody(requestId: string) {
  return {
    error: "not_found",
    message:
      "That fact could not be corrected. It may not exist, may already be retracted, or may not be visible to you.",
    requestId,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminBrainFacts = createAdminRouter();

adminBrainFacts.use(requireOrgContext());

adminBrainFacts.openapi(listRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      // `requireOrgContext` already 400s an org-less request; this keeps the
      // read from ever running without a tenant boundary if that guard moves.
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const url = new URL(c.req.raw.url);
      const rawStatus = url.searchParams.get("status");
      if (rawStatus !== null && !isBrainFactStatusFilter(rawStatus)) {
        return c.json(
          {
            error: "bad_request",
            message: `Invalid status filter. Must be one of: ${BRAIN_FACT_STATUS_FILTERS.join(", ")}.`,
          },
          400,
        );
      }
      const { limit, offset } = parsePagination(c);

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);
      const page = yield* Effect.tryPromise({
        try: () =>
          loadFactCandidates(getInternalDB(), {
            ctx,
            status: rawStatus ?? "draft",
            provisionalOnly: url.searchParams.get("provisional") === "true",
            inTensionOnly: url.searchParams.get("tension") === "true",
            // Bounded like every other input at this seam (`limit`, `offset`,
            // `:id`). It reaches three ILIKE predicates; admin-authenticated,
            // so this is uniformity rather than a live risk.
            search: url.searchParams.get("q")?.slice(0, MAX_SEARCH_CHARS) ?? undefined,
            limit: Math.min(limit || DEFAULT_LIMIT, CANDIDATE_PAGE_MAX),
            offset,
            requestId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainFactCandidateListResponseSchema, page), 200);
    }),
    { label: "list brain fact candidates" },
  );
});

adminBrainFacts.openapi(summaryRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);
      const summary = yield* Effect.tryPromise({
        try: () => loadFactCandidateSummary(getInternalDB(), ctx, requestId),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainFactCandidateSummarySchema, summary), 200);
    }),
    { label: "load brain fact review vitals" },
  );
});

adminBrainFacts.openapi(oversightRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      // The reader context is resolved even though the WORKSPACE counts do not
      // use it. Three jobs now: it produces the one scoped number
      // (`reviewableAwaitingReview`), it gates the will-supersede pair labels
      // (#4912), and it makes an unresolvable identity a 500 rather than a
      // workspace shape served to a session Atlas could not identify.
      const ctx = yield* reviewerContext(mode, user, orgId, requestId);
      const oversight = yield* Effect.tryPromise({
        try: async () => {
          // One request, two loaders — the same "one request, not one
          // snapshot" contract `loadFactOversight` documents for its own
          // statements. The supersession preview is merged here rather than
          // inside the counts loader so the counts aggregate keeps its
          // numbers-only contract and its own tests.
          const db = getInternalDB();
          const [counts, willSupersede] = await Promise.all([
            loadFactOversight(db, ctx, requestId),
            loadSupersessionPreview(db, ctx, requestId),
          ]);
          return { ...counts, willSupersede };
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainFactOversightSchema, oversight), 200);
    }),
    { label: "load brain fact oversight counts" },
  );
});

adminBrainFacts.openapi(retractRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const factId = c.req.param("id");
      if (!UUID_RE.test(factId)) {
        return c.json(
          { error: "bad_request", message: "That is not a valid fact id.", requestId },
          400,
        );
      }
      const ctx = yield* reviewerContext(mode, user, orgId, requestId);

      // The `retract` correction verb — the SAME code path `/correct` runs
      // (#4915): tombstone + correction episode + dependent re-review flags,
      // in one transaction. One retract semantics, not two.
      const outcome = yield* Effect.tryPromise({
        try: () => correctFact({ ctx, factId, verb: "retract", requestId }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (outcome.kind === "not-found") {
        // One message for three causes on purpose — see the route's 404 copy.
        return c.json(correctionNotFoundBody(requestId), 404);
      }
      if (outcome.kind === "refused") {
        // Reachable for a warehouse-derived target (409) and for an actor
        // without an org owner/admin role (403) — e.g. a bare platform_admin,
        // whose platform role resolves to NO org role in the reader context
        // and so does not carry the correction verb. That bar is #4915's, new
        // relative to the pre-unification retract, and deliberate: a
        // correction lands authoritative immediately, so it takes org
        // authority, not platform reach. The prose is the verb machinery's
        // own actionable message.
        return c.json(
          { error: "correction_refused", message: outcome.message, requestId },
          refusalStatus(outcome.reason),
        );
      }

      const { result } = outcome;
      if (result.invalidatedAt === null) {
        // A retract outcome always carries its tombstone; a null here means
        // the correction machinery changed shape underneath this route.
        return yield* Effect.fail(
          new Error(`brain review: retract outcome for ${factId} carried no invalidatedAt`),
        );
      }

      // Durable record of a human trust decision. The `log.info` inside
      // `correctFact` is operational; this is the forensic trail.
      // `logAdminAction` is fire-and-forget by design and handles its own
      // failures — a lost audit row must never roll back a retraction that
      // already committed, since the caller would then retract again.
      logAdminAction({
        actionType: ADMIN_ACTIONS.brainFact.retract,
        targetType: "brainFact",
        targetId: factId,
        metadata: {
          invalidatedAt: result.invalidatedAt,
          workspaceId: orgId,
          correctionEpisodeId: result.correctionEpisodeId,
          flaggedForReReview: result.flaggedForReReview,
        },
      });

      return c.json(
        checked(BrainFactRetractResponseSchema, {
          id: result.factId,
          invalidatedAt: result.invalidatedAt,
        }),
        200,
      );
    }),
    { label: "retract brain fact candidate" },
  );
});

adminBrainFacts.openapi(correctRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const factId = c.req.param("id");
      if (!UUID_RE.test(factId)) {
        return c.json(
          { error: "bad_request", message: "That is not a valid fact id.", requestId },
          400,
        );
      }
      const body = c.req.valid("json");
      const replacementValidFrom = body.replacement?.validFrom
        ? new Date(body.replacement.validFrom)
        : null;

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);
      const outcome: CorrectionOutcome = yield* Effect.tryPromise({
        try: () =>
          correctFact({
            ctx,
            factId,
            verb: body.verb,
            reason: body.reason,
            // Always a valid Date past the body schema's `.datetime()` gate;
            // the machinery keeps a warn-and-degrade backstop regardless.
            replacement: body.replacement
              ? { object: body.replacement.object, validFrom: replacementValidFrom }
              : undefined,
            requestId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (outcome.kind === "not-found") {
        return c.json(correctionNotFoundBody(requestId), 404);
      }
      if (outcome.kind === "refused") {
        const status = refusalStatus(outcome.reason);
        return c.json(
          { error: "correction_refused", message: outcome.message, requestId },
          status,
        );
      }

      const { result } = outcome;
      // The forensic trail beside the in-brain record. Retract keeps its
      // dedicated action type so existing audit consumers see one vocabulary
      // for one semantics; the other verbs share `correct` with the verb in
      // metadata.
      logAdminAction({
        actionType:
          result.verb === "retract"
            ? ADMIN_ACTIONS.brainFact.retract
            : ADMIN_ACTIONS.brainFact.correct,
        targetType: "brainFact",
        targetId: factId,
        metadata: {
          verb: result.verb,
          workspaceId: orgId,
          correctionEpisodeId: result.correctionEpisodeId,
          ...(result.invalidatedAt !== null ? { invalidatedAt: result.invalidatedAt } : {}),
          ...(result.flaggedForReReview.length > 0
            ? { flaggedForReReview: result.flaggedForReReview }
            : {}),
          ...(result.supersededBy !== null ? { supersededBy: result.supersededBy } : {}),
          ...(result.validTo !== null ? { validTo: result.validTo } : {}),
        },
      });

      return c.json(checked(BrainFactCorrectionResponseSchema, result), 200);
    }),
    { label: "apply brain fact correction verb" },
  );
});

export { adminBrainFacts };
