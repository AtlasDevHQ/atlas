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
});

const WebhookStatusSchema = z.object({
  activeCount: z.number().int().nonnegative(),
});

const IntegrationStatusSchema = z.object({
  slack: SlackStatusSchema,
  webhooks: WebhookStatusSchema,
  /** Delivery channels available for scheduled tasks */
  deliveryChannels: z.array(DeliveryChannelEnum),
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

      // Slack status
      const slackInstall = yield* Effect.promise(() =>
        getInstallationByOrg(orgId!),
      );
      const oauthConfigured = !!(
        process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
      );
      const envConfigured = !!process.env.SLACK_BOT_TOKEN;

      const slack = {
        connected: slackInstall !== null,
        teamId: slackInstall?.team_id ?? null,
        workspaceName: slackInstall?.workspace_name ?? null,
        installedAt: slackInstall?.installed_at ?? null,
        oauthConfigured,
        envConfigured,
      };

      // Webhook count (scheduled tasks with webhook recipients)
      const webhookActiveCount = yield* Effect.promise(async () => {
        if (!hasInternalDB()) return 0;
        const rows = await internalQuery<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM scheduled_tasks
           WHERE org_id = $1 AND enabled = true
           AND recipients::text LIKE '%"type":"webhook"%'`,
          [orgId!],
        );
        return rows[0]?.count ?? 0;
      });

      // Available delivery channels
      const deliveryChannels: Array<"email" | "slack" | "webhook"> = ["email"];
      if (slack.connected || slack.envConfigured) {
        deliveryChannels.push("slack");
      }
      deliveryChannels.push("webhook");

      return c.json(
        {
          slack,
          webhooks: { activeCount: webhookActiveCount },
          deliveryChannels,
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

      const deleted = yield* Effect.promise(() =>
        deleteInstallationByOrg(orgId!),
      );

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

export { adminIntegrations };
