/**
 * Teams legacy OAuth install routes — RETIRED (#3142, umbrella #2994).
 *
 * - GET /api/v1/teams/install   — 410 Gone (was: Azure AD admin consent redirect)
 * - GET /api/v1/teams/callback  — 410 Gone (was: admin-consent callback)
 *
 * The Azure AD admin-consent dance that used to live here bound a tenant
 * by writing the legacy `teams_installations` table via
 * `saveTeamsInstallation` — an **uncapped** install that bypassed the
 * chat-integration plan cap and produced a non-routable binding (the
 * #2994 defect). Teams now installs through the unified cap-gated
 * static-bot path: a workspace admin uploads the Atlas Teams manifest to
 * their tenant (or installs from AppSource), then pastes their Microsoft
 * Entra ID tenant GUID into **Admin → Integrations → Microsoft Teams**,
 * which routes to `POST /api/v1/integrations/teams/install-form` →
 * `TeamsStaticBotInstallHandler.confirmInstall` (cap-gated, persists via
 * the advisory-locked `checkChatIntegrationLimitAndInstall`, writes
 * `workspace_plugins`).
 *
 * Both routes are kept mounted (not deleted) so any stale bookmark or
 * in-flight Azure redirect lands on an explicit **410 Gone** pointing at
 * the new flow rather than a 404 that reads like an outage. The legacy
 * `teams_installations` table + `lib/teams/store.ts` writer are dropped
 * in #3145; the read-side `deleteTeamsInstallationByOrg` used by the
 * legacy disconnect path is retired alongside the family-wide disconnect
 * rework (#3154).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";

const log = createLogger("teams");

const teams = new OpenAPIHono({ defaultHook: validationHook });

/**
 * Shared 410 body — the route's install moved to the cap-gated static-bot
 * flow. Kept as one constant so both handlers return identical wording.
 */
const RETIRED_MESSAGE =
  "The Teams OAuth install flow has been retired. Install Microsoft Teams from " +
  "Admin → Integrations → Microsoft Teams: upload the Atlas Teams manifest to your " +
  "tenant (or install from AppSource), then enter your Microsoft Entra ID tenant GUID. " +
  "The new flow is plan-cap-aware and routes inbound messages correctly.";

// ---------------------------------------------------------------------------
// Route definitions — both retired to 410 Gone
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/install",
  tags: ["Teams"],
  summary: "Teams OAuth install redirect (retired)",
  description:
    "Retired in #3142 — Teams now installs via the cap-gated static-bot flow at " +
    "Admin → Integrations. Returns 410 Gone pointing at the new path.",
  responses: {
    410: {
      description: "Endpoint retired — install via Admin → Integrations",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Teams"],
  summary: "Teams OAuth callback (retired)",
  description:
    "Retired in #3142 — the admin-consent callback no longer binds a tenant (that path " +
    "wrote an uncapped install). Returns 410 Gone.",
  request: {
    query: z.object({
      state: z.string().optional().openapi({ description: "Legacy CSRF state (ignored)" }),
      tenant: z.string().optional().openapi({ description: "Legacy Azure AD tenant id (ignored)" }),
    }),
  },
  responses: {
    410: {
      description: "Endpoint retired — install via Admin → Integrations",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers — inert; no OAuth state, no install write
// ---------------------------------------------------------------------------

teams.openapi(installRoute, (c) => {
  const requestId = crypto.randomUUID();
  log.info(
    { requestId },
    "Teams legacy /install hit after retirement — redirecting caller to the static-bot install flow",
  );
  return c.json({ error: "endpoint_retired", message: RETIRED_MESSAGE, requestId }, 410);
});

teams.openapi(callbackRoute, (c) => {
  const requestId = crypto.randomUUID();
  log.info(
    { requestId },
    "Teams legacy /callback hit after retirement — no tenant bound (uncapped install path removed)",
  );
  return c.json({ error: "endpoint_retired", message: RETIRED_MESSAGE, requestId }, 410);
});

export { teams };
