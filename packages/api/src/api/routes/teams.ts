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
// OAuth CSRF state
// ---------------------------------------------------------------------------

const pendingOAuthStates = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of pendingOAuthStates) {
    if (now > expiry) pendingOAuthStates.delete(state);
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
      tenant: z.string().openapi({ description: "Azure AD tenant ID" }),
      admin_consent: z.string().openapi({ description: "Whether admin consent was granted" }),
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

  const state = crypto.randomUUID();
  pendingOAuthStates.set(state, Date.now() + 600_000);

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/v1/teams/callback`;
  const url =
    `https://login.microsoftonline.com/common/adminconsent` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  return c.redirect(url);
});

// --- GET /api/v1/teams/callback ---

teams.openapi(callbackRoute, async (c) => {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) {
    return c.json({ error: "teams_not_configured", message: "Teams not configured" }, 501);
  }

  const state = c.req.query("state");
  if (!state || !pendingOAuthStates.has(state)) {
    return c.json({ error: "invalid_state", message: "Invalid or expired state parameter" }, 400);
  }
  pendingOAuthStates.delete(state);

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
    // Extract org context if available (install may have been initiated by an authenticated admin)
    let orgId: string | undefined;
    try {
      const authResult = c.get("authResult" as never) as
        | { user?: { activeOrganizationId?: string } }
        | undefined;
      orgId = authResult?.user?.activeOrganizationId ?? undefined;
    } catch (err) {
      // Expected: authResult not available on unauthenticated Teams routes
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "authResult not available on Teams callback route",
      );
    }

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
