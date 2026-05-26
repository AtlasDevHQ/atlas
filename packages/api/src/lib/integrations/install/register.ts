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
import {
  registerFormHandler,
  registerOAuthHandler,
  registerStaticBotHandler,
} from "./dispatch";
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
import {
  TelegramStaticBotInstallHandler,
  TELEGRAM_SLUG,
} from "./telegram-static-bot-handler";
import {
  DiscordStaticBotInstallHandler,
  DISCORD_SLUG,
} from "./discord-static-bot-handler";
import {
  TeamsStaticBotInstallHandler,
  TEAMS_SLUG,
} from "./teams-static-bot-handler";
import {
  WhatsAppStaticBotInstallHandler,
  WHATSAPP_SLUG,
} from "./whatsapp-static-bot-handler";
import {
  GchatStaticBotInstallHandler,
  GCHAT_SLUG,
  parseServiceAccountJson,
  asPubsubTopicPath,
} from "./gchat-static-bot-handler";
import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { createJiraLazyBuilder } from "@atlas/api/lib/integrations/jira/lazy-builder";
import { createSalesforceLazyBuilder } from "@atlas/api/lib/integrations/salesforce/lazy-builder";
import { createEmailLazyBuilder } from "@atlas/api/lib/integrations/email-tool";
import { EMAIL_CATALOG_ID } from "./email-secret-schema";
import {
  LinearOAuthInstallHandler,
  LINEAR_CATALOG_ID,
} from "./linear-oauth-handler";
import { LinearApiKeyFormInstallHandler } from "./linear-apikey-form-handler";
import { LINEAR_APIKEY_CATALOG_ID } from "./linear-apikey-secret-schema";
import {
  createLinearOAuthLazyBuilder,
  createLinearApiKeyLazyBuilder,
} from "@atlas/api/lib/integrations/linear/lazy-builder";
import { GitHubPatFormInstallHandler } from "./github-pat-form-handler";
import {
  GitHubOAuthInstallHandler,
  GITHUB_SLUG,
} from "./github-oauth-handler";
import {
  GitHubSingleTenantOAuthInstallHandler,
  GITHUB_SINGLE_TENANT_SLUG,
} from "./github-single-tenant-oauth-handler";

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
  // Linear API-key form-install (#2750). Pairs with the lazy builder
  // for `catalog:linear-apikey` registered below — same "register both
  // halves together so a half-wired deploy can't end up with an
  // installable card whose first tool call fails with builder_missing"
  // rule as Email's pairing above.
  registerFormHandler("linear-apikey", new LinearApiKeyFormInstallHandler());
  if (!lazyPluginLoader.hasBuilder(LINEAR_APIKEY_CATALOG_ID)) {
    lazyPluginLoader.registerBuilder(
      LINEAR_APIKEY_CATALOG_ID,
      createLinearApiKeyLazyBuilder(),
    );
  }
  log.info("Registered LinearApiKeyFormInstallHandler + LazyPluginLoader builder");
  // GitHub PAT form-install (#2751, Phase D PAT mode). No paired lazy
  // builder yet — the GitHub action tool ships in a follow-up PR
  // (alongside the GitHub App OAuth handler). The form handler still
  // registers so the install path works end-to-end: the credential
  // persists, and the tool dispatch will find it once the builder
  // lands. Self-host only — the catalog row carries `saas_eligible:
  // false`, so the integrations-catalog route hides this on SaaS.
  registerFormHandler("github-pat", new GitHubPatFormInstallHandler());
  log.info("Registered GitHubPatFormInstallHandler (no lazy builder yet — agent tool ships in follow-up)");

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
  registerLinearOAuthHandler();
  registerSalesforceOAuthHandler();
  registerGitHubAppOAuthHandler();
  registerGitHubSingleTenantOAuthHandler();

  // ── Static-bot platforms (1.5.3 — Phase D, #2748+) ────────────────
  // Telegram (#2748 keystone), Discord (#2749), Teams (#2752), and
  // Google Chat (#2754) are registered below. WhatsApp (#2753) is the
  // remaining Phase D platform. Each Platform's env-gate guards the
  // operator-shared credential set; the catalog row's `enabled` flag
  // is the second gate (operator-side, DB-toggleable for emergency
  // disable).
  registerTelegramStaticBotHandler();
  registerDiscordStaticBotHandler();
  registerTeamsStaticBotHandler();
  registerWhatsAppStaticBotHandler();
  registerGchatStaticBotHandler();
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

function registerLinearOAuthHandler(): void {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  const publicApiUrl = resolvePublicApiUrl();

  if (!clientId || !clientSecret) {
    log.info(
      "Linear OAuth handler not registered — LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET unset. /api/v1/integrations/linear/install will return 501 until configured. (linear-apikey form-install path remains available — no env gate.)",
    );
    return;
  }
  if (!publicApiUrl) {
    log.warn(
      "Linear OAuth handler not registered — ATLAS_PUBLIC_API_URL is unset, so the redirect URI cannot be resolved.",
    );
    return;
  }

  registerOAuthHandler(
    "linear",
    new LinearOAuthInstallHandler({
      clientId,
      clientSecret,
      redirectUri: `${publicApiUrl}/api/v1/integrations/linear/callback`,
    }),
  );
  if (!lazyPluginLoader.hasBuilder(LINEAR_CATALOG_ID)) {
    lazyPluginLoader.registerBuilder(
      LINEAR_CATALOG_ID,
      createLinearOAuthLazyBuilder({ clientId, clientSecret }),
    );
  }
  log.info({ publicApiUrl }, "Registered LinearOAuthInstallHandler + LazyPluginLoader builder");
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

/**
 * Register the Telegram static-bot install handler when the operator
 * env is wired.
 *
 * **Severity escalation when the catalog disagrees with the env.**
 * Per #2748 review (and #2673 silent-degradation precedent), the boot
 * line is logged at `error` — not `info` — when the resolved catalog
 * row says `enabled: true` for telegram but `TELEGRAM_BOT_TOKEN` is
 * unset. That combination is always an operator misconfig: the
 * AdapterRegistry will degrade chat to no-Telegram, the install route
 * will 501, and the admin UI's Telegram card will look installable but
 * fail at submit. The escalation surfaces the gap in operator log
 * streams instead of blending into routine boot info noise.
 *
 * When the catalog has telegram disabled (or omitted), the env-unset
 * branch stays at `info` — operator intentionally hasn't opted in.
 */
function registerTelegramStaticBotHandler(): void {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken.length === 0) {
    if (isCatalogSlugEnabled("telegram")) {
      log.error(
        { slug: "telegram", requiredEnv: ["TELEGRAM_BOT_TOKEN"] },
        "Telegram catalog row is enabled but TELEGRAM_BOT_TOKEN is unset — install route will return 501 and AdapterRegistry will skip the adapter. Set TELEGRAM_BOT_TOKEN per-service. See #2673 for the same-class silent-degradation precedent.",
      );
    } else {
      log.info(
        "Telegram static-bot handler not registered — TELEGRAM_BOT_TOKEN unset and the 'telegram' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  registerStaticBotHandler(
    TELEGRAM_SLUG,
    new TelegramStaticBotInstallHandler({ botToken }),
  );
  log.info(
    { tokenFingerprint: fingerprintToken(botToken) },
    "Registered TelegramStaticBotInstallHandler",
  );
}

/**
 * Register the Discord static-bot install handler when the operator
 * env is wired (#2749). Mirrors {@link registerTelegramStaticBotHandler}
 * exactly — same severity-escalation contract when the catalog row says
 * `enabled: true` but a required env var is missing.
 *
 * Two env vars gate registration: `DISCORD_BOT_TOKEN` (for the
 * reachability roundtrip and adapter outbound calls) and
 * `DISCORD_CLIENT_ID` (the operator's Discord application id, used to
 * build the bot-install URL the customer admin is redirected to).
 * Both are required because the install flow can't proceed without
 * either — the route would otherwise 501 in a confusing half-wired way.
 *
 * `DISCORD_PUBLIC_KEY` is required by the AdapterRegistry (the chat
 * adapter needs it to verify Ed25519 signatures on incoming webhooks)
 * but is NOT required here — the install handler itself doesn't
 * verify webhooks. An operator who wires install creds but forgets
 * the public key would get a working install flow + a non-functional
 * webhook receive path; the AdapterRegistry's missing-env log is the
 * signal for that gap.
 */
function registerDiscordStaticBotHandler(): void {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!botToken || botToken.length === 0 || !clientId || clientId.length === 0) {
    if (isCatalogSlugEnabled("discord")) {
      log.error(
        {
          slug: "discord",
          requiredEnv: ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID"],
          missing: [
            ...(!botToken ? ["DISCORD_BOT_TOKEN"] : []),
            ...(!clientId ? ["DISCORD_CLIENT_ID"] : []),
          ],
        },
        "Discord catalog row is enabled but DISCORD_BOT_TOKEN and/or DISCORD_CLIENT_ID is unset — install route will return 501 and AdapterRegistry will skip the adapter. Set both per-service. See #2673 for the same-class silent-degradation precedent.",
      );
    } else {
      log.info(
        "Discord static-bot handler not registered — DISCORD_BOT_TOKEN and/or DISCORD_CLIENT_ID unset and the 'discord' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  registerStaticBotHandler(
    DISCORD_SLUG,
    new DiscordStaticBotInstallHandler({ botToken, clientId }),
  );
  log.info(
    {
      clientIdFingerprint: fingerprintToken(clientId),
      tokenFingerprint: fingerprintToken(botToken),
    },
    "Registered DiscordStaticBotInstallHandler",
  );
}

/**
 * Register the Teams static-bot install handler when the operator env
 * is wired (#2752). Mirrors {@link registerDiscordStaticBotHandler}
 * exactly — same severity-escalation contract when the catalog row says
 * `enabled: true` but a required env var is missing.
 *
 * Two env vars gate registration: `TEAMS_APP_ID` (Microsoft App ID /
 * client id from the operator's Azure Bot registration) and
 * `TEAMS_APP_PASSWORD` (Microsoft App Password / client secret). Both
 * are required because the chat adapter and the manifest download path
 * each need them — the install route would otherwise 501 in a confusing
 * half-wired way.
 *
 * `TEAMS_TENANT_ID` is an optional operator-side single-tenant override
 * consumed by the chat adapter (`appType: "SingleTenant"` vs
 * `"MultiTenant"`), not this handler — install always validates the
 * customer-supplied tenant_id regardless. Single-tenant deploys pin one
 * customer tenant up-front; MultiTenant deploys (the default) accept any
 * customer tenant that passes OIDC discovery.
 */
function registerTeamsStaticBotHandler(): void {
  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;
  if (!appId || appId.length === 0 || !appPassword || appPassword.length === 0) {
    if (isCatalogSlugEnabled("teams")) {
      log.error(
        {
          slug: "teams",
          requiredEnv: ["TEAMS_APP_ID", "TEAMS_APP_PASSWORD"],
          missing: [
            ...(!appId ? ["TEAMS_APP_ID"] : []),
            ...(!appPassword ? ["TEAMS_APP_PASSWORD"] : []),
          ],
        },
        "Teams catalog row is enabled but TEAMS_APP_ID and/or TEAMS_APP_PASSWORD is unset — install route will return 501 and AdapterRegistry will skip the adapter. Set both per-service. See #2673 for the same-class silent-degradation precedent.",
      );
    } else {
      log.info(
        "Teams static-bot handler not registered — TEAMS_APP_ID and/or TEAMS_APP_PASSWORD unset and the 'teams' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  registerStaticBotHandler(
    TEAMS_SLUG,
    new TeamsStaticBotInstallHandler({ appId, appPassword }),
  );
  log.info(
    {
      appIdFingerprint: fingerprintToken(appId),
      appPasswordFingerprint: fingerprintToken(appPassword),
    },
    "Registered TeamsStaticBotInstallHandler",
  );
}

/**
 * Register the WhatsApp static-bot install handler when the operator env
 * is wired (#2753). Mirrors {@link registerTeamsStaticBotHandler} exactly
 * — same severity-escalation contract when the catalog row says
 * `enabled: true` but a required env var is missing.
 *
 * Two env vars gate registration: `META_BUSINESS_ACCESS_TOKEN` (the
 * operator's WhatsApp Business Cloud API System User token) and
 * `META_BUSINESS_APP_ID` (the operator's Meta App ID, used by the
 * install routes / manifest deep-link to be the single source of truth
 * for "WhatsApp is wired"). Both are required because the install flow
 * can't proceed without either — the route would otherwise 501 in a
 * confusing half-wired way.
 *
 * `WHATSAPP_APP_SECRET` (HMAC-SHA256 webhook signature) and
 * `WHATSAPP_VERIFY_TOKEN` (webhook challenge handshake) are required by
 * the chat adapter (the inbound webhook path needs both) but are NOT
 * required here — the install handler itself doesn't process webhooks.
 * An operator who wires install creds but forgets the webhook envelope
 * would get a working install + a non-functional receive path; the
 * AdapterRegistry's missing-env log is the signal for that gap.
 */
function registerWhatsAppStaticBotHandler(): void {
  const accessToken = process.env.META_BUSINESS_ACCESS_TOKEN;
  const appId = process.env.META_BUSINESS_APP_ID;
  if (
    !accessToken ||
    accessToken.length === 0 ||
    !appId ||
    appId.length === 0
  ) {
    if (isCatalogSlugEnabled("whatsapp")) {
      log.error(
        {
          slug: "whatsapp",
          requiredEnv: ["META_BUSINESS_ACCESS_TOKEN", "META_BUSINESS_APP_ID"],
          missing: [
            ...(!accessToken ? ["META_BUSINESS_ACCESS_TOKEN"] : []),
            ...(!appId ? ["META_BUSINESS_APP_ID"] : []),
          ],
        },
        "WhatsApp catalog row is enabled but META_BUSINESS_ACCESS_TOKEN and/or META_BUSINESS_APP_ID is unset — install route will return 501 and AdapterRegistry will skip the adapter. Set both per-service. See #2673 for the same-class silent-degradation precedent.",
      );
    } else {
      log.info(
        "WhatsApp static-bot handler not registered — META_BUSINESS_ACCESS_TOKEN and/or META_BUSINESS_APP_ID unset and the 'whatsapp' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  registerStaticBotHandler(
    WHATSAPP_SLUG,
    new WhatsAppStaticBotInstallHandler({ accessToken, appId }),
  );
  log.info(
    {
      appIdFingerprint: fingerprintToken(appId),
      accessTokenFingerprint: fingerprintToken(accessToken),
    },
    "Registered WhatsAppStaticBotInstallHandler",
  );
}

/**
 * Register the Google Chat static-bot install handler when the operator
 * env is wired (#2754). Mirrors {@link registerTelegramStaticBotHandler}
 * exactly — same severity-escalation contract when the catalog row says
 * `enabled: true` but a required env var is missing.
 *
 * Two env vars gate registration: `GCHAT_SERVICE_ACCOUNT_JSON` (the
 * raw JSON file contents for the operator's GCP service account; the
 * SA is what mints Pub/Sub access tokens for the verification round-
 * trip and the chat adapter) and `GCHAT_PUBSUB_TOPIC` (the fully-
 * qualified Pub/Sub topic path the Workspace Events subscription
 * publishes to — `projects/<project>/topics/<topic>`). Both are
 * required because verification publishes a synthetic message at
 * install time, and the chat adapter subscribes to the same topic
 * at boot.
 *
 * `GCHAT_SERVICE_ACCOUNT_JSON` is parsed up-front via
 * {@link parseServiceAccountJson} so a malformed value fails loudly at
 * boot (with a clear actionable message) rather than at first install
 * attempt. Same posture for the topic path — `asPubsubTopicPath`
 * rejects bare topic names.
 */
function registerGchatStaticBotHandler(): void {
  const serviceAccountRaw = process.env.GCHAT_SERVICE_ACCOUNT_JSON;
  const pubsubTopic = process.env.GCHAT_PUBSUB_TOPIC;
  if (
    !serviceAccountRaw ||
    serviceAccountRaw.length === 0 ||
    !pubsubTopic ||
    pubsubTopic.length === 0
  ) {
    if (isCatalogSlugEnabled("gchat")) {
      log.error(
        {
          slug: "gchat",
          requiredEnv: ["GCHAT_SERVICE_ACCOUNT_JSON", "GCHAT_PUBSUB_TOPIC"],
          missing: [
            ...(!serviceAccountRaw ? ["GCHAT_SERVICE_ACCOUNT_JSON"] : []),
            ...(!pubsubTopic ? ["GCHAT_PUBSUB_TOPIC"] : []),
          ],
        },
        "Google Chat catalog row is enabled but GCHAT_SERVICE_ACCOUNT_JSON and/or GCHAT_PUBSUB_TOPIC is unset — install route will return 501 and AdapterRegistry will skip the adapter. Set both per-service. See #2673 for the same-class silent-degradation precedent.",
      );
    } else {
      log.info(
        "Google Chat static-bot handler not registered — GCHAT_SERVICE_ACCOUNT_JSON and/or GCHAT_PUBSUB_TOPIC unset and the 'gchat' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  let serviceAccount;
  let pubsubTopicPath;
  try {
    serviceAccount = parseServiceAccountJson(serviceAccountRaw);
    pubsubTopicPath = asPubsubTopicPath(pubsubTopic);
  } catch (err) {
    // Parse / shape errors are operator misconfig; surface at `error`
    // regardless of catalog enabled state so a malformed value gets
    // immediate operator attention (silent skip here would let a typo
    // disable Google Chat for a SaaS deploy without any log signal).
    //
    // SECURITY: log only `err.message`, NOT the full error object.
    // Pino's default `err` serializer walks `cause` chains, and even
    // though `parseServiceAccountJson` deliberately drops `cause` from
    // its JSON.parse wrapping, defending in depth keeps a future
    // accidental re-attachment of `cause` from leaking PEM bytes here.
    log.error(
      {
        slug: "gchat",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      "Google Chat static-bot handler not registered — operator env (GCHAT_SERVICE_ACCOUNT_JSON or GCHAT_PUBSUB_TOPIC) is malformed. Fix the env value and redeploy.",
    );
    return;
  }
  registerStaticBotHandler(
    GCHAT_SLUG,
    new GchatStaticBotInstallHandler({ serviceAccount, pubsubTopic: pubsubTopicPath }),
  );
  log.info(
    {
      clientEmailFingerprint: fingerprintToken(serviceAccount.client_email),
      pubsubTopic: pubsubTopicPath,
    },
    "Registered GchatStaticBotInstallHandler",
  );
}

/**
 * Register the multi-tenant GitHub App OAuth handler when the operator
 * env is wired (#2751, Phase D App-OAuth mode).
 *
 * Five env vars gate registration:
 *   - `GITHUB_APP_ID` — numeric App ID from the App settings page.
 *     Used at install-token mint time by the lazy builder (ships in a
 *     follow-up PR); recorded on the handler instance for consistency
 *     with the single-tenant sibling.
 *   - `GITHUB_APP_SLUG` — App slug from `https://github.com/apps/<slug>`.
 *     Used to build the install URL (`/apps/<slug>/installations/new`).
 *   - `GITHUB_APP_PRIVATE_KEY` — App private key (`.pem` contents).
 *     Used at install-token mint time by the lazy builder.
 *   - `GITHUB_APP_CLIENT_ID` + `GITHUB_APP_CLIENT_SECRET` — App OAuth
 *     credentials surfaced on the settings page after "Request user
 *     authorization (OAuth) during installation" is enabled. Required
 *     for the user-OAuth-flow ownership verification step (see
 *     `GitHubOAuthInstallHandler` JSDoc for the threat model — without
 *     this check a workspace admin can bind their workspace to a
 *     different org's installation_id).
 *
 * `GITHUB_APP_INSTALLATION_ID` is intentionally NOT checked here — it's
 * the single-tenant marker, distinct from the multi-tenant App config.
 * The single-tenant handler registers separately.
 */
function registerGitHubAppOAuthHandler(): void {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const publicApiUrl = resolvePublicApiUrl();

  const required = {
    GITHUB_APP_ID: appId,
    GITHUB_APP_SLUG: appSlug,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    if (isCatalogSlugEnabled("github")) {
      log.error(
        {
          slug: "github",
          requiredEnv: Object.keys(required),
          missing,
        },
        "GitHub catalog row is enabled but one of GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET is unset — /api/v1/integrations/github/install will return 501 until configured.",
      );
    } else {
      log.info(
        "GitHub App OAuth handler not registered — required env unset and the 'github' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  if (!publicApiUrl) {
    log.warn(
      "GitHub App OAuth handler not registered — ATLAS_PUBLIC_API_URL is unset, so the redirect URI cannot be resolved.",
    );
    return;
  }

  registerOAuthHandler(
    GITHUB_SLUG,
    new GitHubOAuthInstallHandler({
      appId: appId!,
      appSlug: appSlug!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      redirectUri: `${publicApiUrl}/api/v1/integrations/github/callback`,
    }),
  );
  log.info(
    { publicApiUrl, appSlug },
    "Registered GitHubOAuthInstallHandler (no lazy builder yet — agent tool ships in follow-up)",
  );
}

/**
 * Register the single-tenant GitHub App OAuth handler when the operator
 * env is wired (#2751, Phase D single-tenant mode). Mirrors the multi-
 * tenant register but additionally requires `GITHUB_APP_INSTALLATION_ID`
 * — the env-baked id the operator obtained when installing their App
 * into their one GitHub org.
 *
 * Self-host only: the matching catalog row carries `saas_eligible:
 * false`. The handler registers regardless of deploy mode if the env
 * is set, but the integrations-catalog route hides the row on SaaS so
 * customers never see the card.
 */
function registerGitHubSingleTenantOAuthHandler(): void {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const publicApiUrl = resolvePublicApiUrl();

  if (!appId || !appSlug || !privateKey || !installationId) {
    if (isCatalogSlugEnabled("github-single-tenant")) {
      log.error(
        {
          slug: "github-single-tenant",
          requiredEnv: [
            "GITHUB_APP_ID",
            "GITHUB_APP_SLUG",
            "GITHUB_APP_PRIVATE_KEY",
            "GITHUB_APP_INSTALLATION_ID",
          ],
          missing: [
            ...(!appId ? ["GITHUB_APP_ID"] : []),
            ...(!appSlug ? ["GITHUB_APP_SLUG"] : []),
            ...(!privateKey ? ["GITHUB_APP_PRIVATE_KEY"] : []),
            ...(!installationId ? ["GITHUB_APP_INSTALLATION_ID"] : []),
          ],
        },
        "GitHub single-tenant catalog row is enabled but one of GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID is unset — install route will return 501 until configured.",
      );
    } else {
      log.info(
        "GitHub single-tenant handler not registered — required env unset and the 'github-single-tenant' catalog row is not enabled (operator hasn't opted in).",
      );
    }
    return;
  }
  if (!publicApiUrl) {
    log.warn(
      "GitHub single-tenant handler not registered — ATLAS_PUBLIC_API_URL is unset, so the redirect URI cannot be resolved.",
    );
    return;
  }

  registerOAuthHandler(
    GITHUB_SINGLE_TENANT_SLUG,
    new GitHubSingleTenantOAuthInstallHandler({
      appId,
      appSlug,
      installationId,
      redirectUri: `${publicApiUrl}/api/v1/integrations/github-single-tenant/callback`,
    }),
  );
  log.info(
    { publicApiUrl, appSlug },
    "Registered GitHubSingleTenantOAuthInstallHandler (no lazy builder yet — agent tool ships in follow-up)",
  );
}

/**
 * Read the resolved catalog (loaded at boot via `loadConfig`) and check
 * whether a given slug is enabled. Used to escalate the env-unset log
 * severity when the operator's intent is "telegram should work" but
 * the env wiring is missing.
 *
 * Returns `false` when the config hasn't loaded yet — that's the
 * pre-boot path where the handler-register file is imported during
 * test setup; the catalog isn't authoritative then.
 */
function isCatalogSlugEnabled(slug: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require("@atlas/api/lib/config") as {
      getConfig: () => { catalog?: ReadonlyArray<{ slug: string; enabled: boolean }> } | null;
    };
    const config = getConfig();
    if (!config?.catalog) return false;
    return config.catalog.some((e) => e.slug === slug && e.enabled === true);
  } catch {
    return false;
  }
}

/**
 * Log-safe fingerprint of a bot token — last 4 chars only. Bot tokens
 * have the form `<bot_id>:<35-char-secret>`. We never log the full
 * value (it's an operator-scoped credential) but a 4-char tail lets
 * ops correlate boot lines with the right env entry.
 */
function fingerprintToken(token: string): string {
  return token.length <= 4 ? "****" : `…${token.slice(-4)}`;
}

/** @internal Test-only — resets the idempotency latch. */
export function _resetRegistrationLatch(): void {
  alreadyRegistered = false;
}
