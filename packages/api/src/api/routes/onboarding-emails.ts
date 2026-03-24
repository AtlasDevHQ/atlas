/**
 * Public onboarding email routes.
 *
 * Mounted at /api/v1/onboarding-emails. Handles unsubscribe link clicks
 * (no auth required — the userId in the URL acts as a bearer token).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { unsubscribeUser, resubscribeUser } from "@atlas/api/lib/email/engine";
import { ErrorSchema } from "./shared-schemas";

const log = createLogger("onboarding-emails-routes");

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const unsubscribeRoute = createRoute({
  method: "get",
  path: "/unsubscribe",
  tags: ["Onboarding Emails"],
  summary: "Unsubscribe from onboarding emails",
  description: "SaaS only. Unsubscribe a user from onboarding emails via the link in emails.",
  request: {
    query: z.object({
      userId: z.string().openapi({ description: "User ID to unsubscribe" }),
    }),
  },
  responses: {
    200: {
      description: "Unsubscribed successfully",
      content: { "text/html": { schema: z.string() } },
    },
    400: { description: "Missing userId", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const resubscribeRoute = createRoute({
  method: "post",
  path: "/resubscribe",
  tags: ["Onboarding Emails"],
  summary: "Resubscribe to onboarding emails",
  description: "SaaS only. Re-enable onboarding emails for a user.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string().openapi({ description: "User ID to resubscribe" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Resubscribed",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: { description: "Missing userId", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const onboardingEmails = new OpenAPIHono({ defaultHook: validationHook });

onboardingEmails.openapi(unsubscribeRoute, async (c) => {
  const requestId = crypto.randomUUID();
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "bad_request", message: "Missing userId parameter.", requestId }, 400);
  }

  if (!hasInternalDB()) {
    // If onboarding emails cannot be sent without an internal DB, the unsubscribe
    // link would never have been generated. Show a neutral acknowledgement.
    return c.html(unsubscribeHtml("Unsubscribed", "You have been unsubscribed from onboarding emails."), 200);
  }

  try {
    await unsubscribeUser(userId);
  } catch (err) {
    log.error({ userId, err: err instanceof Error ? err.message : String(err), requestId }, "Unsubscribe failed");
    return c.html(
      unsubscribeHtml("Unsubscribe Failed", "We could not process your request. Please try again or contact support."),
      500,
    );
  }

  return c.html(unsubscribeHtml("Unsubscribed", "You have been unsubscribed from onboarding emails. You will no longer receive onboarding tips."), 200);
});

onboardingEmails.openapi(resubscribeRoute, async (c) => {
  const { userId } = c.req.valid("json");
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Internal database not configured.", requestId }, 500);
  }

  try {
    await resubscribeUser(userId);
    return c.json({ ok: true }, 200);
  } catch (err) {
    log.error({ userId, err: err instanceof Error ? err.message : String(err), requestId }, "Resubscribe failed");
    return c.json({ error: "internal_error", message: "Failed to resubscribe.", requestId }, 500);
  }
});

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unsubscribeHtml(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${safeTitle}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;">
  <div style="text-align:center;padding:48px;background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1);max-width:400px;">
    <h1 style="font-size:24px;color:#171717;margin:0 0 12px;">${safeTitle}</h1>
    <p style="font-size:15px;color:#525252;margin:0;line-height:1.5;">${safeMessage}</p>
  </div>
</body>
</html>`;
}
