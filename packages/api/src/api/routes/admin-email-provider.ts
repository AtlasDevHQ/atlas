/**
 * Admin email provider configuration routes.
 *
 * Mounted under /api/v1/admin/email-provider. Org-scoped — each workspace
 * admin configures their own email delivery (BYOT). The Resend baseline is
 * read-only and represents the SaaS default used when no override is set;
 * orgs may bring any of the supported providers for their override.
 *
 * Storage: per-org row in `email_installations` (see lib/email/store).
 * Delivery precedence (lib/email/delivery) is: per-org override →
 * platform settings → ATLAS_SMTP_URL → RESEND_API_KEY → log.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { createLogger } from "@atlas/api/lib/logger";
import {
  getEmailInstallationByOrg,
  saveEmailInstallation,
  deleteEmailInstallationByOrg,
} from "@atlas/api/lib/email/store";
import { sendEmail, sendEmailWithTransport } from "@atlas/api/lib/email/delivery";
import {
  EMAIL_PROVIDERS,
  type EmailProvider,
  type ProviderConfig,
} from "@atlas/api/lib/integrations/types";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-email-provider");

// ---------------------------------------------------------------------------
// Baseline — the SaaS default shown as read-only on the page.
// ---------------------------------------------------------------------------

/**
 * Baseline is deliberately hardcoded to Resend + the atlas.dev sender — it is
 * NOT derived from `ATLAS_EMAIL_PROVIDER` / `ATLAS_EMAIL_FROM` platform
 * settings. The baseline represents "Atlas owns delivery" — the shared SaaS
 * identity rendered as a locked row in the UI so orgs know what falls back
 * when they have no override. The actual runtime fallback resolved by
 * `lib/email/delivery.ts` may differ on self-hosted deployments (platform
 * settings / env vars can change the transport) — this baseline is a brand
 * statement, not a live status readout.
 */
const BASELINE_PROVIDER: EmailProvider = "resend";
const BASELINE_FROM_ADDRESS = "Atlas <noreply@useatlas.dev>";

// Provider-specific secret config shapes. Each carries the `provider`
// discriminator (#1542) — the wire contract now requires it on the
// incoming body so the server can `switch (config.provider)` downstream
// without `as` casts.
const SmtpConfigSchema = z.object({
  provider: z.literal("smtp"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean(),
});

const SendGridConfigSchema = z.object({
  provider: z.literal("sendgrid"),
  apiKey: z.string().min(1),
});

const PostmarkConfigSchema = z.object({
  provider: z.literal("postmark"),
  serverToken: z.string().min(1),
});

const SesConfigSchema = z.object({
  provider: z.literal("ses"),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

const ResendConfigSchema = z.object({
  provider: z.literal("resend"),
  apiKey: z.string().min(1),
});

/**
 * Mask a secret value for display. Exported so tests exercise the real
 * implementation (see __tests__/admin-email-provider.test.ts).
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * Build the non-secret detail list for a stored installation. Secrets are
 * masked; non-secret hints (SMTP host, SES region, etc.) pass through so
 * the UI can show the admin what they configured.
 *
 * Post-#1542 `ProviderConfig` is a discriminated union keyed on
 * `provider` — the `switch` below narrows the config structurally, so
 * the per-case `as` casts are gone.
 */
function describeOverride(
  config: ProviderConfig,
): { secretLabel: string; secretMasked: string | null; hints: Record<string, string> } {
  switch (config.provider) {
    case "resend":
    case "sendgrid":
      return { secretLabel: "API key", secretMasked: config.apiKey ? maskSecret(config.apiKey) : null, hints: {} };
    case "postmark":
      return { secretLabel: "Server token", secretMasked: config.serverToken ? maskSecret(config.serverToken) : null, hints: {} };
    case "smtp":
      // Username and password are both credential material — usernames are
      // often full email addresses or account logins and shouldn't leave
      // the server in the clear (CLAUDE.md "No secrets in responses").
      return {
        secretLabel: "Password",
        secretMasked: config.password ? maskSecret(config.password) : null,
        hints: {
          Host: config.host,
          Port: String(config.port),
          Username: config.username ? maskSecret(config.username) : "",
          TLS: config.tls ? "enabled" : "disabled",
        },
      };
    case "ses":
      // AWS treats access-key-IDs as semi-sensitive — they pair with the
      // secret and leak identity/tenancy. Region is non-sensitive.
      return {
        secretLabel: "Secret access key",
        secretMasked: config.secretAccessKey ? maskSecret(config.secretAccessKey) : null,
        hints: {
          Region: config.region,
          "Access key ID": config.accessKeyId ? maskSecret(config.accessKeyId) : "",
        },
      };
  }
}

/**
 * Validate provider-specific config shape at the HTTP boundary. Post-#1542
 * each schema carries its own `provider` literal, so the body's `provider`
 * and `config.provider` fields must agree; a mismatch is rejected as
 * invalid. Every config stored in `email_installations` flows through
 * here, so reads get a correctly-tagged `ProviderConfig` without further
 * runtime checks.
 */
function validateProviderConfig(
  provider: EmailProvider,
  config: unknown,
): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  // Use a switch rather than a lookup object so TypeScript enforces
  // exhaustiveness on EmailProvider additions.
  let schema;
  switch (provider) {
    case "resend": schema = ResendConfigSchema; break;
    case "sendgrid": schema = SendGridConfigSchema; break;
    case "postmark": schema = PostmarkConfigSchema; break;
    case "smtp": schema = SmtpConfigSchema; break;
    case "ses": schema = SesConfigSchema; break;
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unhandled email provider: ${_exhaustive as string}`);
    }
  }
  const result = schema.safeParse(config);
  if (!result.success) {
    return { ok: false, error: `Invalid ${provider} config: ${result.error.issues.map((i) => i.message).join(", ")}` };
  }
  // `schema` includes a `provider` literal matching the outer `provider`
  // arg, so the parsed result is already a valid `ProviderConfig` variant.
  return { ok: true, config: result.data as ProviderConfig };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProviderEnum = z.enum(EMAIL_PROVIDERS);

const BaselineSchema = z.object({
  provider: z.literal(BASELINE_PROVIDER),
  fromAddress: z.string(),
});

const OverrideSchema = z.object({
  provider: ProviderEnum,
  fromAddress: z.string(),
  secretLabel: z.string(),
  secretMasked: z.string().nullable(),
  hints: z.record(z.string(), z.string()),
  installedAt: z.string(),
});

const EmailProviderConfigSchema = z.object({
  baseline: BaselineSchema,
  override: OverrideSchema.nullable(),
});

const SetEmailProviderBodySchema = z.object({
  provider: ProviderEnum.openapi({ description: "Email provider to use for this workspace." }),
  fromAddress: z.string().min(1).openapi({
    description: "Sender address (From header). Must be verified with the chosen provider.",
    example: "Acme <noreply@acme.com>",
  }),
  config: z
    .union([SmtpConfigSchema, SendGridConfigSchema, PostmarkConfigSchema, SesConfigSchema, ResendConfigSchema])
    .openapi({ description: "Provider-specific configuration (credentials + any non-secret fields)." }),
});

const TestEmailProviderBodySchema = z.object({
  recipientEmail: z.string().email(),
  provider: ProviderEnum.optional(),
  fromAddress: z.string().min(1).optional(),
  config: z
    .union([SmtpConfigSchema, SendGridConfigSchema, PostmarkConfigSchema, SesConfigSchema, ResendConfigSchema])
    .optional()
    .openapi({ description: "Provider-specific config to test. Omit to test the saved override." }),
});

const TestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Email Provider"],
  summary: "Get workspace email provider configuration",
  description:
    "Returns the Resend baseline plus the workspace's BYOT override (if any). Baseline is locked; override supports Resend, SendGrid, Postmark, SMTP, and SES.",
  responses: {
    200: { description: "Email provider configuration", content: { "application/json": { schema: z.object({ config: EmailProviderConfigSchema }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const setConfigRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Email Provider"],
  summary: "Save workspace email provider override",
  description:
    "Stores the workspace's email provider override. Provider-specific config is validated server-side.",
  request: { body: { required: true, content: { "application/json": { schema: SetEmailProviderBodySchema } } } },
  responses: {
    200: { description: "Override saved", content: { "application/json": { schema: z.object({ config: EmailProviderConfigSchema }) } } },
    400: { description: "Invalid configuration", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Admin — Email Provider"],
  summary: "Remove workspace email provider override",
  description:
    "Deletes the workspace's email override. Delivery falls back to the platform default.",
  responses: {
    200: { description: "Override removed", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testConfigRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Admin — Email Provider"],
  summary: "Send a test email",
  description:
    "Sends a test email using the supplied credentials (when given) or the saved override, falling back to the platform default.",
  request: { body: { required: true, content: { "application/json": { schema: TestEmailProviderBodySchema } } } },
  responses: {
    200: { description: "Test result", content: { "application/json": { schema: TestResultSchema } } },
    400: { description: "Invalid configuration", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminEmailProvider = createAdminRouter();
adminEmailProvider.use(requireOrgContext());

// GET / — baseline + optional override
adminEmailProvider.openapi(getConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = c.get("orgContext");

    const install = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const override = install
      ? (() => {
          const { secretLabel, secretMasked, hints } = describeOverride(install.config);
          return {
            provider: install.provider,
            fromAddress: install.sender_address,
            secretLabel,
            secretMasked,
            hints,
            installedAt: install.installed_at,
          };
        })()
      : null;

    return c.json({
      config: {
        baseline: { provider: BASELINE_PROVIDER, fromAddress: BASELINE_FROM_ADDRESS },
        override,
      },
    }, 200);
  }), { label: "get email provider config" });
});

// PUT / — save BYOT override
adminEmailProvider.openapi(setConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId, orgId } = c.get("orgContext");
    const body = c.req.valid("json");

    const validated = validateProviderConfig(body.provider, body.config);
    if (!validated.ok) {
      return c.json({ error: "validation", message: validated.error, requestId }, 400);
    }

    // SMTP/SES require the webhook bridge at delivery time; warn early so admins
    // don't save credentials that can't be used on this deployment.
    if ((body.provider === "smtp" || body.provider === "ses") && !process.env.ATLAS_SMTP_URL) {
      return c.json({
        error: "validation",
        message: `${body.provider.toUpperCase()} delivery requires ATLAS_SMTP_URL to be configured as an HTTP bridge on the server.`,
        requestId,
      }, 400);
    }

    // NEVER log credential material here — the `hasSecret: true` marker is
    // the load-bearing signal; the raw apiKey / password / secretAccessKey
    // must not leak into admin_action_log metadata.
    const fromAddress = body.fromAddress.trim();
    const auditBase = { provider: body.provider, fromAddress, hasSecret: true };
    yield* Effect.tryPromise({
      try: () => saveEmailInstallation(orgId, {
        provider: body.provider,
        senderAddress: fromAddress,
        config: validated.config,
      }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.email_provider.update,
            targetType: "email_provider",
            targetId: orgId,
            status: "failure",
            metadata: { ...auditBase, error: err.message },
          }),
        ),
      ),
    );

    logAdminAction({
      actionType: ADMIN_ACTIONS.email_provider.update,
      targetType: "email_provider",
      targetId: orgId,
      metadata: auditBase,
    });

    const saved = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const override = saved
      ? (() => {
          const { secretLabel, secretMasked, hints } = describeOverride(saved.config);
          return {
            provider: saved.provider,
            fromAddress: saved.sender_address,
            secretLabel,
            secretMasked,
            hints,
            installedAt: saved.installed_at,
          };
        })()
      : null;

    return c.json({
      config: {
        baseline: { provider: BASELINE_PROVIDER, fromAddress: BASELINE_FROM_ADDRESS },
        override,
      },
    }, 200);
  }), { label: "set email provider config" });
});

// DELETE / — remove workspace override
adminEmailProvider.openapi(deleteConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = c.get("orgContext");

    // Capture the prior provider BEFORE the row is gone so the audit trail
    // records which BYOT credential was removed. A pool failure here
    // degrades to `provider: null` in metadata rather than blocking the
    // delete — the deletion itself is still the load-bearing event. The
    // swallow is intentional: we log a breadcrumb so ops can correlate the
    // null-provider audit row to the underlying store error without having
    // to join two unrelated log lines by requestId.
    const prior = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          log.warn(
            { orgId, err: err.message },
            "prior email install lookup failed in delete path — audit will record provider: null",
          );
          return null;
        }),
      ),
    );

    yield* Effect.tryPromise({
      try: () => deleteEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.email_provider.delete,
            targetType: "email_provider",
            targetId: orgId,
            status: "failure",
            metadata: { provider: prior?.provider ?? null, error: err.message },
          }),
        ),
      ),
    );

    logAdminAction({
      actionType: ADMIN_ACTIONS.email_provider.delete,
      targetType: "email_provider",
      targetId: orgId,
      metadata: { provider: prior?.provider ?? null },
    });

    return c.json({ message: "Email provider override removed." }, 200);
  }), { label: "delete email provider config" });
});

// POST /test — send a test email
adminEmailProvider.openapi(testConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId, orgId } = c.get("orgContext");
    const body = c.req.valid("json");

    const testMessage = {
      to: body.recipientEmail,
      subject: "Atlas Email Provider Test",
      html: "<p>This is a test email from Atlas to verify your email provider configuration.</p><p>If you received this email, your configuration is working correctly.</p>",
    };

    // Two valid shapes:
    //   1. provider + config supplied: test those creds without persisting.
    //   2. neither supplied: test the saved override (or fall through to platform default via sendEmail).
    // Any mixed state (provider without config, or config without provider) is
    // ambiguous — reject with 400 so the client can't silently hit the wrong branch.
    const hasProvider = body.provider !== undefined;
    const hasConfig = body.config !== undefined;
    if (hasProvider !== hasConfig) {
      return c.json({
        error: "validation",
        message: "Supply both `provider` and `config` to test fresh credentials, or neither to test the saved override.",
        requestId,
      }, 400);
    }

    // All delivery branches share one audit shape: every probe records the
    // provider that was actually exercised + success/failure + the
    // recipient. The apiKey / password / secretAccessKey in body.config
    // MUST NOT land in the audit row — an attacker with admin would
    // otherwise use this endpoint as a credential oracle.
    //
    // `emitFailureAudit` is shared by both the fresh-creds and saved-creds
    // branches so an unexpected throw from the delivery helper (pool failure,
    // unwrapped provider SDK error) still lands a forensic row before the
    // error bubbles out via `runEffect`.
    const emitFailureAudit = (err: Error, provider: string | null) =>
      Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.email_provider.test,
          targetType: "email_provider",
          targetId: orgId,
          status: "failure",
          metadata: {
            provider,
            success: false,
            recipientEmail: body.recipientEmail,
            error: err.message,
          },
        }),
      );

    let result: { success: boolean; provider: string; error?: string };
    if (hasProvider && hasConfig) {
      const validated = validateProviderConfig(body.provider!, body.config!);
      if (!validated.ok) {
        return c.json({ error: "validation", message: validated.error, requestId }, 400);
      }
      const fromAddress = body.fromAddress?.trim() || BASELINE_FROM_ADDRESS;
      result = yield* Effect.tryPromise({
        try: () => sendEmailWithTransport(testMessage, {
          provider: body.provider!,
          senderAddress: fromAddress,
          config: validated.config,
        }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.tapError((err) => emitFailureAudit(err, body.provider!)));
      if (!result.success) {
        log.warn({ requestId, orgId, provider: result.provider, err: result.error }, "Test email delivery failed (fresh creds)");
      }
    } else {
      result = yield* Effect.tryPromise({
        try: () => sendEmail(testMessage, orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.tapError((err) => emitFailureAudit(err, null)));
      if (!result.success) {
        log.warn({ requestId, orgId, provider: result.provider, err: result.error }, "Test email delivery failed (saved config)");
      }
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.email_provider.test,
      targetType: "email_provider",
      targetId: orgId,
      status: result.success ? "success" : "failure",
      metadata: {
        provider: result.provider,
        success: result.success,
        recipientEmail: body.recipientEmail,
        ...(result.success ? {} : { error: result.error ?? "delivery failed" }),
      },
    });

    return c.json(
      result.success
        ? { success: true, message: `Test email sent successfully via ${result.provider}.` }
        : { success: false, message: result.error ?? `Email delivery failed via ${result.provider}.` },
      200,
    );
  }), { label: "test email config" });
});

export { adminEmailProvider };
