/**
 * Discord integration OAuth routes.
 *
 * - GET /api/v1/discord/install   — Redirect to Discord OAuth2 authorize
 * - GET /api/v1/discord/callback  — Handle OAuth2 authorization callback
 *
 * Discord uses OAuth2 to authorize a bot into a guild (server).
 * Platform operator registers a Discord Application and sets
 * DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET as env vars.
 * What changes per-org is the guild authorization — like Teams,
 * the bot token itself is a platform-level credential.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { saveDiscordInstallation } from "@atlas/api/lib/discord/store";
import { saveOAuthState, consumeOAuthState } from "@atlas/api/lib/auth/oauth-state";
import { ErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";

const log = createLogger("discord");

const discord = new OpenAPIHono({ defaultHook: validationHook });

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/install",
  tags: ["Discord"],
  summary: "Discord OAuth install redirect",
  description:
    "Redirects to the Discord OAuth2 authorize page. Requires DISCORD_CLIENT_ID to be configured.",
  responses: {
    302: {
      description: "Redirect to Discord OAuth2 authorize page",
    },
    501: {
      description: "Discord not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Discord"],
  summary: "Discord OAuth callback",
  description:
    "Handles the OAuth2 callback from Discord. Verifies the guild authorization, " +
    "saves the installation, and returns HTML on success or failure.",
  request: {
    query: z.object({
      state: z.string().optional().openapi({ description: "CSRF state parameter" }),
      code: z.string().optional().openapi({ description: "Authorization code from Discord" }),
      guild_id: z.string().optional().openapi({ description: "Authorized guild ID" }),
      error: z.string().optional().openapi({ description: "Error code from Discord on denial" }),
      error_description: z.string().optional().openapi({ description: "Human-readable error from Discord" }),
    }),
  },
  responses: {
    200: {
      description: "Installation successful (HTML response)",
      content: { "text/html": { schema: z.string() } },
    },
    400: {
      description: "Invalid or expired state, or authorization denied",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Installation failed (HTML response)",
      content: { "text/html": { schema: z.string() } },
    },
    501: {
      description: "Discord not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// --- GET /api/v1/discord/install ---

discord.openapi(installRoute, async (c) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: "discord_not_configured", message: "Discord not configured" }, 501);
  }

  // Extract orgId from session if available (admin clicking "Connect to Discord")
  let orgId: string | undefined;
  try {
    const authResult = c.get("authResult" as never) as
      | { user?: { activeOrganizationId?: string } }
      | undefined;
    orgId = authResult?.user?.activeOrganizationId ?? undefined;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "authResult not available on Discord install route",
    );
  }

  const nonce = crypto.randomUUID();
  try {
    await saveOAuthState(nonce, { orgId, provider: "discord" });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to save OAuth state for Discord install",
    );
    return c.json(
      { error: "state_save_failed", message: "Could not initiate OAuth flow. Please try again." },
      500,
    );
  }

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/v1/discord/callback`;
  // 2048 = Send Messages permission
  const url =
    `https://discord.com/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&permissions=2048` +
    `&scope=bot+applications.commands` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(nonce)}`;
  return c.redirect(url);
});

// --- GET /api/v1/discord/callback ---

discord.openapi(callbackRoute, async (c) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: "discord_not_configured", message: "Discord not configured" }, 501);
  }

  const requestId = crypto.randomUUID();

  // Consume the CSRF nonce first — even if the user denied authorization,
  // the nonce must be consumed to prevent replay attacks.
  const nonce = c.req.query("state");
  if (!nonce) {
    return c.json({ error: "invalid_state", message: "Invalid or expired state parameter." }, 400);
  }

  let oauthState: Awaited<ReturnType<typeof consumeOAuthState>>;
  try {
    oauthState = await consumeOAuthState(nonce);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), requestId },
      "Failed to validate OAuth state — internal database may be unavailable",
    );
    return c.html(
      `<html><body><h1>Installation Failed</h1><p>Could not validate the authorization. Please try again. (ref: ${requestId.slice(0, 8)})</p></body></html>`,
      500,
    );
  }

  if (!oauthState) {
    return c.json({ error: "invalid_state", message: "Invalid or expired state parameter. Please start the installation again." }, 400);
  }

  if (oauthState.provider !== "discord") {
    log.warn({ expected: "discord", got: oauthState.provider, requestId }, "OAuth state provider mismatch");
    return c.json({ error: "invalid_state", message: "Invalid state parameter." }, 400);
  }

  // Check for error from Discord (user denied authorization)
  const errorCode = c.req.query("error");
  if (errorCode) {
    const errorDesc = c.req.query("error_description") ?? "Authorization was not granted";
    log.info({ errorCode, errorDesc }, "Discord authorization denied");
    return c.json(
      { error: "authorization_denied", message: errorDesc },
      400,
    );
  }

  const code = c.req.query("code");
  if (!code) {
    return c.json({ error: "missing_code", message: "Missing authorization code" }, 400);
  }

  // Exchange authorization code for token response (contains guild info)
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/v1/discord/callback`;

  let tokenData: Record<string, unknown>;
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      log.error({ status: tokenRes.status, body, requestId }, "Discord token exchange failed");
      return c.html(
        `<html><body><h1>Installation Failed</h1><p>Could not exchange authorization code. Please try again. (ref: ${requestId.slice(0, 8)})</p></body></html>`,
        500,
      );
    }

    tokenData = (await tokenRes.json()) as Record<string, unknown>;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), requestId },
      "Discord token exchange request failed",
    );
    return c.html(
      `<html><body><h1>Installation Failed</h1><p>Could not contact Discord. Please try again. (ref: ${requestId.slice(0, 8)})</p></body></html>`,
      500,
    );
  }

  // Extract guild info from the token response
  const guild = tokenData.guild as { id?: string; name?: string } | undefined;
  const guildId = guild?.id;
  const guildName = guild?.name ?? null;

  if (!guildId || typeof guildId !== "string") {
    log.error(
      { hasGuild: !!tokenData.guild, tokenType: tokenData.token_type, requestId },
      "Discord token response missing guild.id",
    );
    return c.html(
      `<html><body><h1>Installation Failed</h1><p>Discord did not return guild information. Please try again. (ref: ${requestId.slice(0, 8)})</p></body></html>`,
      500,
    );
  }

  try {
    const orgId = oauthState.orgId;
    await saveDiscordInstallation(guildId, {
      orgId,
      guildName: guildName ?? undefined,
    });
    log.info({ guildId, guildName, orgId }, "Discord installation saved");
  } catch (saveErr) {
    log.error(
      { err: saveErr instanceof Error ? saveErr.message : String(saveErr), guildId, requestId },
      "Failed to save Discord installation",
    );
    return c.html(
      `<html><body><h1>Installation Failed</h1><p>Could not save the installation. Please try again. (ref: ${requestId.slice(0, 8)})</p></body></html>`,
      500,
    );
  }

  return c.html(
    "<html><body><h1>Atlas installed!</h1><p>You can now use Atlas in your Discord server.</p></body></html>",
  );
});

export { discord };
