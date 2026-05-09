/**
 * Per-user MCP rate-limit usage peek (#2216 — Settings → AI Agents).
 *
 * Mounted at `GET /api/v1/me/mcp-usage`. Surfaces the live in-memory
 * bucket state for every OAuth client the calling user owns so the
 * Settings → AI Agents page can render a usage chip ("this agent has
 * used 35/60 weighted requests this minute") and warn the user before
 * the next dispatch trips a 429. Informational only — the chip does
 * not enforce; the limiter middleware does.
 *
 * Why not piggyback on `/api/v1/me/oauth-clients`:
 *   - The clients list is cached by TanStack Query (`staleTime` lives
 *     in `packages/web/src/ui/hooks/use-admin-fetch.ts`'s shared
 *     QueryProvider). Live usage wants tighter freshness while
 *     foregrounded — different cadence.
 *   - The chip's poll cycle should not refetch the relatively heavy
 *     clients query (workspace grants, token aggregates).
 *   - Adding `usage` to the clients response would couple the page's
 *     visibility-gated polling to the clients refetch which already
 *     has its own SWR semantics.
 *
 * Cross-region note: the limiter is per-replica, in-memory, and
 * Atlas's hosted deployment runs `numReplicas: 1` per regional API
 * service. The peek covers the region the request lands in. The
 * issue body explicitly defers cross-region aggregation; the docs
 * "What's not covered yet" section in `apps/docs/.../mcp.mdx` keeps
 * the limitation visible to operators.
 *
 * Audit: emits `mcp_session.usage_read` once per call (skipped when
 * the user has zero clients, to keep noise low for users who haven't
 * connected an agent). Volume is bounded by the page's 10s cadence
 * and visibility-gated polling.
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { listOAuthClients } from "@atlas/api/lib/auth/oauth-clients";
import { getClientUsage } from "@atlas/api/lib/rate-limit/oauth-client";
import { asPercentage, type Percentage } from "@useatlas/types";
import { MeMcpUsageResponseSchema } from "@useatlas/schemas/mcp-usage";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("me-mcp-usage");

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const listMyMcpUsageRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Me — MCP Usage"],
  summary: "Live MCP rate-limit usage for your connected AI agents",
  description:
    "Returns per-OAuth-client usage against the hosted MCP per-minute " +
    "weighted-request budget. Powers the Settings → AI Agents usage " +
    "chip — informational, not enforcement (the actual 429 still comes " +
    "from the limiter middleware on tool dispatch). Clients with zero " +
    "in-window traffic still appear so the chip is visible on every row.",
  responses: {
    200: {
      description: "Per-client usage view",
      content: { "application/json": { schema: MeMcpUsageResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const meMcpUsage = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

meMcpUsage.use(standardAuth);
meMcpUsage.use(requestContext);

meMcpUsage.openapi(listMyMcpUsageRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user } = yield* AuthContext;
      const orgId = user?.activeOrganizationId;

      if (!hasInternalDB()) {
        // Mirrors the empty-DB branch of /api/v1/me/oauth-clients —
        // without an internal DB there are no DCR-issued clients to
        // peek at, so a 404 is honest.
        return c.json(
          {
            error: "not_available",
            message:
              "OAuth client management requires an internal database.",
            requestId,
          },
          404,
        );
      }

      if (!user || !orgId) {
        // Stable empty payload — same belt-and-braces shape the clients
        // list uses for users without an active org. Logged at debug so
        // a triage query can distinguish "no active org" from "user has
        // zero connected clients" (both render an empty list, but the
        // root causes diverge).
        log.debug(
          { requestId, userId: user?.id, orgId, reason: "no_active_org" },
          "served empty MCP usage view",
        );
        return c.json({ clients: [] }, 200);
      }

      const clients = yield* Effect.tryPromise({
        try: () =>
          listOAuthClients({ kind: "user", userId: user.id, orgId }),
        // The defect path in `runEffect` would still surface a 500 with
        // requestId for an `Effect.promise` rejection, but typing the
        // failure channel correctly lets a future `Effect.catchTag`
        // see what can fail here without spelunking the limiter or DB.
        catch: (err) =>
          err instanceof Error ? err : new Error(String(err)),
      });

      const usage = clients.map((client) => {
        const view = getClientUsage(orgId, client.clientId);
        // Saturate to [0, 100] before branding so a hypothetical
        // bucket-overshoot regression renders as a saturated chip
        // rather than a 500 from asPercentage's range guard. Integer
        // rounded so the chip's whole-percent label and aria-label
        // agree on one number.
        const rawPct =
          view.ceiling > 0
            ? Math.round((view.currentMinuteWeightedRequests / view.ceiling) * 100)
            : 0;
        const saturatedPct = Math.min(100, Math.max(0, rawPct));
        const percentUsed: Percentage = asPercentage(saturatedPct);
        return {
          clientId: client.clientId,
          currentMinuteWeightedRequests: view.currentMinuteWeightedRequests,
          ceiling: view.ceiling,
          percentUsed,
          resetAt: new Date(view.resetAt).toISOString(),
        };
      });

      // Audit only when there's something to peek — a brand-new user
      // with no clients hits this endpoint on every page load while
      // the empty-state CTA is up; an audit row per refresh would
      // bury real signal under no-op rows. The bound stays low even
      // for power users (10s polling × number of connected clients).
      if (usage.length > 0) {
        logAdminAction({
          actionType: ADMIN_ACTIONS.mcp_session.usageRead,
          targetType: "mcp_session",
          // Use the user id as the target — the row is "user X peeked
          // their own bucket state". Per-client granularity lives in
          // metadata.clientIds for forensic pivots.
          targetId: user.id,
          metadata: {
            clientIds: usage.map((u) => u.clientId),
            count: usage.length,
          },
        });
      }

      log.debug(
        { requestId, userId: user.id, orgId, clientCount: usage.length },
        "served live MCP usage view",
      );

      return c.json({ clients: usage }, 200);
    }),
    { label: "list my mcp usage" },
  );
});

export { meMcpUsage };
