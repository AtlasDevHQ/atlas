/**
 * Admin integrations routes.
 *
 * Mounted under /api/v1/admin/integrations. All routes require admin role
 * and org context. Provides integration status and Slack disconnect.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import { getInstallationByOrg, deleteInstallationByOrg } from "@atlas/api/lib/slack/store";
import {
  getTeamsInstallationByOrg,
  deleteTeamsInstallationByOrg,
} from "@atlas/api/lib/teams/store";
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-integrations");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DeliveryChannelEnum = z.enum(["email", "slack", "webhook"]);

const SlackStatusSchema = z.object({
  connected: z.boolean(),
  teamId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Whether Slack OAuth env vars are configured (SLACK_CLIENT_ID etc.) */
  oauthConfigured: z.boolean(),
  /** Whether env-based token is set (single-workspace mode) */
  envConfigured: z.boolean(),
  /** Whether the workspace admin can connect/disconnect (true) or it's platform-level only (false) */
  configurable: z.boolean(),
});

const TeamsStatusSchema = z.object({
  connected: z.boolean(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Whether the workspace admin can connect/disconnect (true when TEAMS_APP_ID is set) */
  configurable: z.boolean(),
});

const WebhookStatusSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  /** Whether the workspace admin can create/manage webhooks */
  configurable: z.boolean(),
});

const IntegrationStatusSchema = z.object({
  slack: SlackStatusSchema,
  teams: TeamsStatusSchema,
  webhooks: WebhookStatusSchema,
  /** Delivery channels available for scheduled tasks */
  deliveryChannels: z.array(DeliveryChannelEnum),
  /** Resolved deploy mode — lets the frontend branch UI for SaaS vs self-hosted */
  deployMode: z.enum(["saas", "self-hosted"]),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getStatusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Admin — Integrations"],
  summary: "Get integration status",
  description:
    "Returns the status of all configured integrations for the current workspace: " +
    "Slack connection, webhook count, and available delivery channels.",
  responses: {
    200: {
      description: "Integration status",
      content: {
        "application/json": { schema: IntegrationStatusSchema },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
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
  },
});

const disconnectSlackRoute = createRoute({
  method: "delete",
  path: "/slack",
  tags: ["Admin — Integrations"],
  summary: "Disconnect Slack",
  description:
    "Removes the Slack installation for the current workspace. " +
    "Any Slack bot functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "Slack disconnected",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "No Slack installation found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const disconnectTeamsRoute = createRoute({
  method: "delete",
  path: "/teams",
  tags: ["Admin — Integrations"],
  summary: "Disconnect Teams",
  description:
    "Removes the Teams installation for the current workspace. " +
    "Any Teams bot functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "Teams disconnected",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "No Teams installation found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
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

const adminIntegrations = createAdminRouter();

adminIntegrations.use(requireOrgContext());

// GET /status — aggregated integration status
adminIntegrations.openapi(getStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

      // requireOrgContext() middleware guarantees orgId is set, but verify
      // at the Effect boundary to avoid non-null assertions
      if (!orgId) {
        return c.json(
          { error: "bad_request", message: "No active organization." },
          400,
        );
      }

      // Slack status
      const slackInstall = yield* Effect.tryPromise({
        try: () => getInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      const oauthConfigured = !!(
        process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
      );
      const envConfigured = !!process.env.SLACK_BOT_TOKEN;

      const deployMode = getConfig()?.deployMode ?? "self-hosted";

      // Slack is configurable (connect/disconnect) when OAuth credentials
      // are set. Env-only token setups are operator_managed.
      const slackConfigurable = oauthConfigured;

      const slack = {
        connected: slackInstall !== null,
        teamId: slackInstall?.team_id ?? null,
        workspaceName: slackInstall?.workspace_name ?? null,
        installedAt: slackInstall?.installed_at ?? null,
        oauthConfigured,
        envConfigured,
        configurable: slackConfigurable,
      };

      // Teams status
      const teamsInstall = yield* Effect.tryPromise({
        try: () => getTeamsInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      const teamsConfigurable = !!process.env.TEAMS_APP_ID;

      const teams = {
        connected: teamsInstall !== null,
        tenantId: teamsInstall?.tenant_id ?? null,
        tenantName: teamsInstall?.tenant_name ?? null,
        installedAt: teamsInstall?.installed_at ?? null,
        configurable: teamsConfigurable,
      };

      // Webhook count (scheduled tasks with webhook recipients)
      const webhookActiveCount = yield* Effect.tryPromise({
        try: async () => {
          if (!hasInternalDB()) return 0;
          const rows = await internalQuery<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM scheduled_tasks
             WHERE org_id = $1 AND enabled = true
             AND recipients @> $2::jsonb`,
            [orgId, JSON.stringify([{ type: "webhook" }])],
          );
          return rows[0]?.count ?? 0;
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      // Available delivery channels
      const deliveryChannels: Array<"email" | "slack" | "webhook"> = ["email"];
      if (slack.connected || slack.envConfigured) {
        deliveryChannels.push("slack");
      }
      deliveryChannels.push("webhook");

      // Webhooks are always configurable by workspace admins (they create scheduled tasks)
      const webhooksConfigurable = hasInternalDB();

      return c.json(
        {
          slack,
          teams,
          webhooks: { activeCount: webhookActiveCount, configurable: webhooksConfigurable },
          deliveryChannels,
          deployMode,
        },
        200,
      );
    }),
    { label: "get integration status" },
  );
});

// DELETE /slack — disconnect Slack for current org
adminIntegrations.openapi(disconnectSlackRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

      if (!orgId) {
        return c.json(
          { error: "bad_request", message: "No active organization." },
          400,
        );
      }

      const deleted = yield* Effect.tryPromise({
        try: () => deleteInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No Slack installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Slack installation disconnected by admin");
      return c.json({ message: "Slack disconnected successfully." }, 200);
    }),
    { label: "disconnect slack" },
  );
});

// DELETE /teams — disconnect Teams for current org
adminIntegrations.openapi(disconnectTeamsRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

      if (!orgId) {
        return c.json(
          { error: "bad_request", message: "No active organization." },
          400,
        );
      }

      const deleted = yield* Effect.tryPromise({
        try: () => deleteTeamsInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No Teams installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Teams installation disconnected by admin");
      return c.json({ message: "Teams disconnected successfully." }, 200);
    }),
    { label: "disconnect teams" },
  );
});

export { adminIntegrations };
