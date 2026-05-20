/**
 * Module-load registration for built-in OAuth install handlers — slice 5
 * of #2649 (issue #2653).
 *
 * Side-effect import: importing this module registers the per-Platform
 * handler singletons by calling `registerOAuthHandler(slug, handler)`.
 * The dispatch table in `./dispatch.ts` is empty until something
 * imports this module — that's the seam the boot DAG hooks into (see
 * `lib/effect/layers.ts:registerBuiltinInstallHandlers`).
 *
 * Env-driven gates: an operator that doesn't run Slack (or hasn't yet
 * configured the Slack App) simply omits `SLACK_CLIENT_ID`. The Slack
 * branch logs at info and skips registration; a real install attempt
 * later surfaces the dispatch's "No OAuth install handler registered"
 * — which is the correct fail-loud signal (the operator needs to set
 * the env var, not the route to silently degrade).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { registerOAuthHandler } from "./dispatch";
import { SlackOAuthInstallHandler } from "./slack-oauth-handler";

const log = createLogger("integrations.install.register");

/**
 * Read the public API origin from the operator's env. Each SaaS region
 * has its own value baked into Railway env vars; self-hosted deploys
 * set it once. Falls back to `ATLAS_CORS_ORIGIN` for legacy parity with
 * the pre-#2653 install route, since some deploys only set the latter.
 *
 * Returns `null` when neither is configured — the caller logs and skips
 * registration rather than minting tokens with a half-formed redirect.
 */
function resolvePublicApiUrl(): string | null {
  const explicit = process.env.ATLAS_PUBLIC_API_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const corsOrigin = process.env.ATLAS_CORS_ORIGIN;
  if (corsOrigin && corsOrigin.length > 0) return corsOrigin.replace(/\/+$/, "");
  return null;
}

/**
 * Idempotency latch — `registerBuiltinInstallHandlers` is called once
 * from boot, but tests that import this module repeatedly (via dynamic
 * import in `beforeAll`) shouldn't re-warn about missing env. The
 * registries themselves are idempotent; this is just log hygiene.
 */
let alreadyRegistered = false;

/**
 * Register every built-in OAuth install handler that has the env wiring
 * to run. Idempotent — safe to call multiple times.
 */
export function registerBuiltinInstallHandlers(): void {
  if (alreadyRegistered) return;
  alreadyRegistered = true;

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const publicApiUrl = resolvePublicApiUrl();

  if (!clientId || !clientSecret) {
    log.info(
      "Slack OAuth handler not registered — SLACK_CLIENT_ID / SLACK_CLIENT_SECRET unset. /api/v1/integrations/slack/install will return 501 until configured.",
    );
    return;
  }
  if (!publicApiUrl) {
    log.warn(
      "Slack OAuth handler not registered — neither ATLAS_PUBLIC_API_URL nor ATLAS_CORS_ORIGIN is set, so the redirect URI cannot be resolved.",
    );
    return;
  }

  registerOAuthHandler(
    "slack",
    new SlackOAuthInstallHandler({
      clientId,
      clientSecret,
      redirectUri: `${publicApiUrl}/api/v1/integrations/slack/callback`,
    }),
  );
  log.info({ publicApiUrl }, "Registered SlackOAuthInstallHandler");
}

/** @internal Test-only — resets the idempotency latch. */
export function _resetRegistrationLatch(): void {
  alreadyRegistered = false;
}
