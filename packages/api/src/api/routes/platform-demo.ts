/**
 * Platform demo tracking routes — funnel visibility + model config for the
 * anonymous `/demo` path (#3931 scope B).
 *
 * Mounted at /api/v1/platform/demo. All routes require `platform_admin` role
 * + MFA (via `createPlatformRouter`). The demo path is anonymous free-text
 * top-of-funnel: lead emails and the questions they ask are PII-adjacent, so
 * platform-admin gating IS the access control (per #3931).
 *
 * Provides:
 * - GET  /config     — current demo model / max-steps / RPM (registry-backed)
 * - PUT  /config     — update those three platform settings (hot-reloadable)
 * - GET  /leads      — demo leads with per-email session + spend rollup
 * - GET  /transcript — full question/answer transcript for one lead email
 * - GET  /metrics    — token + cache + latency rollup (aggregate + per-model)
 *
 * The SQL + the fold/join logic live in `lib/demo-tracking.ts` so they're
 * unit- and `-pg`-testable without this route's auth graph; this file is the
 * thin Hono/Effect shell (auth, validation, query → assemble → respond).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, queryEffect } from "@atlas/api/lib/db/internal";
import { setSetting } from "@atlas/api/lib/settings";
import { demoUserId, getDemoConfig } from "@atlas/api/lib/demo";
import {
  LEADS_LIMIT,
  TRANSCRIPT_CONVERSATION_LIMIT,
  LEADS_SQL,
  LEADS_USAGE_SQL,
  LEADS_CONV_COUNT_SQL,
  METRICS_PER_MODEL_SQL,
  METRICS_LEAD_COUNTS_SQL,
  TRANSCRIPT_CONV_SQL,
  TRANSCRIPT_MSG_SQL,
  assembleLeads,
  assembleMetrics,
  assembleTranscript,
  type LeadRow,
  type UsageRow,
  type ConvCountRow,
  type LeadCountsRow,
  type TranscriptConvRow,
  type TranscriptMsgRow,
  type DemoTokenRollup,
  type DemoLead,
  type DemoPerModel,
  type DemoMetrics,
} from "@atlas/api/lib/demo-tracking";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-demo");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_MAX_STEPS_MIN = 1;
const DEMO_MAX_STEPS_MAX = 100;

// ---------------------------------------------------------------------------
// Response schemas (inline — kept out of @useatlas/schemas so the scaffold
// template's pinned-version build never blocks on a not-yet-published symbol.
// The web page mirrors these shapes in `ui/lib/admin-schemas.ts`, and the
// internal shapes live in `lib/demo-tracking.ts`; keep field names in lockstep.)
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  model: z.string().openapi({
    description:
      "Configured ATLAS_DEMO_MODEL override (a gateway model id, e.g. anthropic/claude-haiku-4.5). Empty string = use the resolved default.",
    example: "anthropic/claude-haiku-4.5",
  }),
  maxSteps: z.number().int(),
  rpm: z.number().int(),
  effectiveModel: z.string().nullable().openapi({
    description:
      "What the demo model resolves to right now: the override if set, else the gateway Haiku default (SaaS), else null (non-gateway → platform default).",
  }),
});

const UpdateConfigBodySchema = z.object({
  model: z.string().max(200).openapi({
    description: "Gateway model id, or empty string to clear the override.",
    example: "anthropic/claude-haiku-4.5",
  }),
  maxSteps: z.number().int().min(DEMO_MAX_STEPS_MIN).max(DEMO_MAX_STEPS_MAX),
  rpm: z.number().int().min(0),
});

const TokenRollupSchema = z.object({
  turns: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  avgLatencyMs: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
});

const LeadSchema = z.object({
  email: z.string(),
  sessionCount: z.number().int(),
  firstSeen: z.string(),
  lastActive: z.string(),
  conversationCount: z.number().int(),
  usage: TokenRollupSchema,
});

const LeadsResponseSchema = z.object({
  leads: z.array(LeadSchema),
});

const PerModelSchema = TokenRollupSchema.extend({
  model: z.string().nullable(),
  provider: z.string().nullable(),
});

const MetricsResponseSchema = z.object({
  leadCount: z.number().int(),
  sessionCount: z.number().int(),
  totals: TokenRollupSchema.extend({
    /** False when one or more models with turns had no known price. */
    costComplete: z.boolean(),
  }),
  perModel: z.array(PerModelSchema),
});

// Compile-time lock — the inline response schemas above and the
// `lib/demo-tracking.ts` interfaces are two same-package mirrors of one wire
// shape (the web-local zod in `admin-schemas.ts` is the third, cross-package).
// These bindings fail `tsgo` on any field/nullability drift between the zod and
// the lib interface, so the mirrors can't silently diverge (they did once in
// review). `Exact` collapses to `never` on mismatch, and `true` is not
// assignable to `never`.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _rollupLock: Exact<z.infer<typeof TokenRollupSchema>, DemoTokenRollup> = true;
const _leadLock: Exact<z.infer<typeof LeadSchema>, DemoLead> = true;
const _perModelLock: Exact<z.infer<typeof PerModelSchema>, DemoPerModel> = true;
const _metricsLock: Exact<z.infer<typeof MetricsResponseSchema>, DemoMetrics> = true;

const TranscriptQuerySchema = z.object({
  email: z.string().email().openapi({
    description: "Demo lead email whose transcript to load.",
    example: "lead@example.com",
  }),
});

const TranscriptMessageSchema = z.object({
  role: z.string(),
  content: z.unknown(),
  createdAt: z.string(),
});

const TranscriptConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  messages: z.array(TranscriptMessageSchema),
});

const TranscriptResponseSchema = z.object({
  email: z.string(),
  conversations: z.array(TranscriptConversationSchema),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const TAG = "Platform Admin — Demo";

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: [TAG],
  summary: "Get demo model + limits config",
  responses: {
    200: { description: "Demo config", content: { "application/json": { schema: ConfigSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateConfigRoute = createRoute({
  method: "put",
  path: "/config",
  tags: [TAG],
  summary: "Update demo model + limits config",
  description:
    "Writes ATLAS_DEMO_MODEL / ATLAS_DEMO_MAX_STEPS / ATLAS_DEMO_RATE_LIMIT_RPM to the settings registry (platform scope). Hot-reloadable — takes effect within the ~30s settings refresh window, no redeploy.",
  request: { body: { required: true, content: { "application/json": { schema: UpdateConfigBodySchema } } } },
  responses: {
    200: { description: "Config saved", content: { "application/json": { schema: ConfigSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const leadsRoute = createRoute({
  method: "get",
  path: "/leads",
  tags: [TAG],
  summary: "List demo leads with per-email spend rollup",
  responses: {
    200: { description: "Demo leads", content: { "application/json": { schema: LeadsResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const transcriptRoute = createRoute({
  method: "get",
  path: "/transcript",
  tags: [TAG],
  summary: "Get the demo question/answer transcript for one lead",
  request: { query: TranscriptQuerySchema },
  responses: {
    200: { description: "Demo transcript", content: { "application/json": { schema: TranscriptResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const metricsRoute = createRoute({
  method: "get",
  path: "/metrics",
  tags: [TAG],
  summary: "Demo token + cache + latency rollup",
  responses: {
    200: { description: "Demo metrics", content: { "application/json": { schema: MetricsResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformDemo = createPlatformRouter();

/** Shared 404 body when no internal DB backs the demo data. */
function noDbBody(requestId: string) {
  return {
    error: "not_available",
    message: "Demo tracking requires an internal database (DATABASE_URL).",
    requestId,
  };
}

// ── GET /config ──────────────────────────────────────────────────────

platformDemo.openapi(getConfigRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) return c.json(noDbBody(requestId), 404);
      return c.json(getDemoConfig(), 200);
    }),
    { label: "get demo config" },
  );
});

// ── PUT /config ──────────────────────────────────────────────────────

platformDemo.openapi(updateConfigRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) return c.json(noDbBody(requestId), 404);

      // `validationHook` (mounted by createPlatformRouter) already 422s a
      // malformed body, so by here `maxSteps`/`rpm` are in-range ints and
      // `model` is a ≤200-char string.
      const body = c.req.valid("json");
      const model = body.model.trim();
      const userId = c.get("authResult")?.user?.id;

      // Written sequentially, not as a concurrent Promise.all. The three are
      // INDEPENDENT, individually-valid platform knobs (no cross-key invariant)
      // persisted as idempotent `INSERT … ON CONFLICT` UPSERTs, so a partial
      // failure is self-healed by the operator's retry (which re-writes all
      // three). True cross-key atomicity would need a DB transaction, but
      // `setSetting` also mutates an in-process settings cache after its own
      // write — a rollback couldn't unwind that cleanly — so a transaction isn't
      // the right seam here. Sequential keeps the partial-failure boundary
      // deterministic: everything before the failing write committed, nothing
      // after.
      yield* Effect.tryPromise({
        try: async () => {
          await setSetting("ATLAS_DEMO_MODEL", model, userId);
          await setSetting("ATLAS_DEMO_MAX_STEPS", String(body.maxSteps), userId);
          await setSetting("ATLAS_DEMO_RATE_LIMIT_RPM", String(body.rpm), userId);
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      logAdminAction({
        actionType: ADMIN_ACTIONS.settings.update,
        targetType: "settings",
        targetId: "demo",
        scope: "platform",
        metadata: { model, maxSteps: body.maxSteps, rpm: body.rpm },
        ipAddress:
          c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      });

      log.info({ requestId, model, maxSteps: body.maxSteps, rpm: body.rpm }, "Demo config updated by platform admin");

      // Re-read so the response reflects the resolved effectiveModel, not the
      // raw write (e.g. blank model → gateway Haiku default on SaaS).
      return c.json(getDemoConfig(), 200);
    }),
    { label: "update demo config" },
  );
});

// ── GET /leads ───────────────────────────────────────────────────────

platformDemo.openapi(leadsRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) return c.json(noDbBody(requestId), 404);

      const [leadRows, usageRows, convCountRows] = yield* Effect.all(
        [
          queryEffect<LeadRow>(LEADS_SQL, [LEADS_LIMIT]),
          queryEffect<UsageRow>(LEADS_USAGE_SQL),
          queryEffect<ConvCountRow>(LEADS_CONV_COUNT_SQL),
        ],
        { concurrency: "unbounded" },
      );

      return c.json({ leads: assembleLeads(leadRows, usageRows, convCountRows) }, 200);
    }),
    { label: "list demo leads" },
  );
});

// ── GET /transcript ──────────────────────────────────────────────────

platformDemo.openapi(transcriptRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) return c.json(noDbBody(requestId), 404);

      const email = c.req.valid("query").email;
      const uid = demoUserId(email);

      const convRows = yield* queryEffect<TranscriptConvRow>(TRANSCRIPT_CONV_SQL, [
        uid,
        TRANSCRIPT_CONVERSATION_LIMIT,
      ]);

      const convIds = convRows.map((r) => r.id);
      const msgRows =
        convIds.length === 0
          ? []
          : yield* queryEffect<TranscriptMsgRow>(TRANSCRIPT_MSG_SQL, [convIds]);

      return c.json(assembleTranscript(email, convRows, msgRows), 200);
    }),
    { label: "get demo transcript" },
  );
});

// ── GET /metrics ─────────────────────────────────────────────────────

platformDemo.openapi(metricsRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      if (!hasInternalDB()) return c.json(noDbBody(requestId), 404);

      const [perModelRows, leadCountRows] = yield* Effect.all(
        [
          queryEffect<UsageRow>(METRICS_PER_MODEL_SQL),
          queryEffect<LeadCountsRow>(METRICS_LEAD_COUNTS_SQL),
        ],
        { concurrency: "unbounded" },
      );

      return c.json(assembleMetrics(perModelRows, leadCountRows), 200);
    }),
    { label: "get demo metrics" },
  );
});

export { platformDemo };
