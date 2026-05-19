/**
 * Admin proactive-chat drill-down events + classifier review routes (#2622).
 *
 * Two surfaces, both enterprise-gated:
 *
 *   GET  /api/v1/admin/proactive/events
 *     Paginated list of recent meter rows joined with the verdict if
 *     any. Defaults to a 30-day window and the `classify` event type
 *     (the only one the drill-down currently labels). Cursor
 *     pagination — pass `cursor` query param from the previous page's
 *     `nextCursor` to continue.
 *
 *   POST /api/v1/admin/proactive/events/:messageId/review
 *     Upsert a verdict (`misfire` / `correct` / `unsure`) on the
 *     classify row for `messageId`. Emits a `proactive.review`
 *     `admin_action_log` row so the labelling stream is itself
 *     forensically auditable — without it, a workspace admin could
 *     quietly relabel ambiguous classifies and shift the team's
 *     misfire metric.
 *
 * Lives next to `admin-proactive-analytics.ts` rather than absorbed
 * into it because the events surface is paginated + write-capable;
 * keeping the analytics summary handler small + cacheable matters
 * for the existing per-render usage indicator on the workspace form.
 */

import { Effect } from "effect";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  AuthContext,
  ProactiveGate,
  RequestContext,
} from "@atlas/api/lib/effect/services";
import {
  AnswerMeter,
  AnswerMeterLive,
  MAX_EVENT_PAGE_LIMIT,
} from "@atlas/api/lib/proactive/answer-meter";
import type {
  EventCursor,
  ProactiveEventType,
  ProactiveReviewVerdict,
} from "@atlas/api/lib/proactive/answer-meter";
import {
  PROACTIVE_REVIEW_VERDICTS,
  lookupClassifyChannel,
  upsertClassificationReview,
} from "@atlas/api/lib/proactive/classification-review";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  createAdminRouter,
  requireOrgContext,
  requirePermission,
} from "./admin-router";
import { parseSinceMs } from "./admin-proactive-analytics";

const log = createLogger("admin-proactive-events");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Cursor is encoded as `<isoCreatedAt>|<uuid>` — opaque to the client.
 * Keeping it human-readable means a 500 carrying the cursor in pino is
 * inspectable without base64-decoding. Cleanly malformed cursors
 * (missing separator, empty halves, unparseable timestamp, non-UUID
 * id) fall back to "first page" rather than 400 — but every rejection
 * emits a `warn` with the rejection reason so a real pagination bug
 * (off-by-one in the client, stale cursor format after a migration)
 * doesn't silently loop back to page 1 without trace.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(
  raw: string | undefined,
  requestId: string,
): EventCursor | null {
  if (!raw) return null;
  const idx = raw.indexOf("|");
  if (idx <= 0 || idx === raw.length - 1) {
    log.warn(
      { requestId, cursor: raw, reason: "missing-separator" },
      "proactive events cursor rejected — falling back to first page",
    );
    return null;
  }
  const createdAt = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!createdAt || !id) {
    log.warn(
      { requestId, cursor: raw, reason: "empty-half" },
      "proactive events cursor rejected — falling back to first page",
    );
    return null;
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    log.warn(
      { requestId, cursor: raw, reason: "unparseable-timestamp" },
      "proactive events cursor rejected — falling back to first page",
    );
    return null;
  }
  // UUID shape check ahead of the SQL `::uuid` cast so a corrupted
  // cursor degrades to "first page" with a warn instead of bubbling
  // up as a `pg` 22P02 invalid_text_representation error.
  if (!UUID_REGEX.test(id)) {
    log.warn(
      { requestId, cursor: raw, reason: "non-uuid-id" },
      "proactive events cursor rejected — falling back to first page",
    );
    return null;
  }
  return { createdAt, id };
}

function encodeCursor(cursor: EventCursor | null): string | null {
  return cursor ? `${cursor.createdAt}|${cursor.id}` : null;
}

const ReviewBodySchema = z.object({
  verdict: z.enum(
    PROACTIVE_REVIEW_VERDICTS as readonly [
      ProactiveReviewVerdict,
      ...ProactiveReviewVerdict[],
    ],
  ),
  /**
   * Optional reviewer note — 1024 chars is plenty for "looks like a
   * data question but classifier confidence too low" without becoming
   * a freeform message-text dump.
   */
  note: z.string().max(1024).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminProactiveEvents = createAdminRouter();

adminProactiveEvents.use(requireOrgContext());
// `admin:audit` matches the analytics route — the drill-down is an
// observability surface for forensic / quality work. Reviewing a
// verdict is the same posture as flipping `helpful`/`not-helpful`
// (also covered by `admin:audit` in the existing analytics route).
adminProactiveEvents.use(requirePermission("admin:audit"));

// ---------------------------------------------------------------------------
// GET / — paginated drill-down
// ---------------------------------------------------------------------------

adminProactiveEvents.get("/", async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();

      const { orgId } = yield* AuthContext;
      const { requestId } = yield* RequestContext;

      if (!orgId) {
        return c.json(
          {
            error: "bad_request",
            message: "No active organization.",
            requestId,
          },
          400,
        );
      }

      const sinceMs = parseSinceMs(c.req.query("since"));
      const eventTypeRaw = c.req.query("eventType")?.trim() || undefined;
      const limitRaw = c.req.query("limit");
      const cursor = decodeCursor(c.req.query("cursor"), requestId);

      // Validate eventType against the canonical union — accept only the
      // six values the meter ever inserts (the six in `chk_proactive_meter_event_type`).
      // An unknown value is treated as "no filter" rather than 400 so a
      // stale bookmark with a dropped filter degrades gracefully — but
      // we log at `warn` so a client-side regression (typo, dropped
      // event type after rename) doesn't silently widen the result set.
      const VALID_EVENT_TYPES = new Set([
        "classify",
        "react",
        "offer",
        "accept",
        "feedback",
        "public_refused",
      ]);
      let eventType: ProactiveEventType | undefined;
      if (eventTypeRaw === undefined) {
        eventType = undefined;
      } else if (VALID_EVENT_TYPES.has(eventTypeRaw)) {
        eventType = eventTypeRaw as ProactiveEventType;
      } else {
        log.warn(
          { requestId, orgId, eventTypeRaw },
          "proactive events eventType filter rejected — falling back to no filter",
        );
        eventType = undefined;
      }

      let limit: number | undefined;
      if (limitRaw !== undefined) {
        const parsed = Number(limitRaw);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(Math.floor(parsed), MAX_EVENT_PAGE_LIMIT);
        }
      }

      const meter = yield* AnswerMeter;
      const result = yield* Effect.tryPromise({
        try: () => meter.listEvents(orgId, { sinceMs, eventType, limit, cursor }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      const reviewSummary = yield* Effect.tryPromise({
        try: () => meter.reviewSummary(orgId, sinceMs),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      log.info(
        {
          requestId,
          orgId,
          sinceMs,
          eventType: eventType ?? null,
          returned: result.events.length,
          hasMore: result.nextCursor !== null,
        },
        "proactive events drill-down served",
      );

      return c.json(
        {
          workspaceId: orgId,
          sinceMs,
          eventType: eventType ?? null,
          events: result.events,
          nextCursor: encodeCursor(result.nextCursor),
          reviewSummary,
        },
        200,
      );
    }).pipe(Effect.provide(AnswerMeterLive)),
    { label: "proactive events drill-down" },
  ),
);

// ---------------------------------------------------------------------------
// POST /:messageId/review — upsert verdict
// ---------------------------------------------------------------------------

adminProactiveEvents.post("/:messageId/review", async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();

      const { orgId, user } = yield* AuthContext;
      const { requestId } = yield* RequestContext;

      if (!orgId) {
        return c.json(
          {
            error: "bad_request",
            message: "No active organization.",
            requestId,
          },
          400,
        );
      }
      // hasInternalDB() check lives in `requireOrgContext()` middleware;
      // we don't repeat it here.

      const messageId = c.req.param("messageId");
      if (!messageId) {
        return c.json(
          { error: "bad_request", message: "messageId is required.", requestId },
          400,
        );
      }

      const rawBody = yield* Effect.tryPromise({
        try: () => c.req.json(),
        catch: () => new Error("Invalid JSON body."),
      });
      const parsed = ReviewBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            error: "bad_request",
            message: parsed.error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join("; "),
            requestId,
          },
          400,
        );
      }

      // Guard against orphan verdicts — the classify row must exist on
      // this workspace before we let the admin label it. The lookup
      // also returns the channelId so we can stamp it onto the audit
      // row without a second read.
      const channelId = yield* Effect.tryPromise({
        try: () => lookupClassifyChannel(orgId, messageId),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      if (channelId === null) {
        return c.json(
          {
            error: "not_found",
            message: "No classify event found for this message in this workspace.",
            requestId,
          },
          404,
        );
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          upsertClassificationReview({
            workspaceId: orgId,
            messageId,
            verdict: parsed.data.verdict,
            reviewerUserId: user?.id ?? null,
            note: parsed.data.note ?? null,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.review,
        targetType: "proactive",
        // Target id is the messageId so forensic filters can pivot
        // straight onto the chat-platform reference (e.g. Slack ts).
        targetId: messageId,
        scope: "workspace",
        ipAddress:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          null,
        metadata: {
          workspaceId: orgId,
          channelId,
          messageId,
          verdict: result.verdict,
          previousVerdict: result.previousVerdict,
          ...(result.note ? { note: result.note } : {}),
        },
      });

      log.info(
        {
          requestId,
          orgId,
          messageId,
          verdict: result.verdict,
          previousVerdict: result.previousVerdict,
          reviewerUserId: result.reviewerUserId,
        },
        "proactive classification verdict upserted",
      );

      return c.json(result, 200);
    }),
    { label: "upsert proactive classification verdict" },
  ),
);

export { adminProactiveEvents };
