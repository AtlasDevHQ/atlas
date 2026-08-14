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
 *
 * ## Why the surface exists
 *
 * Every fact lands as a `draft` needing a human publish — migration 0180's
 * default IS the review gate (`reconcile.ts:777`). A warehouse producer emitting
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
  unenrollPair,
} from "@atlas/api/lib/brain/enrollment";
import {
  loadEnrollableDimensions,
  loadEnrollableEntities,
} from "@atlas/api/lib/brain/enrollment-candidates";
import {
  BrainEnrollmentDimensionsResponseSchema,
  BrainEnrollmentEntitiesResponseSchema,
  BrainEnrollmentListResponseSchema,
  BrainEnrollmentUnenrollRequestSchema,
  BrainEnrollmentWriteRequestSchema,
  BrainEnrollmentWriteResponseSchema,
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
 * time).
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
          const enrolled = new Set(
            enrollments.filter((e) => e.entity === entity).map((e) => e.dimension),
          );
          return {
            entity,
            dimensions: candidates.map((candidate) => ({
              ...candidate,
              enrolled: enrolled.has(candidate.name),
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

export { adminBrainEnrollment };
