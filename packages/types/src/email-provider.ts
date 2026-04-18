/**
 * Shared wire types for email provider configuration.
 *
 * The enum is intentionally a tuple (not `string[]`) so it can feed zod's
 * `z.enum(...)` on both the API and web sides without duplication.
 */

export const EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "smtp", "ses"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];
