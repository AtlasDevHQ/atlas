/**
 * Email provider enum — kept colocated with the form helper. Mirrors the
 * tuple in `packages/api/src/lib/integrations/types.ts`; when the types
 * package next publishes with an `email-provider` subpath (see #1543), both
 * copies should move to `@useatlas/types/email-provider` and this local
 * declaration can be deleted.
 */
export const EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "smtp", "ses"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/**
 * Form state for the email-provider editor. A flat bag is intentional — it
 * preserves typed-but-unsaved credentials when the admin switches providers
 * (e.g. paste Resend key → switch to SMTP → switch back — key still there).
 * A discriminated union would either erase that UX affordance or require a
 * map-of-per-provider-bags that doubles the state surface.
 */
export interface ProviderFieldValues {
  resendApiKey: string;
  sendgridApiKey: string;
  postmarkServerToken: string;
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpTls: boolean;
  sesRegion: string;
  sesAccessKeyId: string;
  sesSecretAccessKey: string;
}

export const INITIAL_FIELD_VALUES: ProviderFieldValues = {
  resendApiKey: "",
  sendgridApiKey: "",
  postmarkServerToken: "",
  smtpHost: "",
  smtpPort: "587",
  smtpUsername: "",
  smtpPassword: "",
  smtpTls: true,
  sesRegion: "us-east-1",
  sesAccessKeyId: "",
  sesSecretAccessKey: "",
};

export type BuildResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Assemble the provider-specific `config` payload from the form values.
 * Returns a failure result with a human-readable error when required fields
 * are missing or the SMTP port is out of range. Pure function — safe to
 * unit-test without React/DOM.
 */
export function buildProviderConfig(
  provider: EmailProvider,
  values: ProviderFieldValues,
): BuildResult {
  switch (provider) {
    case "resend":
      if (!values.resendApiKey.trim()) return { ok: false, error: "API key is required." };
      return { ok: true, config: { apiKey: values.resendApiKey.trim() } };
    case "sendgrid":
      if (!values.sendgridApiKey.trim()) return { ok: false, error: "API key is required." };
      return { ok: true, config: { apiKey: values.sendgridApiKey.trim() } };
    case "postmark":
      if (!values.postmarkServerToken.trim()) return { ok: false, error: "Server token is required." };
      return { ok: true, config: { serverToken: values.postmarkServerToken.trim() } };
    case "smtp": {
      const port = Number(values.smtpPort);
      if (!values.smtpHost.trim()) return { ok: false, error: "Host is required." };
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: "Port must be 1–65535." };
      }
      if (!values.smtpUsername.trim()) return { ok: false, error: "Username is required." };
      if (!values.smtpPassword.trim()) return { ok: false, error: "Password is required." };
      return {
        ok: true,
        config: {
          host: values.smtpHost.trim(),
          port,
          username: values.smtpUsername.trim(),
          password: values.smtpPassword.trim(),
          tls: values.smtpTls,
        },
      };
    }
    case "ses":
      if (!values.sesRegion.trim()) return { ok: false, error: "Region is required." };
      if (!values.sesAccessKeyId.trim()) return { ok: false, error: "Access key ID is required." };
      if (!values.sesSecretAccessKey.trim()) return { ok: false, error: "Secret access key is required." };
      return {
        ok: true,
        config: {
          region: values.sesRegion.trim(),
          accessKeyId: values.sesAccessKeyId.trim(),
          secretAccessKey: values.sesSecretAccessKey.trim(),
        },
      };
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unhandled email provider: ${_exhaustive as string}`);
    }
  }
}

/**
 * True when the user has typed into at least one of the fields that belong to
 * the currently-selected provider. Used to distinguish "test my fresh creds"
 * from "test the saved override" — without this check a half-filled form
 * would silently fall through to the saved-config test path and mislead the
 * admin about what was actually verified.
 *
 * Fields with pre-populated defaults (smtpPort="587", smtpTls=true,
 * sesRegion="us-east-1") DO count as "typed" when the user changes them —
 * a port or TLS edit is a credential edit, just like typing a host, and
 * should push the flow toward "test these fresh values" instead of silently
 * testing the saved config. Compare against INITIAL_FIELD_VALUES defaults.
 */
export function hasAnyProviderFieldFilled(
  provider: EmailProvider,
  values: ProviderFieldValues,
): boolean {
  switch (provider) {
    case "resend": return values.resendApiKey.trim().length > 0;
    case "sendgrid": return values.sendgridApiKey.trim().length > 0;
    case "postmark": return values.postmarkServerToken.trim().length > 0;
    case "smtp":
      return (
        values.smtpHost.trim().length > 0 ||
        values.smtpUsername.trim().length > 0 ||
        values.smtpPassword.trim().length > 0 ||
        values.smtpPort.trim() !== INITIAL_FIELD_VALUES.smtpPort ||
        values.smtpTls !== INITIAL_FIELD_VALUES.smtpTls
      );
    case "ses":
      return (
        values.sesAccessKeyId.trim().length > 0 ||
        values.sesSecretAccessKey.trim().length > 0 ||
        values.sesRegion.trim() !== INITIAL_FIELD_VALUES.sesRegion
      );
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unhandled email provider: ${_exhaustive as string}`);
    }
  }
}
