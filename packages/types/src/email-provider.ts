/** Supported email provider keys for transactional email integrations. */
export const EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "smtp", "ses"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];
