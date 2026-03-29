/**
 * Teams integration OAuth routes.
 *
 * - GET /api/v1/teams/install   — Redirect to Azure AD admin consent
 * - GET /api/v1/teams/callback  — Handle admin consent callback
 *
 * Unlike Slack, Teams uses Azure AD admin consent. The app credentials
 * (TEAMS_APP_ID, TEAMS_APP_PASSWORD) are platform-level env vars.
 * What changes per-org is the tenant authorization — proof that a
 * workspace admin consented to the bot in their tenant.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { saveTeamsInstallation } from "@atlas/api/lib/teams/store";
import { ErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";

const log = createLogger("teams");

const teams = new OpenAPIHono({ defaultHook: validationHook });

// ---------------------------------------------------------------------------
// OAuth CSRF state — stores { expiry, orgId } keyed by nonce
// ---------------------------------------------------------------------------

interface OAuthState {
  expiry: number;
  orgId: string | undefined;
}

const pendingOAuthStates = new Map<string, OAuthState>();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, state] of pendingOAuthStates) {
    if (now > state.expiry) pendingOAuthStates.delete(nonce);
  }
}, 600_000).unref();

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/install",
  tags: ["Teams"],
  summary: "Teams OAuth install redirect",
  description:
    "Redirects to the Azure AD admin consent page. Requires TEAMS_APP_ID to be configured.",
  responses: {
    302: {
      description: "Redirect to Azure AD admin consent page",
    },
    501: {
      description: "Teams not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Teams"],
  summary: "Teams OAuth callback",
  description:
    "Handles the admin consent callback from Azure AD. Saves the tenant authorization " +
    "and returns HTML on success or failure.",
  request: {
    query: z.object({
      state: z.string().openapi({ description: "CSRF state parameter" }),
      tenant: z.string().optional().openapi({ description: "Azure AD tenant ID (absent on denial)" }),
      admin_consent: z.string().optional().openapi({ description: "Whether admin consent was granted" }),
      error: z.string().optional().openapi({ description: "Error code from Azure AD on denial" }),
      error_description: z.string().optional().openapi({ description: "Human-readable error from Azure AD" }),
    }),
  },
  responses: {
    200: {
      description: "Installation successful (HTML response)",
      content: { "text/html": { schema: z.string() } },
    },
    400: {
      description: "Invalid or expired state, or consent not granted",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Installation failed (HTML response)",
      content: { "text/html": { schema: z.string() } },
    },
    501: {
      description: "Teams not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// --- GET /api/v1/teams/install ---

teams.openapi(installRoute, (c) => {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) {
    return c.json({ error: "teams_not_configured", message: "Teams not configured" }, 501);
  }

  // Extract orgId from session if available (admin clicking "Connect to Teams")
  let orgId: string | undefined;
  try {
    const authResult = c.get("authResult" as never) as
      | { user?: { activeOrganizationId?: string } }
      | undefined;
    orgId = authResult?.user?.activeOrganizationId ?? undefined;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "authResult not available on Teams install route",
    );
  }

  const nonce = crypto.randomUUID();
  pendingOAuthStates.set(nonce, { expiry: Date.now() + 600_000, orgId });

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/v1/teams/callback`;
  const url =
    `https://login.microsoftonline.com/common/adminconsent` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&state=${encodeURIComponent(nonce)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  return c.redirect(url);
});

// --- GET /api/v1/teams/callback ---

teams.openapi(callbackRoute, async (c) => {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) {
    return c.json({ error: "teams_not_configured", message: "Teams not configured" }, 501);
  }

  const nonce = c.req.query("state");
  if (!nonce || !pendingOAuthStates.has(nonce)) {
    return c.json({ error: "invalid_state", message: "Invalid or expired state parameter" }, 400);
  }
  const oauthState = pendingOAuthStates.get(nonce)!;
  pendingOAuthStates.delete(nonce);

  // Azure AD returns error/error_description when consent is denied
  const errorCode = c.req.query("error");
  if (errorCode) {
    const errorDesc = c.req.query("error_description") ?? "Admin consent was not granted";
    log.info({ errorCode, errorDesc }, "Teams admin consent denied");
    return c.json(
      { error: "consent_denied", message: errorDesc },
      400,
    );
  }

  const tenantId = c.req.query("tenant");
  if (!tenantId) {
    return c.json({ error: "missing_tenant", message: "Missing tenant parameter" }, 400);
  }

  const adminConsent = c.req.query("admin_consent");
  if (adminConsent !== "True") {
    return c.json(
      { error: "consent_denied", message: "Admin consent was not granted" },
      400,
    );
  }

  try {
    const orgId = oauthState.orgId;
    await saveTeamsInstallation(tenantId, { orgId });
    log.info({ tenantId, orgId }, "Teams installation saved");
  } catch (saveErr) {
    log.error(
      { err: saveErr instanceof Error ? saveErr.message : String(saveErr), tenantId },
      "Failed to save Teams installation",
    );
    return c.html(
      "<html><body><h1>Installation Failed</h1><p>Could not save the installation. Please try again.</p></body></html>",
      500,
    );
  }

  return c.html(
    "<html><body><h1>Atlas installed!</h1><p>You can now use Atlas in your Teams workspace.</p></body></html>",
  );
});

export { teams };
