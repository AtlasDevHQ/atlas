/**
 * Teams OAuth (Azure AD admin-consent) install routes — cap-gated (#3142).
 *
 * - GET /api/v1/teams/install   — Redirect to Azure AD admin consent
 * - GET /api/v1/teams/callback  — Handle admin consent callback, cap-gated install
 *
 * Teams is **OAuth-shaped** (like Discord): the Microsoft Entra ID tenant
 * GUID is captured from the Azure AD **admin-consent** callback — the
 * admin consents in their *own* tenant and Azure returns the verified
 * tenant id. That round-trip IS the ownership proof, so the generic
 * `/install-form` route refuses Teams (`oauthShaped`); this dedicated
 * callback is the install surface.
 *
 * What changed under umbrella #2994: the callback used to write the
 * legacy `teams_installations` table via `saveTeamsInstallation` — an
 * **uncapped** install that bypassed the chat-integration plan cap and
 * produced a non-routable binding (the #2994 defect). That table and its
 * store were dropped entirely in #3161. It now dispatches
 * the verified tenant into `TeamsStaticBotInstallHandler.confirmInstall`,
 * which enforces the cap via the advisory-locked
 * `checkChatIntegrationLimitAndInstall` and persists a `workspace_plugins`
 * row that the runtime Teams branch (`lib/chat-plugin/executeQuery.ts`)
 * resolves. The app credentials (`TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`) are
 * platform-level env vars; what changes per-workspace is the verified
 * tenant authorization.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
// NOTE: `getInstallHandler` is imported *lazily* inside the callback (see
// below), not at module top. `api/index.ts` dynamically imports this route, and
// pulling the install/enforcement graph in at module-load time here forms a
// circular load that surfaces as "Export named 'checkChatIntegrationLimit' not
// found in billing/enforcement.ts" when other app-importing tests link the app.
// Keeping this module's static import graph light (like the rest of the route
// layer) avoids the cycle. The Teams catalog slug is the literal "teams".
import {
  TeamsApiUnavailableError,
  TeamsReachabilityError,
  TeamsTenantIdInvalidError,
  ChatIntegrationLimitError,
  BillingCheckFailedError,
} from "@atlas/api/lib/effect/errors";
import { saveOAuthState, consumeOAuthState } from "@atlas/api/lib/auth/oauth-state";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { adminAuthPreamble } from "./admin-auth";
import { getConfig } from "@atlas/api/lib/config";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import type { WorkspaceId } from "@useatlas/types";

const log = createLogger("teams");

const teams = new OpenAPIHono({ defaultHook: validationHook });

/** Log-safe tenant fingerprint — last 4 chars only. */
function fingerprintTenant(tenantId: string): string {
  return tenantId.length <= 4 ? tenantId : `…${tenantId.slice(-4)}`;
}

/**
 * Browser-facing failure handler. Redirects to the admin integrations page
 * with an `error` reason when a web origin is configured; otherwise returns
 * a self-contained HTML page (self-hosted deploys with no separate web app).
 */
function installFailure(
  c: Parameters<Parameters<typeof teams.openapi>[1]>[0],
  webOrigin: string | null,
  reason: string,
  requestId: string,
): Response {
  if (webOrigin) {
    return c.redirect(`${webOrigin}/admin/integrations?error=${encodeURIComponent(reason)}`);
  }
  return c.html(
    `<html><body><h1>Installation Failed</h1><p>Could not complete the Teams install (${reason}). Please try again. (ref: ${requestId.slice(0, 8)})</p></body></html>`,
    500,
  );
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/install",
  tags: ["Teams"],
  summary: "Teams OAuth install redirect",
  description:
    "Redirects to the Azure AD admin consent page. Requires TEAMS_APP_ID to be configured. " +
    "Caller must be authenticated as a workspace admin/owner — the OAuth state binds the resulting " +
    "tenant authorization to the caller's organization, so anonymous installs are rejected to prevent install hijacking.",
  responses: {
    302: { description: "Redirect to Azure AD admin consent page" },
    401: { description: "Not authenticated", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Caller is not an admin/owner of the workspace", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Failed to save OAuth state", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "Teams not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Teams"],
  summary: "Teams OAuth callback (cap-gated install)",
  description:
    "Handles the admin-consent callback from Azure AD. Dispatches the verified tenant id into the " +
    "cap-gated static-bot install handler (writes workspace_plugins via checkChatIntegrationLimitAndInstall), " +
    "then redirects to /admin/integrations (or returns HTML when no web origin is configured).",
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
    200: { description: "Installation successful (HTML, when no web origin is configured)", content: { "text/html": { schema: z.string() } } },
    302: { description: "Installation outcome (redirect to /admin/integrations on the web app)" },
    400: { description: "Invalid or expired state, or consent not granted", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Installation failed (HTML response)", content: { "text/html": { schema: z.string() } } },
    501: { description: "Teams not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// --- GET /api/v1/teams/install ---

teams.openapi(installRoute, async (c) => {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) {
    return c.json({ error: "teams_not_configured", message: "Teams not configured" }, 501);
  }

  // F-04 (security): require authenticated admin so the OAuth state binds the
  // resulting tenant authorization to a real org. Anonymous /install was an
  // install-hijack vector — an attacker could trigger admin consent and have
  // the tenant bound to org_id = NULL, then later be claimed by another tenant.
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers);
  }
  const orgId = preamble.authResult.user?.activeOrganizationId ?? undefined;

  const nonce = crypto.randomUUID();
  try {
    await saveOAuthState(nonce, { orgId, provider: "teams" });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to save OAuth state for Teams install",
    );
    return c.json(
      {
        error: "state_save_failed",
        message: "Could not initiate OAuth flow. Please try again.",
        requestId,
      },
      500,
    );
  }

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

  const requestId = crypto.randomUUID();
  const webOrigin = getWebOrigin();

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
    return installFailure(c, webOrigin, "state_validation_failed", requestId);
  }

  if (!oauthState) {
    return c.json({ error: "invalid_state", message: "Invalid or expired state parameter. Please start the installation again." }, 400);
  }
  if (oauthState.provider !== "teams") {
    log.warn({ expected: "teams", got: oauthState.provider, requestId }, "OAuth state provider mismatch");
    return c.json({ error: "invalid_state", message: "Invalid state parameter." }, 400);
  }

  // F-04: in SaaS mode every install must bind to an org. A missing orgId here
  // means /install was reached without a valid admin session (or the row was
  // tampered with) — refuse to bind the tenant. Self-hosted may keep
  // platform-wide installs (orgId undefined when there's no org concept).
  if (oauthState.orgId === undefined && getConfig()?.deployMode === "saas") {
    log.warn({ requestId }, "Rejecting Teams install: SaaS mode requires orgId on OAuth state");
    return c.json(
      { error: "missing_org_binding", message: "Install must be initiated by an authenticated workspace admin." },
      400,
    );
  }

  // Azure AD returns error/error_description when consent is denied.
  const errorCode = c.req.query("error");
  if (errorCode) {
    const errorDesc = c.req.query("error_description") ?? "Admin consent was not granted";
    log.info({ errorCode, errorDesc }, "Teams admin consent denied");
    return c.json({ error: "consent_denied", message: errorDesc }, 400);
  }

  const tenantId = c.req.query("tenant");
  if (!tenantId) {
    return c.json({ error: "missing_tenant", message: "Missing tenant parameter" }, 400);
  }
  const adminConsent = c.req.query("admin_consent");
  if (adminConsent !== "True") {
    return c.json({ error: "consent_denied", message: "Admin consent was not granted" }, 400);
  }

  // Dispatch the Azure-verified tenant into the cap-gated static-bot handler.
  // `confirmInstall` re-validates the tenant GUID shape, round-trips Microsoft
  // OIDC discovery for reachability, and UPSERTs `workspace_plugins` through
  // `checkChatIntegrationLimitAndInstall` (over-cap -> ChatIntegrationLimitError,
  // count-check -> BillingCheckFailedError, reconnect grandfathered).
  const workspaceId = (oauthState.orgId ?? "self-hosted") as WorkspaceId;
  // Lazy import (see module-top note): keep the install/enforcement graph out
  // of this route's static import chain to avoid a circular-load.
  const { getInstallHandler } = await import("@atlas/api/lib/integrations/install");
  let handler;
  try {
    handler = getInstallHandler({ slug: "teams", install_model: "static-bot" });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), requestId },
      "No Teams install handler registered at callback time",
    );
    return installFailure(c, webOrigin, "handler_unavailable", requestId);
  }
  if (handler.kind !== "static-bot") {
    log.error({ kind: handler.kind, requestId }, "Teams callback: dispatch returned non-static-bot handler");
    return installFailure(c, webOrigin, "handler_unavailable", requestId);
  }

  try {
    await handler.confirmInstall(workspaceId, tenantId);
    log.info(
      { tenantIdFingerprint: fingerprintTenant(tenantId), workspaceId, requestId },
      "Teams install completed via admin-consent callback (cap-gated, workspace_plugins)",
    );
  } catch (err) {
    if (err instanceof TeamsTenantIdInvalidError || err instanceof TeamsReachabilityError) {
      log.warn({ workspaceId, err: err.message, requestId }, "Teams install rejected tenant — actionable error");
      return installFailure(c, webOrigin, "upstream_error", requestId);
    }
    if (err instanceof TeamsApiUnavailableError) {
      log.error({ workspaceId, err: err.message, requestId }, "Microsoft tenant discovery unreachable during callback");
      return installFailure(c, webOrigin, "upstream_unavailable", requestId);
    }
    if (err instanceof ChatIntegrationLimitError) {
      log.info({ workspaceId, limit: err.limit, requestId }, "Teams install blocked — workspace at chat-integration cap");
      return installFailure(c, webOrigin, "plan_limit_exceeded", requestId);
    }
    if (err instanceof BillingCheckFailedError) {
      log.error({ workspaceId, err: err.message, requestId }, "Teams install blocked — billing check failed (transient)");
      return installFailure(c, webOrigin, "billing_check_failed", requestId);
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId, requestId },
      "Failed to persist Teams install",
    );
    return installFailure(c, webOrigin, "install_failed", requestId);
  }

  if (webOrigin) {
    return c.redirect(`${webOrigin}/admin/integrations?installed=teams`);
  }
  return c.html(
    "<html><body><h1>Atlas installed!</h1><p>You can now use Atlas in your Teams workspace.</p></body></html>",
  );
});

export { teams };
