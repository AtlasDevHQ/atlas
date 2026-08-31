/**
 * Admin fact-review routes — the human end of the company-brain wedge
 * (#4772, ADR-0036).
 *
 * Mounted under `/api/v1/admin/brain-facts`:
 *
 *   GET  /          — the review queue, paginated and filterable
 *   GET  /summary   — queue vitals for the stats bar
 *   GET  /oversight — per-audience counts, workspace-wide, with no content
 *   GET  /retirable — published warehouse-derived facts + their ids (#5403)
 *   POST /:id/retract — reject a candidate (the `retract` correction verb)
 *   POST /:id/correct — apply a `correct_fact` verb (#4915)
 *   POST /tension-sweep — mint advisory tension edges over EXISTING rows (#5029)
 *   POST /actor-identity/erase — clear one author's directory snapshot (#5440)
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
 * ## `/retirable` is a SECOND listing, and the split is the design (#5403)
 *
 * `GET /` excludes warehouse-derived observations at every `?status=`,
 * including `all` — `lib/brain/candidates.ts` puts that exclusion ABOVE its
 * status arm on purpose, so `?status=published` cannot reach the rows ADR-0042
 * strands. That is right for a REVIEW queue: an observation is not a candidate
 * for review, and a reviewer has no trust call to make on one.
 *
 * But `retract` IS admitted on those rows, and it needs an id. Once #5341
 * closed the last surface that emitted one, the verb shipped with no way to
 * name its own population — the arc closed every path to the identifiers it
 * consumes, in the same milestone that shipped it.
 *
 * `GET /retirable` is the answer, and it is a separate surface rather than a
 * filter BECAUSE retirement is not review. A `?source=` parameter on `GET /`
 * would have been cheaper and would have re-opened `?status=published` on the
 * review queue to do it. The two listings are complementary by construction —
 * one composes `notAnObservationSql`, the other `observationSql` — and
 * `retirable-vs-review.test.ts` pins both directions so they cannot drift back
 * together.
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
 *
 * ## `/tension-sweep` is the one WRITE here that is not about a single fact
 *
 * Every other verb on this router names a fact in its path and acts on that row.
 * The sweep (#5029, ADR-0037 §7) is workspace-scoped and picks its own pairs: it
 * mints the advisory `in-tension-with` edges the corpus earned but was never
 * offered, because approving an alias or a `single` cardinality entry changes
 * what WOULD collide for rows nothing will ever look at again — and replaying
 * reconcile cannot reach the tension pass at all (`lib/brain/tension-sweep.ts`
 * carries the structural argument).
 *
 * It is the second explicitly-authorized autonomous writer of `in-tension-with`
 * edges — scoped to that edge type, not to `brain_edges`, which reconcile,
 * correction, publish and the region importer all write too — and
 * everything that makes that acceptable is enforced rather than asserted: the
 * write is additive and advisory (nothing is superseded, retracted, or
 * reordered), it is admin-TRIGGERED rather than scheduled or on the boot path,
 * it is bounded twice, and it is audited. Its response carries COUNTS only —
 * see `BrainFactTensionSweepResponse` for why listing the pairs would be a
 * workspace-wide disclosure on a router whose every other read is reader-scoped.
 */

import type { WithLooseOptionals } from "@useatlas/schemas";
import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import {
  CANDIDATE_PAGE_MAX,
  loadFactCandidateSummary,
} from "@atlas/api/lib/brain/candidates";
import {
  RETIRABLE_PAGE_MAX,
  loadRetirableObservations,
} from "@atlas/api/lib/brain/retirable";
import { correctFact, type CorrectionOutcome } from "@atlas/api/lib/brain/correction";
// The review gate's own verbs (#5568). This route is the gate's HTTP face, so
// it speaks the gate's vocabulary: `queued` is the review queue, `reject` is
// the negative verb, `previewApprove` is what approving would do. Each still
// runs the same internal it always did — the facade owns no SQL — but a reader
// arriving at `lib/brain/review-gate.ts` now finds every consumer of the
// concept, rather than four modules that happen to be called from one router.
import { previewApprove, queued, reject } from "@atlas/api/lib/brain/review-gate";
import {
  loadFactOversight,
} from "@atlas/api/lib/brain/oversight";
import { loadGateAnalytics } from "@atlas/api/lib/brain/gate-export";
// Both caps come from the sweep module, including `TENSION_EDGE_CAP`, which it
// RE-EXPORTS from `reconcile.ts`. Reaching past it to the declaration site would
// give this route a direct edge onto the reconcile stage for an integer it only
// prints, and would leave the route tests mocking two modules to stub one seam.
import {
  TENSION_EDGE_CAP,
  TENSION_SWEEP_RUN_CAP,
  contentionMessage,
  forecastContentionMessage,
  forecastTensionEdges,
  sweepTensionEdges,
} from "@atlas/api/lib/brain/tension-sweep";
import { eraseActorIdentity } from "@atlas/api/lib/brain/actor-identity";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
// The BARREL, like `admin-publish.ts` — not the two leaf modules. The route
// tests `mock.module` `@atlas/api/lib/audit`, so a leaf import walks past the
// double and writes a real row.
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type {
  AuthMode,
  BrainActorIdentityEraseResponse,
  BrainFactTensionForecastRequest,
  BrainFactTensionForecastResponse,
  BrainFactTensionSweepResponse,
} from "@useatlas/types";
import {
  BRAIN_FACT_STATUS_FILTERS,
  BrainActorIdentityEraseResponseSchema,
  BrainFactCandidateListResponseSchema,
  BrainFactCandidateSummarySchema,
  BrainFactCorrectRequestSchema,
  BrainFactCorrectionResponseSchema,
  BrainFactOversightSchema,
  BrainFactRetirableListResponseSchema,
  BrainFactRetractResponseSchema,
  BrainFactTensionForecastRequestSchema,
  BrainFactTensionForecastResponseSchema,
  BrainFactTensionSweepResponseSchema,
  isBrainFactStatusFilter,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import { refusalStatus, correctionNotFoundBody } from "./shared-correction";

const log = createLogger("admin-brain-facts");

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
 * with `searchAtlas`: it re-resolves the role against the workspace being read
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
    "Returns a paginated page of company-brain fact candidates with everything the reconcile stage attached: the SPO claim, the provenance chain back to its episode, the derived grant, the corroboration count (distinct SOURCES, so one person restating a claim strengthens it once), provisional-entity flags, and advisory in-tension-with hints. " +
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

const retirableRoute = createRoute({
  method: "get",
  path: "/retirable",
  tags: ["Admin — Brain Facts"],
  summary: "List published warehouse-derived facts awaiting retirement",
  description:
    "Enumerates PUBLISHED, warehouse-derived facts — the population ADR-0042 stranded — with the fact `id` that `POST /{id}/retract` consumes. It exists because no other surface could produce that id (#5403): `searchAtlas` excludes observations from both content-mode arms (#5341), `/admin/brain-coverage` emits predicates without ids, `executeSQL` is whitelist-scoped and `brain_facts` is not a whitelisted entity, and the review queue excludes them at every `?status=` including `all`. " +
    "⚠️ This is NOT the review queue with a filter, and it does not weaken one. An observation is not a candidate for REVIEW — a reviewer has no trust call to make on it — and `lib/brain/candidates.ts` still excludes these rows at every status. What this surface serves is a different question with a different verb: RETIREMENT, for a closed legacy population that can only shrink (the publish gate has refused warehouse-derived promotions since #5342). " +
    "Retracting a warehouse-derived fact is admitted and says only that the row should not have been blessed — it asserts no belief about the warehouse, which is why `supersede`, `re-authority` and `pin` remain refused on these rows. " +
    "Reader-scoped like every read on this router: `total` is what THIS reviewer can see, not what exists, and the audit override is deliberately not wired up. Retracted rows are excluded, so an empty page after a clearing is the confirmation that it worked. " +
    "Rows whose `validTo` has passed ARE listed, unlike on every serving surface: this is a discovery listing, not a belief, and a superseded observation is reachable by no other path, so filtering it out would strand it exactly as this endpoint exists to prevent. `validTo` is in the projection, so an already-inert row is visibly inert. " +
    // ⚠️ NAMES NO REGION, and that is the fix rather than an omission (#5409).
    // This sentence used to read "Facts stranded on `eu-prod` / `apac-prod`
    // need a session PER REGION". The RULE was right — ADR-0024 makes a session
    // single-region — and the EXAMPLE was false about the world: measured
    // 2026-08-24 against all three internal DBs, every ADR-0042 straggler was
    // on `us-prod` and `eu` / `apac` held zero brain facts between them. So the
    // copy sent an operator mid-retirement to look in the two places the rows
    // were not, on the one surface that exists to find them — and an empty page
    // in `eu` is also what SUCCESS looks like there, so nothing would have told
    // them.
    //
    // ⭐ The general form: a description may state a RULE about regions, which
    // stays true, but not an INSTANCE about where data sits, which no
    // description can keep true and which reaches the published OpenAPI spec.
    // Keep the warning, drop the falsifiable half.
    "⚠️ A workspace-admin session authenticates against exactly ONE region (ADR-0024), so this listing covers the region you are authenticated against and no other. A workspace holding facts in more than one region needs a session PER REGION — a `200` here says nothing about the others, and an empty page is equally what a region with nothing to retire looks like.",
  request: {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({ description: `Maximum results (default ${DEFAULT_LIMIT}, max ${RETIRABLE_PAGE_MAX})` }),
      offset: z.string().optional().openapi({ description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Published warehouse-derived facts, with their ids",
      content: { "application/json": { schema: BrainFactRetirableListResponseSchema } },
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
    "The WORKSPACE-WIDE half returns numbers only: no subject, predicate, object, provenance, episode body, or fact id reaches the counts, the buckets, or the totals. The TWO exceptions are `willSupersede.pairs` and `willWiden.entries` below, which carry claims and fact ids — and are therefore reader-scoped, never workspace-wide. " +
    "A bucket is labelled with its grant token only when naming it discloses nothing the admin does not already hold — `org` and `role:*` always, an `audience:` for a channel present in this workspace's install config, and never a `user:` or an audience Atlas discovered rather than the admin configured; those carry an opaque handle. " +
    "⚠️ The counters do NOT count the same population on every arm, and the asymmetry is deliberate (ADR-0042). A warehouse OBSERVATION is a machine reading of a column, never reviewed and never publishable, so `awaitingReview`, `provisional` and `inTension` exclude observations on both halves — reporting them as review backlog would name work no reviewer can do, since publish refuses every one of them unconditionally. `published` and `retracted` KEEP counting observations, because those are the already-published stragglers `GET /retirable` exists to enumerate and the completed retirements that clear them; hiding them would strand the retirement flow behind a panel reading zero. " +
    "`reviewableAwaitingReview` restates this reader's own queue total in the same response, so the hidden-backlog delta cannot flicker between two client fetches. It carries the same observation exclusion as the workspace `awaitingReview` it is subtracted from, so the delta reports only backlog a reader genuinely cannot see — narrowing one half alone would report observations as backlog federated to somebody else. The statements are not transactionally consistent, so a brief ingest race can still invert them — `countsConsistent` reports that rather than clamping the delta to a reassuring zero. `distinctAudiences` is the true audience cardinality even when `buckets` is capped. " +
    "`willSupersede` discloses what the next publish will supersede (#4912): promoting a single-cardinality draft that collides with a live published fact stamps the old fact's `valid_to` atomically with the promotion. Not every same-slot disagreement collides — publish stamps only where the two values are PROVABLY different, and never where either side is warehouse-derived or carries a source kind this region cannot classify (a warehouse-derived fact is never superseded by review, and never itself supersedes anything); those pairs coexist in visible tension instead, and are absent here because this disclosure is built from the same rule the transaction runs. The pairs list both claims and is gated by the reader's own visibility predicate on BOTH sides; supersessions the reader may not see travel as `willSupersede.withheld` — a count, never content. " +
    "`gateAnalytics` reports how the review gate has been DECIDING (#5335) — approvals, rejections, and the rate between them. Reader-scoped, unlike the workspace buckets beside it: a COUNT is not exempt from a visibility predicate, so these answer \"of the decided claims you can see\" and can be smaller than an operator's unscoped export of the same workspace. A rejection is a RETRACTION (`invalidated_at`), never a status — the gate's negative verb is a tombstone, not a demotion. `approvalRate` is null rather than 0 when nothing has been decided, because an unstarted queue and a reviewer who rejects everything are different states. Only the two decided classes are served: the third class an export carries (an extracted episode that yielded no claim) is per-episode and cannot be counted on this fact-grained join, and reporting it as 0 would be a false claim about the extractor's silence. " +
    "`willWiden` discloses what the next publish will make VISIBLE TO MORE PEOPLE (#5032): publishing a draft unions in the grant of every episode already recorded as evidence for it, so a claim first seen privately and restated publicly stops being served only to the private audience. That is usually right, and it is wrong when two different entities share a name — corroboration matches on identity derived from the surface, so a public episode about one `Acme Corp` can become evidence for a private fact about another, and the widening then discloses the private claim's body. An entry appears ONLY where the widening actually adds a grant token (an ordinary corroboration between equally-granted episodes adds none and is not listed), and `added` is a syntactic upper bound on readers gained rather than a reader count. A WAREHOUSE episode is not widening evidence at all and never appears here (ADR-0042): the union's warrant is that a person restated the claim in a wider room, and a machine reading a column satisfies no part of that sentence — publish applies the identical exclusion, so this notice and the act cannot disagree. ⚠️ Reader-scoped with NO withheld counterpart: an empty `entries` means \"none that you can see\", never \"none\".",
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
      description:
        "The candidate was retracted. The body carries the correction episode the verb materialized and the ids of any `derives-from` dependents it flagged for re-review — the same two disclosures `/correct` returns, so the console reviewer is told what the audit row records",
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
        "The fact cannot be retracted because its source kind is one this deployment does not recognise, so its tier cannot be determined and every correction verb is refused until the deployment knows the kind (#4964). " +
        "⚠️ Warehouse-derived (tier-1) facts are NOT refused here: `retract` is the one verb admitted on them (#5331), because it asserts only that the row should not have been blessed rather than a belief ABOUT a warehouse value. `supersede`, `re-authority` and `pin` remain refused on those rows — see `/correct`. Discover their ids at `GET /retirable` (#5403). " +
        "This copy previously claimed tier-1 had no correction path at all, which `lib/brain/correction.ts` has not done since #5331 and which would have told the operator clearing the ADR-0042 stragglers that their one available verb was unavailable",
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
    "Tier-1 warehouse-derived facts are refused for every verb: fix the data or the semantic layer, not the brain. " +
    "A fact whose source kind this deployment does not recognise — imported verbatim from a region running a newer vocabulary, or left behind by a rollback — is likewise refused for every verb, because its tier cannot be determined here.",
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
        "The verb cannot apply to this target — a warehouse-derived (tier-1) fact, a fact whose source kind this deployment does not recognise or whose recorded source is malformed (so its tier cannot be determined), a supersede on an unpublished or already-superseded fact, or an unpublishable replacement. The message says which and what to do instead.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const tensionSweepRoute = createRoute({
  method: "post",
  path: "/tension-sweep",
  tags: ["Admin — Brain Facts"],
  summary: "Mint advisory tension edges over existing rows",
  description:
    "Sweeps this workspace's live facts and mints the advisory `in-tension-with` edges the corpus has earned but was never offered (#5029, ADR-0037 §7). " +
    "The ingest path only ever wires a tension edge for a claim it is CREATING, so approving an alias or a `single` cardinality entry changes what would collide for rows nothing looks at again — and replaying reconciliation cannot help, because it corroborates an existing claim and returns before the tension pass. This is the operation that looks again. " +
    "A pair is flagged when both facts are live (not retracted, not superseded), occupy the same subject+predicate slot under TODAY's vocabulary, are not provably about different subjects, are not provably the same object, and the canonical predicate is curated `single` and approved today. Absent curation nothing is minted — `single` requires positive evidence, so a workspace that has never authored a cardinality entry gets `{minted: 0}`. " +
    "The write is ADDITIVE and advisory: nothing is superseded, retracted, invalidated, or reordered, and no fact row is touched. Running it twice does not duplicate edges — an existing edge between two facts suppresses the pair in either direction. " +
    // INTERPOLATED, never spelled. Two numbers in prose is two more places to
    // forget when a cap moves, and this one is published: the description is
    // extracted into `apps/docs/openapi.json` and rendered as the API
    // reference, so a stale literal here is a documented promise Atlas no
    // longer keeps. The openapi-drift gate re-extracts on every PR, so a
    // changed constant shows up as a docs diff rather than as a lie.
    `Bounded twice: each fact gains at most ${TENSION_EDGE_CAP} edges (the same per-fact fan-out bound the ingest path applies), and one run mints at most ${TENSION_SWEEP_RUN_CAP} edges in total. \`truncated\` reports the second bound biting; run it again to resume, which picks up where it stopped rather than repeating. ` +
    "Needs the owner or admin entitlement, re-resolved against this workspace rather than read off the session. The response carries counts only, never the pairs — this operation is workspace-wide where every read on this router is scoped to the caller's own grants; to SEE what was flagged, read the queue with `?tension=true`.",
  responses: {
    200: {
      description:
        "The sweep ran. `minted` is edges actually WRITTEN, never pairs considered. `0` does not identify a cause: it is returned when the corpus has converged, when there are no live facts, AND when no predicate in this workspace is curated `single` and approved — which is the commonest reason on a workspace that has just started curating, since a pending proposal does not arm the sweep. Check the vocabulary before reading `0` as done",
      content: { "application/json": { schema: BrainFactTensionSweepResponseSchema } },
    },
    ...commonResponses,
    403: {
      description:
        "Forbidden — the sweep is an autonomous writer of `brain_edges` and needs the owner or admin entitlement (ADR-0037 §6), re-resolved against the workspace being swept rather than read off the session",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description:
        "The sweep could not run, and `error` is one of three values naming WHICH bound it hit. `reconcile-lock` — another operation holds this workspace's reconcile lock, either an ingest pass or a sweep already running (the two cannot overlap, since both write these edges); retry in a few seconds. `conflicting-lock` — a conflicting lock on this workspace's facts, most often a concurrent publish or correction (the sweep deliberately does not queue behind either) and less often a migration or an index build; retry in a few seconds, and check for maintenance if it persists. `unfinished` — the statement did not complete, which is either a time-bound expiry or a cancellation, and Postgres does not distinguish them; retry once and escalate to an operator if it repeats. Every value names what is KNOWN rather than a cause the server could not establish, because none of these SQLSTATEs carries one. Nothing was changed in any of the three",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

/**
 * Hono's own JSON content-type test, restated where this router can enforce it.
 *
 * ⚠️ A COPY, deliberately, and the duplication is the lesser evil. The original
 * is `jsonRegex` in `hono/dist/validator/validator.js` — not exported, and
 * reaching into a dependency's internals to import it would break on a patch
 * release. The property that matters is that this is no NARROWER than Hono's: a
 * body Hono would parse must not be refused here. Anchored and case-insensitive,
 * matching the `application/<suffix+>json` shape, and deliberately not anchored
 * at the END so `application/json; charset=utf-8` passes both.
 */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json/i;

const tensionForecastRoute = createRoute({
  method: "post",
  path: "/tension-forecast",
  tags: ["Admin — Brain Facts"],
  summary: "Count the tension edges a sweep would mint, without minting them",
  description:
    "Answers `/tension-sweep`'s question and writes nothing (#5450). `wouldMint` is the number that endpoint would return as `minted` if it ran in this same instant, under the same two caps — the same statement, with the INSERT replaced by a count. " +
    "Send `predicateSurface` to ask the COUNTERFACTUAL: *what would a sweep mint if I also approved this predicate `single`?* Nothing is proposed, approved, or recorded — the hypothesis lives for the length of one statement, and the answer is what an approver needs BEFORE arming a predicate, because an `in-tension-with` edge that turns out spurious is one a reviewer must then dismiss by hand. Omit it to ask about the workspace exactly as it stands. " +
    "⚠️ A FORECAST, not a promise. This takes no lock — deliberately, so a preview cannot block this workspace's ingest for as long as a human takes to decide — so an ingest pass, a correction, or another sweep landing before you press moves the number. " +
    "⚠️ `wouldMint` is not a count of pairs in tension. A pair that already carries an edge is excluded, because both this and the sweep answer *what would this ADD?* And a `0` does not identify a cause: a converged corpus, a workspace with no live facts, and a workspace that has approved no predicate `single` all answer `0` — which is why the counterfactual exists. " +
    "\u26a0\ufe0f A JSON body is REQUIRED, even to ask about the workspace as it stands - send `{}`. It is not optional, because an optional JSON body that arrives without an `application/json` content-type is silently discarded rather than rejected, and a discarded `predicateSurface` would be answered with the CURRENT number as though the counterfactual had been asked. " +
    "The response is a DISCRIMINATED UNION. `kind: \"unkeyable-surface\"` is returned when the surface you asked about normalizes away to nothing, and it is deliberately not a `wouldMint` of `0`: *we could not ask your question* and *approving this mints nothing* are opposite advice. " +
    `Bounded by the same two caps the sweep applies — at most ${TENSION_EDGE_CAP} edges per fact, at most ${TENSION_SWEEP_RUN_CAP} per run — so \`truncated\` here means what it means there. ` +
    "Needs the owner or admin entitlement, re-resolved against this workspace rather than read off the session, on exactly the bar `/tension-sweep` applies: this reads workspace-wide state that no per-claim grant scopes, and it is the decision aid for an act at that bar.",
  request: {
    body: {
      content: { "application/json": { schema: BrainFactTensionForecastRequestSchema } },
      // REQUIRED, and this is a correctness fix rather than a strictness
      // preference. Under `required: false`, `@hono/zod-openapi` (1.5.1,
      // `dist/index.mjs:118-128`) installs a middleware that checks the
      // `content-type` header and, when it is absent or not JSON, calls
      // `addValidatedData("json", {})` and SKIPS PARSING THE BODY. So
      // `fetch(url, {method:"POST", body: JSON.stringify({predicateSurface:"plan tier"})})`
      // - which sends `text/plain;charset=UTF-8` - had its counterfactual
      // silently discarded, fell through to the `as-curated` branch, and
      // answered 200 with the CURRENT number.
      //
      // That is this endpoint's worst possible failure: an approver asking
      // "what would approving `plan tier` mint?" is told `0` for a question
      // that was never asked, and reads it as a licence to approve. It is the
      // same confident-zero the `unkeyable-surface` arm exists to prevent,
      // arriving through the one path that had no arm for it.
      //
      // Required, the validator always runs, and a missing or wrong
      // content-type is a 400 naming the problem. The cost is that the
      // "as the workspace stands" question must be asked as `{}` rather than as
      // an empty body - a documented two characters, paid once, in exchange for
      // a wrong answer becoming unrepresentable.
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "The forecast ran and nothing was written. `kind: \"forecast\"` carries `wouldMint` and `truncated`; `kind: \"unkeyable-surface\"` means the predicate surface asked about occupies no slot",
      content: { "application/json": { schema: BrainFactTensionForecastResponseSchema } },
    },
    ...commonResponses,
    403: {
      description:
        "Forbidden — the forecast reads workspace-wide state and is the decision aid for arming an autonomous writer of `brain_edges`, so it takes the same owner/admin bar as the sweep itself (ADR-0037 §6), re-resolved against the workspace being read rather than read off the session",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    415: {
      description:
        "The request carried no `application/json` content-type. Refused rather than defaulted, and the reason is specific to this endpoint: a body sent under any other content-type is discarded by the framework before the handler runs, so a `predicateSurface` would vanish and the reply would answer the DEFAULT question with a number the caller reads as an answer to theirs. `fetch(url, {method:\"POST\", body})` with no explicit header sends `text/plain` and lands here — set the header and resend",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "The forecast could not run, and `error` names WHICH bound it hit. `forecast-busy` \u2014 this server is already running the maximum number of forecasts at once and refused rather than queued, since a queued forecast holds a database connection too; wait a moment and retry, and if it persists something is calling this endpoint in a loop. `unfinished` — the candidate scan did not complete, which is either a time-bound expiry or a cancellation, and Postgres does not distinguish them; retry once and escalate if it repeats. `conflicting-lock` — a conflicting lock on this workspace's facts, most often a migration or an index build (this statement takes no lock of its own); retry in a few seconds. `reconcile-lock` is NOT among them: unlike the sweep, this never takes the reconcile lock. Nothing was read to a partial answer and nothing was written in either case",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const eraseActorIdentityRoute = createRoute({
  method: "post",
  path: "/actor-identity/erase",
  tags: ["Admin — Brain Facts"],
  summary: "Clear one author's directory snapshot",
  description:
    "Clears the DATED DIRECTORY SNAPSHOT Atlas holds for one source principal (#5440, ADR-0036 §T5). " +
    "Every claim that principal authored returns to the `opaque` identity state — the review surface and `searchAtlas` render an explicit \"cannot name this person\" instead of the name — and **no claim is deleted, retracted or otherwise changed**. That is the `retract` shape applied to a person: the record keeps the statement and loses the person. " +
    "The erasure is DURABLE. The audience sync's capture pass skips an erased handle forever, so the name does not come back on the next cycle. There is no un-erase verb; re-capturing a cleared name is a deliberate database operation, not an API call. " +
    "⚠️ Only a `directory` snapshot can be erased, and the narrowness is the point. An `atlas` identity stores no snapshot — its name is a live join to a Better Auth account whose own erasure path is account deletion — so clearing one would remove nothing and would leave a current colleague unnameable on every claim they made. " +
    "Needs the owner or admin entitlement, re-resolved against this workspace rather than read off the session, on the same bar `/tension-sweep` applies: this writes workspace-wide state that no per-claim grant scopes.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            actor: z
              .string()
              .min(1)
              .max(256)
              .openapi({
                description:
                  "The actor handle exactly as it appears on the claim's provenance — `slack:U0AQW6KF2EM`. Read it off the review surface; it is never guessed from a name, because there is no query from a name to a handle and adding one would make this a people directory.",
                example: "slack:U0AQW6KF2EM",
              }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "The snapshot was cleared. The body echoes the handle and nothing else — deliberately NOT a count of affected claims, which would report the size of one person's presence in the record to a caller who asked only to remove their name",
      content: { "application/json": { schema: BrainActorIdentityEraseResponseSchema } },
    },
    ...commonResponses,
    403: {
      description:
        "Forbidden — erasure writes workspace-wide identity state and needs the owner or admin entitlement, re-resolved against the workspace being written rather than read off the session",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description:
        "No identity is recorded for that handle in this workspace. Nothing was changed — and nothing needed to be: a handle with no row already renders `opaque`",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "That handle carries no snapshot to clear. Either it resolves to an Atlas account (`atlas`, whose name is a LIVE join and whose erasure path is account deletion, not this route) or it is already `opaque`. Reported rather than answered as a silent success, so an operator learns which case they are in",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});


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
      // Read once into a local: the conditional-spread idiom evaluates its
      // subject twice, and this one parses the URL (#5522).
      const searchTerm = url.searchParams.get("q")?.slice(0, MAX_SEARCH_CHARS);
      const page = yield* Effect.tryPromise({
        try: () =>
          queued(getInternalDB(), {
            ctx,
            status: rawStatus ?? "draft",
            provisionalOnly: url.searchParams.get("provisional") === "true",
            inTensionOnly: url.searchParams.get("tension") === "true",
            // Bounded like every other input at this seam (`limit`, `offset`,
            // `:id`). It reaches three ILIKE predicates; admin-authenticated,
            // so this is uniformity rather than a live risk.
            ...(searchTerm !== undefined ? { search: searchTerm } : {}),
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

adminBrainFacts.openapi(retirableRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const { limit, offset } = parsePagination(c);

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);
      const page = yield* Effect.tryPromise({
        try: () =>
          loadRetirableObservations(getInternalDB(), {
            ctx,
            limit: Math.min(limit || DEFAULT_LIMIT, RETIRABLE_PAGE_MAX),
            offset,
            requestId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(checked(BrainFactRetirableListResponseSchema, page), 200);
    }),
    { label: "list retirable brain observations" },
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
          // ⚠️ Bound whole, then read below — NOT destructured in place as
          // `[counts, { willSupersede, willWiden }, gateAnalytics]`. That form
          // typechecks in isolation and blows the inference budget of this
          // router's handler union: it surfaced as a TS2322 in
          // `admin-cache.ts`, a file nothing here imports. Two extra lines
          // against a type error that names the wrong file.
          const [counts, approvePreview, gateAnalytics] = await Promise.all([
            loadFactOversight(db, ctx, requestId),
            // Unscoped: this panel is the WORKSPACE's publish modal, so the
            // question is "what would publishing the whole backlog do". The
            // `factIds` arm exists for a caller approving a named set (#5568);
            // passing none here is what keeps this surface's numbers unchanged.
            previewApprove(db, ctx, requestId),
            // The gate-decision counts (#5335). Reader-scoped like the two
            // previews above and unlike the workspace buckets, so this number
            // can legitimately be smaller than an operator's unscoped export
            // of the same workspace — see `lib/brain/gate-export.ts`.
            loadGateAnalytics(db, ctx, requestId),
          ]);
          return {
            ...counts,
            willSupersede: approvePreview.willSupersede,
            willWiden: approvePreview.willWiden,
            gateAnalytics,
          };
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

      // The workspace's real vocabulary since #5023. REQUIRED on every verb,
      // and the loaded VALUE is read by `supersede` alone — so on THIS path
      // nothing consults it. The load is not free, though, and the honest
      // version says so: it costs a query, and it PROPAGATES
      // `VocabularyClosureError`, so a half-rebuilt closure fails retract too —
      // the withdrawal verb, during exactly the incident where an operator
      // wants it.
      //
      // Accepted rather than repaired here, and the alternative is recorded so
      // the next reader need not re-derive it: making
      // `CorrectionRequest.vocabulary` a thunk that only the supersede arm
      // forces would make the dependency lazy and truthful, at the cost of
      // rewriting ~60 test call sites — for a state only a hand-written write
      // or an aborted restore produces, and in which ingest is already refusing
      // wholesale. The argument for why the value must be the REAL vocabulary
      // lives on the `/correct` call site below, which is where it is read.
      const outcome = yield* Effect.tryPromise({
        try: async () =>
          reject({
            ctx,
            factId,
            // #5496 — this route IS the human's explicit act: an admin clicked
            // Retract in the admin brain UI, with no agent between the intent
            // and the request. It is deliberately NOT routed through the chat
            // surface's confirm card; confirming a click you just made is
            // ceremony, not evidence.
            intent: "admin-ui",
            requestId,
            vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (outcome.kind === "not-found") {
        // One message for three causes on purpose — see the route's 404 copy.
        return c.json(correctionNotFoundBody(requestId), 404);
      }
      if (outcome.kind === "refused") {
        // Reachable for a warehouse-derived target (409), for a target whose
        // source kind this deployment cannot classify (409, #4964 — the one a
        // reader would least expect on a retract route), and for an actor
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

      // No `logAdminAction` here on purpose: `correctFact` emits the
      // `admin_action_log` row for every entry point onto the correction write,
      // so the agent tool's corrections are audited too (#4934). Adding a call
      // back here would double-log. See `lib/brain/correction.ts`'s header.

      return c.json(
        checked(BrainFactRetractResponseSchema, {
          id: result.factId,
          invalidatedAt: result.invalidatedAt,
          // The verb's own two disclosures, echoed to the CALLER rather than
          // living only in the machinery's audit row (#4939). Ids here, a count
          // on the agent path — the asymmetry and its precise justification are
          // on `BrainFactRetractResponse`; in short, the ids are already in
          // this actor's own audit row and they are the human who has to act on
          // the flag, neither of which is true of an LLM.
          correctionEpisodeId: result.correctionEpisodeId,
          flaggedForReReview: [...result.flaggedForReReview],
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
        try: async () =>
          correctFact({
            ctx,
            factId,
            verb: body.verb,
            // #5496 — see the retract route above: the admin UI click is the
            // explicit act, so this entry point establishes intent directly.
            intent: "admin-ui",
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
            // Always a valid Date past the body schema's `.datetime()` gate;
            // the machinery keeps a warn-and-degrade backstop regardless.
            ...(body.replacement
              ? { replacement: { object: body.replacement.object, validFrom: replacementValidFrom } }
              : {}),
            requestId,
            // `correctFact` reads this at BOTH of the `supersede` verb's key
            // sites — the guard's slot comparison and the replacement claim it
            // hands to reconcile — so it has to be the same function the ingest
            // path used, or the guard refuses a different set than the corpus
            // considers identical and the replacement lands keyed under a
            // different identity function than every other row in the
            // workspace. A load failure propagates: there is no degraded
            // answer, and the empty vocabulary is not a safe one.
            vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),
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
      // The forensic trail is `correctFact`'s, not this route's — see the
      // retract handler above and `lib/brain/correction.ts`'s header.
      return c.json(checked(BrainFactCorrectionResponseSchema, result), 200);
    }),
    { label: "apply brain fact correction verb" },
  );
});

adminBrainFacts.openapi(tensionSweepRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);

      // ADR-0037 §6's owner/admin bar, applied HERE for the reason
      // `admin-brain-vocabulary.ts` applies it at its own routes: `adminAuth`
      // gates the router on the SESSION's role, which does not know which
      // workspace is being written, so an admin of another org clears it. The
      // re-resolved context does not.
      //
      // Same bar as curating a predicate, and that is the point rather than a
      // convenience: this sweep is the *consequence* of a curation — it is what
      // makes an approved `single` entry reach rows that already exist — so a
      // reader who may not arm the entry may not fire it either. A lower bar
      // here would be a way around the higher one.
      const target = sweepTarget(ctx);
      if (target === null) {
        // LOGGED, like every other denial at this bar. The sweep is an
        // autonomous writer of `brain_edges`, and an attempt to run one without
        // the entitlement is exactly the event `acl.ts` says you want in the
        // log; the message travels out in the response, which is the caller's
        // copy rather than a server-side record.
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Brain tension sweep refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          {
            error: "forbidden",
            message: sweepDenialMessage(ctx),
            requestId,
          },
          403,
        );
      }

      const outcome = yield* Effect.tryPromise({
        // `target`, not `orgId` — the value the entitlement was CHECKED
        // against, so "the workspace I verified" and "the workspace I swept"
        // are literally the same binding rather than two reads that happen to
        // agree.
        try: () => sweepTensionEdges(target),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (outcome.kind === "contended") {
        // 409, on `refusalStatus`' own semantics: a target-state mismatch the
        // client can retry past. Not a 503 — nothing is unavailable, and not a
        // 500 — nothing failed.
        //
        // ⚠️ The discriminant travels in `error`, NOT in a `reason` field beside
        // it — `refusalBody`'s shape on the sibling vocabulary router, and for
        // its reason. `ErrorSchema` declares `error`, so the three values reach
        // the published spec for free. A separate `reason` was documented in the
        // 409's own prose, sent at runtime, absent from the schema, and STRIPPED
        // by any conforming reader (`ErrorSchema` is `z.object`, which drops
        // unknown keys) — a field a client is told to branch on and cannot see
        // is worse than no field at all.
        return c.json(
          { error: outcome.reason, message: contentionMessage(outcome.reason), requestId },
          409,
        );
      }

      // The audit row is THIS route's, unlike `/retract` and `/correct` where
      // the machinery owns it (#4934). `sweepTensionEdges` is a store primitive
      // with no request context and one entry point; a row emitted from inside
      // it would have to invent the actor. Emitted for a `minted: 0` run too —
      // "an admin swept and found nothing" is what makes a later non-zero run
      // interpretable, and its absence would read as "nobody has swept".
      logAdminAction({
        actionType: ADMIN_ACTIONS.brainFact.tensionSweep,
        targetType: "brainFact",
        // The WORKSPACE, not a fact — the sweep has no single target. See the
        // catalog entry, which is where that irregularity is recorded.
        // `target`, not `orgId` — the SAME binding the sweep ran on. Round 1
        // threaded `target` into the call and left both audit fields reading the
        // other variable, which is precisely the agree-by-construction shape
        // `sweepTarget`'s docstring refuses: they match today only because
        // `reviewerContext` was handed `orgId`. `actions.ts` calls this the one
        // `targetId` in the domain that is a workspace rather than a fact, so it
        // is the field an auditor reads.
        targetId: target,
        metadata: {
          workspaceId: target,
          minted: outcome.report.minted,
          truncated: outcome.report.truncated,
        },
      });

      // `checked`, not a `checkedWrite` equivalent, and the difference from
      // `admin-brain-vocabulary.ts`'s three write routes is real rather than an
      // oversight: this response is two numbers built from a value the seam just
      // returned, so a schema mismatch means the SHAPE drifted, not that a
      // committed write cannot be described. There is also nothing for an
      // approver to act on — the write is additive and re-running is a no-op —
      // so "it landed, reload" would be advice about nothing.
      return c.json(
        checked(BrainFactTensionSweepResponseSchema, {
          minted: outcome.report.minted,
          truncated: outcome.report.truncated,
        } satisfies BrainFactTensionSweepResponse),
        200,
      );
    }),
    { label: "sweep brain fact tension edges" },
  );
});

adminBrainFacts.openapi(tensionForecastRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);

      // The SAME bar as `/tension-sweep`, and reusing `sweepTarget` rather than
      // re-deriving it is the point that helper's docstring makes: the value the
      // entitlement was checked against IS the value the read runs on.
      //
      // ⚠️ The bar is not lowered because this is a read, and the temptation to
      // lower it is real — "it only returns a number". That number is
      // workspace-wide on a router where every other read is scoped to the
      // caller's own grants, and it is the decision aid for an act at the higher
      // bar. A reader who may not fire the sweep may not price it either; a
      // lower bar here would be a way around the higher one, which is the
      // sentence the sweep's own handler already carries.
      const target = sweepTarget(ctx);
      if (target === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Brain tension forecast refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          { error: "forbidden", message: forecastDenialMessage(ctx), requestId },
          403,
        );
      }

      // ⚠️ THE CONTENT-TYPE IS CHECKED BY HAND, because no layer beneath this
      // one will do it and the failure is silent in the worst possible
      // direction.
      //
      // MEASURED, not assumed. `hono/dist/validator/validator.js:13`: for
      // target `json`, if the content-type is absent or does not match
      // `application/…json`, the validator `break`s with `value = {}` and NEVER
      // PARSES THE BODY. `@hono/zod-openapi@1.5.1` then validates that `{}`
      // against this schema, which accepts it because `predicateSurface` is
      // optional. `required: true` does not change this — it selects which
      // middleware is installed, and both of them discard a body whose
      // content-type is wrong.
      //
      // So `fetch(url, {method:"POST", body: JSON.stringify({predicateSurface:"plan tier"})})`
      // — which sends `text/plain;charset=UTF-8`, and is the DEFAULT way to
      // call this — had its counterfactual dropped, fell through to the
      // `as-curated` branch, and was answered 200 with the CURRENT number. An
      // approver asking *"what would approving `plan tier` mint?"* reads that
      // `0` as a licence to approve, for a question that was never asked. It is
      // the same confident zero the `unkeyable-surface` arm exists to prevent,
      // reaching the caller through the one path that had no arm for it.
      //
      // Refused rather than guessed. There is no safe default: treating a
      // non-JSON body as `as-curated` is exactly the wrong answer, and ignoring
      // the body while claiming to have read it is worse.
      const contentType = c.req.header("content-type");
      if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
        return c.json(
          {
            error: "unsupported_media_type",
            message:
              "This endpoint needs a JSON body with an `application/json` content-type — send `{}` to ask about the workspace as it stands. It is refused rather than defaulted because a body sent under any other content-type is discarded before this handler runs, and answering the default question would report a number for a counterfactual nobody asked.",
            requestId,
          },
          415,
        );
      }

      // Past the guard the validator has genuinely parsed and accepted the body,
      // so this is the schema's output type and never `undefined`.
      // `predicateSurface` is what stays optional: present asks the
      // counterfactual, absent asks about the workspace as it stands.
      // `WithLooseOptionals` per the stage-1 precedent: Zod's `.optional()`
      // infers `predicateSurface?: string | undefined`, which under
      // `exactOptionalPropertyTypes` is no longer the exact optional the
      // request type declares. Required fields stay exact, so this still
      // catches a rename or a wrong type (#5522).
      const body: WithLooseOptionals<BrainFactTensionForecastRequest> = c.req.valid("json");
      const surface = body.predicateSurface;

      const outcome = yield* Effect.tryPromise({
        try: () =>
          forecastTensionEdges(
            target,
            surface === undefined
              ? { kind: "as-curated" }
              : { kind: "if-approved", predicateSurface: surface },
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (outcome.kind === "contended") {
        // 409, and the discriminant travels in `error` for the reason the sweep's
        // handler spells out: `ErrorSchema` declares `error` and drops unknown
        // keys, so a separate `reason` field would be documented, sent, and
        // stripped before any conforming client could branch on it.
        return c.json(
          { error: outcome.reason, message: forecastContentionMessage(outcome.reason), requestId },
          409,
        );
      }

      // ⚠️ NO `logAdminAction` row, and the asymmetry with `/tension-sweep` is
      // deliberate rather than an omission. That route audits because it WRITES
      // `brain_edges` workspace-wide and an auditor must be able to ask who
      // minted an edge. This reads, changes nothing, and is meant to be run
      // repeatedly and idly before a decision — a row per press would bury the
      // sweep's own rows in the log of people thinking about it. The server-side
      // record is `forecastTensionEdges`' unconditional `log.info`, which is the
      // right altitude for a read.
      return c.json(
        checked(
          BrainFactTensionForecastResponseSchema,
          outcome satisfies BrainFactTensionForecastResponse,
        ),
        200,
      );
    }),
    { label: "forecast brain fact tension edges" },
  );
});

/**
 * ADR-0037 §6's owner/admin bar — returning the WORKSPACE to sweep, or `null`.
 *
 * ⚠️ **It returns the target rather than a boolean, and that is the point.**
 * `recordedAuthor` in `admin-brain-vocabulary.ts` — the precedent this follows —
 * returns the author id you then store, so you cannot proceed past it without
 * consuming it. A `boolean` is discardable, and the call it guards took a
 * SEPARATE variable (`orgId`) that agreed with the checked context only by both
 * happening to read the same thing: the remember-to-call-it shape. Handing back
 * `ctx.workspaceId` makes "the workspace I verified" and "the workspace I swept"
 * one binding.
 *
 * Switched on the ORIGIN rather than written as a role test with a null guard,
 * for `recordedAuthor`'s other reason: an arm added to `BrainPrincipalContext`
 * has to be considered here rather than inheriting whichever answer a `??` chain
 * happens to give it. Verified, not assumed — a fourth arm fails to compile
 * against the declared return type.
 *
 * ⚠️ It does NOT require `ctx.userId`, where `recordedAuthor` does. That is not
 * a live divergence: `BrainPrincipalContext`'s `authenticated` arm declares
 * `userId: string`, and `resolveBrainReaderContext` answers `unresolved` when
 * there is no user, so the two bars agree in every representable state. The
 * reason to keep it absent here anyway is that nothing on this path is
 * attributed to a person on a ROW — the edges carry no author column, and the
 * actor reaches `admin_action_log` through the ambient request context — so
 * copying the requirement across would deny an entitled reader to protect a
 * column this path does not write.
 */
function sweepTarget(ctx: BrainPrincipalContext): string | null {
  switch (ctx.origin) {
    case "authenticated":
      return ctx.role === "owner" || ctx.role === "admin" ? ctx.workspaceId : null;
    case "unauthenticated-local":
      return ctx.workspaceId;
    case "unresolved":
      return null;
  }
}

/** Why a reader may not sweep — the `cardinalityDenialMessage` shape, one bar over. */
function sweepDenialMessage(ctx: BrainPrincipalContext): string {
  return ctx.origin === "authenticated"
    ? `Sweeping for tension edges needs the owner or admin entitlement; this reader is ` +
        `"${ctx.role ?? "no org role"}". The sweep is an autonomous writer of advisory ` +
        "contradiction edges over every live fact in the workspace, and it is the operation that " +
        "makes an approved `single` cardinality entry reach rows that already exist."
    : `Sweeping for tension edges needs a resolved reader identity; this one is "${ctx.origin}".`;
}

/**
 * Why a reader may not FORECAST - {@link sweepDenialMessage}, minus the write.
 *
 * WARNING: its own function rather than reusing the sweep's, and the reuse was a
 * real defect rather than a tidiness question. That message says the operation
 * "is an autonomous writer of advisory contradiction edges over every live fact
 * in the workspace" - so a member who pressed *Preview* was told they had been
 * denied a workspace-wide WRITE they never attempted, on an endpoint whose
 * published description promises it "writes nothing". A denial that misdescribes
 * what was refused is worse than a terse one: it sends the reader to ask for the
 * wrong permission.
 *
 * The BAR is identical and deliberately so - the sentence explaining why is what
 * differs, because here the argument is about disclosure rather than about
 * mutation.
 */
function forecastDenialMessage(ctx: BrainPrincipalContext): string {
  return ctx.origin === "authenticated"
    ? `Forecasting tension edges needs the owner or admin entitlement; this reader is ` +
        `"${ctx.role ?? "no org role"}". The forecast writes nothing, but it counts across ` +
        "every live fact in the workspace, where every other read on this router is scoped to " +
        "the caller's own grants - and it is the decision aid for arming the sweep, so a reader " +
        "who may not run that may not price it either."
    : `Forecasting tension edges needs a resolved reader identity; this one is "${ctx.origin}".`;
}

/**
 * Who to record as the eraser.
 *
 * `recordedAuthor`'s shape (`admin-brain-vocabulary.ts`), narrowed to a
 * NON-NULL return because `erased_by` carries a `<> ''` CHECK and the bar has
 * already been cleared by the time this is called. Switched on the ORIGIN
 * rather than written as a role test, for that helper's reason: a fourth arm on
 * `BrainPrincipalContext` has to be considered here rather than inheriting
 * whichever answer a `??` chain happens to give it.
 *
 * The `unresolved` arm is unreachable — `sweepTarget` returned `null` for it and
 * the route already answered 403 — and it returns a value rather than throwing
 * because an exception on an unreachable branch turns a hypothetical into a 500.
 */
function recordedEraser(ctx: BrainPrincipalContext): string {
  switch (ctx.origin) {
    case "authenticated":
      return ctx.userId ?? "unknown-admin";
    case "unauthenticated-local":
      return "local-operator";
    case "unresolved":
      return "unresolved-reader";
  }
}

adminBrainFacts.openapi(eraseActorIdentityRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* reviewerContext(mode, user, orgId, requestId);

      // The SAME bar `/tension-sweep` applies, and reusing `sweepTarget` rather
      // than writing a second predicate is deliberate: both are workspace-wide
      // writes that no per-claim grant scopes, so two spellings of one bar could
      // only ever drift apart. The binding it hands back is the workspace the
      // entitlement was CHECKED against, which is the workspace written below.
      const target = sweepTarget(ctx);
      if (target === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Brain actor-identity erasure refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          {
            error: "forbidden",
            message:
              ctx.origin === "authenticated"
                ? `Erasing an actor's directory snapshot needs the owner or admin entitlement; this reader is ` +
                  `"${ctx.role ?? "no org role"}". It clears a name from every claim that principal authored, ` +
                  "workspace-wide, and the capture pass never restores it."
                : `Erasing an actor's directory snapshot needs a resolved reader identity; this one is "${ctx.origin}".`,
            requestId,
          },
          403,
        );
      }

      const actor = c.req.valid("json").actor.trim();
      if (actor === "") {
        return c.json(
          {
            error: "invalid_request",
            message:
              "`actor` must be the handle exactly as it appears on the claim's provenance, such as `slack:U0AQW6KF2EM`.",
            requestId,
          },
          400,
        );
      }

      const db = getInternalDB();
      const outcome = yield* Effect.tryPromise({
        try: () => eraseActorIdentity(db, target, actor, recordedEraser(ctx)),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (!outcome.ok) {
        // The two refusals are kept DISTINGUISHABLE, unlike `/retract`'s
        // deliberately-indistinguishable 404 trio. Nothing is disclosed by the
        // difference: the caller already holds the handle (it is on the claim
        // they are reading), so neither answer confirms the existence of
        // anything they could not already see. What the difference buys is the
        // operator knowing whether to look elsewhere or to stop.
        return outcome.reason === "not-found"
          ? c.json(
              {
                error: "not_found",
                message:
                  `No identity is recorded for "${actor}" in this workspace, so there is nothing to erase. ` +
                  "Claims by that handle already render as \"cannot name this person\".",
                requestId,
              },
              404,
            )
          : c.json(
              {
                error: "conflict",
                message:
                  `"${actor}" carries no directory snapshot to clear. It either resolves to an Atlas account — ` +
                  "whose name is read live from that account, and whose erasure path is account deletion rather " +
                  "than this route — or it is already opaque.",
                requestId,
              },
              409,
            );
      }

      // Fire-and-forget, on `tensionSweep`'s argument rather than the
      // correction verbs': the pino line is emitted unconditionally before the
      // durable row is attempted, so an open circuit breaker costs the row and
      // not the trail — and reporting an erasure that COMMITTED as a failure is
      // the worse error here, since there is no un-erase verb to retry past it.
      logAdminAction({
        actionType: ADMIN_ACTIONS.brainFact.eraseActorIdentity,
        targetType: "brainFact",
        // The ACTOR HANDLE, not a fact id. An erasure is scoped to a person
        // across every claim they made; see the catalog entry, which records
        // this as the second irregular `targetId` in the domain.
        targetId: actor,
        metadata: { workspaceId: target },
      });

      return c.json(
        checked<BrainActorIdentityEraseResponse>(BrainActorIdentityEraseResponseSchema, {
          erased: true,
          actor,
        }),
        200,
      );
    }),
  );
});

export { adminBrainFacts };
