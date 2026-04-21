/**
 * Public onboarding email routes (/unsubscribe, /resubscribe).
 *
 * Both endpoints require a signed token bound to the `userId` (HMAC-SHA256
 * over `userId:expiresAt` using BETTER_AUTH_SECRET). See F-03 in the 1.2.3
 * security audit — the previous design treated `userId` as a bearer token,
 * letting anyone flip any user's onboarding-email preference.
 *
 * Failure semantics differ between the two endpoints:
 *   - /unsubscribe returns a neutral HTML page and skips the DB write. This
 *     avoids turning the response into an oracle ("does this userId exist?")
 *     while not confusing a legitimate user whose email link has expired.
 *   - /resubscribe returns 403. Resubscribe is a consent grant; the caller
 *     must have come from a valid email link, so a loud error is the right
 *     signal. A leaked unsubscribe URL must not be weaponizable to undo a
 *     revocation.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { unsubscribeUser, resubscribeUser } from "@atlas/api/lib/email/engine";
import { verifyUnsubscribeToken } from "@atlas/api/lib/email/unsubscribe-token";
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
  description:
    "SaaS only. Unsubscribes a user from onboarding emails. Requires a signed token bound to the userId (the link in every onboarding email already carries one).",
  request: {
    query: z.object({
      userId: z.string().openapi({ description: "User ID to unsubscribe" }),
      token: z
        .string()
        .optional()
        .openapi({ description: "HMAC-signed token bound to userId" }),
    }),
  },
  responses: {
    200: {
      description: "Acknowledgement page. Returned even on token failure to avoid exposing whether the userId exists.",
      content: { "text/html": { schema: z.string() } },
    },
    400: { description: "Missing userId", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "text/html": { schema: z.string() } } },
  },
});

const resubscribeRoute = createRoute({
  method: "post",
  path: "/resubscribe",
  tags: ["Onboarding Emails"],
  summary: "Resubscribe to onboarding emails",
  description:
    "SaaS only. Re-enable onboarding emails for a user. Requires a signed token bound to the userId — this is a consent grant, so a missing or invalid token returns 403.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string().openapi({ description: "User ID to resubscribe" }),
            token: z
              .string()
              .optional()
              .openapi({ description: "HMAC-signed token bound to userId" }),
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
    403: { description: "Missing or invalid token", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const onboardingEmails = new OpenAPIHono({ defaultHook: validationHook });

/** Truncate userId for log correlation without dumping PII / full UUIDs. */
function hashForLog(userId: string): string {
  return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
}

onboardingEmails.openapi(unsubscribeRoute, async (c) => {
  const requestId = crypto.randomUUID();
  const userId = c.req.query("userId");
  const token = c.req.query("token");
  if (!userId) {
    return c.json({ error: "bad_request", message: "Missing userId parameter.", requestId }, 400);
  }

  // Fail-closed token check. Return the neutral 200 HTML on any failure so an
  // attacker can't enumerate userIds, but skip the DB write.
  const verification = token
    ? verifyUnsubscribeToken(userId, token)
    : { valid: false as const, reason: "malformed" as const };

  if (!verification.valid) {
    log.warn(
      { userId: hashForLog(userId), reason: verification.reason, hasToken: Boolean(token), requestId },
      "Unsubscribe token verification failed — returning neutral response without DB write",
    );
    return c.html(
      unsubscribeHtml("Unsubscribed", "You have been unsubscribed from onboarding emails."),
      200,
    );
  }

  if (!hasInternalDB()) {
    // If onboarding emails cannot be sent without an internal DB, the unsubscribe
    // link would never have been generated. Show a neutral acknowledgement.
    return c.html(
      unsubscribeHtml("Unsubscribed", "You have been unsubscribed from onboarding emails."),
      200,
    );
  }

  try {
    await unsubscribeUser(userId);
  } catch (err) {
    log.error(
      { userId: hashForLog(userId), err: err instanceof Error ? err.message : String(err), requestId },
      "Unsubscribe failed",
    );
    return c.html(
      unsubscribeHtml("Unsubscribe Failed", "We could not process your request. Please try again or contact support."),
      500,
    );
  }

  return c.html(
    unsubscribeHtml("Unsubscribed", "You have been unsubscribed from onboarding emails. You will no longer receive onboarding tips."),
    200,
  );
});

onboardingEmails.openapi(resubscribeRoute, async (c) => {
  const { userId, token } = c.req.valid("json");
  const requestId = crypto.randomUUID();

  // Resubscribe must have a valid token — a consent grant can't be silent.
  const verification = token
    ? verifyUnsubscribeToken(userId, token)
    : { valid: false as const, reason: "malformed" as const };

  if (!verification.valid) {
    log.warn(
      { userId: hashForLog(userId), reason: verification.reason, hasToken: Boolean(token), requestId },
      "Resubscribe token verification failed",
    );
    return c.json(
      { error: "forbidden", message: "Invalid or missing unsubscribe token.", requestId },
      403,
    );
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Internal database not configured.", requestId }, 500);
  }

  try {
    await resubscribeUser(userId);
    return c.json({ ok: true }, 200);
  } catch (err) {
    log.error(
      { userId: hashForLog(userId), err: err instanceof Error ? err.message : String(err), requestId },
      "Resubscribe failed",
    );
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
