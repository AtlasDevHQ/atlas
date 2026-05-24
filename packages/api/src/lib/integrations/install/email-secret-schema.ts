/**
 * Shared SMTP form schema + secret-field map for the Email integration.
 *
 * Both the form install handler ({@link EmailFormInstallHandler}) and
 * the agent-loop lazy builder ({@link createEmailLazyBuilder}) need to
 * know:
 *
 *   1. The Zod shape of the install form (host, port, username, …) so
 *      stored configs can be re-validated on read without re-deriving
 *      the schema in two places.
 *   2. Which fields in `workspace_plugins.config` are `secret: true` so
 *      the write path encrypts and the read path decrypts the same
 *      set.
 *
 * Centralizing here means a future field rename or a new secret (e.g.
 * an OAuth refresh token alongside the SMTP password) lands in one
 * place and both sides stay in lockstep. Duplicating the `secret: true`
 * flag set in two modules is the F-42 audit's exact failure mode — a
 * write that encrypts more than the read decrypts (or vice versa)
 * corrupts the stored value silently.
 *
 * The catalog id is exported here too so the install handler, lazy
 * builder, and tool layer all share one source of truth.
 * `catalog:email` mirrors the seeder's `catalog:${slug}` convention.
 */

import { z } from "zod";
import type { ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";

/** Stable `plugin_catalog.id` for Email. */
export const EMAIL_CATALOG_ID = "catalog:email";

/**
 * Sender-address regex. SMTP `from` values commonly carry a
 * display-name (`"Atlas <reports@example.com>"`) that bare `.email()`
 * would reject. The regex accepts both bare-email and display-name
 * forms; the actual delivery is nodemailer's responsibility.
 */
const SMTP_FROM_RE =
  /^(?:[^<>]*<\s*[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>|[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+)$/;

/** Defensive upper bound on the password field — JSONB rows shouldn't carry 50MB strings. */
const SMTP_PASSWORD_MAX = 4096;

export const EmailFormDataSchema = z.object({
  host: z.string().min(1, "host is required").max(253),
  port: z.coerce.number().int().min(1).max(65_535),
  username: z.string().min(1, "username is required").max(320),
  password: z
    .string()
    .min(1, "password is required")
    .max(SMTP_PASSWORD_MAX, `password must be ${SMTP_PASSWORD_MAX} characters or fewer`),
  fromAddress: z
    .string()
    .min(3, "fromAddress is required")
    .regex(SMTP_FROM_RE, "fromAddress must be a valid email or display-name form"),
  /**
   * STARTTLS / TLS toggle. Defaults to `true` — the safe choice for
   * any public SMTP relay. Internal-only relays can opt out by
   * submitting `secure: false`; that path is logged at warn so a
   * mis-click is at least observable post-hoc.
   */
  secure: z.boolean().optional().default(true),
}).strict();

export type EmailFormData = z.infer<typeof EmailFormDataSchema>;

/**
 * `encryptSecretFields` / `decryptSecretFields` schema for the Email
 * handler. The `fields[].key` element is constrained to
 * `keyof EmailFormData` so a Zod rename without a matching update here
 * surfaces as a TS error rather than a silent encryption regression at
 * runtime.
 */
export const EMAIL_SECRET_FIELDS_SCHEMA: ConfigSchema & {
  state: "parsed";
  fields: ReadonlyArray<ConfigSchemaField & { key: keyof EmailFormData }>;
} = {
  state: "parsed",
  fields: [
    { key: "host", type: "string" },
    { key: "port", type: "number" },
    { key: "username", type: "string" },
    { key: "password", type: "string", secret: true },
    { key: "fromAddress", type: "string" },
    { key: "secure", type: "boolean" },
  ],
};
