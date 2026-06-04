/**
 * Discord legacy OAuth install routes — RETIRED (#3145, umbrella #2994).
 *
 * - GET /api/v1/discord/install   — 410 Gone (was: Discord OAuth2 authorize redirect)
 * - GET /api/v1/discord/callback  — 410 Gone (was: OAuth2 callback)
 *
 * This was the **residual uncapped** Discord install: its callback wrote a
 * `discord_installations` row via `saveDiscordInstallation` with **no**
 * chat-integration cap check — the same bypass the unified install pipeline
 * (ADR-0007) was built to eliminate. The working, cap-gated Discord install
 * lives in `routes/integrations-discord.ts` at
 * `/api/v1/integrations/discord/{install,callback}`: it dispatches into
 * `DiscordStaticBotInstallHandler.confirmInstall`, which persists a
 * `workspace_plugins` row through the advisory-locked
 * `checkChatIntegrationLimitAndInstall` (over-cap → 429, reconnect
 * grandfathered) and verifies the guild via the Discord API.
 *
 * Both routes are kept mounted (not deleted) so a stale bookmark or in-flight
 * Discord redirect lands on an explicit **410 Gone** pointing at the new path
 * rather than a 404 that reads like an outage. With this retirement, every
 * chat install path routes through the cap gate — closing the last bypass
 * under umbrella #2994.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";

const log = createLogger("discord");

const discord = new OpenAPIHono({ defaultHook: validationHook });

/** Shared 410 body — the install moved to the cap-gated integrations route. */
const RETIRED_MESSAGE =
  "The legacy Discord OAuth install has been retired. Install Discord from " +
  "Admin → Integrations → Discord, which uses the cap-gated bot-install flow at " +
  "/api/v1/integrations/discord/install. The old /api/v1/discord/* endpoints created " +
  "uncapped installs and no longer accept connections.";

// ---------------------------------------------------------------------------
// Route definitions — both retired to 410 Gone
// ---------------------------------------------------------------------------

const installRoute = createRoute({
  method: "get",
  path: "/install",
  tags: ["Discord"],
  summary: "Discord OAuth install redirect (retired)",
  description:
    "Retired in #3145 — Discord now installs via the cap-gated flow at " +
    "/api/v1/integrations/discord/install. Returns 410 Gone.",
  responses: {
    410: {
      description: "Endpoint retired — install via /api/v1/integrations/discord/install",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Discord"],
  summary: "Discord OAuth callback (retired)",
  description:
    "Retired in #3145 — the legacy callback wrote an uncapped install. Returns 410 Gone.",
  request: {
    query: z.object({
      state: z.string().optional().openapi({ description: "Legacy CSRF state (ignored)" }),
      code: z.string().optional().openapi({ description: "Legacy authorization code (ignored)" }),
      guild_id: z.string().optional().openapi({ description: "Legacy guild id (ignored)" }),
    }),
  },
  responses: {
    410: {
      description: "Endpoint retired — install via /api/v1/integrations/discord/install",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers — inert; no OAuth state, no install write
// ---------------------------------------------------------------------------
//
// These tombstone routes are public (no `adminAuthPreamble`, no
// `checkRateLimit`), so anonymous bot scans hit them freely. Log at `debug`,
// not `info`, so repeated unauthenticated hits can't flood production logs;
// the `requestId` stays in the 410 body for correlation when debug is enabled.

discord.openapi(installRoute, (c) => {
  const requestId = crypto.randomUUID();
  log.debug(
    { requestId },
    "Discord legacy /install hit after retirement — redirecting caller to the cap-gated install flow",
  );
  return c.json({ error: "endpoint_retired", message: RETIRED_MESSAGE, requestId }, 410);
});

discord.openapi(callbackRoute, (c) => {
  const requestId = crypto.randomUUID();
  log.debug(
    { requestId },
    "Discord legacy /callback hit after retirement — no guild bound (uncapped install path removed)",
  );
  return c.json({ error: "endpoint_retired", message: RETIRED_MESSAGE, requestId }, 410);
});

export { discord };
