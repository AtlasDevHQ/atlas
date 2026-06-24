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
 * Demo turns are identified by `conversations.surface = 'demo'`; token_usage
 * rows join through `conversation_id`. A lead email maps to its synthetic
 * conversation `user_id` via {@link demoUserId} (sha256 — the email is never
 * stored on conversations), so the JS-side join keys hashed id → email.
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
import { estimateCostUsd } from "@atlas/api/lib/token-pricing";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-demo");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEADS_LIMIT = 500;
const TRANSCRIPT_CONVERSATION_LIMIT = 100;
const DEMO_MAX_STEPS_MIN = 1;
const DEMO_MAX_STEPS_MAX = 100;

// ---------------------------------------------------------------------------
// Schemas (inline — kept out of @useatlas/schemas so the scaffold template's
// pinned-version build never blocks on a not-yet-published symbol. The web
// page mirrors these shapes in `ui/lib/admin-schemas.ts`; keep field names in
// lockstep.)
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
// SQL — hoisted so each statement is greppable
// ---------------------------------------------------------------------------

const LEADS_SQL = `
  SELECT email, session_count, created_at, last_active_at
  FROM demo_leads
  ORDER BY last_active_at DESC
  LIMIT $1
`;

/** Per-(user, model) token rollup over demo turns. Keyed back to email in JS. */
const LEADS_USAGE_SQL = `
  SELECT c.user_id AS user_id, tu.model AS model, tu.provider AS provider,
         COUNT(*)::int AS turns,
         COALESCE(SUM(tu.prompt_tokens), 0)::bigint AS prompt_tokens,
         COALESCE(SUM(tu.completion_tokens), 0)::bigint AS completion_tokens,
         COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS cache_read_tokens,
         COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS cache_write_tokens,
         AVG(tu.latency_ms)::float8 AS avg_latency_ms,
         COUNT(tu.latency_ms)::int AS latency_count
  FROM conversations c
  JOIN token_usage tu ON tu.conversation_id = c.id::text
  WHERE c.surface = 'demo' AND c.user_id IS NOT NULL
  GROUP BY c.user_id, tu.model, tu.provider
`;

const LEADS_CONV_COUNT_SQL = `
  SELECT user_id, COUNT(*)::int AS conversation_count
  FROM conversations
  WHERE surface = 'demo' AND user_id IS NOT NULL
  GROUP BY user_id
`;

/** Global per-model rollup over all demo turns (independent of leads). */
const METRICS_PER_MODEL_SQL = `
  SELECT tu.model AS model, tu.provider AS provider,
         COUNT(*)::int AS turns,
         COALESCE(SUM(tu.prompt_tokens), 0)::bigint AS prompt_tokens,
         COALESCE(SUM(tu.completion_tokens), 0)::bigint AS completion_tokens,
         COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS cache_read_tokens,
         COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS cache_write_tokens,
         AVG(tu.latency_ms)::float8 AS avg_latency_ms,
         COUNT(tu.latency_ms)::int AS latency_count
  FROM token_usage tu
  JOIN conversations c ON c.id::text = tu.conversation_id
  WHERE c.surface = 'demo'
  GROUP BY tu.model, tu.provider
  ORDER BY turns DESC
`;

const METRICS_LEAD_COUNTS_SQL = `
  SELECT COUNT(*)::int AS lead_count,
         COALESCE(SUM(session_count), 0)::int AS session_count
  FROM demo_leads
`;

const TRANSCRIPT_CONV_SQL = `
  SELECT id, title, created_at
  FROM conversations
  WHERE user_id = $1 AND surface = 'demo'
  ORDER BY created_at DESC
  LIMIT $2
`;

const TRANSCRIPT_MSG_SQL = `
  SELECT conversation_id, role, content, created_at
  FROM messages
  WHERE conversation_id = ANY($1::uuid[])
  ORDER BY created_at ASC
`;

// ---------------------------------------------------------------------------
// Row types + helpers
// ---------------------------------------------------------------------------

type LeadRow = {
  email: string;
  session_count: number;
  created_at: string | Date;
  last_active_at: string | Date;
} & Record<string, unknown>;

type UsageRow = {
  user_id: string;
  model: string | null;
  provider: string | null;
  turns: number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  avg_latency_ms: number | null;
  latency_count: number;
} & Record<string, unknown>;

type ConvCountRow = {
  user_id: string;
  conversation_count: number;
} & Record<string, unknown>;

type LeadCountsRow = {
  lead_count: number;
  session_count: number;
} & Record<string, unknown>;

type TranscriptConvRow = {
  id: string;
  title: string | null;
  created_at: string | Date;
} & Record<string, unknown>;

type TranscriptMsgRow = {
  conversation_id: string;
  role: string;
  content: unknown;
  created_at: string | Date;
} & Record<string, unknown>;

function isoOf(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/** Latency-count-weighted average across rows, or null when no row had latency. */
function weightedAvgLatency(
  parts: ReadonlyArray<{ avg: number | null; count: number }>,
): number | null {
  let weightedSum = 0;
  let totalCount = 0;
  for (const p of parts) {
    if (p.avg != null && p.count > 0) {
      weightedSum += p.avg * p.count;
      totalCount += p.count;
    }
  }
  return totalCount > 0 ? weightedSum / totalCount : null;
}

/**
 * Fold per-(user|null, model) usage rows into one token rollup, summing the
 * per-model estimated cost. `estimatedCostUsd` is null only when EVERY model in
 * the group is unpriced (so the UI shows "—" rather than a misleading $0);
 * `costComplete` flags a partial estimate (some priced, some not).
 */
function foldUsage(rows: ReadonlyArray<UsageRow>): {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgLatencyMs: number | null;
  estimatedCostUsd: number | null;
  costComplete: boolean;
} {
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costSum = 0;
  let anyPriced = false;
  let anyUnpriced = false;
  const latencyParts: Array<{ avg: number | null; count: number }> = [];

  for (const r of rows) {
    const prompt = Number(r.prompt_tokens);
    const completion = Number(r.completion_tokens);
    const cacheRead = Number(r.cache_read_tokens);
    const cacheWrite = Number(r.cache_write_tokens);
    turns += r.turns;
    promptTokens += prompt;
    completionTokens += completion;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    latencyParts.push({ avg: r.avg_latency_ms, count: r.latency_count });

    const cost = estimateCostUsd(r.model, {
      promptTokens: prompt,
      completionTokens: completion,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });
    if (cost == null) {
      anyUnpriced = true;
    } else {
      anyPriced = true;
      costSum += cost;
    }
  }

  return {
    turns,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    avgLatencyMs: weightedAvgLatency(latencyParts),
    estimatedCostUsd: anyPriced ? costSum : null,
    costComplete: !anyUnpriced,
  };
}

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

      yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            setSetting("ATLAS_DEMO_MODEL", model, c.get("authResult")?.user?.id),
            setSetting("ATLAS_DEMO_MAX_STEPS", String(body.maxSteps), c.get("authResult")?.user?.id),
            setSetting("ATLAS_DEMO_RATE_LIMIT_RPM", String(body.rpm), c.get("authResult")?.user?.id),
          ]),
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

      // Map synthetic demo user_id → email. The email is never stored on
      // conversations/token_usage, so the hash is the only join key.
      const emailByUid = new Map<string, string>();
      for (const lead of leadRows) emailByUid.set(demoUserId(lead.email), lead.email);

      const usageByEmail = new Map<string, UsageRow[]>();
      for (const row of usageRows) {
        const email = emailByUid.get(row.user_id);
        if (!email) continue; // demo conversation with no surviving lead row
        const list = usageByEmail.get(email);
        if (list) list.push(row);
        else usageByEmail.set(email, [row]);
      }

      const convCountByUid = new Map<string, number>();
      for (const row of convCountRows) convCountByUid.set(row.user_id, row.conversation_count);

      const leads = leadRows.map((lead) => {
        const uid = demoUserId(lead.email);
        const folded = foldUsage(usageByEmail.get(lead.email) ?? []);
        return {
          email: lead.email,
          sessionCount: lead.session_count,
          firstSeen: isoOf(lead.created_at),
          lastActive: isoOf(lead.last_active_at),
          conversationCount: convCountByUid.get(uid) ?? 0,
          usage: {
            turns: folded.turns,
            promptTokens: folded.promptTokens,
            completionTokens: folded.completionTokens,
            cacheReadTokens: folded.cacheReadTokens,
            cacheWriteTokens: folded.cacheWriteTokens,
            avgLatencyMs: folded.avgLatencyMs,
            estimatedCostUsd: folded.estimatedCostUsd,
          },
        };
      });

      return c.json({ leads }, 200);
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

      const msgsByConv = new Map<string, TranscriptMsgRow[]>();
      for (const m of msgRows) {
        const list = msgsByConv.get(m.conversation_id);
        if (list) list.push(m);
        else msgsByConv.set(m.conversation_id, [m]);
      }

      const conversations = convRows.map((conv) => ({
        id: conv.id,
        title: conv.title,
        createdAt: isoOf(conv.created_at),
        messages: (msgsByConv.get(conv.id) ?? []).map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: isoOf(m.created_at),
        })),
      }));

      return c.json({ email, conversations }, 200);
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

      const perModel = perModelRows.map((r) => {
        const folded = foldUsage([r]);
        return {
          model: r.model,
          provider: r.provider,
          turns: folded.turns,
          promptTokens: folded.promptTokens,
          completionTokens: folded.completionTokens,
          cacheReadTokens: folded.cacheReadTokens,
          cacheWriteTokens: folded.cacheWriteTokens,
          avgLatencyMs: folded.avgLatencyMs,
          estimatedCostUsd: folded.estimatedCostUsd,
        };
      });

      const totals = foldUsage(perModelRows);
      const counts = leadCountRows[0] ?? { lead_count: 0, session_count: 0 };

      return c.json(
        {
          leadCount: counts.lead_count,
          sessionCount: counts.session_count,
          totals: {
            turns: totals.turns,
            promptTokens: totals.promptTokens,
            completionTokens: totals.completionTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            avgLatencyMs: totals.avgLatencyMs,
            estimatedCostUsd: totals.estimatedCostUsd,
            costComplete: totals.costComplete,
          },
          perModel,
        },
        200,
      );
    }),
    { label: "get demo metrics" },
  );
});

export { platformDemo };
