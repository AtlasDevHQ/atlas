/**
 * Admin integrations routes.
 *
 * Mounted under /api/v1/admin/integrations. All routes require admin role
 * and org context. Provides aggregated integration status, connect,
 * and disconnect operations for Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp, and Email.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
} from "@atlas/api/lib/effect/workspace-installer";
import type { WorkspaceId } from "@useatlas/types";
import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import { getInstallationByOrg, saveInstallation, deleteInstallationByOrg } from "@atlas/api/lib/slack/store";
// teams/telegram/gchat/whatsapp stores were deleted with their tables in #3161.
// Those static-bot platforms' connection status is now read from
// `workspace_plugins` (see the status handler below), and their disconnect
// flows through the unified `DELETE /api/v1/integrations/:slug` (#3154 GAP 1).
import {
  getDiscordInstallationByOrg,
  saveDiscordInstallation,
  deleteDiscordInstallationByOrg,
} from "@atlas/api/lib/discord/store";
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
  getEmailInstallationByOrg,
  saveEmailInstallation,
  deleteEmailInstallationByOrg,
} from "@atlas/api/lib/email/store";
import { EMAIL_PROVIDERS } from "@atlas/api/lib/email/store";
import type { EmailProvider } from "@atlas/api/lib/email/store";
import { sendEmailWithTransport } from "@atlas/api/lib/email/delivery";
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";
import { IntegrationStatusSchema } from "@useatlas/schemas";

const log = createLogger("admin-integrations");

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

// Note: the legacy per-platform disconnect routes for teams / telegram /
// gchat / whatsapp were removed in #3161 — those static-bot installs now
// disconnect through the unified `DELETE /api/v1/integrations/:slug`
// (#3154 GAP 1). Slack and Discord keep their dedicated disconnect routes
// (Slack two-store teardown; Discord BYOT `discord_installations`).

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminIntegrations = createAdminRouter();

// #4356 — every handler on this router reads `const { orgId } = c.get("orgContext")`
// directly: this mount is what makes that read non-null (a missing active org 400s
// here, before any handler runs). Stated once, at the mount, rather than repeated
// above each read. A structural test pins the pairing — see
// `__tests__/admin-router.test.ts` (#4751).
adminIntegrations.use(requireOrgContext());

// GET /status — aggregated integration status
adminIntegrations.openapi(getStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = c.get("orgContext");

      const deployMode = getConfig()?.deployMode ?? "self-hosted";

      // Run all integration lookups in parallel — they are independent.
      // The `slackInstallMeta` lookup reads the slice 5 install record
      // (`workspace_plugins`) for `installed_by` / `installed_at`, which
      // `chat_cache` does not carry. Null on legacy installs that
      // predate slice 5 — the UI then degrades to "Connected on <chat_cache
      // installed_at>" without the "by X" part. Cheap (one PK lookup
      // on the unique workspace_id + catalog_id index).
      const [slackInstall, slackInstallMeta, staticBotInstalls, discordInstall, githubInstall, linearInstall, emailInstall, webhookActiveCount] =
        yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => getInstallationByOrg(orgId),
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: async () => {
                if (!hasInternalDB()) return null;
                const rows = await internalQuery<{
                  installed_at: string | null;
                  installed_by: string | null;
                }>(
                  `SELECT to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at,
                          installed_by
                     FROM workspace_plugins
                    WHERE workspace_id = $1 AND catalog_id = 'catalog:slack'
                    LIMIT 1`,
                  [orgId],
                );
                return rows[0] ?? null;
              },
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            // Teams / Telegram / Google Chat / WhatsApp connection status. Their
            // per-platform `*_installations` tables were dropped in #3161; the
            // static-bot install record now lives in `workspace_plugins` keyed
            // by `catalog:<slug>` with the routing identifier in `config`. One
            // query covers all four; `enabled = true` matches the inbound
            // routing resolvers in `lib/chat-plugin/executeQuery.ts` so
            // "connected" means "actually routable".
            Effect.tryPromise({
              try: async (): Promise<
                ReadonlyMap<string, { installedAt: string | null; config: Record<string, unknown> }>
              > => {
                if (!hasInternalDB()) return new Map();
                const rows = await internalQuery<{
                  catalog_id: string;
                  installed_at: string | null;
                  config: Record<string, unknown> | null;
                }>(
                  `SELECT catalog_id,
                          to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at,
                          config
                     FROM workspace_plugins
                    WHERE workspace_id = $1
                      AND pillar = 'chat'
                      AND enabled = true
                      AND catalog_id = ANY($2::text[])`,
                  [orgId, ["catalog:teams", "catalog:telegram", "catalog:gchat", "catalog:whatsapp"]],
                );
                const map = new Map<string, { installedAt: string | null; config: Record<string, unknown> }>();
                for (const r of rows) {
                  map.set(r.catalog_id, { installedAt: r.installed_at, config: r.config ?? {} });
                }
                return map;
              },
              catch: (err) => err instanceof Error ? err : new Error(String(err)),
            }),
            Effect.tryPromise({
              try: () => getDiscordInstallationByOrg(orgId),
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

      // Prefer `workspace_plugins.installed_at` when present — it's the
      // canonical first-store timestamp (slice 5 always writes it). Fall
      // back to the chat_cache value for legacy installs.
      //
      // `hasOAuthInstall` discriminates OAuth installs (slice-5 wrote a
      // workspace_plugins row) from BYOT / env-token installs (only
      // chat_cache or env). The admin UI gates the slice-6 "Disconnect
      // pending in #2655" placeholder on this — BYOT installs still get
      // the working DisconnectDialog because their teardown path
      // (`DELETE /admin/integrations/slack` → `deleteInstallationByOrg`)
      // is unchanged.
      const slack = {
        connected: slackInstall !== null,
        teamId: slackInstall?.team_id ?? null,
        workspaceName: slackInstall?.workspace_name ?? null,
        installedAt: slackInstallMeta?.installed_at ?? slackInstall?.installed_at ?? null,
        installedBy: slackInstallMeta?.installed_by ?? null,
        hasOAuthInstall: slackInstallMeta !== null,
        oauthConfigured,
        envConfigured,
        configurable: slackConfigurable,
      };

      // Read a non-empty string field out of a static-bot install's
      // `workspace_plugins.config` JSONB, or null. The routing identifiers
      // (tenant_id, phone_number_id, …) are non-secret, so they're stored in
      // plaintext and need no decryption here.
      const cfgString = (
        install: { config: Record<string, unknown> } | undefined,
        key: string,
      ): string | null => {
        const v = install?.config[key];
        return typeof v === "string" && v.length > 0 ? v : null;
      };

      // Teams status — install state now reads from `workspace_plugins`
      // (#3161 dropped `teams_installations`). The bot is operator-shared and
      // the install surface is the catalog card, so this legacy endpoint stays
      // non-configurable. The `tenant_id` / `tenant_name` config fields carry
      // through; the old credential-specific fields no longer exist.
      const teamsInstall = staticBotInstalls.get("catalog:teams");
      const teamsConfigurable = false;
      const teams = {
        connected: teamsInstall !== undefined,
        tenantId: cfgString(teamsInstall, "tenant_id"),
        tenantName: cfgString(teamsInstall, "tenant_name"),
        installedAt: teamsInstall?.installedAt ?? null,
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

      // Telegram status — reads from `workspace_plugins` (#3161 dropped
      // `telegram_installations`). The bot is operator-shared, so there is no
      // per-workspace bot id / username (the config carries `chat_id` /
      // `display_name`); those credential-specific fields are now always null.
      const telegramInstall = staticBotInstalls.get("catalog:telegram");
      const telegramConfigurable = false;
      const telegram = {
        connected: telegramInstall !== undefined,
        botId: null,
        botUsername: null,
        installedAt: telegramInstall?.installedAt ?? null,
        configurable: telegramConfigurable,
      };

      // Google Chat status — reads from `workspace_plugins` (#3161 dropped
      // `gchat_installations`). The service account is operator-shared, so the
      // per-workspace project id / SA email are no longer tracked here (the
      // config carries the routing `workspace_id`); those fields are now null.
      const gchatInstall = staticBotInstalls.get("catalog:gchat");
      const gchatConfigurable = false;
      const gchat = {
        connected: gchatInstall !== undefined,
        projectId: null,
        serviceAccountEmail: null,
        installedAt: gchatInstall?.installedAt ?? null,
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

      // WhatsApp status — reads from `workspace_plugins` (#3161 dropped
      // `whatsapp_installations`). The `phone_number_id` / `display_phone`
      // config fields carry through; the install is via the catalog card so
      // this legacy endpoint stays non-configurable.
      const whatsappInstall = staticBotInstalls.get("catalog:whatsapp");
      const whatsappConfigurable = false;
      const whatsapp = {
        connected: whatsappInstall !== undefined,
        phoneNumberId: cfgString(whatsappInstall, "phone_number_id"),
        displayPhone: cfgString(whatsappInstall, "display_phone"),
        installedAt: whatsappInstall?.installedAt ?? null,
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

// DELETE /slack — disconnect Slack for current org.
//
// #2742 — consolidated through `WorkspaceInstaller.uninstall` so the
// ADR-0003 two-store teardown sequencing (chat_cache before
// workspace_plugins) lives in one place. For OAuth installs this
// clears both stores; for BYOT installs (which write to chat_cache
// only via `connectSlackByotRoute` and never produce a
// workspace_plugins row) the facade returns `InstallNotFoundError`
// and we fall back to the legacy `deleteInstallationByOrg` — keeping
// the BYOT disconnect path working without forcing every BYOT user
// to first migrate to OAuth.
adminIntegrations.openapi(disconnectSlackRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = c.get("orgContext");

      // Try the facade first — drains both stores when the install was
      // created via OAuth (slice 5+ flow). Catch `InstallNotFoundError`
      // so we can fall back to the BYOT-only path.
      const facadeOutcome = yield* Effect.gen(function* () {
        const installer = yield* WorkspaceInstaller;
        yield* installer.uninstall(orgId as WorkspaceId, "slack");
        return "ok" as const;
      }).pipe(
        // #3764 — accepted: per-route boundary provide of the dependency-free,
        // finalizer-free WorkspaceInstallerLive; the route stays its own
        // composition root rather than reaching into the app ManagedRuntime.
        Effect.provide(WorkspaceInstallerLive),
        Effect.catchTag("InstallNotFoundError", () =>
          Effect.succeed("not_found" as const),
        ),
        Effect.catchTag("CatalogNotFoundError", () =>
          // No catalog row → no OAuth install possible; treat as BYOT
          // fallback so an environment without the `slack` catalog row
          // can still clean up legacy BYOT credentials.
          Effect.succeed("not_found" as const),
        ),
      );

      if (facadeOutcome === "not_found") {
        // BYOT fallback — legacy single-store delete keyed by orgId.
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
      }

      log.info({ orgId }, "Slack installation disconnected by admin");

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.disable,
        targetType: "integration",
        targetId: orgId!,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "slack" },
      });

      return c.json({ message: "Slack disconnected successfully." }, 200);
    }),
    { label: "disconnect slack" },
  );
});

// (Legacy `DELETE /teams` removed in #3161 — unified disconnect, #3154 GAP 1.)

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
      const { orgId } = c.get("orgContext");

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

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.disable,
        targetType: "integration",
        targetId: orgId!,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "discord" },
      });

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
      const { orgId } = c.get("orgContext");

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
            log.warn({ err: errorMessage(err) }, "Slack auth.test fetch failed");
            return { ok: false as const, error: "Could not reach Slack API. Please try again." };
          }
          let data: { ok: boolean; team_id?: string; team?: string; error?: string };
          try {
            data = (await res.json()) as typeof data;
          } catch (err) {
            log.warn({ err: errorMessage(err) }, "Slack auth.test response parse failed");
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
      }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            logAdminAction({
              actionType: ADMIN_ACTIONS.integration.enable,
              targetType: "integration",
              targetId: orgId,
              status: "failure",
              ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
              metadata: { platform: "slack", mode: "byot", hasSecret: true, error: err.message },
            }),
          ),
        ),
      );

      log.info({ orgId, teamId: authResult.teamId, workspaceName: authResult.workspaceName }, "Slack BYOT installation saved by admin");

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.enable,
        targetType: "integration",
        targetId: orgId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        // `hasSecret: true` is the load-bearing compliance-query marker.
        metadata: { platform: "slack", mode: "byot", hasSecret: true },
      });

      return c.json(
        { message: "Slack connected successfully.", workspaceName: authResult.workspaceName, teamId: authResult.teamId },
        200,
      );
    }),
    { label: "connect slack byot" },
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
      const { orgId } = c.get("orgContext");

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
            log.warn({ err: errorMessage(err) }, "Discord /users/@me fetch failed");
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
            log.warn({ err: errorMessage(err) }, "Discord /users/@me response parse failed");
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
      }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            logAdminAction({
              actionType: ADMIN_ACTIONS.integration.enable,
              targetType: "integration",
              targetId: orgId,
              status: "failure",
              ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
              metadata: { platform: "discord", mode: "byot", hasSecret: true, error: err.message },
            }),
          ),
        ),
      );

      log.info({ orgId, applicationId, botUsername: meResult.botUsername }, "Discord BYOT installation saved by admin");

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.enable,
        targetType: "integration",
        targetId: orgId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "discord", mode: "byot", hasSecret: true },
      });

      return c.json(
        { message: "Discord connected successfully.", botUsername: meResult.botUsername },
        200,
      );
    }),
    { label: "connect discord byot" },
  );
});

// (Legacy `DELETE /telegram` and `DELETE /gchat` removed in #3161 — those
// static-bot installs now disconnect through the unified
// `DELETE /api/v1/integrations/:slug` (#3154 GAP 1). Neither platform had a
// BYOT connect route on this surface; #2994 removed the only install routes.)

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
      const { orgId } = c.get("orgContext");

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
            log.warn({ err: errorMessage(err) }, "GitHub /user fetch failed");
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
            log.warn({ err: errorMessage(err) }, "GitHub /user response parse failed");
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
        logAdminAction({
          actionType: ADMIN_ACTIONS.integration.enable,
          targetType: "integration",
          targetId: orgId,
          status: "failure",
          ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          metadata: { platform: "github", hasSecret: true, error: saveResult.message },
        });
        return c.json(
          { error: "conflict", message: saveResult.message },
          409,
        );
      }

      log.info({ orgId, userId: userResult.userId, username: userResult.username }, "GitHub installation saved by admin");

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.enable,
        targetType: "integration",
        targetId: orgId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "github", hasSecret: true },
      });

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
      const { orgId } = c.get("orgContext");

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

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.disable,
        targetType: "integration",
        targetId: orgId!,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "github" },
      });

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
      const { orgId } = c.get("orgContext");

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
            log.warn({ err: errorMessage(err) }, "Linear GraphQL fetch failed");
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
            log.warn({ err: errorMessage(err) }, "Linear GraphQL response parse failed");
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
        logAdminAction({
          actionType: ADMIN_ACTIONS.integration.enable,
          targetType: "integration",
          targetId: orgId,
          status: "failure",
          ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          metadata: { platform: "linear", hasSecret: true, error: saveResult.message },
        });
        return c.json(
          { error: "conflict", message: saveResult.message },
          409,
        );
      }

      log.info({ orgId, userId: viewerResult.userId, userName: viewerResult.userName }, "Linear installation saved by admin");

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.enable,
        targetType: "integration",
        targetId: orgId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "linear", hasSecret: true },
      });

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
      const { orgId } = c.get("orgContext");

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

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.disable,
        targetType: "integration",
        targetId: orgId!,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "linear" },
      });

      return c.json({ message: "Linear disconnected successfully." }, 200);
    }),
    { label: "disconnect linear" },
  );
});

// (Legacy `DELETE /whatsapp` removed in #3161 — the static-bot WhatsApp install
// now disconnects through the unified `DELETE /api/v1/integrations/:slug`
// (#3154 GAP 1). #2994 removed the only WhatsApp install route on this surface.)

// ---------------------------------------------------------------------------
// Email routes (BYOT — SMTP, SendGrid, Postmark, SES, Resend)
// ---------------------------------------------------------------------------

const EmailProviderEnum = z.enum(EMAIL_PROVIDERS);

// Provider-specific config schemas tagged with `provider` (#1542). Clients
// now submit `config: { provider: "smtp", host: ... }` — the nested tag is
// validated against the sibling `provider` field via
// `z.discriminatedUnion` below.
const SmtpConfigSchema = z.object({
  provider: z.literal("smtp"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean(),
});

const SendGridConfigSchema = z.object({
  provider: z.literal("sendgrid"),
  apiKey: z.string().min(1),
});

const PostmarkConfigSchema = z.object({
  provider: z.literal("postmark"),
  serverToken: z.string().min(1),
});

const SesConfigSchema = z.object({
  provider: z.literal("ses"),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

const ResendConfigSchema = z.object({
  provider: z.literal("resend"),
  apiKey: z.string().min(1),
});

const ProviderConfigSchema = z.discriminatedUnion("provider", [
  SmtpConfigSchema,
  SendGridConfigSchema,
  PostmarkConfigSchema,
  SesConfigSchema,
  ResendConfigSchema,
]);

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
            // Discriminated union (#1542) — `config.provider` must match
            // the sibling `provider` field above. Mismatch → 400.
            config: ProviderConfigSchema
              .openapi({ description: "Provider-specific configuration (tagged with the matching provider key)." }),
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
      const { orgId } = c.get("orgContext");

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_configured", message: "Email integration requires an internal database. Configure DATABASE_URL." },
          400,
        );
      }

      const { provider, senderAddress, config } = c.req.valid("json");

      // `config` is already a tagged `ProviderConfig` variant (#1542) but
      // the discriminator might disagree with the sibling `provider` field.
      // Reject mismatches explicitly — this would be a client bug, not an
      // operator config issue, and warrants a clear 400.
      if (config.provider !== provider) {
        return c.json(
          { error: "invalid_config", message: `config.provider ("${config.provider}") must equal the sibling provider field ("${provider}").` },
          400,
        );
      }

      yield* Effect.tryPromise({
        try: () =>
          saveEmailInstallation(orgId, {
            provider: provider as EmailProvider,
            senderAddress,
            config,
          }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            logAdminAction({
              actionType: ADMIN_ACTIONS.integration.configure,
              targetType: "integration",
              targetId: orgId,
              status: "failure",
              ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
              metadata: { platform: "email", provider, hasSecret: true, error: err.message },
            }),
          ),
        ),
      );

      log.info({ orgId, provider, senderAddress }, "Email installation saved by admin");

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.configure,
        targetType: "integration",
        targetId: orgId,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "email", provider, hasSecret: true },
      });

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
      const { orgId } = c.get("orgContext");

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

      // Route the test-send through the canonical delivery seam (#3889): build
      // the SAME EmailTransport `resolveEmailSender(orgId)` would for this org
      // (org-transport) from the install we just validated, and send it via
      // `sendEmailWithTransport` → `deliverViaTransport` — the exact per-provider
      // senders production uses, with the staging outbound clamp. This replaces
      // the removed parallel raw test-senders, so the test path's provider + from
      // are byte-for-byte what the real send uses. `result.success`/`result.error`
      // drive the response; the audited `provider` stays the installed one below.
      const result = yield* Effect.tryPromise({
        try: () => sendEmailWithTransport(
          {
            to: recipientEmail,
            subject: "Atlas Email Test",
            html: "<h1>Atlas Email Test</h1><p>This is a test email from Atlas to verify your email configuration is working correctly.</p>",
          },
          {
            provider: install.provider,
            senderAddress: install.sender_address,
            config: install.config,
          },
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            logAdminAction({
              actionType: ADMIN_ACTIONS.integration.test,
              targetType: "integration",
              targetId: orgId,
              status: "failure",
              ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
              metadata: {
                platform: "email",
                provider: install.provider,
                success: false,
                error: err.message,
              },
            }),
          ),
        ),
      );

      // result.success:false is a provider-side delivery failure; audit as
      // failure so the row counts toward credential-oracle attempts.
      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.test,
        targetType: "integration",
        targetId: orgId,
        status: result.success ? "success" : "failure",
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: {
          platform: "email",
          provider: install.provider,
          success: result.success,
          ...(result.success ? {} : { error: result.error ?? "delivery failed" }),
        },
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
      const { orgId } = c.get("orgContext");

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

      logAdminAction({
        actionType: ADMIN_ACTIONS.integration.disable,
        targetType: "integration",
        targetId: orgId!,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { platform: "email" },
      });

      return c.json({ message: "Email disconnected successfully." }, 200);
    }),
    { label: "disconnect email" },
  );
});

// ---------------------------------------------------------------------------
// Email helpers
// ---------------------------------------------------------------------------

// `validateProviderConfig` was removed in #1542 — the route's
// `ProviderConfigSchema` (z.discriminatedUnion) plus the sibling-match
// check in the handler cover the same ground without double-validation.
//
// The per-provider test-send helpers (sendResendTestEmail / sendSendGridTestEmail
// / sendPostmarkTestEmail / sendSmtpTestEmail / sendSesTestEmail) were removed in
// #3889. They were a parallel copy of the canonical senders in
// `lib/email/delivery.ts`, so the Admin "test email" could pass through a
// different provider/from than production actually uses. The test-send handler
// now builds the install's `EmailTransport` and calls `sendEmailWithTransport(..)`
// → `deliverViaTransport` — one sender per provider, test path == prod path.

export { adminIntegrations };
