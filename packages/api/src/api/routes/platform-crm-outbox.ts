/**
 * Platform CRM outbox routes — inspection + manual recovery for the
 * `crm_outbox` queue (#2735, slice 9 of 1.6.0).
 *
 * Mounted at /api/v1/platform/crm-outbox. All routes require
 * `platform_admin` role.
 *
 * Surface choice — platform, not admin: the `crm_outbox` table holds
 * Atlas's own marketing-funnel leads (demo signups, Better Auth
 * signups, talk-to-sales submissions). It's only populated when the
 * `SaasCrm` EE layer is bound — customer workspaces never write to it.
 * Same chrome split as `/platform/sla` and `/platform/backups`.
 *
 * Self-hosted gating: every handler reads `SaasCrm.available` and
 * returns 404 `not_available` when false. The no-op `SaasCrm` layer's
 * `available: false` keeps `/platform/crm-outbox` invisible on
 * self-hosted deploys (the web nav hides the link via `saasOnly`, and
 * direct access falls through to the 404 envelope).
 *
 * Provides:
 * - GET    /             — list rows with status / event_type / since filters
 * - GET    /:id          — full row detail (payload + untruncated last_error)
 * - POST   /:id/retry    — reset a `dead` row to `pending` (clears
 *                          `last_error`; keeps `attempts` so backoff resumes
 *                          from where it left off — no foot-gun infinite
 *                          retry loop on a permanently-broken upstream)
 * - POST   /:id/mark-dead — escape hatch: flip a `pending` row to
 *                          `dead` so the flusher stops retrying.
 *                          `in_flight` rows are rejected (400) — see
 *                          `MARK_DEAD_SQL` for the durability
 *                          rationale.
 *
 * The route uses `queryEffect` directly because the table lives in
 * core; the `SaasCrm` Tag is touched only for the availability gate.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import {
  logAdminAction,
  logAdminActionAwait,
  ADMIN_ACTIONS,
} from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  SaasCrm,
} from "@atlas/api/lib/effect/services";
import { hasInternalDB, queryEffect } from "@atlas/api/lib/db/internal";
import {
  CrmOutboxRowSchema,
  CrmOutboxRowDetailSchema,
  CrmOutboxListResponseSchema,
  // OUTBOX_STATUSES is mirrored in @useatlas/schemas (not imported from
  // @useatlas/types) to avoid the registry-pinned value-export drag on
  // the scaffold template build — see the comment in
  // `packages/schemas/src/crm-outbox.ts`.
  OUTBOX_STATUSES,
} from "@useatlas/schemas";
import type { OutboxStatus } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-crm-outbox");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;
/**
 * Cap on `last_error` length in the list payload. The detail endpoint
 * surfaces the full string under `fullLastError` — a multi-KB stack
 * from a runaway upstream shouldn't bloat the list response.
 */
const LAST_ERROR_LIST_TRUNCATION = 200;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------
//
// Declared once and shared across `createRoute` definitions so the
// generated OpenAPI surfaces the parameter contract AND the
// `validationHook` (mounted by `createPlatformRouter`) automatically
// 422s on malformed input — no more silent fallbacks for bad
// `since=` or `limit=` values.

const ListQuerySchema = z.object({
  status: z.enum(OUTBOX_STATUSES).optional().openapi({
    description: "Filter by outbox row status.",
    example: "dead",
  }),
  event_type: z.string().min(1).max(64).optional().openapi({
    description:
      "Filter by event_type discriminator (e.g. demo, sales-form, signup).",
    example: "demo",
  }),
  since: z.string().datetime({ offset: true }).optional().openapi({
    description:
      "Return rows created at or after this RFC-3339 timestamp. " +
      "MUST include a timezone offset (Z or ±HH:MM) — naive local " +
      "timestamps are rejected so the filter window is unambiguous " +
      "across server/client zones.",
    example: "2026-05-01T00:00:00Z",
  }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .optional()
    .openapi({
      description: `Max rows to return. Default ${LIST_LIMIT_DEFAULT}, capped at ${LIST_LIMIT_MAX}.`,
      example: 100,
    }),
});

const RowParamSchema = z.object({
  id: z.string().uuid().openapi({
    description: "Outbox row id (UUID).",
    example: "00000000-0000-0000-0000-000000000000",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform Admin — CRM Outbox"],
  summary: "List CRM outbox rows",
  description:
    "SaaS only. Returns crm_outbox rows ordered by created_at DESC. Filters: status, event_type, since (RFC-3339 timestamp with timezone), limit.",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "Outbox rows",
      content: {
        "application/json": { schema: CrmOutboxListResponseSchema },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or no internal DB", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRowRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Platform Admin — CRM Outbox"],
  summary: "Get CRM outbox row detail",
  description:
    "SaaS only. Returns the full row including payload JSONB and untruncated last_error.",
  request: { params: RowParamSchema },
  responses: {
    200: {
      description: "Outbox row detail",
      content: { "application/json": { schema: CrmOutboxRowDetailSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or row not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const retryRoute = createRoute({
  method: "post",
  path: "/{id}/retry",
  tags: ["Platform Admin — CRM Outbox"],
  summary: "Retry a dead outbox row",
  description:
    "SaaS only. Flips a `dead` row back to `pending` and clears `last_error`. `attempts` is intentionally NOT reset so the deterministic backoff in lib/lead-outbox continues from where it left off — prevents an operator from foot-gunning infinite retries on a permanently-broken upstream call.",
  request: { params: RowParamSchema },
  responses: {
    200: {
      description: "Row reset to pending",
      content: { "application/json": { schema: z.object({ message: z.string(), row: CrmOutboxRowSchema }) } },
    },
    400: { description: "Row is not in `dead` status", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or row not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const markDeadRoute = createRoute({
  method: "post",
  path: "/{id}/mark-dead",
  tags: ["Platform Admin — CRM Outbox"],
  summary: "Manually mark an outbox row dead",
  description:
    "SaaS only. Operator escape hatch — flip a `pending` row to `dead` so the flusher stops retrying. `in_flight` rows are NOT accepted: the flusher's terminal commit (MARK_DONE_SQL / MARK_TRANSIENT_FAIL_SQL) is gated on `id` only, so a mark-dead during dispatch would be silently overwritten by the dispatcher's outcome. Operators must wait for the current attempt to settle (the row returns to `pending` on transient failure within seconds) before marking dead.",
  request: { params: RowParamSchema },
  responses: {
    200: {
      description: "Row marked dead",
      content: { "application/json": { schema: z.object({ message: z.string(), row: CrmOutboxRowSchema }) } },
    },
    400: { description: "Row is already in a terminal state", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or row not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// SQL — hoisted so each statement is greppable
// ---------------------------------------------------------------------------

const LIST_SQL = `
  SELECT id, created_at, event_type, status, attempts, last_error,
         twenty_person_id, twenty_note_id, processed_at, retry_after, claimed_at
  FROM crm_outbox
  WHERE ($1::text IS NULL OR status = $1)
    AND ($2::text IS NULL OR event_type = $2)
    AND ($3::timestamptz IS NULL OR created_at >= $3)
  ORDER BY created_at DESC
  LIMIT $4
`;

const GET_SQL = `
  SELECT id, created_at, event_type, payload, status, attempts, last_error,
         twenty_person_id, twenty_note_id, processed_at, retry_after, claimed_at
  FROM crm_outbox
  WHERE id = $1
`;

/**
 * Pre-mutation probe. Used by `retry` and `mark-dead` to snapshot the
 * row's prior state for the audit-log metadata BEFORE the conditional
 * UPDATE flips the row. Also disambiguates "no such id" (404) from
 * "wrong status for this action" (400).
 */
const PROBE_SQL = `
  SELECT id, event_type, status, attempts, last_error
  FROM crm_outbox
  WHERE id = $1
`;

/**
 * Retry: only succeeds when the row is currently `dead`. The
 * conditional UPDATE is the gate.
 *
 * `attempts` is deliberately NOT reset. The deterministic backoff in
 * `lib/lead-outbox/backoff.ts` is keyed on attempts; leaving it intact
 * means a retried row's next failure honours the same tier it would
 * have if the operator had never touched it. Resetting would let an
 * operator turn a permanently-broken upstream into a tight retry loop.
 */
const RETRY_SQL = `
  UPDATE crm_outbox
  SET status = 'pending',
      last_error = NULL,
      retry_after = NULL,
      claimed_at = NULL,
      processed_at = NULL
  WHERE id = $1 AND status = 'dead'
  RETURNING id, created_at, event_type, status, attempts, last_error,
            twenty_person_id, twenty_note_id, processed_at, retry_after, claimed_at
`;

/**
 * Mark-dead: only succeeds on `pending`. `in_flight` is intentionally
 * excluded — the flusher's terminal writes in `lib/lead-outbox/outbox.ts`
 * (`MARK_DONE_SQL`, `MARK_TRANSIENT_FAIL_SQL`, `MARK_DEAD_SQL`) are
 * gated on `id` only, so a manual `dead` write during dispatch would
 * be silently overwritten when the dispatcher's commit lands. Forcing
 * the operator to wait until the row returns to `pending` (typically
 * &lt; 1s for transient outcomes; immediate for permanent failures —
 * the flusher dead-letters those itself) makes the verdict durable.
 *
 * Appends an audit suffix to `last_error` so a future row-detail view
 * shows the manual override even when the prior error string was empty.
 */
const MARK_DEAD_SQL = `
  UPDATE crm_outbox
  SET status = 'dead',
      processed_at = now(),
      last_error = CASE
        WHEN last_error IS NULL OR last_error = ''
          THEN 'manually marked dead by platform admin'
        ELSE last_error || ' [manually marked dead by platform admin]'
      END,
      retry_after = NULL,
      claimed_at = NULL
  WHERE id = $1 AND status = 'pending'
  RETURNING id, created_at, event_type, status, attempts, last_error,
            twenty_person_id, twenty_note_id, processed_at, retry_after, claimed_at
`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

// `internalQuery<T extends Record<string, unknown>>` requires an
// index signature on the row type. Express as `type … & Record<…>`
// rather than `interface` so the structural compatibility goes through
// without forcing the helper's bound onto unrelated call sites.
type RawListRow = {
  id: string;
  created_at: string | Date;
  event_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  twenty_person_id: string | null;
  twenty_note_id: string | null;
  processed_at: string | Date | null;
  retry_after: string | Date | null;
  claimed_at: string | Date | null;
} & Record<string, unknown>;

type RawDetailRow = RawListRow & { payload: unknown };

type ProbeRow = {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
} & Record<string, unknown>;

function isoOrNull(v: string | Date | null): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : v.toISOString();
}

function isoOr(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

function truncate(value: string | null, max: number): string | null {
  if (value == null) return null;
  if (value.length <= max) return value;
  return value.slice(0, max) + "…";
}

function toListRow(raw: RawListRow) {
  return {
    id: raw.id,
    createdAt: isoOr(raw.created_at),
    eventType: raw.event_type,
    status: raw.status as OutboxStatus,
    attempts: raw.attempts,
    lastError: truncate(raw.last_error, LAST_ERROR_LIST_TRUNCATION),
    twentyPersonId: raw.twenty_person_id,
    twentyNoteId: raw.twenty_note_id,
    processedAt: isoOrNull(raw.processed_at),
    retryAfter: isoOrNull(raw.retry_after),
    claimedAt: isoOrNull(raw.claimed_at),
  };
}

function toDetailRow(raw: RawDetailRow) {
  // Detail-row override: skip the list-side truncation so `lastError`
  // and `fullLastError` carry the same untruncated string on the
  // detail endpoint. Two fields exist for wire compatibility with
  // `CrmOutboxRowSchema` (the parent shape) — they MUST agree on
  // detail rows so a UI consumer reading `.lastError` doesn't get a
  // half-string mid-stack-trace.
  return {
    ...toListRow(raw),
    lastError: raw.last_error,
    fullLastError: raw.last_error,
    payload: raw.payload,
  };
}

// `queryEffect` (from @atlas/api/lib/db/internal) is the canonical DB
// → Effect bridge: it wraps `internalQuery` with the centralized
// `normalizeError` so route handlers don't re-implement the catch
// shape per file. See `packages/api/src/lib/db/internal.ts:629` for
// the rationale ("Effect.promise hides DB rejections in the defect
// channel; route handlers should use queryEffect").

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformCrmOutbox = createPlatformRouter();

// ── List rows ────────────────────────────────────────────────────────

platformCrmOutbox.openapi(listRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;

      const crm = yield* SaasCrm;
      if (!crm.available) {
        return c.json(
          {
            error: "not_available",
            message:
              "CRM outbox inspection requires enterprise features to be enabled.",
            requestId,
          },
          404,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_available",
            message: "CRM outbox inspection requires an internal database.",
            requestId,
          },
          404,
        );
      }

      // `validationHook` 422s on a malformed query — by the time we
      // reach here every field is either undefined or a valid value
      // matching `ListQuerySchema`. Coerce undefined → null so the
      // `IS NULL OR …` predicates in `LIST_SQL` skip the filter
      // server-side.
      const query = c.req.valid("query");
      const status = query.status ?? null;
      const eventType = query.event_type ?? null;
      // `z.string().datetime({ offset: true })` validates RFC-3339;
      // normalise to UTC ISO so the SQL bind is timezone-unambiguous.
      const since = query.since ? new Date(query.since).toISOString() : null;
      const limit = query.limit ?? LIST_LIMIT_DEFAULT;

      const rows = yield* queryEffect<RawListRow>(LIST_SQL, [
        status,
        eventType,
        since,
        limit,
      ]);

      return c.json({ rows: rows.map(toListRow) }, 200);
    }),
    { label: "list crm outbox rows" },
  );
});

// ── Get row detail ───────────────────────────────────────────────────

platformCrmOutbox.openapi(getRowRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;

      const crm = yield* SaasCrm;
      if (!crm.available) {
        return c.json(
          {
            error: "not_available",
            message:
              "CRM outbox inspection requires enterprise features to be enabled.",
            requestId,
          },
          404,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_available",
            message: "CRM outbox inspection requires an internal database.",
            requestId,
          },
          404,
        );
      }

      const id = c.req.param("id");
      const rows = yield* queryEffect<RawDetailRow>(GET_SQL, [id]);
      const row = rows[0];
      if (!row) {
        return c.json(
          { error: "not_found", message: "Outbox row not found.", requestId },
          404,
        );
      }
      return c.json(toDetailRow(row), 200);
    }),
    { label: "get crm outbox row" },
  );
});

// ── Retry dead row ───────────────────────────────────────────────────

platformCrmOutbox.openapi(retryRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;

      const crm = yield* SaasCrm;
      if (!crm.available) {
        return c.json(
          {
            error: "not_available",
            message:
              "CRM outbox retry requires enterprise features to be enabled.",
            requestId,
          },
          404,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_available",
            message: "CRM outbox retry requires an internal database.",
            requestId,
          },
          404,
        );
      }

      const id = c.req.param("id");

      // Snapshot before mutation so the audit row captures what the
      // operator overrode.
      const probeRows = yield* queryEffect<ProbeRow>(PROBE_SQL, [id]);
      const probe = probeRows[0];
      if (!probe) {
        return c.json(
          { error: "not_found", message: "Outbox row not found.", requestId },
          404,
        );
      }
      if (probe.status !== "dead") {
        return c.json(
          {
            error: "invalid_state",
            message: `Retry only applies to dead rows (row is currently \`${probe.status}\`).`,
            requestId,
          },
          400,
        );
      }

      const updated = yield* queryEffect<RawListRow>(RETRY_SQL, [id]);
      const row = updated[0];
      const ipAddress =
        c.req.header("x-forwarded-for") ??
        c.req.header("x-real-ip") ??
        null;
      if (!row) {
        // Race: a concurrent retry slipped between the probe and the
        // UPDATE. The row is no longer `dead` so the conditional WHERE
        // matched zero rows. Surface as 400 so the UI can re-fetch
        // AND emit a `status: "failure"` audit row so a reviewer can
        // still tell that an operator tried — without this row, two
        // simultaneous retries on the same id leave only the winner's
        // trail in `admin_action_log`.
        logAdminAction({
          actionType: ADMIN_ACTIONS.crm_outbox.retry,
          targetType: "crm_outbox",
          targetId: id,
          scope: "platform",
          status: "failure",
          metadata: {
            outboxId: id,
            eventType: probe.event_type,
            previousStatus: probe.status,
            previousAttempts: probe.attempts,
            previousLastError: probe.last_error,
            raceLost: true,
          },
          ipAddress,
        });
        return c.json(
          {
            error: "race_lost",
            message:
              "Row transitioned out of `dead` between probe and update. Re-fetch and retry if needed.",
            requestId,
          },
          400,
        );
      }

      log.info(
        { rowId: id, requestId, previousAttempts: probe.attempts },
        "CRM outbox row reset to pending by platform admin",
      );

      // Audit is the security control here — without a durable row,
      // an operator can flip a `dead` lead back to `pending` with no
      // forensic trail. Use `logAdminActionAwait` so a DB blip after
      // the UPDATE surfaces to the caller as a 500; the operator's
      // instinctive retry safely no-ops because the row's status is
      // already `pending` (returns 400 `invalid_state` next time).
      yield* Effect.tryPromise({
        try: () =>
          logAdminActionAwait({
            actionType: ADMIN_ACTIONS.crm_outbox.retry,
            targetType: "crm_outbox",
            targetId: id,
            scope: "platform",
            metadata: {
              outboxId: id,
              eventType: probe.event_type,
              previousStatus: probe.status,
              previousAttempts: probe.attempts,
              previousLastError: probe.last_error,
            },
            ipAddress,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(
        {
          message:
            "Row reset to pending. The next flusher tick will pick it up.",
          row: toListRow(row),
        },
        200,
      );
    }),
    { label: "retry crm outbox row" },
  );
});

// ── Mark dead ────────────────────────────────────────────────────────

platformCrmOutbox.openapi(markDeadRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;

      const crm = yield* SaasCrm;
      if (!crm.available) {
        return c.json(
          {
            error: "not_available",
            message:
              "CRM outbox mark-dead requires enterprise features to be enabled.",
            requestId,
          },
          404,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_available",
            message: "CRM outbox mark-dead requires an internal database.",
            requestId,
          },
          404,
        );
      }

      const id = c.req.param("id");

      const probeRows = yield* queryEffect<ProbeRow>(PROBE_SQL, [id]);
      const probe = probeRows[0];
      if (!probe) {
        return c.json(
          { error: "not_found", message: "Outbox row not found.", requestId },
          404,
        );
      }
      if (probe.status !== "pending") {
        return c.json(
          {
            error: "invalid_state",
            message: `Mark-dead only applies to pending rows (row is currently \`${probe.status}\`). Wait for an in_flight attempt to settle before marking the row dead — the flusher's terminal commit would silently overwrite a manual write.`,
            requestId,
          },
          400,
        );
      }

      const updated = yield* queryEffect<RawListRow>(MARK_DEAD_SQL, [id]);
      const row = updated[0];
      const ipAddress =
        c.req.header("x-forwarded-for") ??
        c.req.header("x-real-ip") ??
        null;
      if (!row) {
        // Race: a concurrent mark-dead OR the flusher's own commit
        // flipped the row to a terminal state between probe and
        // UPDATE. Emit a failure audit so the loser's intent isn't
        // erased from `admin_action_log`.
        logAdminAction({
          actionType: ADMIN_ACTIONS.crm_outbox.markDead,
          targetType: "crm_outbox",
          targetId: id,
          scope: "platform",
          status: "failure",
          metadata: {
            outboxId: id,
            eventType: probe.event_type,
            previousStatus: probe.status,
            previousAttempts: probe.attempts,
            previousLastError: probe.last_error,
            raceLost: true,
          },
          ipAddress,
        });
        return c.json(
          {
            error: "race_lost",
            message:
              "Row transitioned to a terminal state between probe and update. Re-fetch and retry if needed.",
            requestId,
          },
          400,
        );
      }

      log.info(
        { rowId: id, requestId, previousStatus: probe.status },
        "CRM outbox row marked dead by platform admin",
      );

      // Same audit-as-security-control rationale as the retry path —
      // mark-dead is a state mutation that disappears without a
      // durable forensic trail.
      yield* Effect.tryPromise({
        try: () =>
          logAdminActionAwait({
            actionType: ADMIN_ACTIONS.crm_outbox.markDead,
            targetType: "crm_outbox",
            targetId: id,
            scope: "platform",
            metadata: {
              outboxId: id,
              eventType: probe.event_type,
              previousStatus: probe.status,
              previousAttempts: probe.attempts,
              previousLastError: probe.last_error,
            },
            ipAddress,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      return c.json(
        { message: "Row marked dead.", row: toListRow(row) },
        200,
      );
    }),
    { label: "mark crm outbox row dead" },
  );
});

export { platformCrmOutbox };
