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
 * - POST   /:id/mark-dead — escape hatch: flip a pending/in_flight row to
 *                          `dead` so the flusher stops retrying
 *
 * Direct query approach: `crm_outbox` lives in core (no EE-specific
 * logic), so the route queries via `internalQuery` rather than widening
 * the SaasCrm Tag. The Tag is consulted only for the availability gate.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  SaasCrm,
} from "@atlas/api/lib/effect/services";
import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
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
const STATUS_SET = new Set<OutboxStatus>(OUTBOX_STATUSES);

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform Admin — CRM Outbox"],
  summary: "List CRM outbox rows",
  description:
    "SaaS only. Returns crm_outbox rows ordered by created_at DESC. Filters: status, event_type, since (ISO timestamp), limit.",
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
    "SaaS only. Operator escape hatch — flip a `pending` or `in_flight` row to `dead` so the flusher stops retrying. Use when an operator knows the upstream dispatch will never succeed.",
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
 * Mark-dead: only succeeds on `pending` or `in_flight`. Appends an
 * audit suffix to `last_error` so a future row-detail view shows the
 * manual override even when the prior error string was empty.
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
  WHERE id = $1 AND status IN ('pending', 'in_flight')
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
  return {
    ...toListRow(raw),
    fullLastError: raw.last_error,
    payload: raw.payload,
  };
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return LIST_LIMIT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return LIST_LIMIT_DEFAULT;
  return Math.min(parsed, LIST_LIMIT_MAX);
}

function tryQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
) {
  return Effect.tryPromise({
    try: () => internalQuery<T>(sql, params),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

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

      const rawStatus = c.req.query("status");
      const status =
        rawStatus && STATUS_SET.has(rawStatus as OutboxStatus)
          ? (rawStatus as OutboxStatus)
          : null;
      const eventType = c.req.query("event_type") ?? null;
      const sinceRaw = c.req.query("since");
      let since: string | null = null;
      if (sinceRaw) {
        const parsed = Date.parse(sinceRaw);
        if (Number.isFinite(parsed)) since = new Date(parsed).toISOString();
      }
      const limit = clampLimit(c.req.query("limit"));

      const rows = yield* tryQuery<RawListRow>(LIST_SQL, [
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
      const rows = yield* tryQuery<RawDetailRow>(GET_SQL, [id]);
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
      const probeRows = yield* tryQuery<ProbeRow>(PROBE_SQL, [id]);
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

      const updated = yield* tryQuery<RawListRow>(RETRY_SQL, [id]);
      const row = updated[0];
      if (!row) {
        // Race: a concurrent retry slipped between the probe and the
        // UPDATE. The row is no longer `dead` so the conditional WHERE
        // matched zero rows. Surface as 400 so the UI can re-fetch.
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

      logAdminAction({
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
        ipAddress:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          null,
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

      const probeRows = yield* tryQuery<ProbeRow>(PROBE_SQL, [id]);
      const probe = probeRows[0];
      if (!probe) {
        return c.json(
          { error: "not_found", message: "Outbox row not found.", requestId },
          404,
        );
      }
      if (probe.status !== "pending" && probe.status !== "in_flight") {
        return c.json(
          {
            error: "invalid_state",
            message: `Mark-dead only applies to pending/in_flight rows (row is currently \`${probe.status}\`).`,
            requestId,
          },
          400,
        );
      }

      const updated = yield* tryQuery<RawListRow>(MARK_DEAD_SQL, [id]);
      const row = updated[0];
      if (!row) {
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

      logAdminAction({
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
        ipAddress:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          null,
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
