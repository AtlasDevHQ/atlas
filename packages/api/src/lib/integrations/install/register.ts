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
  JiraOAuthInstallHandler,
  JIRA_CATALOG_ID,
} from "./jira-oauth-handler";
import {
  SalesforceOAuthInstallHandler,
  SALESFORCE_CATALOG_ID,
} from "./salesforce-oauth-handler";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { createJiraLazyBuilder } from "@atlas/api/lib/integrations/jira/lazy-builder";
import { createSalesforceLazyBuilder } from "@atlas/api/lib/integrations/salesforce/lazy-builder";
import { createEmailLazyBuilder } from "@atlas/api/lib/integrations/email-tool";
import { EMAIL_CATALOG_ID } from "./email-secret-schema";

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
  if (!lazyPluginLoader.hasBuilder(EMAIL_CATALOG_ID)) {
    // No operator env gate — customer-supplied SMTP creds make the
    // builder always available alongside the form handler. Pair them
    // together so a half-wired deploy can't end up with an installable
    // card whose first tool call fails with builder_missing.
    lazyPluginLoader.registerBuilder(EMAIL_CATALOG_ID, createEmailLazyBuilder());
  }
  log.info("Registered EmailFormInstallHandler + LazyPluginLoader builder");
  registerFormHandler("obsidian", new ObsidianFormInstallHandler());
  log.info("Registered ObsidianFormInstallHandler");
  registerFormHandler("webhook", new WebhookFormInstallHandler());
  log.info("Registered WebhookFormInstallHandler");

  // ── Slack OAuth ───────────────────────────────────────────────────
  registerSlackOAuthHandler();

  // ── Lazy OAuth integrations (alphabetical — #2658 / #2659) ────────
  // Each registers both the OAuth install handler (for the install +
  // callback routes) AND the LazyPluginLoader builder (for the
  // on-demand per-Workspace plugin instantiation the agent loop
  // dispatches into). Env gates the pair as a unit so a half-wired
  // operator install doesn't end up with an installable card that
  // breaks on the first tool call.
  registerJiraOAuthHandler();
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

function registerJiraOAuthHandler(): void {
  const clientId = process.env.JIRA_CLIENT_ID;
  const clientSecret = process.env.JIRA_CLIENT_SECRET;
  const publicApiUrl = resolvePublicApiUrl();

  if (!clientId || !clientSecret) {
    log.info(
      "Jira OAuth handler not registered — JIRA_CLIENT_ID / JIRA_CLIENT_SECRET unset. /api/v1/integrations/jira/install will return 501 until configured.",
    );
    return;
  }
  if (!publicApiUrl) {
    log.warn(
      "Jira OAuth handler not registered — ATLAS_PUBLIC_API_URL is unset, so the redirect URI cannot be resolved.",
    );
    return;
  }

  registerOAuthHandler(
    "jira",
    new JiraOAuthInstallHandler({
      clientId,
      clientSecret,
      redirectUri: `${publicApiUrl}/api/v1/integrations/jira/callback`,
    }),
  );
  if (!lazyPluginLoader.hasBuilder(JIRA_CATALOG_ID)) {
    lazyPluginLoader.registerBuilder(
      JIRA_CATALOG_ID,
      createJiraLazyBuilder({ clientId, clientSecret }),
    );
  }
  log.info({ publicApiUrl }, "Registered JiraOAuthInstallHandler + LazyPluginLoader builder");
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
