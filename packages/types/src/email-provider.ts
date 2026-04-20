/**
 * Email provider types shared across API, frontend, and SDK.
 *
 * `ProviderConfig` is a discriminated union keyed on `provider`. Before
 * #1542 it was a structural union (`SmtpConfig | SendGridConfig | ...`)
 * with `provider` carried on a sibling column — TypeScript could not
 * narrow the config from the provider string, forcing `as` casts at every
 * read site. Embedding the tag closes that gap: handlers `switch` on
 * `config.provider` and the compiler narrows.
 *
 * JSONB rows in `email_installations.config` do not store the `provider`
 * field today — the parser in `lib/email/store.ts` injects it at read
 * time from the sibling `provider` column, which is the authoritative
 * source.
 */

/** Supported email provider keys for transactional email integrations. */
export const EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "smtp", "ses"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Provider-specific config shapes — each carries the `provider` discriminator
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  provider: "smtp";
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
}

export interface SendGridConfig {
  provider: "sendgrid";
  apiKey: string;
}

export interface PostmarkConfig {
  provider: "postmark";
  serverToken: string;
}

export interface SesConfig {
  provider: "ses";
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ResendConfig {
  provider: "resend";
  apiKey: string;
}

/** Discriminated union of provider-specific credential shapes. */
export type ProviderConfig =
  | SmtpConfig
  | SendGridConfig
  | PostmarkConfig
  | SesConfig
  | ResendConfig;
