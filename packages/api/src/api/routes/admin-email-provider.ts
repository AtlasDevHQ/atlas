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
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Baseline — the SaaS default shown as read-only on the page.
// ---------------------------------------------------------------------------

const BASELINE_PROVIDER: EmailProvider = "resend";
const BASELINE_FROM_ADDRESS = "Atlas <noreply@useatlas.dev>";

/** Provider-specific secret config shapes. */
const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean(),
});

const SendGridConfigSchema = z.object({
  apiKey: z.string().min(1),
});

const PostmarkConfigSchema = z.object({
  serverToken: z.string().min(1),
});

const SesConfigSchema = z.object({
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

const ResendConfigSchema = z.object({
  apiKey: z.string().min(1),
});

/** Mask a secret value for display. */
function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * Build the non-secret detail list for a stored installation. Secrets are
 * masked; non-secret hints (SMTP host, SES region, etc.) pass through so
 * the UI can show the admin what they configured.
 */
function describeOverride(
  provider: EmailProvider,
  config: ProviderConfig,
): { secretLabel: string; secretMasked: string | null; hints: Record<string, string> } {
  switch (provider) {
    case "resend":
    case "sendgrid": {
      const apiKey = (config as { apiKey: string }).apiKey;
      return { secretLabel: "API key", secretMasked: apiKey ? maskSecret(apiKey) : null, hints: {} };
    }
    case "postmark": {
      const token = (config as { serverToken: string }).serverToken;
      return { secretLabel: "Server token", secretMasked: token ? maskSecret(token) : null, hints: {} };
    }
    case "smtp": {
      const c = config as { host: string; port: number; username: string; password: string; tls: boolean };
      return {
        secretLabel: "Password",
        secretMasked: c.password ? maskSecret(c.password) : null,
        hints: {
          Host: c.host,
          Port: String(c.port),
          Username: c.username,
          TLS: c.tls ? "enabled" : "disabled",
        },
      };
    }
    case "ses": {
      const c = config as { region: string; accessKeyId: string; secretAccessKey: string };
      return {
        secretLabel: "Secret access key",
        secretMasked: c.secretAccessKey ? maskSecret(c.secretAccessKey) : null,
        hints: {
          Region: c.region,
          "Access key ID": c.accessKeyId,
        },
      };
    }
  }
}

function validateProviderConfig(
  provider: EmailProvider,
  config: unknown,
): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  const schema = {
    resend: ResendConfigSchema,
    sendgrid: SendGridConfigSchema,
    postmark: PostmarkConfigSchema,
    smtp: SmtpConfigSchema,
    ses: SesConfigSchema,
  }[provider];
  const result = schema.safeParse(config);
  if (!result.success) {
    return { ok: false, error: `Invalid ${provider} config: ${result.error.issues.map((i) => i.message).join(", ")}` };
  }
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
          const { secretLabel, secretMasked, hints } = describeOverride(install.provider, install.config);
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

    yield* Effect.tryPromise({
      try: () => saveEmailInstallation(orgId, {
        provider: body.provider,
        senderAddress: body.fromAddress.trim(),
        config: validated.config,
      }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const saved = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const override = saved
      ? (() => {
          const { secretLabel, secretMasked, hints } = describeOverride(saved.provider, saved.config);
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

    yield* Effect.tryPromise({
      try: () => deleteEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
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

    // 1. Supplied provider + config: test as-is without persisting.
    // 2. No supplied config: test the saved override (or fall through to platform default).
    if (body.provider && body.config) {
      const validated = validateProviderConfig(body.provider, body.config);
      if (!validated.ok) {
        return c.json({ error: "validation", message: validated.error, requestId }, 400);
      }
      const fromAddress = body.fromAddress?.trim() || BASELINE_FROM_ADDRESS;
      const result = yield* Effect.tryPromise({
        try: () => sendEmailWithTransport(testMessage, {
          provider: body.provider!,
          senderAddress: fromAddress,
          config: validated.config as unknown as Record<string, unknown>,
        }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      });
      return c.json(
        result.success
          ? { success: true, message: `Test email sent successfully via ${result.provider}.` }
          : { success: false, message: result.error ?? `Email delivery failed via ${result.provider}.` },
        200,
      );
    }

    const result = yield* Effect.tryPromise({
      try: () => sendEmail(testMessage, orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
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
