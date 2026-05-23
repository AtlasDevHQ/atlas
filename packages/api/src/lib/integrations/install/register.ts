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
import { registerFormHandler, registerOAuthHandler } from "./dispatch";
import { SlackOAuthInstallHandler } from "./slack-oauth-handler";
import { EmailFormInstallHandler } from "./email-form-handler";
import { ObsidianFormInstallHandler } from "./obsidian-form-handler";
import { WebhookFormInstallHandler } from "./webhook-form-handler";
import {
  SalesforceOAuthInstallHandler,
  SALESFORCE_CATALOG_ID,
} from "./salesforce-oauth-handler";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { createSalesforceLazyBuilder } from "@atlas/api/lib/integrations/salesforce/lazy-builder";

const log = createLogger("integrations.install.register");

/**
 * Read the public API origin from the operator's env. Each SaaS region
 * has its own value baked into Railway env vars; self-hosted deploys
 * set it once.
 *
 * Intentionally does NOT fall back to `ATLAS_CORS_ORIGIN` — that variable
 * is the *web app* origin (e.g. `app.useatlas.dev`), not the API host
 * (`api.useatlas.dev`). In SaaS split-origin deploys the two diverge, so
 * a CORS-origin fallback would generate a Slack redirect URL on the wrong
 * host, mismatching the Slack App's registered redirect URI and surfacing
 * as `invalid_redirect_uri` on every install attempt.
 *
 * Returns `null` when unset — the caller logs and skips registration
 * rather than minting tokens with a half-formed redirect.
 */
function resolvePublicApiUrl(): string | null {
  const explicit = process.env.ATLAS_PUBLIC_API_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
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
 * Register every built-in install handler that has the env wiring to
 * run. Idempotent — safe to call multiple times.
 *
 * Per-handler env gates are independent: Email (form-based, customer-
 * supplied SMTP creds) registers regardless of Slack env state, and
 * each OAuth handler short-circuits on its own missing env without
 * affecting others. Don't introduce ordering coupling between
 * handlers — a deploy that runs Email but not Slack must still get
 * Email.
 */
export function registerBuiltinInstallHandlers(): void {
  if (alreadyRegistered) return;
  alreadyRegistered = true;

  // ── Form-based handlers (alphabetical — #2660, #2661) ─────────────
  // No env-var gates: the customer admin supplies their own credentials
  // at install time, so each handler is always available whenever the
  // matching catalog row is enabled. Handlers stay alphabetical so
  // additive merges (e.g. Salesforce slice #2658) land at predictable
  // line offsets and don't conflict here.
  registerFormHandler("email", new EmailFormInstallHandler());
  log.info("Registered EmailFormInstallHandler");
  registerFormHandler("obsidian", new ObsidianFormInstallHandler());
  log.info("Registered ObsidianFormInstallHandler");
  registerFormHandler("webhook", new WebhookFormInstallHandler());
  log.info("Registered WebhookFormInstallHandler");

  // ── Slack OAuth ───────────────────────────────────────────────────
  registerSlackOAuthHandler();

  // ── Salesforce OAuth (#2658) ──────────────────────────────────────
  // First lazy OAuth integration. Registers both the OAuth install
  // handler (for the install + callback routes) AND the
  // LazyPluginLoader builder (for the on-demand per-Workspace plugin
  // instantiation that the agent loop dispatches into). Env gates the
  // pair as a unit — without SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET
  // there is no operator-side Connected App to drive either side.
  registerSalesforceOAuthHandler();
}

function registerSlackOAuthHandler(): void {
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
      "Slack OAuth handler not registered — ATLAS_PUBLIC_API_URL is unset, so the redirect URI cannot be resolved. Note: ATLAS_CORS_ORIGIN is the web app origin and is intentionally NOT a fallback (would mismatch the Slack App redirect URI in split-origin deploys).",
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

function registerSalesforceOAuthHandler(): void {
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  const publicApiUrl = resolvePublicApiUrl();
  // Operator override for sandboxes — defaults to login.salesforce.com
  // inside the handler when unset.
  const loginUrl = process.env.SALESFORCE_LOGIN_URL || undefined;

  if (!clientId || !clientSecret) {
    log.info(
      "Salesforce OAuth handler not registered — SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET unset. /api/v1/integrations/salesforce/install will return 501 until configured.",
    );
    return;
  }
  if (!publicApiUrl) {
    log.warn(
      "Salesforce OAuth handler not registered — ATLAS_PUBLIC_API_URL is unset, so the redirect URI cannot be resolved.",
    );
    return;
  }

  registerOAuthHandler(
    "salesforce",
    new SalesforceOAuthInstallHandler({
      clientId,
      clientSecret,
      redirectUri: `${publicApiUrl}/api/v1/integrations/salesforce/callback`,
      ...(loginUrl ? { loginUrl } : {}),
    }),
  );
  // Register the LazyPluginLoader builder too — the OAuth install dance
  // and the on-demand per-Workspace plugin instantiation are two halves
  // of the same Platform wiring; registering them together keeps the
  // env-gate seam aligned and avoids the "install works but tool calls
  // fail with builder_missing" failure mode.
  if (!lazyPluginLoader.hasBuilder(SALESFORCE_CATALOG_ID)) {
    lazyPluginLoader.registerBuilder(
      SALESFORCE_CATALOG_ID,
      createSalesforceLazyBuilder({
        clientId,
        clientSecret,
        ...(loginUrl ? { loginUrl } : {}),
      }),
    );
  }
  log.info({ publicApiUrl }, "Registered SalesforceOAuthInstallHandler + LazyPluginLoader builder");
}

/** @internal Test-only — resets the idempotency latch. */
export function _resetRegistrationLatch(): void {
  alreadyRegistered = false;
}
