/**
 * Admin platform email provider configuration routes.
 *
 * Mounted under /api/v1/admin/email-provider. All routes require platform_admin role.
 * Manages the platform-level email provider used as the default for all email
 * delivery (onboarding, scheduled tasks, invitations, agent actions).
 *
 * Workspace-level BYOT email config is managed separately via /admin/integrations/email.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { getSetting, setSetting, deleteSetting, getSettingsForAdmin } from "@atlas/api/lib/settings";
import { sendEmail, sendEmailWithTransport } from "@atlas/api/lib/email/delivery";
import { EMAIL_PROVIDERS, type EmailProvider } from "@atlas/api/lib/integrations/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmailProvider(s: string): s is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(s);
}

/** Map provider to its corresponding API key setting key. */
function providerKeySettingKey(provider: string): string | null {
  switch (provider) {
    case "resend": return "RESEND_API_KEY";
    case "sendgrid": return "SENDGRID_API_KEY";
    case "postmark": return "POSTMARK_SERVER_TOKEN";
    default: return null;
  }
}

/** Mask a secret value for display. */
function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** Determine the source of a setting value using the authoritative settings resolution. */
function resolveSource(key: string): "override" | "env" | "default" {
  const allSettings = getSettingsForAdmin(undefined, true);
  const setting = allSettings.find((s) => s.key === key);
  if (!setting) return "default";
  if (setting.source === "override") return "override";
  if (setting.source === "env") return "env";
  return "default";
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EmailProviderConfigSchema = z.object({
  provider: z.enum(EMAIL_PROVIDERS),
  fromAddress: z.string(),
  apiKeyMasked: z.string().nullable(),
  source: z.enum(["override", "env", "default"]),
});

const SetEmailProviderBodySchema = z.object({
  provider: z.enum(EMAIL_PROVIDERS).openapi({
    description: "Email provider to use for platform email delivery.",
    example: "resend",
  }),
  apiKey: z.string().min(1).optional().openapi({
    description: "Provider API key. Omit to keep existing key on update.",
  }),
  fromAddress: z.string().optional().openapi({
    description: "Sender address for platform emails.",
    example: "Atlas <noreply@useatlas.dev>",
  }),
});

const TestEmailProviderBodySchema = z.object({
  provider: z.enum(EMAIL_PROVIDERS),
  apiKey: z.string().min(1).optional().openapi({
    description: "Provider API key to test. Omit to test the currently saved key.",
  }),
  fromAddress: z.string().min(1),
  recipientEmail: z.string().email(),
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
  summary: "Get platform email provider configuration",
  description:
    "Returns the platform's email provider configuration. Shows source: override (DB), env, or default.",
  responses: {
    200: { description: "Platform email provider configuration", content: { "application/json": { schema: z.object({ config: EmailProviderConfigSchema }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const setConfigRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Email Provider"],
  summary: "Set platform email provider configuration",
  description:
    "Configures the platform-level email provider. Stores as a settings override in the internal database.",
  request: { body: { required: true, content: { "application/json": { schema: SetEmailProviderBodySchema } } } },
  responses: {
    200: { description: "Email provider configuration saved", content: { "application/json": { schema: z.object({ config: EmailProviderConfigSchema }) } } },
    400: { description: "Invalid configuration", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Admin — Email Provider"],
  summary: "Reset platform email provider to defaults",
  description:
    "Removes DB overrides for email provider settings. Falls back to environment variables, then defaults.",
  responses: {
    200: { description: "Configuration reset to defaults", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testConfigRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Admin — Email Provider"],
  summary: "Test email provider configuration",
  description:
    "Sends a test email using the provided credentials. Does not save the configuration.",
  request: { body: { required: true, content: { "application/json": { schema: TestEmailProviderBodySchema } } } },
  responses: {
    200: { description: "Test result", content: { "application/json": { schema: TestResultSchema } } },
    400: { description: "Invalid configuration", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminEmailProvider = createPlatformRouter();

// GET / — get platform email provider configuration
adminEmailProvider.openapi(getConfigRoute, async (c) => {
  return runEffect(c, Effect.sync(() => {
    const raw = getSetting("ATLAS_EMAIL_PROVIDER") ?? "resend";
    const provider: EmailProvider = isEmailProvider(raw) ? raw : "resend";
    const fromAddress = getSetting("ATLAS_EMAIL_FROM") ?? "Atlas <noreply@useatlas.dev>";
    const keySetting = providerKeySettingKey(provider);
    const apiKey = keySetting ? getSetting(keySetting) : undefined;

    return c.json({
      config: {
        provider,
        fromAddress,
        apiKeyMasked: maskSecret(apiKey) ?? null,
        source: resolveSource("ATLAS_EMAIL_PROVIDER"),
      },
    }, 200);
  }), { label: "get platform email config" });
});

// PUT / — set platform email provider configuration
adminEmailProvider.openapi(setConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
    }

    const body = c.req.valid("json");

    // Validate that API-key providers have a key (either new or existing)
    const keySetting = providerKeySettingKey(body.provider);
    if (keySetting && !body.apiKey) {
      const existing = getSetting(keySetting);
      if (!existing) {
        return c.json({ error: "validation", message: `API key is required for ${body.provider} when no existing key is configured.`, requestId }, 400);
      }
    }

    // SMTP/SES require the webhook bridge
    if ((body.provider === "smtp" || body.provider === "ses") && !process.env.ATLAS_SMTP_URL) {
      return c.json({
        error: "validation",
        message: `${body.provider.toUpperCase()} provider requires ATLAS_SMTP_URL to be configured as an HTTP bridge.`,
        requestId,
      }, 400);
    }

    // Save settings
    yield* Effect.promise(() => setSetting("ATLAS_EMAIL_PROVIDER", body.provider));
    if (body.apiKey && keySetting) {
      yield* Effect.promise(() => setSetting(keySetting, body.apiKey!));
    }
    if (body.fromAddress) {
      yield* Effect.promise(() => setSetting("ATLAS_EMAIL_FROM", body.fromAddress!));
    }

    // Read back for response
    const rawProvider = getSetting("ATLAS_EMAIL_PROVIDER") ?? "resend";
    const savedProvider: EmailProvider = isEmailProvider(rawProvider) ? rawProvider : "resend";
    const fromAddress = getSetting("ATLAS_EMAIL_FROM") ?? "Atlas <noreply@useatlas.dev>";
    const apiKey = keySetting ? getSetting(keySetting) : undefined;

    return c.json({
      config: {
        provider: savedProvider,
        fromAddress,
        apiKeyMasked: maskSecret(apiKey) ?? null,
        source: "override" as const,
      },
    }, 200);
  }), { label: "set platform email config" });
});

// DELETE / — reset platform email provider to defaults
adminEmailProvider.openapi(deleteConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
    }

    // Delete all email-related setting overrides.
    // deleteSetting() does not throw when no override exists (DELETE matching 0 rows is not an error).
    const keys = ["ATLAS_EMAIL_PROVIDER", "RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_SERVER_TOKEN", "ATLAS_EMAIL_FROM"];
    yield* Effect.forEach(keys, (key) => Effect.promise(() => deleteSetting(key)));

    return c.json({ message: "Email provider configuration reset to defaults." }, 200);
  }), { label: "delete platform email config" });
});

// POST /test — test email provider configuration
adminEmailProvider.openapi(testConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    yield* RequestContext;
    const body = c.req.valid("json");

    const testMessage = {
      to: body.recipientEmail,
      subject: "Atlas Email Provider Test",
      html: "<p>This is a test email from Atlas to verify your email provider configuration.</p><p>If you received this email, your configuration is working correctly.</p>",
    };

    // Use provided credentials when available; fall back to saved/live config
    const testApiKey = body.apiKey;
    let result;
    if (testApiKey) {
      // Build transport from provided credentials — tests before save
      const config: Record<string, unknown> = {};
      if (body.provider === "resend" || body.provider === "sendgrid") config.apiKey = testApiKey;
      if (body.provider === "postmark") config.serverToken = testApiKey;

      result = yield* Effect.tryPromise({
        try: () => sendEmailWithTransport(testMessage, {
          provider: body.provider,
          senderAddress: body.fromAddress,
          config,
        }),
        catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
      });
    } else {
      // No new credentials — test the saved platform config
      result = yield* Effect.tryPromise({
        try: () => sendEmail(testMessage),
        catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
      });
    }

    if (result.success) {
      return c.json({ success: true, message: `Test email sent successfully via ${result.provider}.` }, 200);
    }

    return c.json({
      success: false,
      message: result.error ?? `Email delivery failed via ${result.provider}.`,
    }, 200);
  }), { label: "test email config" });
});

export { adminEmailProvider };
