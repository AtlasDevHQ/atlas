/**
 * Registry of operator-tier integration platforms whose app credentials
 * are settable + rotatable from the Admin console (#3704).
 *
 * This is the REUSABLE SEAM. Adding a platform to the operator-credential
 * Admin surface is a one-entry addition here (plus a row in the Admin UI's
 * platform list). The resolver, boot guard, and Admin route all iterate this
 * registry — they have no per-platform branches.
 *
 * Pilot scope (#3704): Slack. The remaining chat platforms (Discord #3767,
 * Teams #3768, Telegram #3769, WhatsApp #3770, Google Chat #3771 — children of
 * umbrella #3765) followed as one-entry additions. The action targets (Jira /
 * Linear / GitHub App / Salesforce) need a per-workspace credential design
 * pass first (#3765) and are not in this registry yet. The migration checklist
 * lives in `docs/development/saas-env-audit.md` (operator-credentials section).
 *
 * Each field maps to an EXISTING operator env var so env stays the
 * self-host fallback unchanged — the field's `envVar` is both the storage
 * key in the encrypted bundle AND the `process.env` key the chat adapter
 * builders read. The resolver overlays the decrypted bundle onto env with
 * DB-wins precedence; an unset field falls through to env.
 */

/** One settable field of an operator platform's app credentials. */
export interface OperatorCredentialField {
  /** The env var this field maps to (storage key + adapter-builder env key). */
  readonly envVar: string;
  /** Human label for the Admin form. */
  readonly label: string;
  /** Short helper text shown under the field in the Admin UI. */
  readonly hint: string;
  /**
   * Whether the value is a secret (masked in the Admin UI + never echoed
   * back on read). Client IDs are not secret; client/signing/encryption
   * secrets are. Non-secret fields are still never logged verbatim.
   */
  readonly secret: boolean;
  /**
   * Whether the field is required for the adapter to build. Mirrors the
   * chat adapter builder's `requiredEnv` set — the boot guard treats a
   * platform as "configured" only when every required field resolves.
   */
  readonly required: boolean;
  /**
   * Whether ROTATING this field is destructive — i.e. changing it
   * invalidates data already encrypted/derived with the old value, forcing
   * downstream re-authorization. Surfaced to the Admin UI so it can warn
   * before a write (e.g. Slack's `SLACK_ENCRYPTION_KEY` encrypts stored bot
   * tokens; rotating it makes every workspace re-authorize). Generic so a
   * future platform's destructive key lights up the same warning with no
   * UI change. Absent ⇒ non-destructive rotation.
   */
  readonly destructiveRotation?: boolean;
}

/** An operator-tier platform managed by the Admin credential surface. */
export interface OperatorPlatformSpec {
  /** Operator-tier platform slug — the `platform` key in the credential table. */
  readonly platform: string;
  /** Human label for the Admin UI. */
  readonly label: string;
  /**
   * The chat-catalog slug this platform's adapter is keyed by, when it is a
   * chat platform (used by the boot guard to match catalog entries). `null`
   * for non-chat action targets (none in the pilot).
   */
  readonly catalogSlug: string | null;
  /** Settable credential fields, in display order. */
  readonly fields: readonly OperatorCredentialField[];
}

/**
 * Slack — the pilot operator platform. The four fields must mirror the
 * `SLACK_BUILDER.requiredEnv` set from `@useatlas/chat`'s adapter registry,
 * so a fully-populated row lets the Slack adapter build with zero Slack env
 * vars set on the region. The set is hand-copied across the package boundary;
 * the parity is pinned by a drift test (`__tests__/platforms.test.ts`) against
 * `getChatAdapterRequiredEnv("slack")` so an adapter-side change can't drift
 * this silently.
 *
 * ⚠ `SLACK_ENCRYPTION_KEY` rotation is destructive: it is the AES-GCM key
 * the `@chat-adapter/slack` adapter uses to encrypt bot tokens stored in
 * `chat_cache`. Rotating it makes previously-stored bot tokens undecryptable,
 * so every installed workspace must re-authorize Slack. The Admin UI warns
 * on change. The OAuth app credentials (`CLIENT_ID` / `CLIENT_SECRET` /
 * `SIGNING_SECRET`) rotate non-destructively — `SIGNING_SECRET` rotation is
 * the canonical "roll a secret without a redeploy" case this feature targets.
 */
const SLACK_PLATFORM: OperatorPlatformSpec = {
  platform: "slack",
  label: "Slack",
  catalogSlug: "slack",
  fields: [
    {
      envVar: "SLACK_CLIENT_ID",
      label: "Client ID",
      hint: "Slack app OAuth client ID (Basic Information → App Credentials).",
      secret: false,
      required: true,
    },
    {
      envVar: "SLACK_CLIENT_SECRET",
      label: "Client Secret",
      hint: "Slack app OAuth client secret. Used for the install token exchange.",
      secret: true,
      required: true,
    },
    {
      envVar: "SLACK_SIGNING_SECRET",
      label: "Signing Secret",
      hint: "Verifies inbound webhook signatures. Roll this here to rotate without a redeploy.",
      secret: true,
      required: true,
    },
    {
      envVar: "SLACK_ENCRYPTION_KEY",
      label: "Encryption Key",
      hint: "AES-256-GCM key for stored bot tokens. ⚠ Rotating it forces every workspace to re-authorize Slack.",
      secret: true,
      required: true,
      destructiveRotation: true,
    },
  ],
};

/**
 * Discord (#3767). The three required fields mirror `DISCORD_BUILDER.requiredEnv`
 * from `@useatlas/chat`. `DISCORD_CLIENT_ID` is the application id (public, also
 * used by the install flow to build the bot-install URL) and `DISCORD_PUBLIC_KEY`
 * is the Ed25519 *public* verification key — neither is a secret. The bot token
 * authenticates outbound API calls and is the only secret here. No field's
 * rotation invalidates stored data (the static-bot adapter stores no
 * per-platform-key-encrypted token), so none is a destructive rotation.
 */
const DISCORD_PLATFORM: OperatorPlatformSpec = {
  platform: "discord",
  label: "Discord",
  catalogSlug: "discord",
  fields: [
    {
      envVar: "DISCORD_BOT_TOKEN",
      label: "Bot Token",
      hint: "Discord bot token (Developer Portal → Bot). Authenticates outbound API calls.",
      secret: true,
      required: true,
    },
    {
      envVar: "DISCORD_CLIENT_ID",
      label: "Client ID",
      hint: "Discord application (client) ID. Used to build the bot-install URL.",
      secret: false,
      required: true,
    },
    {
      envVar: "DISCORD_PUBLIC_KEY",
      label: "Public Key",
      hint: "Ed25519 public key (Developer Portal → General Information). Verifies inbound webhook signatures.",
      secret: false,
      required: true,
    },
  ],
};

/**
 * Microsoft Teams (#3768). The two required fields mirror
 * `TEAMS_BUILDER.requiredEnv` from `@useatlas/chat` — one Microsoft Entra ID app
 * registration. `TEAMS_APP_ID` is the app (client) id (public); `TEAMS_APP_PASSWORD`
 * is the client secret. `TEAMS_TENANT_ID` is intentionally omitted: the adapter
 * runs MultiTenant by default and the tenant id is only set for single-tenant
 * Azure Bots, so it isn't required and isn't an operator-credential field here.
 */
const TEAMS_PLATFORM: OperatorPlatformSpec = {
  platform: "teams",
  label: "Microsoft Teams",
  catalogSlug: "teams",
  fields: [
    {
      envVar: "TEAMS_APP_ID",
      label: "App ID",
      hint: "Microsoft Entra ID app (client) ID for the Azure Bot.",
      secret: false,
      required: true,
    },
    {
      envVar: "TEAMS_APP_PASSWORD",
      label: "App Password",
      hint: "Entra ID client secret. Authenticates the Bot Framework connector.",
      secret: true,
      required: true,
    },
  ],
};

/**
 * Telegram (#3769). The two required fields mirror `TELEGRAM_BUILDER.requiredEnv`
 * from `@useatlas/chat`. Both are secret: the bot token authenticates outbound
 * Bot API calls, and the webhook secret is the shared token Telegram echoes back
 * in the `x-telegram-bot-api-secret-token` header — the only thing standing
 * between the public webhook URL and a forged update (mandatory since #3154).
 * Rotating the webhook secret requires re-running `setWebhook` on Telegram's side
 * but invalidates no stored data, so it is not a destructive rotation.
 */
const TELEGRAM_PLATFORM: OperatorPlatformSpec = {
  platform: "telegram",
  label: "Telegram",
  catalogSlug: "telegram",
  fields: [
    {
      envVar: "TELEGRAM_BOT_TOKEN",
      label: "Bot Token",
      hint: "Telegram bot token from @BotFather. Authenticates outbound Bot API calls.",
      secret: true,
      required: true,
    },
    {
      envVar: "TELEGRAM_WEBHOOK_SECRET",
      label: "Webhook Secret",
      hint: "Shared secret Telegram echoes in the x-telegram-bot-api-secret-token header. Verifies inbound updates.",
      secret: true,
      required: true,
    },
  ],
};

/**
 * WhatsApp (#3770). The four required fields mirror `WHATSAPP_BUILDER.requiredEnv`
 * from `@useatlas/chat` (Meta Cloud API). `META_BUSINESS_APP_ID` is the Meta App
 * ID (public); the access token, app secret (HMAC-SHA256 webhook verification),
 * and verify token (echoed in the GET challenge handshake) are all secrets.
 * `META_BUSINESS_APP_ID` is in `requiredEnv` as an Atlas-side boot-consistency
 * gate, not because `@chat-adapter/whatsapp` consumes it at activation time. No
 * field's rotation invalidates stored data, so none is a destructive rotation.
 */
const WHATSAPP_PLATFORM: OperatorPlatformSpec = {
  platform: "whatsapp",
  label: "WhatsApp",
  catalogSlug: "whatsapp",
  fields: [
    {
      envVar: "META_BUSINESS_ACCESS_TOKEN",
      label: "System User Access Token",
      hint: "Meta System User access token for Cloud API calls (whatsapp_business_management + _messaging scopes).",
      secret: true,
      required: true,
    },
    {
      envVar: "META_BUSINESS_APP_ID",
      label: "Meta App ID",
      hint: "Meta App ID (App Dashboard → Settings → Basic).",
      secret: false,
      required: true,
    },
    {
      envVar: "WHATSAPP_APP_SECRET",
      label: "App Secret",
      hint: "Meta App Secret for HMAC-SHA256 webhook signature verification (X-Hub-Signature-256).",
      secret: true,
      required: true,
    },
    {
      envVar: "WHATSAPP_VERIFY_TOKEN",
      label: "Verify Token",
      hint: "Random string pasted into the Meta webhook config; mirrored back in the GET challenge handshake.",
      secret: true,
      required: true,
    },
  ],
};

/**
 * Google Chat (#3771). The two required fields mirror `GCHAT_BUILDER.requiredEnv`
 * from `@useatlas/chat`. `GCHAT_SERVICE_ACCOUNT_JSON` is the raw service-account
 * JSON (it contains the private key) — a secret. `GCHAT_PUBSUB_TOPIC` is the
 * fully-qualified Pub/Sub topic path (`projects/<project>/topics/<topic>`) — not
 * a secret. The optional impersonation / project-number / audience env vars are
 * not required fields and are omitted here (they fall through to env). Rotating
 * the service account invalidates no stored data, so neither is destructive.
 */
const GCHAT_PLATFORM: OperatorPlatformSpec = {
  platform: "gchat",
  label: "Google Chat",
  catalogSlug: "gchat",
  fields: [
    {
      envVar: "GCHAT_SERVICE_ACCOUNT_JSON",
      label: "Service Account JSON",
      hint: "Raw GCP service-account JSON. Used to obtain Pub/Sub access tokens and authenticate outbound Google Chat API calls.",
      secret: true,
      required: true,
    },
    {
      envVar: "GCHAT_PUBSUB_TOPIC",
      label: "Pub/Sub Topic",
      hint: "Fully-qualified topic path the Workspace Events subscription publishes to (projects/<project>/topics/<topic>).",
      secret: false,
      required: true,
    },
  ],
};

/** Every operator platform managed by the Admin credential surface. */
export const OPERATOR_PLATFORMS: readonly OperatorPlatformSpec[] = [
  SLACK_PLATFORM,
  DISCORD_PLATFORM,
  TEAMS_PLATFORM,
  TELEGRAM_PLATFORM,
  WHATSAPP_PLATFORM,
  GCHAT_PLATFORM,
];

/** Look up a managed operator platform by slug. `undefined` if unmanaged. */
export function getOperatorPlatform(platform: string): OperatorPlatformSpec | undefined {
  return OPERATOR_PLATFORMS.find((p) => p.platform === platform);
}

/** Find the managed operator platform whose chat-catalog slug matches, if any. */
export function getOperatorPlatformByCatalogSlug(
  catalogSlug: string,
): OperatorPlatformSpec | undefined {
  return OPERATOR_PLATFORMS.find((p) => p.catalogSlug === catalogSlug);
}
