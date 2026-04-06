/**
 * Admin integrations routes.
 *
 * Mounted under /api/v1/admin/integrations. All routes require admin role
 * and org context. Provides aggregated integration status, connect,
 * and disconnect operations for Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp, and Email.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import { getInstallationByOrg, saveInstallation, deleteInstallationByOrg } from "@atlas/api/lib/slack/store";
import {
  getTeamsInstallationByOrg,
  saveTeamsInstallation,
  deleteTeamsInstallationByOrg,
} from "@atlas/api/lib/teams/store";
import {
  getDiscordInstallationByOrg,
  saveDiscordInstallation,
  deleteDiscordInstallationByOrg,
} from "@atlas/api/lib/discord/store";
import {
  getTelegramInstallationByOrg,
  saveTelegramInstallation,
  deleteTelegramInstallationByOrg,
} from "@atlas/api/lib/telegram/store";
import {
  getGChatInstallationByOrg,
  saveGChatInstallation,
  deleteGChatInstallationByOrg,
} from "@atlas/api/lib/gchat/store";
import {
  getGitHubInstallationByOrg,
  saveGitHubInstallation,
  deleteGitHubInstallationByOrg,
} from "@atlas/api/lib/github/store";
import {
  getLinearInstallationByOrg,
  saveLinearInstallation,
  deleteLinearInstallationByOrg,
} from "@atlas/api/lib/linear/store";
import {
  getWhatsAppInstallationByOrg,
  saveWhatsAppInstallation,
  deleteWhatsAppInstallationByOrg,
} from "@atlas/api/lib/whatsapp/store";
import {
  getEmailInstallationByOrg,
  saveEmailInstallation,
  deleteEmailInstallationByOrg,
} from "@atlas/api/lib/email/store";
import { EMAIL_PROVIDERS } from "@atlas/api/lib/email/store";
import type { EmailProvider, ProviderConfig } from "@atlas/api/lib/email/store";
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

const DiscordStatusSchema = z.object({
  connected: z.boolean(),
  guildId: z.string().nullable(),
  guildName: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Whether the workspace admin can connect/disconnect (true when DISCORD_CLIENT_ID is set) */
  configurable: z.boolean(),
});

const TelegramStatusSchema = z.object({
  connected: z.boolean(),
  botId: z.string().nullable(),
  botUsername: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Configurable when internal DB is available (SaaS or self-hosted with DATABASE_URL). BYOT — bring your own token */
  configurable: z.boolean(),
});

const GChatStatusSchema = z.object({
  connected: z.boolean(),
  projectId: z.string().nullable(),
  serviceAccountEmail: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Configurable when internal DB is available. BYOT — bring your own service account */
  configurable: z.boolean(),
});

const GitHubStatusSchema = z.object({
  connected: z.boolean(),
  username: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Configurable when internal DB is available. BYOT — bring your own PAT */
  configurable: z.boolean(),
});

const LinearStatusSchema = z.object({
  connected: z.boolean(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Configurable when internal DB is available. BYOT — bring your own API key */
  configurable: z.boolean(),
});

const WhatsAppStatusSchema = z.object({
  connected: z.boolean(),
  phoneNumberId: z.string().nullable(),
  displayPhone: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Configurable when internal DB is available. BYOT — bring your own Cloud API credentials */
  configurable: z.boolean(),
});

const EmailStatusSchema = z.object({
  connected: z.boolean(),
  provider: z.string().nullable(),
  senderAddress: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  /** Configurable when internal DB is available. BYOT — bring your own email provider credentials */
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
  discord: DiscordStatusSchema,
  telegram: TelegramStatusSchema,
  gchat: GChatStatusSchema,
  github: GitHubStatusSchema,
  linear: LinearStatusSchema,
  whatsapp: WhatsAppStatusSchema,
  email: EmailStatusSchema,
  webhooks: WebhookStatusSchema,
  /** Delivery channels available for scheduled tasks */
  deliveryChannels: z.array(DeliveryChannelEnum),
  /** Resolved deploy mode — lets the frontend branch UI for SaaS vs self-hosted */
  deployMode: z.enum(["saas", "self-hosted"]),
  /** Whether the internal database is available (enables BYOT credential storage) */
  hasInternalDB: z.boolean(),
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
    "Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp, Email, webhooks, available delivery channels, deploy mode, and internal database availability.",
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

      const deployMode = getConfig()?.deployMode ?? "self-hosted";

      // Run all integration lookups in parallel — they are independent
      const [slackInstall, teamsInstall, discordInstall, telegramInstall, gchatInstall, githubInstall, linearInstall, whatsappInstall, emailInstall, webhookActiveCount] =
        yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => getInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getTeamsInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getDiscordInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getTelegramInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getGChatInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getGitHubInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getLinearInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getWhatsAppInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getEmailInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
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
            }),
          ],
          { concurrency: "unbounded" },
        );

      // Slack status
      const oauthConfigured = !!(
        process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
      );
      const envConfigured = !!process.env.SLACK_BOT_TOKEN;
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
      const teamsConfigurable = !!process.env.TEAMS_APP_ID;
      const teams = {
        connected: teamsInstall !== null,
        tenantId: teamsInstall?.tenant_id ?? null,
        tenantName: teamsInstall?.tenant_name ?? null,
        installedAt: teamsInstall?.installed_at ?? null,
        configurable: teamsConfigurable,
      };

      // Discord status
      const discordConfigurable = !!process.env.DISCORD_CLIENT_ID;
      const discord = {
        connected: discordInstall !== null,
        guildId: discordInstall?.guild_id ?? null,
        guildName: discordInstall?.guild_name ?? null,
        installedAt: discordInstall?.installed_at ?? null,
        configurable: discordConfigurable,
      };

      // Telegram status — configurable in SaaS mode or when internal DB is available (BYOT)
      const telegramConfigurable = deployMode === "saas" || hasInternalDB();
      const telegram = {
        connected: telegramInstall !== null,
        botId: telegramInstall?.bot_id ?? null,
        botUsername: telegramInstall?.bot_username ?? null,
        installedAt: telegramInstall?.installed_at ?? null,
        configurable: telegramConfigurable,
      };

      // Google Chat status — BYOT-only, configurable when internal DB is available.
      // SaaS always has internal DB, so hasInternalDB() alone suffices (no deployMode check needed).
      const gchatConfigurable = hasInternalDB();
      const gchat = {
        connected: gchatInstall !== null,
        projectId: gchatInstall?.project_id ?? null,
        serviceAccountEmail: gchatInstall?.service_account_email ?? null,
        installedAt: gchatInstall?.installed_at ?? null,
        configurable: gchatConfigurable,
      };

      // GitHub status — BYOT-only, configurable when internal DB is available.
      const githubConfigurable = hasInternalDB();
      const github = {
        connected: githubInstall !== null,
        username: githubInstall?.username ?? null,
        installedAt: githubInstall?.installed_at ?? null,
        configurable: githubConfigurable,
      };

      // Linear status — BYOT-only, configurable when internal DB is available.
      const linearConfigurable = hasInternalDB();
      const linear = {
        connected: linearInstall !== null,
        userName: linearInstall?.user_name ?? null,
        userEmail: linearInstall?.user_email ?? null,
        installedAt: linearInstall?.installed_at ?? null,
        configurable: linearConfigurable,
      };

      // WhatsApp status — BYOT-only, configurable when internal DB is available.
      const whatsappConfigurable = hasInternalDB();
      const whatsapp = {
        connected: whatsappInstall !== null,
        phoneNumberId: whatsappInstall?.phone_number_id ?? null,
        displayPhone: whatsappInstall?.display_phone ?? null,
        installedAt: whatsappInstall?.installed_at ?? null,
        configurable: whatsappConfigurable,
      };

      // Email status — BYOT-only, configurable when internal DB is available.
      const emailConfigurable = hasInternalDB();
      const email = {
        connected: emailInstall !== null,
        provider: emailInstall?.provider ?? null,
        senderAddress: emailInstall?.sender_address ?? null,
        installedAt: emailInstall?.installed_at ?? null,
        configurable: emailConfigurable,
      };

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
          discord,
          telegram,
          gchat,
          github,
          linear,
          whatsapp,
          email,
          webhooks: { activeCount: webhookActiveCount, configurable: webhooksConfigurable },
          deliveryChannels,
          deployMode,
          hasInternalDB: hasInternalDB(),
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

// DELETE /discord — disconnect Discord for current org
const disconnectDiscordRoute = createRoute({
  method: "delete",
  path: "/discord",
  tags: ["Admin — Integrations"],
  summary: "Disconnect Discord",
  description:
    "Removes the Discord installation for the current workspace. " +
    "Any Discord bot functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "Discord disconnected",
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
      description: "No Discord installation found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectDiscordRoute, async (c) => {
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
        try: () => deleteDiscordInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No Discord installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Discord installation disconnected by admin");
      return c.json({ message: "Discord disconnected successfully." }, 200);
    }),
    { label: "disconnect discord" },
  );
});

// ---------------------------------------------------------------------------
// BYOT (Bring Your Own Token) routes
// ---------------------------------------------------------------------------

// POST /slack/byot — connect Slack via bot token (no platform OAuth needed)
const connectSlackByotRoute = createRoute({
  method: "post",
  path: "/slack/byot",
  tags: ["Admin — Integrations"],
  summary: "Connect Slack via bot token (BYOT)",
  description:
    "Validates a Slack bot token via auth.test and saves the installation " +
    "for the current workspace. Use when platform OAuth is not configured.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            botToken: z
              .string()
              .min(1)
              .refine((t) => t.startsWith("xoxb-"), { message: "Bot token must start with xoxb-" })
              .openapi({ description: "Slack bot token (xoxb-...)" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Slack connected via BYOT",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            workspaceName: z.string().nullable(),
            teamId: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid bot token, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectSlackByotRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Slack BYOT requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { botToken } = c.req.valid("json");

      // Validate token by calling Slack's auth.test API.
      // Inner catches log the original error for debugging but return sanitized user-facing messages.
      const authResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
            });
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slack auth.test fetch failed");
            return { ok: false as const, error: "Could not reach Slack API. Please try again." };
          }
          let data: { ok: boolean; team_id?: string; team?: string; error?: string };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slack auth.test response parse failed");
            return { ok: false as const, error: "Slack API returned an invalid response" };
          }
          if (!data.ok) {
            return { ok: false as const, error: data.error ?? "Invalid bot token" };
          }
          return { ok: true as const, teamId: data.team_id ?? null, workspaceName: data.team ?? null };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!authResult.ok) {
        return c.json(
          { error: "invalid_token", message: `Invalid Slack bot token: ${authResult.error}` },
          400,
        );
      }

      yield* Effect.tryPromise({
        try: () =>
          saveInstallation(authResult.teamId ?? `byot-${orgId}`, botToken, {
            orgId,
            workspaceName: authResult.workspaceName ?? undefined,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      log.info({ orgId, teamId: authResult.teamId, workspaceName: authResult.workspaceName }, "Slack BYOT installation saved by admin");
      return c.json(
        { message: "Slack connected successfully.", workspaceName: authResult.workspaceName, teamId: authResult.teamId },
        200,
      );
    }),
    { label: "connect slack byot" },
  );
});

// POST /teams/byot — connect Teams via app credentials (no platform OAuth needed)
const connectTeamsByotRoute = createRoute({
  method: "post",
  path: "/teams/byot",
  tags: ["Admin — Integrations"],
  summary: "Connect Teams via app credentials (BYOT)",
  description:
    "Validates Azure Bot app credentials via client credentials token acquisition " +
    "and saves the installation for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            appId: z.string().min(1).openapi({ description: "Azure Bot App ID (client_id)" }),
            appPassword: z.string().min(1).openapi({ description: "Azure Bot App Password (client_secret)" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Teams connected via BYOT",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            appId: z.string(),
          }),
        },
      },
    },
    400: {
      description: "Invalid credentials, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectTeamsByotRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Teams BYOT requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { appId, appPassword } = c.req.valid("json");

      // Validate credentials by requesting a client credentials token from Azure AD.
      // Inner catches log the original error for debugging but return sanitized user-facing messages.
      const tokenResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch(
              "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
              {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "client_credentials",
                  client_id: appId,
                  client_secret: appPassword,
                  scope: "https://api.botframework.com/.default",
                }),
              },
            );
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Azure AD token fetch failed");
            return { ok: false as const, error: "Could not reach Azure AD. Please try again." };
          }
          let data: { access_token?: string; error?: string; error_description?: string };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Azure AD token response parse failed");
            return { ok: false as const, error: "Azure AD returned an invalid response" };
          }
          if (!data.access_token) {
            return { ok: false as const, error: data.error_description ?? data.error ?? "Invalid credentials" };
          }
          return { ok: true as const };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!tokenResult.ok) {
        return c.json(
          { error: "invalid_credentials", message: `Invalid Teams credentials: ${tokenResult.error}` },
          400,
        );
      }

      // BYOT has no tenant context — use appId as the primary key (tenant_id column)
      yield* Effect.tryPromise({
        try: () =>
          saveTeamsInstallation(appId, {
            orgId,
            appPassword,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      log.info({ orgId, appId }, "Teams BYOT installation saved by admin");
      return c.json(
        { message: "Teams connected successfully.", appId },
        200,
      );
    }),
    { label: "connect teams byot" },
  );
});

// POST /discord/byot — connect Discord via bot credentials (no platform OAuth needed)
const connectDiscordByotRoute = createRoute({
  method: "post",
  path: "/discord/byot",
  tags: ["Admin — Integrations"],
  summary: "Connect Discord via bot credentials (BYOT)",
  description:
    "Validates a Discord bot token via the Discord API and saves the installation " +
    "for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            botToken: z.string().min(1).openapi({ description: "Discord bot token" }),
            applicationId: z.string().min(1).openapi({ description: "Discord application ID" }),
            publicKey: z.string().min(1).openapi({ description: "Discord application public key (for interaction verification)" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Discord connected via BYOT",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            botUsername: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid bot token, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectDiscordByotRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Discord BYOT requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { botToken, applicationId, publicKey } = c.req.valid("json");

      // Validate token by calling Discord's /users/@me API.
      // Inner catches log the original error for debugging but return sanitized user-facing messages.
      const meResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch("https://discord.com/api/v10/users/@me", {
              headers: { Authorization: `Bot ${botToken}` },
            });
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Discord /users/@me fetch failed");
            return { ok: false as const, error: "Could not reach Discord API. Please try again." };
          }
          if (!res.ok) {
            let detail = `status ${res.status}`;
            try {
              const errBody = (await res.json()) as { message?: string };
              if (errBody.message) detail = errBody.message;
            } catch {
              // intentionally ignored: response body may not be JSON
            }
            return { ok: false as const, error: `Discord API error: ${detail}` };
          }
          let data: { id?: string; username?: string };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Discord /users/@me response parse failed");
            return { ok: false as const, error: "Discord API returned an invalid response" };
          }
          if (!data.id) {
            return { ok: false as const, error: "Invalid bot token" };
          }
          return { ok: true as const, botId: data.id, botUsername: data.username ?? null };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!meResult.ok) {
        return c.json(
          { error: "invalid_token", message: `Discord validation failed: ${meResult.error}` },
          400,
        );
      }

      // Use applicationId as guild_id primary key for BYOT — no real guild context from
      // token validation, so each BYOT installation maps 1:1 to a Discord application
      yield* Effect.tryPromise({
        try: () =>
          saveDiscordInstallation(applicationId, {
            orgId,
            guildName: meResult.botUsername ? `@${meResult.botUsername}` : undefined,
            botToken,
            applicationId,
            publicKey,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      log.info({ orgId, applicationId, botUsername: meResult.botUsername }, "Discord BYOT installation saved by admin");
      return c.json(
        { message: "Discord connected successfully.", botUsername: meResult.botUsername },
        200,
      );
    }),
    { label: "connect discord byot" },
  );
});

// POST /telegram — connect Telegram for current org (bot token submission)
const connectTelegramRoute = createRoute({
  method: "post",
  path: "/telegram",
  tags: ["Admin — Integrations"],
  summary: "Connect Telegram",
  description:
    "Validates a Telegram bot token via the Telegram Bot API and saves the installation " +
    "for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            botToken: z.string().min(1).openapi({ description: "Telegram bot token from @BotFather" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Telegram connected",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            botUsername: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid bot token or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectTelegramRoute, async (c) => {
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

      // Check internal DB availability before making the external API call
      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Telegram integration requires an internal database. Contact your platform administrator." },
          400,
        );
      }

      const { botToken } = c.req.valid("json");

      // Validate token by calling Telegram's getMe API.
      // Wrap in a sanitized try/catch to prevent the bot token from leaking
      // into error messages (the token is embedded in the URL path).
      const getMeResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
          } catch {
            return { ok: false as const, error: "Could not reach Telegram API. Please try again." };
          }
          if (!res.ok) {
            return { ok: false as const, error: `Telegram API returned ${res.status}` };
          }
          let data: { ok: boolean; result?: { id: number; username?: string } };
          try {
            data = (await res.json()) as typeof data;
          } catch {
            return { ok: false as const, error: "Telegram API returned an invalid response" };
          }
          if (!data.ok || !data.result) {
            return { ok: false as const, error: "Invalid bot token" };
          }
          return { ok: true as const, botId: String(data.result.id), botUsername: data.result.username ?? null };
        },
        catch: () => new Error("Telegram token validation failed"),
      });

      if (!getMeResult.ok) {
        return c.json(
          { error: "invalid_token", message: `Invalid Telegram bot token: ${getMeResult.error}` },
          400,
        );
      }

      yield* Effect.tryPromise({
        try: () =>
          saveTelegramInstallation(getMeResult.botId, {
            orgId,
            botUsername: getMeResult.botUsername ?? undefined,
            botToken,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      log.info({ orgId, botId: getMeResult.botId, botUsername: getMeResult.botUsername }, "Telegram installation saved by admin");
      return c.json(
        { message: "Telegram connected successfully.", botUsername: getMeResult.botUsername },
        200,
      );
    }),
    { label: "connect telegram" },
  );
});

// DELETE /telegram — disconnect Telegram for current org
const disconnectTelegramRoute = createRoute({
  method: "delete",
  path: "/telegram",
  tags: ["Admin — Integrations"],
  summary: "Disconnect Telegram",
  description:
    "Removes the Telegram installation for the current workspace. " +
    "Any Telegram bot functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "Telegram disconnected",
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
      description: "No Telegram installation found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectTelegramRoute, async (c) => {
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
        try: () => deleteTelegramInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No Telegram installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Telegram installation disconnected by admin");
      return c.json({ message: "Telegram disconnected successfully." }, 200);
    }),
    { label: "disconnect telegram" },
  );
});

// ---------------------------------------------------------------------------
// Google Chat routes (BYOT-only — no platform OAuth variant)
// ---------------------------------------------------------------------------

const connectGChatRoute = createRoute({
  method: "post",
  path: "/gchat",
  tags: ["Admin — Integrations"],
  summary: "Connect Google Chat via service account",
  description:
    "Parses a Google Chat service account JSON key, validates required fields " +
    "(client_email, private_key), and saves the installation for the current workspace. " +
    "Structural validation only — does not call the Google API.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            credentialsJson: z
              .string()
              .min(1)
              .openapi({ description: "Google Cloud service account JSON key" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Google Chat connected",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            projectId: z.string().nullable(),
            serviceAccountEmail: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid credentials, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "Service account already bound to a different organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectGChatRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Google Chat integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { credentialsJson } = c.req.valid("json");

      // Parse and validate the service account JSON
      let parsed: { client_email?: string; private_key?: string; project_id?: string };
      try {
        parsed = JSON.parse(credentialsJson) as typeof parsed;
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "Google Chat credentials JSON parse failed");
        return c.json(
          { error: "invalid_credentials", message: "Invalid JSON. Paste the full service account key file contents." },
          400,
        );
      }

      if (!parsed.client_email || typeof parsed.client_email !== "string") {
        return c.json(
          { error: "invalid_credentials", message: "Service account JSON is missing the 'client_email' field." },
          400,
        );
      }

      if (!parsed.private_key || typeof parsed.private_key !== "string") {
        return c.json(
          { error: "invalid_credentials", message: "Service account JSON is missing the 'private_key' field." },
          400,
        );
      }

      if (!parsed.private_key.startsWith("-----BEGIN")) {
        return c.json(
          { error: "invalid_credentials", message: "Service account JSON has an invalid 'private_key'. Ensure you pasted the full key file." },
          400,
        );
      }

      const clientEmail = parsed.client_email;
      const projectId = typeof parsed.project_id === "string" && parsed.project_id
        ? parsed.project_id
        : clientEmail.split("@")[1]?.replace(".iam.gserviceaccount.com", "") ?? `gchat-${orgId}`;

      const saveResult = yield* Effect.tryPromise({
        try: () =>
          saveGChatInstallation(projectId, {
            orgId,
            serviceAccountEmail: clientEmail,
            credentialsJson,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchAll((err) => Effect.succeed({ ok: false as const, message: err.message })),
      );

      if (!saveResult.ok) {
        return c.json(
          { error: "conflict", message: saveResult.message },
          409,
        );
      }

      log.info({ orgId, projectId, serviceAccountEmail: clientEmail }, "Google Chat installation saved by admin");
      return c.json(
        { message: "Google Chat connected successfully.", projectId, serviceAccountEmail: clientEmail },
        200,
      );
    }),
    { label: "connect gchat" },
  );
});

const disconnectGChatRoute = createRoute({
  method: "delete",
  path: "/gchat",
  tags: ["Admin — Integrations"],
  summary: "Disconnect Google Chat",
  description:
    "Removes the Google Chat installation for the current workspace. " +
    "Any Google Chat bot functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "Google Chat disconnected",
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
      description: "No Google Chat installation found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectGChatRoute, async (c) => {
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
        try: () => deleteGChatInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No Google Chat installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Google Chat installation disconnected by admin");
      return c.json({ message: "Google Chat disconnected successfully." }, 200);
    }),
    { label: "disconnect gchat" },
  );
});

// ---------------------------------------------------------------------------
// GitHub routes (BYOT-only — no platform OAuth variant)
// ---------------------------------------------------------------------------

const connectGitHubRoute = createRoute({
  method: "post",
  path: "/github",
  tags: ["Admin — Integrations"],
  summary: "Connect GitHub via personal access token",
  description:
    "Validates a GitHub personal access token via the GitHub API and saves the installation " +
    "for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            accessToken: z
              .string()
              .min(1)
              .openapi({ description: "GitHub personal access token (ghp_ or github_pat_ prefix)" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "GitHub connected",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            username: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid token, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "GitHub user already bound to a different organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectGitHubRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "GitHub integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { accessToken } = c.req.valid("json");

      // Validate token by calling GitHub's /user API.
      const userResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch("https://api.github.com/user", {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "Atlas-Integration",
              },
            });
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "GitHub /user fetch failed");
            return { ok: false as const, error: "Could not reach GitHub API. Please try again." };
          }
          if (!res.ok) {
            let detail = `status ${res.status}`;
            try {
              const errBody = (await res.json()) as { message?: string };
              if (errBody.message) detail = errBody.message;
            } catch {
              // intentionally ignored: response body may not be JSON
            }
            return { ok: false as const, error: `GitHub API error: ${detail}` };
          }
          let data: { id?: number; login?: string };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "GitHub /user response parse failed");
            return { ok: false as const, error: "GitHub API returned an invalid response" };
          }
          if (!data.id) {
            return { ok: false as const, error: "Invalid personal access token" };
          }
          return { ok: true as const, userId: String(data.id), username: data.login ?? null };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!userResult.ok) {
        return c.json(
          { error: "invalid_token", message: `Invalid GitHub token: ${userResult.error}` },
          400,
        );
      }

      const saveResult = yield* Effect.tryPromise({
        try: () =>
          saveGitHubInstallation(userResult.userId, {
            orgId,
            username: userResult.username ?? undefined,
            accessToken,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchAll((err) => Effect.succeed({ ok: false as const, message: err.message })),
      );

      if (!saveResult.ok) {
        return c.json(
          { error: "conflict", message: saveResult.message },
          409,
        );
      }

      log.info({ orgId, userId: userResult.userId, username: userResult.username }, "GitHub installation saved by admin");
      return c.json(
        { message: "GitHub connected successfully.", username: userResult.username },
        200,
      );
    }),
    { label: "connect github" },
  );
});

const disconnectGitHubRoute = createRoute({
  method: "delete",
  path: "/github",
  tags: ["Admin — Integrations"],
  summary: "Disconnect GitHub",
  description:
    "Removes the GitHub installation for the current workspace. " +
    "Any GitHub integration functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "GitHub disconnected",
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
      description: "No GitHub installation found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectGitHubRoute, async (c) => {
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
        try: () => deleteGitHubInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No GitHub installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "GitHub installation disconnected by admin");
      return c.json({ message: "GitHub disconnected successfully." }, 200);
    }),
    { label: "disconnect github" },
  );
});

// ---------------------------------------------------------------------------
// Linear routes (BYOT-only — API key)
// ---------------------------------------------------------------------------

const connectLinearRoute = createRoute({
  method: "post",
  path: "/linear",
  tags: ["Admin — Integrations"],
  summary: "Connect Linear via API key",
  description:
    "Validates a Linear personal API key via the Linear GraphQL API and saves the installation " +
    "for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            apiKey: z
              .string()
              .min(1)
              .openapi({ description: "Linear personal API key" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Linear connected",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            userName: z.string().nullable(),
            userEmail: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid API key, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "Linear user already bound to a different organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectLinearRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Linear integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { apiKey } = c.req.valid("json");

      // Validate key by calling Linear's GraphQL API with a viewer query.
      const viewerResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch("https://api.linear.app/graphql", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: "{ viewer { id name email } }" }),
              signal: AbortSignal.timeout(10_000),
            });
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Linear GraphQL fetch failed");
            return { ok: false as const, error: "Could not reach Linear API. Please try again." };
          }
          if (!res.ok) {
            let detail = `status ${res.status}`;
            try {
              const errBody = (await res.json()) as { errors?: Array<{ message?: string }> };
              if (errBody.errors?.[0]?.message) detail = errBody.errors[0].message;
            } catch {
              // intentionally ignored: response body may not be JSON
            }
            return { ok: false as const, error: `Linear API error: ${detail}` };
          }
          let data: { data?: { viewer?: { id?: string; name?: string; email?: string } }; errors?: Array<{ message?: string }> };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Linear GraphQL response parse failed");
            return { ok: false as const, error: "Linear API returned an invalid response" };
          }
          if (data.errors?.length) {
            return { ok: false as const, error: data.errors[0].message ?? "GraphQL error" };
          }
          if (!data.data?.viewer?.id) {
            return { ok: false as const, error: "Invalid API key" };
          }
          return {
            ok: true as const,
            userId: data.data.viewer.id,
            userName: data.data.viewer.name ?? null,
            userEmail: data.data.viewer.email ?? null,
          };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!viewerResult.ok) {
        return c.json(
          { error: "invalid_token", message: `Invalid Linear API key: ${viewerResult.error}` },
          400,
        );
      }

      const saveResult = yield* Effect.tryPromise({
        try: () =>
          saveLinearInstallation(viewerResult.userId, {
            orgId,
            userName: viewerResult.userName ?? undefined,
            userEmail: viewerResult.userEmail ?? undefined,
            apiKey,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchAll((err) => {
          if (err.message.includes("already bound to a different organization")) {
            return Effect.succeed({ ok: false as const, message: err.message });
          }
          return Effect.fail(err);
        }),
      );

      if (!saveResult.ok) {
        return c.json(
          { error: "conflict", message: saveResult.message },
          409,
        );
      }

      log.info({ orgId, userId: viewerResult.userId, userName: viewerResult.userName }, "Linear installation saved by admin");
      return c.json(
        { message: "Linear connected successfully.", userName: viewerResult.userName, userEmail: viewerResult.userEmail },
        200,
      );
    }),
    { label: "connect linear" },
  );
});

const disconnectLinearRoute = createRoute({
  method: "delete",
  path: "/linear",
  tags: ["Admin — Integrations"],
  summary: "Disconnect Linear",
  description:
    "Removes the Linear installation for the current workspace. " +
    "Any Linear integration functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "Linear disconnected",
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
      description: "No Linear installation found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectLinearRoute, async (c) => {
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
        try: () => deleteLinearInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No Linear installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Linear installation disconnected by admin");
      return c.json({ message: "Linear disconnected successfully." }, 200);
    }),
    { label: "disconnect linear" },
  );
});

// ---------------------------------------------------------------------------
// WhatsApp routes (BYOT-only — Cloud API credentials)
// ---------------------------------------------------------------------------

const connectWhatsAppRoute = createRoute({
  method: "post",
  path: "/whatsapp",
  tags: ["Admin — Integrations"],
  summary: "Connect WhatsApp via Cloud API credentials",
  description:
    "Validates WhatsApp Cloud API credentials via the Meta Graph API and saves the installation " +
    "for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            phoneNumberId: z
              .string()
              .min(1)
              .regex(/^\d+$/, "Phone number ID must be numeric")
              .openapi({ description: "WhatsApp phone number ID from Meta Business Suite" }),
            accessToken: z
              .string()
              .min(1)
              .openapi({ description: "Permanent access token from Meta" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "WhatsApp connected",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            displayPhone: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid credentials, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "Phone number already bound to a different organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectWhatsAppRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "WhatsApp integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { phoneNumberId, accessToken } = c.req.valid("json");

      // Validate credentials by calling Meta's Graph API.
      const phoneResult = yield* Effect.tryPromise({
        try: async () => {
          let res: Response;
          try {
            res = await fetch(`https://graph.facebook.com/v18.0/${encodeURIComponent(phoneNumberId)}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
              signal: AbortSignal.timeout(10_000),
            });
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "WhatsApp Graph API fetch failed");
            return { ok: false as const, error: "Could not reach Meta API. Please try again." };
          }
          if (!res.ok) {
            let detail = `status ${res.status}`;
            try {
              const errBody = (await res.json()) as { error?: { message?: string } };
              if (errBody.error?.message) detail = errBody.error.message;
            } catch {
              // intentionally ignored: response body may not be JSON
            }
            return { ok: false as const, error: `Meta API error: ${detail}` };
          }
          let data: { id?: string; display_phone_number?: string };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "WhatsApp Graph API response parse failed");
            return { ok: false as const, error: "Meta API returned an invalid response" };
          }
          if (!data.id) {
            return { ok: false as const, error: "Invalid phone number ID or access token" };
          }
          return { ok: true as const, displayPhone: data.display_phone_number ?? null };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!phoneResult.ok) {
        return c.json(
          { error: "invalid_credentials", message: `Invalid WhatsApp credentials: ${phoneResult.error}` },
          400,
        );
      }

      const saveResult = yield* Effect.tryPromise({
        try: () =>
          saveWhatsAppInstallation(phoneNumberId, {
            orgId,
            displayPhone: phoneResult.displayPhone ?? undefined,
            accessToken,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchAll((err) => {
          if (err.message.includes("already bound to a different organization")) {
            return Effect.succeed({ ok: false as const, message: err.message });
          }
          return Effect.fail(err);
        }),
      );

      if (!saveResult.ok) {
        return c.json(
          { error: "conflict", message: saveResult.message },
          409,
        );
      }

      log.info({ orgId, phoneNumberId, displayPhone: phoneResult.displayPhone }, "WhatsApp installation saved by admin");
      return c.json(
        { message: "WhatsApp connected successfully.", displayPhone: phoneResult.displayPhone },
        200,
      );
    }),
    { label: "connect whatsapp" },
  );
});

const disconnectWhatsAppRoute = createRoute({
  method: "delete",
  path: "/whatsapp",
  tags: ["Admin — Integrations"],
  summary: "Disconnect WhatsApp",
  description:
    "Removes the WhatsApp installation for the current workspace. " +
    "Any WhatsApp messaging functionality will stop working until reconnected.",
  responses: {
    200: {
      description: "WhatsApp disconnected",
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
      description: "No WhatsApp installation found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectWhatsAppRoute, async (c) => {
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
        try: () => deleteWhatsAppInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No WhatsApp installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "WhatsApp installation disconnected by admin");
      return c.json({ message: "WhatsApp disconnected successfully." }, 200);
    }),
    { label: "disconnect whatsapp" },
  );
});

// ---------------------------------------------------------------------------
// Email routes (BYOT — SMTP, SendGrid, Postmark, SES, Resend)
// ---------------------------------------------------------------------------

const EmailProviderEnum = z.enum(EMAIL_PROVIDERS);

const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean(),
});

const SendGridConfigSchema = z.object({
  apiKey: z.string().min(1),
});

const PostmarkConfigSchema = z.object({
  serverToken: z.string().min(1),
});

const SesConfigSchema = z.object({
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

const ResendConfigSchema = z.object({
  apiKey: z.string().min(1),
});

const connectEmailRoute = createRoute({
  method: "post",
  path: "/email",
  tags: ["Admin — Integrations"],
  summary: "Connect email delivery provider",
  description:
    "Saves email delivery configuration for the current workspace. " +
    "Supports SMTP, SendGrid, Postmark, and SES providers.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: EmailProviderEnum.openapi({ description: "Email provider type" }),
            senderAddress: z
              .string()
              .email()
              .openapi({ description: "Sender email address (From header)" }),
            config: z.union([SmtpConfigSchema, SendGridConfigSchema, PostmarkConfigSchema, SesConfigSchema, ResendConfigSchema])
              .openapi({ description: "Provider-specific configuration" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Email connected",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            provider: z.string(),
            senderAddress: z.string(),
          }),
        },
      },
    },
    400: {
      description: "Invalid configuration, no active organization, or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(connectEmailRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Email integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { provider, senderAddress, config } = c.req.valid("json");

      // Validate provider-specific config shape
      const configResult = validateProviderConfig(provider, config);
      if (!configResult.ok) {
        return c.json(
          { error: "invalid_config", message: configResult.error },
          400,
        );
      }

      yield* Effect.tryPromise({
        try: () =>
          saveEmailInstallation(orgId, {
            provider: provider as EmailProvider,
            senderAddress,
            config: config as ProviderConfig,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      log.info({ orgId, provider, senderAddress }, "Email installation saved by admin");
      return c.json(
        { message: "Email connected successfully.", provider, senderAddress },
        200,
      );
    }),
    { label: "connect email" },
  );
});

const testEmailRoute = createRoute({
  method: "post",
  path: "/email/test",
  tags: ["Admin — Integrations"],
  summary: "Send test email",
  description:
    "Sends a test email using the saved email configuration for the current workspace.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            recipientEmail: z
              .string()
              .email()
              .openapi({ description: "Recipient email address for the test" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Test email sent",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            success: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: "No active organization, internal database not configured, or no email config found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(testEmailRoute, async (c) => {
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

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Email integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { recipientEmail } = c.req.valid("json");

      const install = yield* Effect.tryPromise({
        try: () => getEmailInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!install) {
        return c.json(
          { error: "not_found", message: "No email configuration found for this workspace. Connect an email provider first." },
          400,
        );
      }

      const result = yield* Effect.tryPromise({
        try: () => sendTestEmail(install, recipientEmail),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!result.success) {
        log.warn({ orgId, provider: install.provider, error: result.error }, "Test email failed");
        return c.json(
          { message: `Test email failed: ${result.error}`, success: false },
          200,
        );
      }

      log.info({ orgId, provider: install.provider, recipientEmail }, "Test email sent successfully");
      return c.json(
        { message: "Test email sent successfully.", success: true },
        200,
      );
    }),
    { label: "test email" },
  );
});

const disconnectEmailRoute = createRoute({
  method: "delete",
  path: "/email",
  tags: ["Admin — Integrations"],
  summary: "Disconnect email",
  description:
    "Removes the email configuration for the current workspace. " +
    "Email delivery will fall back to environment variables or be disabled until reconnected.",
  responses: {
    200: {
      description: "Email disconnected",
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
      description: "No email installation found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrations.openapi(disconnectEmailRoute, async (c) => {
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
        try: () => deleteEmailInstallationByOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });

      if (!deleted) {
        return c.json(
          { error: "not_found", message: "No email installation found for this workspace." },
          404,
        );
      }

      log.info({ orgId }, "Email installation disconnected by admin");
      return c.json({ message: "Email disconnected successfully." }, 200);
    }),
    { label: "disconnect email" },
  );
});

// ---------------------------------------------------------------------------
// Email helpers
// ---------------------------------------------------------------------------

function validateProviderConfig(
  provider: string,
  config: unknown,
): { ok: true } | { ok: false; error: string } {
  switch (provider) {
    case "smtp": {
      const result = SmtpConfigSchema.safeParse(config);
      if (!result.success) return { ok: false, error: `Invalid SMTP config: ${result.error.issues.map(i => i.message).join(", ")}` };
      return { ok: true };
    }
    case "sendgrid": {
      const result = SendGridConfigSchema.safeParse(config);
      if (!result.success) return { ok: false, error: `Invalid SendGrid config: ${result.error.issues.map(i => i.message).join(", ")}` };
      return { ok: true };
    }
    case "postmark": {
      const result = PostmarkConfigSchema.safeParse(config);
      if (!result.success) return { ok: false, error: `Invalid Postmark config: ${result.error.issues.map(i => i.message).join(", ")}` };
      return { ok: true };
    }
    case "ses": {
      const result = SesConfigSchema.safeParse(config);
      if (!result.success) return { ok: false, error: `Invalid SES config: ${result.error.issues.map(i => i.message).join(", ")}` };
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown provider: ${provider}` };
  }
}

interface TestEmailResult {
  success: boolean;
  error?: string;
}

async function sendTestEmail(
  install: { provider: string; sender_address: string; config: unknown },
  recipientEmail: string,
): Promise<TestEmailResult> {
  const config = install.config as Record<string, unknown>;
  const subject = "Atlas Email Test";
  const html = "<h1>Atlas Email Test</h1><p>This is a test email from Atlas to verify your email configuration is working correctly.</p>";

  switch (install.provider) {
    case "smtp":
      return sendSmtpTestEmail(config, install.sender_address, recipientEmail, subject, html);
    case "sendgrid":
      return sendSendGridTestEmail(config, install.sender_address, recipientEmail, subject, html);
    case "postmark":
      return sendPostmarkTestEmail(config, install.sender_address, recipientEmail, subject, html);
    case "ses":
      return sendSesTestEmail(config, install.sender_address, recipientEmail, subject, html);
    case "resend":
      return sendResendTestEmail(config, install.sender_address, recipientEmail, subject, html);
    default:
      return { success: false, error: `Unknown provider: ${install.provider}` };
  }
}

async function sendSendGridTestEmail(
  config: Record<string, unknown>,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<TestEmailResult> {
  const apiKey = config.apiKey;
  if (typeof apiKey !== "string") return { success: false, error: "Missing SendGrid API key" };

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `SendGrid API error (${res.status}): ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendPostmarkTestEmail(
  config: Record<string, unknown>,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<TestEmailResult> {
  const serverToken = config.serverToken;
  if (typeof serverToken !== "string") return { success: false, error: "Missing Postmark server token" };

  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": serverToken,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        HtmlBody: html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Postmark API error (${res.status}): ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendSmtpTestEmail(
  _config: Record<string, unknown>,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<TestEmailResult> {
  // SMTP delivery delegates to the ATLAS_SMTP_URL webhook bridge.
  // The bridge endpoint is responsible for connecting to the SMTP server
  // using the config stored in the database — we do not send credentials
  // over the wire in this payload.
  const smtpUrl = process.env.ATLAS_SMTP_URL;
  if (!smtpUrl) {
    return {
      success: false,
      error: "SMTP test requires ATLAS_SMTP_URL to be configured as an SMTP-to-HTTP bridge endpoint. " +
        "Configuration has been saved and will be used when ATLAS_SMTP_URL is available.",
    };
  }

  try {
    const res = await fetch(smtpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `SMTP webhook error (${res.status}): ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendSesTestEmail(
  _config: Record<string, unknown>,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<TestEmailResult> {
  // AWS Signature V4 is complex — for the test email we delegate to the
  // ATLAS_SMTP_URL webhook bridge if available. We do not send AWS credentials
  // over the wire; the bridge reads them from its own config or the database.
  const smtpUrl = process.env.ATLAS_SMTP_URL;
  if (!smtpUrl) {
    return {
      success: false,
      error: "SES test email requires ATLAS_SMTP_URL configured as an SES-compatible bridge. " +
        "Configuration has been saved.",
    };
  }

  try {
    const res = await fetch(smtpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `SES webhook error (${res.status}): ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendResendTestEmail(
  config: Record<string, unknown>,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<TestEmailResult> {
  const apiKey = config.apiKey;
  if (typeof apiKey !== "string") return { success: false, error: "Missing Resend API key" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Resend API error (${res.status}): ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { adminIntegrations };
