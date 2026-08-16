/**
 * The **enrollment surface** (#5196, ADR-0039) — where a human names the
 * `(entity, dimension)` pairs the tier-1 warehouse producer (#5042) may emit
 * claims about.
 *
 * Mounted under `/api/v1/admin/brain-enrollment`:
 *
 *   GET  /            — what this workspace has enrolled
 *   GET  /entities    — the entities a pair could be enrolled from
 *   GET  /dimensions  — one entity's dimensions/measures, each flagged enrolled
 *   POST /enroll      — bring one pair into the producer's reach
 *   POST /unenroll    — take one pair back out
 *   POST /produce     — run the producer over that reach (#5042)
 *
 * ## Why the producer's trigger lives on the ENROLLMENT surface
 *
 * Because the reach is what it runs over, and the two questions an operator asks
 * — *what may it emit?* and *what did it emit?* — are one screen. Keeping the
 * verb here also keeps it under the same owner/admin bar as the two writes, which
 * matters: running the producer fills the review queue an admin has to drain, so
 * it is an authority act wearing a read's shape.
 *
 * It is no longer the only trigger. #5228 added the cadence fiber ADR-0039
 * promised (`lib/scheduler/brain-warehouse-cadence.ts`), which answered the
 * enablement, cadence and audit questions this paragraph used to defer. There is
 * still no on-connect hook, and that one is not a deferral — an enroll-on-connect
 * affordance is the sweep the ADR rejects by name.
 *
 * Both triggers now go through the same workspace-scoped run lock
 * (`lib/brain/warehouse-run-lock.ts`), so this verb can answer **409** for a
 * reason it never could before: a scheduled run is in flight. That is a real
 * outcome rather than a defensive one — two runs take two snapshot instants and
 * the episode table's conflict clause cannot see them as the same reading.
 *
 * ## Why the surface exists
 *
 * Every fact lands as a `draft` needing a human publish — migration 0180's
 * default IS the review gate (`reconcile.ts`'s `INSERT_FACT_SQL`, #4769). A warehouse producer emitting
 * one fact per row per dimension on a schedule would put an unreviewable queue
 * behind the one gate the product is differentiated by; ADR-0039's arithmetic is
 * ten thousand accounts across eight dimensions being eighty thousand drafts.
 * Enrollment is the bound, and ADR-0040 states its general form: **the contract
 * automates availability and never automates authority.**
 *
 * ## The two GETs that are not writes, and the one rule they must not break
 *
 * `/entities` and `/dimensions` ENUMERATE the semantic layer. Enumerating is the
 * availability arm and may happen automatically on every page load; turning any
 * of it into an enrollment is the authority arm and takes a person clicking a
 * specific pair. **There is deliberately no `POST /enroll-all`, no
 * enroll-on-connect hook, and no enroll-from-profiler affordance** — ADR-0039's
 * rejected-alternative test is whether a person chose the MEMBERS, not whether a
 * person clicked something, and a button over a set the server chose fails it.
 * A bulk affordance could be added later over a selection the admin ticked; one
 * over "everything the list returned" could not.
 *
 * ## Enrollment is an authority decision, so it is attributed and 403-gated
 *
 * `adminAuth` gates the router coarsely (it reads the SESSION's role); each write
 * additionally re-resolves the principal against THIS workspace
 * (`resolveBrainReaderContext`) and applies the owner/admin bar, exactly as
 * `admin-brain-vocabulary.ts` and `admin-brain-slack.ts` do. Neither check is
 * redundant: the router keeps a non-admin session out of the surface, the
 * re-resolution keeps an admin of ANOTHER workspace out of this one's reach.
 *
 * ## What un-enrolling does NOT do
 *
 * It stops future emission. It does not retract, invalidate, hide, or re-review
 * a single fact the producer already emitted and a human already published — a
 * machine invalidating a fact is forbidden (#4759 §2, ADR-0036 §T4), and the only
 * invalidation authority is the human at the review gate. The response says so
 * to the caller and `lib/brain/enrollment.ts` says so to the next reader.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { resolveBrainReaderContext } from "@atlas/api/lib/brain/reader-context";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  InvalidEnrollmentPairError,
  enrollPair,
  listEnrollments,
  normalizeEnrollmentPair,
  setNamingDimension,
  unenrollPair,
} from "@atlas/api/lib/brain/enrollment";
import {
  loadEnrollableDimensions,
  loadEnrollableEntities,
} from "@atlas/api/lib/brain/enrollment-candidates";
import {
  runWarehouseProducer,
  type WarehouseProducerReport,
} from "@atlas/api/lib/brain/warehouse-producer";
import { withWarehouseRunLock } from "@atlas/api/lib/brain/warehouse-run-lock";
import {
  BrainEnrollmentDimensionsResponseSchema,
  BrainEnrollmentEntitiesResponseSchema,
  BrainEnrollmentListResponseSchema,
  BrainEnrollmentNamingRequestSchema,
  BrainEnrollmentNamingResponseSchema,
  BrainEnrollmentUnenrollRequestSchema,
  BrainEnrollmentWriteRequestSchema,
  BrainEnrollmentWriteResponseSchema,
  BrainWarehouseRunReportSchema,
  BrainWarehouseRunResponseSchema,
} from "@useatlas/schemas";
import { ErrorSchema } from "./shared-schemas";
import { createAdminRouter, noActiveOrgBody, requireOrgContext } from "./admin-router";

const log = createLogger("api.admin.brain-enrollment");

/**
 * `admin-brain-slack.ts`'s `recordedAuthor`, verbatim and for its reason.
 *
 * Switched on the ORIGIN rather than written `ctx.userId ?? SENTINEL`: `??`
 * applies the local-operator sentinel to every origin whose `userId` happens to
 * be null, so an `unresolved` principal would file one workspace's authority
 * decision under another's operator.
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

function errorBody(error: string, message: string, requestId: string) {
  return { error, message, requestId };
}

/**
 * Every response is parsed through its own wire schema before it goes out —
 * `admin-brain-vocabulary.ts`'s `checked`, and for its reason: Hono does not
 * validate responses, so without this the shared schema is a promise the API
 * makes and never checks.
 */
function checked<T>(schema: { parse: (value: unknown) => T }, payload: unknown): T {
  return schema.parse(payload);
}

/**
 * Compile-time pin: the producer's report and its wire schema describe ONE shape.
 *
 * ⚠️ Without it the two are a hand-maintained mirror whose drift is invisible until
 * production. `checked` takes `unknown`, the schemas are `strictObject`, and the
 * parse runs after every episode, fact and cardinality proposal has committed — so
 * one field added to `WarehouseEntityOutcome` and not to the schema compiles clean,
 * passes both producer suites (neither parses a report through the schema), and
 * 500s in production on a run that fully succeeded.
 *
 * Mutual `extends` rather than a one-way `satisfies`: a schema that is a strict
 * SUBSET of the report is the direction that actually happens, and one-way
 * assignability admits it.
 */
type ExactShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _reportMatchesWireSchema: ExactShape<
  WarehouseProducerReport,
  z.infer<typeof BrainWarehouseRunReportSchema>
> = true;
void _reportMatchesWireSchema;

/**
 * The producer report's response parse, with the POST-COMMIT posture.
 *
 * `admin-brain-vocabulary.ts`'s `checkedWrite`, applied where that file's argument
 * actually bites. On a parse failure this does not throw: the run LANDED, its
 * drafts are in the review queue, and a 500 saying "Failed to run" would invite the
 * one retry that doubles the queue.
 *
 * ⚠️ **The degraded arm says NOTHING about the run, and the first cut of it was
 * worse than the 500 it replaced.** That version returned the counts with
 * `entities: []` and `refusals: []` — so `{enrolled: 8, created: 0, refusals: []}`,
 * a confident all-clear for a run that may have refused every pair, handed to the
 * one operator whose next action is to press Run again. It also copied four fields
 * verbatim out of the object whose parse had just failed, without knowing which
 * field failed. Now the arm carries only what the ROUTE knows — the workspace, the
 * request id, and a sentence — so a caller cannot read a zero out of it and nothing
 * un-validated is re-emitted.
 */
function checkedRun(report: WarehouseProducerReport, workspaceId: string, requestId: string) {
  // ⚠️ Parsed against the REPORT schema, not the response UNION, and the difference
  // is the whole diagnostic. A zod union failure is a single `invalid_union` issue
  // at `path: []` — the per-arm detail lives in `issue.errors` — so mapping
  // `i.path.join(".")` over a union's issues yields `[""]` for every possible
  // drift. That is the one record of a post-commit, deterministic-under-retry
  // failure, and the response tells the operator to go read it.
  const parsed = BrainWarehouseRunReportSchema.safeParse(report);
  if (parsed.success) return { ...parsed.data, reportComplete: true as const };
  // ⚠️ **THE COUNTS, RECOVERED THROUGH A SECOND PARSE — never read off `report`.**
  // The drift is usually ONE field (`entities[]` is the largest and most drift-prone
  // array), so `created`/`corroborated` are primitives that parsed fine. Losing them
  // here is the one path where the run COMMITTED facts into the review queue and
  // nothing anywhere says how many — while the 200 body tells the operator to go read
  // this very log line. Recovered by parsing, not by reading, so the class the
  // pre-validation fix closed stays closed: a drifted or hostile report cannot throw
  // here, it just yields `null`.
  const counts = z
    .object({
      enrolled: z.number(),
      created: z.number(),
      corroborated: z.number(),
      refusals: z.array(z.unknown()),
    })
    .partial()
    .safeParse(report);
  log.error(
    {
      requestId,
      workspaceId,
      // The ZodError itself AND a flattened summary: the first survives whatever
      // the serializer does with it, the second is greppable.
      err: parsed.error,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message: i.message,
      })),
      recoveredCounts: counts.success
        ? {
            enrolled: counts.data.enrolled,
            created: counts.data.created,
            corroborated: counts.data.corroborated,
            refusals: counts.data.refusals?.length,
          }
        : null,
    },
    "Warehouse producer report failed its own response schema — the run COMMITTED; the report shape drifted",
  );
  return {
    reportComplete: false,
    workspaceId,
    requestId,
    message:
      "The producer run completed and its claims are in the review queue, but this server could not " +
      "serialize the report of it. Nothing was retried, nothing was lost, and re-running would file a " +
      "second round of drafts — check the review queue and the server log for this request id instead.",
  } satisfies z.infer<typeof BrainWarehouseRunResponseSchema>;
}

/**
 * ⚠️ **Why the two WRITE routes use `checked` and not `admin-brain-vocabulary`'s
 * `checkedWrite` — a deliberate divergence, recorded rather than assumed.**
 *
 * `checkedWrite` exists there because a response-schema throw AFTER a committed
 * write reports a landed write as *"Failed to author…"*. The same shape exists
 * here in principle. It is not reachable in practice today:
 * `BrainEnrollmentWriteResponseSchema` is a three-key `strictObject` built from
 * a literal whose values were already validated on the way in — two trimmed
 * strings and a boolean — so there is no DB-derived field that could fail the
 * parse.
 *
 * The reason to state it rather than leave it: the moment that response grows a
 * field derived from anything but the request, the failure lands post-commit and
 * is DETERMINISTIC under retry — the same request rebuilds the same payload and
 * fails the same parse, so an admin sees "failed" forever while the pair is
 * enrolled and the producer's reach is genuinely wider. Grow the response, take
 * `checkedWrite` (and lift it somewhere shared rather than copying it a third
 * time). (`/produce` takes {@link checkedRun} — it IS the post-commit case this
 * block says to take `checkedWrite` for.)
 */

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Brain"],
  summary: "List the workspace's enrolled (entity, dimension) pairs",
  description:
    "The warehouse producer's reach (ADR-0039). It emits claims for these pairs and for no others; " +
    "an unenrolled dimension is outside its reach rather than hidden or pending. `entityCount` is " +
    "the distinct entity set the producer evaluates its fail-closed ambiguity rule across.",
  responses: {
    200: { description: "Enrolled pairs", content: { "application/json": { schema: BrainEnrollmentListResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const entitiesRoute = createRoute({
  method: "get",
  path: "/entities",
  tags: ["Admin — Brain"],
  summary: "List the entities a pair could be enrolled from",
  description:
    "The published semantic layer's entities. ENUMERATION ONLY — listing an entity enrolls nothing, " +
    "and there is no endpoint that enrolls a set the server chose.",
  responses: {
    200: { description: "Enrollable entities", content: { "application/json": { schema: BrainEnrollmentEntitiesResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const dimensionsRoute = createRoute({
  method: "get",
  path: "/dimensions",
  tags: ["Admin — Brain"],
  summary: "List one entity's enrollable dimensions and measures",
  description:
    "Each carries whether it is already enrolled, computed server-side against the same rows the " +
    "list endpoint returns. An entity with no dimensions answers 200 with an empty list; an entity " +
    "this workspace's published semantic layer has never heard of answers 404 — they are different " +
    "facts and only one of them is a mistake the caller made.",
  request: {
    query: z.object({
      entity: z.string().min(1).openapi({ param: { name: "entity", in: "query" }, example: "accounts" }),
    }),
  },
  responses: {
    200: { description: "Enrollable dimensions", content: { "application/json": { schema: BrainEnrollmentDimensionsResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "No such entity in the published semantic layer", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description:
        "The entity name resolves in more than one connection group (#2412), so which one to enroll from is ambiguous. " +
        "Enrollment stores `(workspace, entity, dimension)` with no group column, so this surface cannot express the choice.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const enrollRoute = createRoute({
  method: "post",
  path: "/enroll",
  tags: ["Admin — Brain"],
  summary: "Bring one (entity, dimension) pair into the producer's reach",
  description:
    "Idempotent. `changed: false` means the pair was already enrolled and nothing — recorded author " +
    "and note included — changed. The pair must exist in the published semantic layer: an enrollment " +
    "for a dimension Atlas cannot see inserts cleanly and reaches nothing, which looks exactly like " +
    "success.",
  request: {
    body: { content: { "application/json": { schema: BrainEnrollmentWriteRequestSchema } } },
  },
  responses: {
    200: { description: "Enrolled", content: { "application/json": { schema: BrainEnrollmentWriteResponseSchema } } },
    400: { description: "Invalid pair or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not entitled", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "No such (entity, dimension) in the published semantic layer", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description:
        "The entity name resolves in more than one connection group (#2412). Declared on this WRITE route because the " +
        "pre-write semantic-layer check runs the same lookup as `GET /dimensions`.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const produceRoute = createRoute({
  method: "post",
  path: "/produce",
  tags: ["Admin — Brain"],
  summary: "Run the tier-1 warehouse producer over this workspace's reach",
  description:
    "Reads every enrolled pair, snapshots the warehouse, and files the claims as DRAFTS for review " +
    "(#5042, ADR-0037 §4). It emits for enrolled pairs and for no others, and it refuses rather " +
    "than choosing when a dimension name is enrolled on two entities at once. Nothing it does " +
    "publishes, retires, or invalidates a fact: a re-run over a changed value files a new draft and " +
    "an advisory tension edge beside the old one, and stamps no validity window. `enrolled` and " +
    "`refusals` are both returned because a run that emitted nothing because nothing is enrolled and " +
    "one that emitted nothing because everything was refused are otherwise the same silence.",
  responses: {
    200: { description: "The run report", content: { "application/json": { schema: BrainWarehouseRunResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not entitled", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description:
        "A run is already in progress for this workspace — this press, or the cadence fiber (#5228). " +
        "Nothing was read and nothing was written. Two overlapping runs take two snapshot instants, so " +
        "the episode table's conflict clause dedupes neither, and each changed value would cost two " +
        "drafts and two tension edges instead of one.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unenrollRoute = createRoute({
  method: "post",
  path: "/unenroll",
  tags: ["Admin — Brain"],
  summary: "Take one (entity, dimension) pair out of the producer's reach",
  description:
    "Stops FUTURE emission and does nothing else. Facts the producer already emitted and a human " +
    "already published stay published, stay visible, and keep their validity windows — un-enrolling " +
    "is not an invalidation authority. `changed: false` means the pair was not enrolled.",
  request: {
    body: { content: { "application/json": { schema: BrainEnrollmentUnenrollRequestSchema } } },
  },
  responses: {
    200: { description: "Un-enrolled", content: { "application/json": { schema: BrainEnrollmentWriteResponseSchema } } },
    400: { description: "Invalid pair or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not entitled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const namingRoute = createRoute({
  method: "post",
  path: "/naming",
  tags: ["Admin — Brain"],
  summary: "Name the dimension that supplies an entity's canonical surface",
  description:
    "The entity store (#5043) keys on a human-readable name, and the semantic layer marks which " +
    "dimension identifies a row but marks nothing as the row's NAME — so a person names it. " +
    "Marking one makes a surrogate-keyed warehouse row (`42`) collide with an extracted mention of " +
    "its name (`Acme Corp`), by way of an approved vocabulary edge. ⚠️ That edge RE-KEYS every " +
    "brain fact about the entity, workspace-wide, and so does changing it. `dimension: null` " +
    "clears it, after which the store holds no entry for the entity and every lookup abstains. " +
    "The dimension must already be enrolled: the snapshot query names the enrolled columns only, " +
    "so naming an unenrolled one would look set and reach nothing.",
  request: {
    body: { content: { "application/json": { schema: BrainEnrollmentNamingRequestSchema } } },
  },
  responses: {
    200: { description: "Named", content: { "application/json": { schema: BrainEnrollmentNamingResponseSchema } } },
    400: { description: "Invalid pair, dimension not enrolled, or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not entitled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminBrainEnrollment = createAdminRouter();

adminBrainEnrollment.use(requireOrgContext());

const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

adminBrainEnrollment.openapi(listRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const enrollments = yield* Effect.tryPromise({
        try: () => listEnrollments(orgId),
        catch: toError,
      });

      return c.json(
        checked(BrainEnrollmentListResponseSchema, {
          enrollments,
          entityCount: new Set(enrollments.map((e) => e.entity)).size,
        }),
        200,
      );
    }),
    { label: "list brain enrollments" },
  );
});

adminBrainEnrollment.openapi(entitiesRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const entities = yield* Effect.tryPromise({
        try: () => loadEnrollableEntities(orgId),
        catch: toError,
      });

      return c.json(checked(BrainEnrollmentEntitiesResponseSchema, { entities }), 200);
    }),
    { label: "list brain enrollment entities" },
  );
});

adminBrainEnrollment.openapi(dimensionsRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);
      const { entity } = c.req.valid("query");

      const payload = yield* Effect.tryPromise({
        try: async () => {
          // Both reads in one round trip. They are independent — the semantic
          // layer knows nothing about enrollment — so serializing them would
          // only cost latency.
          const [candidates, enrollments] = await Promise.all([
            loadEnrollableDimensions(orgId, entity),
            listEnrollments(orgId),
          ]);
          if (candidates === null) return null;
          const mine = enrollments.filter((e) => e.entity === entity);
          const enrolled = new Set(mine.map((e) => e.dimension));
          // Computed SERVER-SIDE beside `enrolled`, for that flag's reason: the
          // client would have to re-implement the pair's identity to join it,
          // and a mismatch renders the naming dimension as un-named — offering a
          // "name this" action whose click is a no-op.
          const naming = new Set(mine.filter((e) => e.naming).map((e) => e.dimension));
          return {
            entity,
            dimensions: candidates.map((candidate) => ({
              ...candidate,
              enrolled: enrolled.has(candidate.name),
              naming: naming.has(candidate.name),
            })),
          };
        },
        catch: toError,
      });

      if (payload === null) {
        return c.json(
          errorBody(
            "entity-not-found",
            `"${entity.slice(0, 80)}" is not an entity in this workspace's published semantic layer. ` +
              "A draft entity is deliberately not enrollable — the producer reads what is live, and a " +
              "pair enrolled against a draft would disappear when the draft is discarded.",
            requestId,
          ),
          404,
        );
      }

      return c.json(checked(BrainEnrollmentDimensionsResponseSchema, payload), 200);
    }),
    { label: "list brain enrollment dimensions" },
  );
});

adminBrainEnrollment.openapi(enrollRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);
      const body = c.req.valid("json");

      const ctx = yield* Effect.tryPromise({
        try: () =>
          resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
        catch: toError,
      });
      const author = recordedAuthor(ctx);
      if (author === null) {
        // LOGGED. Widening what the Atlas may hold claims about without the
        // entitlement is exactly the event `acl.ts` says belongs in the log.
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Enrollment refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          errorBody(
            "not-entitled",
            "Enrolling a dimension decides what the company Atlas may hold claims about, so it is " +
              "limited to workspace owners and admins.",
            requestId,
          ),
          403,
        );
      }

      const outcome = yield* Effect.tryPromise({
        try: async () => {
          const pair = normalizeEnrollmentPair(body.entity, body.dimension);
          // ⚠️ Verified against the semantic layer BEFORE the write, not after.
          // An enrollment for a dimension Atlas cannot see stores cleanly and
          // reaches nothing — it sits in the list looking live while the
          // producer's lookup never matches it, which is indistinguishable from
          // a working enrollment for a warehouse that happens to be quiet. The
          // check is a point-in-time one, deliberately: an entity RENAMED after
          // enrolment leaves a stale pair, and that is the coverage surface's
          // question (ADR-0041) rather than a reason to re-validate on read.
          const candidates = await loadEnrollableDimensions(orgId, pair.entity);
          if (candidates === null) return { kind: "missing", pair, entityResolved: false } as const;
          if (!candidates.some((cnd) => cnd.name === pair.dimension)) {
            return { kind: "missing", pair, entityResolved: true } as const;
          }
          const changed = await enrollPair({
            workspaceId: orgId,
            entity: pair.entity,
            dimension: pair.dimension,
            note: body.note ?? null,
            actor: author,
          });
          return { kind: "written", pair, changed } as const;
        },
        catch: toError,
      }).pipe(
        // Matched by TYPE, not by message substring — a reworded message must
        // not silently turn the 400 into a 500 — and the message travels FROM
        // the error, so the route cannot drift from the validator's wording.
        Effect.catchAll((err) =>
          err instanceof InvalidEnrollmentPairError
            ? Effect.succeed({ kind: "invalid", message: err.message } as const)
            : Effect.fail(err),
        ),
      );

      if (outcome.kind === "invalid") {
        return c.json(errorBody("invalid-pair", outcome.message, requestId), 400);
      }
      if (outcome.kind === "missing") {
        // ⚠️ TWO messages, because the two halves fail for different reasons and
        // one sentence sent an admin hunting the wrong one. When the ENTITY did
        // not resolve, "names are case-sensitive" is advice about the dimension
        // — a typo that does not exist — and the real causes (not published, or
        // ambiguous across connection groups) go unnamed.
        const message = outcome.entityResolved
          ? `"${outcome.pair.dimension}" is not a dimension or measure of "${outcome.pair.entity}" ` +
            "in this workspace's published semantic layer. Names are case-sensitive, because a " +
            "warehouse may hold two columns that differ only in case."
          : `"${outcome.pair.entity}" is not an entity in this workspace's published semantic layer. ` +
            "A draft entity is deliberately not enrollable — the producer reads what is live.";
        return c.json(errorBody("pair-not-found", message, requestId), 404);
      }

      // ⚠️ The two guards above `return`, so control reaching here is the
      // WRITTEN arm — but TypeScript only notices a new arm that lacks `pair` or
      // `changed`. An arm like `{ kind: "conflict", pair, changed }` would
      // narrow in silently and be logged as "Enrolled a pair" with a 200. On a
      // surface whose thesis is that a no-op must never wear success, the
      // default has to be a compile error instead.
      outcome satisfies { readonly kind: "written" };
      log.info(
        {
          workspaceId: orgId,
          entity: outcome.pair.entity,
          dimension: outcome.pair.dimension,
          changed: outcome.changed,
          requestId,
        },
        "Enrolled a pair into the warehouse producer's reach",
      );
      return c.json(
        checked(BrainEnrollmentWriteResponseSchema, {
          entity: outcome.pair.entity,
          dimension: outcome.pair.dimension,
          changed: outcome.changed,
        }),
        200,
      );
    }),
    { label: "enroll brain dimension" },
  );
});

adminBrainEnrollment.openapi(unenrollRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);
      const body = c.req.valid("json");

      const ctx = yield* Effect.tryPromise({
        try: () =>
          resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
        catch: toError,
      });
      // Gated on the SAME bar as enrolling. Narrowing the reach is the less
      // consequential direction — it stops future emission and touches no
      // published fact — but a lower bar here would let a non-admin undo an
      // admin's decision about what the Atlas may learn.
      if (recordedAuthor(ctx) === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Un-enrollment refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          errorBody(
            "not-entitled",
            "Un-enrolling a dimension decides what the company Atlas may hold claims about, so it is " +
              "limited to workspace owners and admins.",
            requestId,
          ),
          403,
        );
      }

      // NOT verified against the semantic layer. The enroll verb checks because
      // enrolling something Atlas cannot see is a silent no-op wearing success;
      // un-enrolling a pair whose entity has since been deleted is the ONE case
      // where the row most needs removing, so the same check here would strand
      // exactly the enrollments an admin came to clear.
      const outcome = yield* Effect.tryPromise({
        try: async () => {
          const pair = normalizeEnrollmentPair(body.entity, body.dimension);
          const changed = await unenrollPair({
            workspaceId: orgId,
            entity: pair.entity,
            dimension: pair.dimension,
          });
          return { kind: "written", pair, changed } as const;
        },
        catch: toError,
      }).pipe(
        Effect.catchAll((err) =>
          err instanceof InvalidEnrollmentPairError
            ? Effect.succeed({ kind: "invalid", message: err.message } as const)
            : Effect.fail(err),
        ),
      );

      if (outcome.kind === "invalid") {
        return c.json(errorBody("invalid-pair", outcome.message, requestId), 400);
      }

      // The enroll verb's pin, for its reason. See there.
      outcome satisfies { readonly kind: "written" };
      log.info(
        {
          workspaceId: orgId,
          entity: outcome.pair.entity,
          dimension: outcome.pair.dimension,
          changed: outcome.changed,
          requestId,
        },
        "Removed a pair from the warehouse producer's reach — published facts untouched",
      );
      return c.json(
        checked(BrainEnrollmentWriteResponseSchema, {
          entity: outcome.pair.entity,
          dimension: outcome.pair.dimension,
          changed: outcome.changed,
        }),
        200,
      );
    }),
    { label: "unenroll brain dimension" },
  );
});

adminBrainEnrollment.openapi(namingRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);
      const body = c.req.valid("json");

      const ctx = yield* Effect.tryPromise({
        try: () =>
          resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
        catch: toError,
      });
      // The SAME owner/admin bar the other two write verbs take, and here it is
      // the strictest of the three by consequence: enrolling widens what may be
      // emitted, un-enrolling narrows it, and this one RE-KEYS facts that are
      // already published — the workspace-wide blast radius ADR-0037 §5 records
      // as reachable from a warehouse rename nobody thinks of as a brain
      // operation.
      if (recordedAuthor(ctx) === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Naming-dimension change refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          errorBody(
            "not-entitled",
            "Naming an entity's canonical surface re-keys every fact about it, so it is limited to " +
              "workspace owners and admins.",
            requestId,
          ),
          403,
        );
      }

      const outcome = yield* Effect.tryPromise({
        try: async () => {
          const changed = await setNamingDimension({
            workspaceId: orgId,
            entity: body.entity,
            dimension: body.dimension,
          });
          // Normalized through the same door the write took, so the response
          // echoes what was STORED rather than what was sent — a trailing space
          // in the request must not read back as an accepted spelling.
          const pair = normalizeEnrollmentPair(body.entity, body.dimension ?? body.entity);
          return {
            kind: "written",
            entity: pair.entity,
            dimension: body.dimension === null ? null : pair.dimension,
            changed,
          } as const;
        },
        catch: toError,
      }).pipe(
        Effect.catchAll((err) =>
          err instanceof InvalidEnrollmentPairError
            ? Effect.succeed({ kind: "invalid", message: err.message } as const)
            : Effect.fail(err),
        ),
      );

      if (outcome.kind === "invalid") {
        return c.json(errorBody("invalid-pair", outcome.message, requestId), 400);
      }

      outcome satisfies { readonly kind: "written" };
      log.info(
        {
          workspaceId: orgId,
          entity: outcome.entity,
          dimension: outcome.dimension,
          changed: outcome.changed,
          requestId,
        },
        outcome.dimension === null
          ? "Cleared an entity's naming dimension — the entity store holds no entry for it"
          : "Named an entity's canonical surface — every fact about it re-keys onto that name",
      );
      return c.json(
        checked(BrainEnrollmentNamingResponseSchema, {
          entity: outcome.entity,
          dimension: outcome.dimension,
          changed: outcome.changed,
        }),
        200,
      );
    }),
    { label: "set brain naming dimension" },
  );
});

adminBrainEnrollment.openapi(produceRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { mode, user, orgId } = yield* AuthContext;
      if (!orgId) return c.json(noActiveOrgBody(requestId), 400);

      const ctx = yield* Effect.tryPromise({
        try: () =>
          resolveBrainReaderContext(getInternalDB(), { workspaceId: orgId, mode, user, requestId }),
        catch: toError,
      });
      // The SAME owner/admin bar the two write verbs take. Running the producer
      // writes drafts into the review queue and reads the workspace's warehouse,
      // so it is not a read even though it takes no body — and a lower bar here
      // would let a non-admin fill the queue an admin has to drain.
      const triggeredBy = recordedAuthor(ctx);
      if (triggeredBy === null) {
        log.warn(
          { workspaceId: orgId, origin: ctx.origin, role: ctx.role, requestId },
          "Warehouse producer run refused — the reader does not clear the owner/admin bar",
        );
        return c.json(
          errorBody(
            "not-entitled",
            "Running the warehouse producer files claims into this workspace's review queue, so it " +
              "is limited to workspace owners and admins.",
            requestId,
          ),
          403,
        );
      }

      // ⚠️ **The lock, and it is not belt-and-braces** (#5228). Since the cadence
      // fiber exists, "an operator presses Run while a scheduled run is in
      // flight" is an ordinary Tuesday rather than a race somebody has to
      // engineer. Two overlapping runs take two `new Date()` readings, so the
      // episode table's `ON CONFLICT (workspace_id, source, source_id)` — whose
      // source id carries the snapshot instant — dedupes nothing, and every
      // changed value costs two drafts and two tension edges where the product's
      // whole argument is that a person reviews each one.
      const outcome = yield* Effect.tryPromise({
        try: () =>
          withWarehouseRunLock(orgId, () =>
            runWarehouseProducer({ workspaceId: orgId, triggeredBy, requestId }),
          ),
        catch: toError,
      });
      if (!outcome.acquired) {
        // 409, not 200-with-an-empty-report. "A run is already in progress" and
        // "your reach produced nothing" are different sentences, and an operator
        // who cannot tell them apart un-enrolls a working pair.
        log.info(
          { workspaceId: orgId, triggeredBy, requestId },
          "Warehouse producer run declined — a run is already in progress for this workspace",
        );
        return c.json(
          errorBody(
            "run-in-progress",
            "A warehouse producer run is already in progress for this workspace — either a scheduled " +
              "run or another press. Nothing was read and nothing was written by this request. Wait for " +
              "it to finish and check the review queue before running again.",
            requestId,
          ),
          409,
        );
      }
      const report = outcome.value;

      // ⚠️ `checkedRun`, NOT `checked` — this is the case the file's own docstring
      // above says to take `checkedWrite` for. Every field of this response is
      // derived from the semantic layer, the warehouse and `reconcileFacts`, and it
      // is built AFTER N transactions have committed. A schema drift here is
      // deterministic under retry, so `checked` would tell an admin the run failed,
      // forever, while each press files another full round of drafts.
      const response = checkedRun(report, orgId, requestId);
      // ⚠️ **VALIDATED FIRST, then logged — the log reads `response`, never `report`.**
      // This line used to run BEFORE the parse and read four fields straight off the
      // producer's return, one of them nested (`report.refusals.length`). On a DRIFTED
      // report — the case `checkedRun` exists for, and which the degraded-report test
      // models by omitting a field — a nested access throws, and a throw here turns a
      // committed run into the 500 this route spends three paragraphs refusing to
      // return.
      //
      // Measured twice, and the second time is the point: adding `entityEdges.kind` to
      // the old line 500'd immediately, and narrowing THAT ONE FIELD from `unknown`
      // left `refusals.length` beside it doing exactly the same thing. Reading only
      // post-parse values closes the class instead of the instance — there is no
      // pre-validation read left to get wrong.
      //
      // The edge pass's verdict is here because without it the line reads as an
      // unqualified success for a run whose edge pass threw: the producer's own
      // `log.error` fires, but an operator grepping THIS line — keyed by `requestId` —
      // saw a clean run and nothing else.
      log.info(
        response.reportComplete
          ? {
              workspaceId: orgId,
              requestId,
              enrolled: response.enrolled,
              created: response.created,
              corroborated: response.corroborated,
              refusals: response.refusals.length,
              entityEdgeKind: response.entityEdges.kind,
              // ⚠️ `kind: "failed"` alone stops one question short: the remedy for a
              // store that was never read is not the remedy for a batch that was
              // half-committed. Post-parse, so it costs nothing.
              entityEdgePhase:
                response.entityEdges.kind === "failed"
                  ? response.entityEdges.reached.phase
                  : undefined,
            }
          : // The drifted arm says so rather than reporting numbers it does not have.
            // `checkedRun`'s own `log.error` carries the zod issues; this line exists
            // so the route's success line is never the last word on a failed parse.
            { workspaceId: orgId, requestId, reportComplete: false },
        "Warehouse producer run requested from the admin surface",
      );
      return c.json(response, 200);
    }),
    { label: "run brain warehouse producer" },
  );
});

export { adminBrainEnrollment };
