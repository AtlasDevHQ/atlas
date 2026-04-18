/**
 * Admin email provider configuration routes.
 *
 * Mounted under /api/v1/admin/email-provider. Org-scoped — each workspace
 * admin configures their own Resend API key + From address. Orgs cannot
 * choose a different provider; Resend is the SaaS baseline and the only
 * editable layer is BYO credentials.
 *
 * Storage: per-org row in `email_installations` (provider is always "resend").
 * Delivery falls back to platform/env-var config when no override exists.
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
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Baseline — the SaaS default shown as read-only on the page.
// ---------------------------------------------------------------------------

const BASELINE_PROVIDER = "resend" as const;
const BASELINE_FROM_ADDRESS = "Atlas <noreply@useatlas.dev>";

/** Mask a secret value for display. */
function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** Pull the Resend API key out of a stored installation's config blob. */
function extractApiKey(config: unknown): string | null {
  if (config && typeof config === "object" && "apiKey" in config) {
    const apiKey = (config as { apiKey: unknown }).apiKey;
    if (typeof apiKey === "string" && apiKey) return apiKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BaselineSchema = z.object({
  provider: z.literal(BASELINE_PROVIDER),
  fromAddress: z.string(),
});

const OverrideSchema = z.object({
  fromAddress: z.string(),
  apiKeyMasked: z.string(),
  installedAt: z.string(),
});

const EmailProviderConfigSchema = z.object({
  baseline: BaselineSchema,
  override: OverrideSchema.nullable(),
});

const SetEmailProviderBodySchema = z.object({
  apiKey: z.string().min(1).optional().openapi({
    description: "Resend API key. Omit to keep the existing key when updating the From address only.",
  }),
  fromAddress: z.string().min(1).optional().openapi({
    description: "Sender address for this workspace's emails. Must be verified with Resend.",
    example: "Acme <noreply@acme.com>",
  }),
});

const TestEmailProviderBodySchema = z.object({
  apiKey: z.string().min(1).optional().openapi({
    description: "Resend API key to test. Omit to test the saved override (or the platform default).",
  }),
  fromAddress: z.string().min(1).optional().openapi({
    description: "Sender address to test with. Defaults to the saved override or baseline.",
  }),
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
  summary: "Get workspace email provider configuration",
  description:
    "Returns the Resend baseline plus the workspace's BYO override (if any). Provider is locked to Resend.",
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
    "Stores the Resend API key and optional From address for this workspace. Provider is always Resend.",
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
    "Deletes the workspace's Resend override. Delivery falls back to the platform default.",
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
    "Sends a test email using supplied credentials (when given) or the saved override, falling back to the platform default.",
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

    const override = install && install.provider === BASELINE_PROVIDER && extractApiKey(install.config)
      ? {
          fromAddress: install.sender_address,
          apiKeyMasked: maskSecret(extractApiKey(install.config)!),
          installedAt: install.installed_at,
        }
      : null;

    return c.json({
      config: {
        baseline: { provider: BASELINE_PROVIDER, fromAddress: BASELINE_FROM_ADDRESS },
        override,
      },
    }, 200);
  }), { label: "get email provider config" });
});

// PUT / — save Resend override
adminEmailProvider.openapi(setConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId, orgId } = c.get("orgContext");
    const body = c.req.valid("json");

    // Look up existing installation to allow partial updates (e.g. update
    // fromAddress without re-entering the apiKey).
    const existing = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const existingKey = existing?.provider === BASELINE_PROVIDER ? extractApiKey(existing.config) : null;
    const apiKey = body.apiKey ?? existingKey;
    if (!apiKey) {
      return c.json({
        error: "validation",
        message: "A Resend API key is required to save your override.",
        requestId,
      }, 400);
    }

    const fromAddress = body.fromAddress?.trim() || existing?.sender_address || BASELINE_FROM_ADDRESS;

    yield* Effect.tryPromise({
      try: () => saveEmailInstallation(orgId, {
        provider: BASELINE_PROVIDER,
        senderAddress: fromAddress,
        config: { apiKey },
      }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const saved = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const savedKey = saved ? extractApiKey(saved.config) : null;
    const override = saved && savedKey
      ? {
          fromAddress: saved.sender_address,
          apiKeyMasked: maskSecret(savedKey),
          installedAt: saved.installed_at,
        }
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
    const { orgId } = c.get("orgContext");
    const body = c.req.valid("json");

    const existing = yield* Effect.tryPromise({
      try: () => getEmailInstallationByOrg(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const existingKey = existing?.provider === BASELINE_PROVIDER ? extractApiKey(existing.config) : null;
    const fromAddress = body.fromAddress?.trim() || existing?.sender_address || BASELINE_FROM_ADDRESS;

    const testMessage = {
      to: body.recipientEmail,
      subject: "Atlas Email Provider Test",
      html: "<p>This is a test email from Atlas to verify your email provider configuration.</p><p>If you received this email, your configuration is working correctly.</p>",
    };

    // 1. Supplied API key — test it directly before the caller commits.
    // 2. Existing saved override — test that.
    // 3. Fall through to the platform default via sendEmail(orgId).
    const apiKey = body.apiKey ?? existingKey;
    const result = apiKey
      ? yield* Effect.tryPromise({
          try: () => sendEmailWithTransport(testMessage, {
            provider: BASELINE_PROVIDER,
            senderAddress: fromAddress,
            config: { apiKey },
          }),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        })
      : yield* Effect.tryPromise({
          try: () => sendEmail(testMessage, orgId),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        });

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
