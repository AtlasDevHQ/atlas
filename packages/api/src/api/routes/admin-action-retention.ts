/**
 * Admin-action retention + erasure management routes (F-36 Phase 2).
 *
 * Mounted under /api/v1/admin/audit. Sibling to `admin-audit-retention.ts`
 * which governs `audit_log`; this file governs `admin_action_log`. All
 * routes require admin role AND enterprise license (enforced within the
 * EE retention library).
 *
 * Exports two sub-routers so admin.ts can keep the public paths flat:
 *   adminActionRetention  → /audit/admin-action-retention{,/purge}
 *   adminEraseUser        → /audit/erase-user{,/preview}
 *
 * Surface:
 *   GET  /admin-action-retention          — current policy + last-purge metadata
 *   PUT  /admin-action-retention          — update policy (emits policy_update)
 *   POST /admin-action-retention/purge    — manual hard-delete past retention (emits manual_purge)
 *   GET  /erase-user/preview?userId=...   — row-count preview, no audit emission
 *   POST /erase-user                      — scrub actor_id + actor_email (library emits user.erase)
 *
 * Audit emission contract:
 *   - `policyUpdate` / `manualPurge` — mirror the audit-log retention
 *     route pattern: route-layer emission with previous values + ipAddress.
 *     The library's `setAdminActionRetentionPolicy` gates its own emission
 *     on `!isHttpContext()` so there's no double-row under HTTP.
 *   - `user.erase` — Phase 1 library owns success emission unconditionally
 *     (see `anonymizeUserAdminActions` docstring in ee/src/audit/retention.ts).
 *     This route emits ONLY on failure, so a library error still leaves a
 *     forensic row even though the scrub never completed.
 *
 * Erasure preview is deliberately read-only: no audit row for a reviewer
 * clicking "what would this wipe" before the confirm dialog.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { RetentionError, type AnonymizeInitiatedBy } from "@atlas/ee/audit/retention";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { logAdminActionAwait, ADMIN_ACTIONS, type AdminActionEntry } from "@atlas/api/lib/audit";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const retentionDomainError = domainError(RetentionError, { validation: 400, not_found: 404 });

const log = createLogger("admin-action-retention");

function clientIpFrom(headers: { header(name: string): string | undefined }): string | null {
  const fwd = headers.header("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.header("x-real-ip") ?? null;
}

function errorContext(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const ctx: Record<string, unknown> = { message: err.message };
    const codeVal = (err as { code?: unknown }).code;
    if (typeof codeVal === "string") ctx.code = codeVal;
    const tagVal = (err as { _tag?: unknown })._tag;
    if (typeof tagVal === "string") ctx.tag = tagVal;
    return ctx;
  }
  return { message: String(err) };
}

/**
 * Synchronous audit emission for the "success → 200" path.
 *
 * Invariant: an audit-write failure must promote to a 500 response rather
 * than a silent 200 with no row. A 200 with no audit row would let an
 * attacker shrink retention or trigger a purge without leaving a trace —
 * the F-26 threat model this route exists to defend against. The admin
 * retries on 500 (library writes are idempotent: `setAdminActionRetentionPolicy`
 * upserts, `purgeAdminActionExpired` re-scans past-window rows).
 */
function emitAudit(entry: AdminActionEntry): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => logAdminActionAwait(entry),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

/**
 * Suppressed audit emission for the failure-path tapError helpers. An
 * audit-emit failure must never replace the original EE error in the
 * Effect channel — the admin needs to see why the mutation failed, not
 * why the failure audit write failed. Log-warn so the audit miss is still
 * observable in pino.
 */
function emitAuditBestEffort(entry: AdminActionEntry): Effect.Effect<void> {
  return emitAudit(entry).pipe(
    Effect.catchAll((auditErr) =>
      Effect.sync(() => {
        log.error(
          { err: auditErr.message, actionType: entry.actionType, targetId: entry.targetId },
          "admin_action_retention audit row failed during failure-path emission — original error still propagated",
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RetentionPolicySchema = z.object({
  orgId: z.string(),
  retentionDays: z.number().int().min(7).nullable(),
  hardDeleteDelayDays: z.number().int().min(0),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  lastPurgeAt: z.string().nullable(),
  lastPurgeCount: z.number().int().min(0).nullable(),
});

// Zod validation is deliberately tighter than a pass-through `z.number()`
// so 400s carry a structured parse error and OpenAPI advertises the real
// contract. The EE library still catches out-of-band values as a last
// line of defense (see `MIN_RETENTION_DAYS` / hard-delete validation).
const UpdateRetentionBodySchema = z.object({
  retentionDays: z.number().int().min(7).nullable().openapi({
    example: 2555,
    description: "Number of days to retain admin-action log entries. null = unlimited. Minimum 7. Recommended default 2555 (7 years).",
  }),
  hardDeleteDelayDays: z.number().int().min(0).optional().openapi({
    example: 30,
    description: "Days after soft-delete before permanent deletion. Default 30. (Admin-action purge is direct hard-delete; this column is held for symmetry and future use.)",
  }),
});

// The HTTP surface narrows `AnonymizeInitiatedBy` — `scheduled_retention` is
// reserved for future background erasure automation and must never be
// submitted via an admin-triggered HTTP body. `satisfies` is a compile-time
// guard: if Phase 1 renames a value, the route fails to type-check (instead
// of silently accepting a string the library no longer understands).
const INITIATED_BY_VALUES = [
  "self_request",
  "dsr_request",
] as const satisfies readonly AnonymizeInitiatedBy[];

const EraseUserBodySchema = z.object({
  userId: z.string().min(1).openapi({
    example: "user-abc",
    description: "The internal user id whose identifiers should be scrubbed from admin_action_log.",
  }),
  initiatedBy: z.enum(INITIATED_BY_VALUES).openapi({
    example: "dsr_request",
    description: "Origination path. 'self_request' = user-initiated self-serve erasure; 'dsr_request' = admin-processed DSR letter.",
  }),
});

const PreviewQuerySchema = z.object({
  userId: z.string().min(1).openapi({
    param: { in: "query", name: "userId" },
    description: "The internal user id to preview scrub count for.",
  }),
});

// ---------------------------------------------------------------------------
// Admin-action-retention CRUD + purge routes
// ---------------------------------------------------------------------------

const getRetentionRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Admin-Action Retention"],
  summary: "Get admin-action retention policy",
  description:
    "Returns the current admin-action retention policy for the admin's active organization. Returns null policy if no retention is configured (unlimited).",
  responses: {
    200: {
      description: "Current retention policy",
      content: {
        "application/json": {
          schema: z.object({ policy: RetentionPolicySchema.nullable() }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateRetentionRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Admin-Action Retention"],
  summary: "Update admin-action retention policy",
  description:
    "Sets or updates the admin-action retention policy. Retention period must be at least 7 days or null (unlimited). Default recommendation is 2555 days (7 years).",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpdateRetentionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated retention policy",
      content: { "application/json": { schema: z.object({ policy: RetentionPolicySchema }) } },
    },
    400: { description: "Invalid retention configuration or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const purgeRoute = createRoute({
  method: "post",
  path: "/purge",
  tags: ["Admin — Admin-Action Retention"],
  summary: "Trigger manual admin-action log purge",
  description:
    "Manually hard-deletes admin_action_log entries past the retention window for the admin's active organization. Normally runs automatically on a daily schedule.",
  responses: {
    200: {
      description: "Purge results",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(z.object({
              orgId: z.string(),
              deletedCount: z.number(),
            })),
          }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Erase-user routes
// ---------------------------------------------------------------------------

const erasePreviewRoute = createRoute({
  method: "get",
  path: "/preview",
  tags: ["Admin — Admin-Action Retention"],
  summary: "Preview admin-action erasure blast radius",
  description:
    "Returns the count of admin_action_log rows that would be scrubbed for the given userId. Read-only — never emits an audit row, never modifies state. Drives the UI confirm dialog.",
  request: { query: PreviewQuerySchema },
  responses: {
    200: {
      description: "Row count preview",
      content: {
        "application/json": {
          schema: z.object({ anonymizableRowCount: z.number() }),
        },
      },
    },
    400: { description: "Missing or empty userId, or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const eraseUserRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Admin-Action Retention"],
  summary: "Erase a user from the admin-action log (GDPR / CCPA right-to-erasure)",
  description:
    "Scrubs actor_id and actor_email to NULL and stamps anonymized_at on every admin_action_log row where actor_id = userId. The row survives so the sequence of actions is preserved without the identifier. Pino / operational logs are controlled by your log-aggregator retention policy.",
  request: {
    body: { required: true, content: { "application/json": { schema: EraseUserBodySchema } } },
  },
  responses: {
    200: {
      description: "Erasure result",
      content: {
        "application/json": {
          schema: z.object({ anonymizedRowCount: z.number() }),
        },
      },
    },
    400: { description: "Invalid userId or initiatedBy, or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

const adminActionRetention = createAdminRouter();
adminActionRetention.use(requireOrgContext());

// GET /admin-action-retention — current policy
adminActionRetention.openapi(getRetentionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { getAdminActionRetentionPolicy } = yield* Effect.promise(
      () => import("@atlas/ee/audit/retention"),
    );
    const policy = yield* getAdminActionRetentionPolicy(orgId!);
    return c.json({ policy }, 200);
  }), { label: "get admin-action retention policy", domainErrors: [retentionDomainError] });
});

// PUT /admin-action-retention — update policy
adminActionRetention.openapi(updateRetentionRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const body = c.req.valid("json");

    const { setAdminActionRetentionPolicy, getAdminActionRetentionPolicy } =
      yield* Effect.promise(() => import("@atlas/ee/audit/retention"));

    const requestedMeta = {
      retentionDays: body.retentionDays,
      hardDeleteDelayDays: body.hardDeleteDelayDays ?? null,
    };

    // Snapshot prior policy BEFORE the write so the audit row captures
    // the shrink delta. A read failure still emits a stage:policy_read
    // failure audit so an attacker can't probe for transient-error gaps.
    const previous = yield* getAdminActionRetentionPolicy(orgId!).pipe(
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.admin_action_retention.policyUpdate,
          targetType: "admin_action_retention",
          targetId: orgId!,
          status: "failure",
          metadata: {
            ...requestedMeta,
            previousRetentionDays: null,
            previousHardDeleteDelayDays: null,
            stage: "policy_read",
            ...errorContext(err),
          },
          ipAddress,
        }),
      ),
    );

    const baseMeta = {
      ...requestedMeta,
      previousRetentionDays: previous?.retentionDays ?? null,
      previousHardDeleteDelayDays: previous?.hardDeleteDelayDays ?? null,
    };

    return yield* setAdminActionRetentionPolicy(
      orgId!,
      { retentionDays: body.retentionDays, hardDeleteDelayDays: body.hardDeleteDelayDays },
      user?.id ?? null,
    ).pipe(
      Effect.tap(() =>
        emitAudit({
          actionType: ADMIN_ACTIONS.admin_action_retention.policyUpdate,
          targetType: "admin_action_retention",
          targetId: orgId!,
          metadata: baseMeta,
          ipAddress,
        }),
      ),
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.admin_action_retention.policyUpdate,
          targetType: "admin_action_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { ...baseMeta, ...errorContext(err) },
          ipAddress,
        }),
      ),
      Effect.map((policy) => c.json({ policy }, 200)),
    );
  }), { label: "update admin-action retention policy", domainErrors: [retentionDomainError] });
});

// POST /admin-action-retention/purge — manual hard-delete past retention window
adminActionRetention.openapi(purgeRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { purgeAdminActionExpired, getAdminActionRetentionPolicy } =
      yield* Effect.promise(() => import("@atlas/ee/audit/retention"));

    const policy = yield* getAdminActionRetentionPolicy(orgId!).pipe(
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.admin_action_retention.manualPurge,
          targetType: "admin_action_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { retentionDays: null, stage: "policy_read", ...errorContext(err) },
          ipAddress,
        }),
      ),
    );
    const retentionDays = policy?.retentionDays ?? null;

    return yield* purgeAdminActionExpired(orgId!).pipe(
      Effect.tap((results) => {
        const deletedCount = results.reduce((sum, row) => sum + row.deletedCount, 0);
        return emitAudit({
          actionType: ADMIN_ACTIONS.admin_action_retention.manualPurge,
          targetType: "admin_action_retention",
          targetId: orgId!,
          metadata: { deletedCount, retentionDays },
          ipAddress,
        });
      }),
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.admin_action_retention.manualPurge,
          targetType: "admin_action_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { retentionDays, ...errorContext(err) },
          ipAddress,
        }),
      ),
      Effect.map((results) => c.json({ results }, 200)),
    );
  }), { label: "purge admin-action log entries", domainErrors: [retentionDomainError] });
});

const adminEraseUser = createAdminRouter();
adminEraseUser.use(requireOrgContext());

// GET /erase-user/preview — read-only count, no audit emission
adminEraseUser.openapi(erasePreviewRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const query = c.req.valid("query");
    const { previewAdminActionErasure } = yield* Effect.promise(
      () => import("@atlas/ee/audit/retention"),
    );
    const result = yield* previewAdminActionErasure(query.userId);
    return c.json(result, 200);
  }), { label: "preview admin-action erasure", domainErrors: [retentionDomainError] });
});

// POST /erase-user — GDPR / CCPA scrub. Library owns success-path audit;
// route emits failure-path only (see file-header contract).
adminEraseUser.openapi(eraseUserRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const body = c.req.valid("json");
    const { anonymizeUserAdminActions } = yield* Effect.promise(
      () => import("@atlas/ee/audit/retention"),
    );

    return yield* anonymizeUserAdminActions(body.userId, body.initiatedBy).pipe(
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.user.erase,
          targetType: "user",
          targetId: body.userId,
          status: "failure",
          scope: "platform",
          metadata: {
            targetUserId: body.userId,
            initiatedBy: body.initiatedBy,
            ...errorContext(err),
          },
          ipAddress,
        }),
      ),
      Effect.map((result) => c.json(result, 200)),
    );
  }), { label: "erase user admin-action log entries", domainErrors: [retentionDomainError] });
});

export { adminActionRetention, adminEraseUser };
