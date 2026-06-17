/**
 * Registry of operator-tier integration platforms whose app credentials
 * are settable + rotatable from the Admin console (#3704).
 *
 * This is the REUSABLE SEAM. Adding a platform to the operator-credential
 * Admin surface is a one-entry addition here (plus a row in the Admin UI's
 * platform list). The resolver, boot guard, and Admin route all iterate this
 * registry — they have no per-platform branches.
 *
 * Pilot scope (#3704): Slack only. The remaining platforms (Discord, Teams,
 * Telegram, WhatsApp, Google Chat, and the action targets Jira / Linear /
 * GitHub App / Salesforce) follow incrementally, one entry per platform.
 * The migration checklist lives in
 * `docs/development/saas-env-audit.md` (operator-credentials section).
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
    },
  ],
};

/** Every operator platform managed by the Admin credential surface. */
export const OPERATOR_PLATFORMS: readonly OperatorPlatformSpec[] = [SLACK_PLATFORM];

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
