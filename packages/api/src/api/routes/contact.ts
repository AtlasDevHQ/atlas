/**
 * Talk-to-sales contact form route (#2730, slice 3 of 1.6.0).
 *
 * `POST /api/v1/contact` accepts a sales-form submission from the
 * marketing site (apps/www `/pricing` Business tier dialog) and hands
 * it off to the SaaS CRM outbox for durable dispatch into Twenty
 * (Person + Note).
 *
 * Request pipeline:
 *   1. IP-based rate limit (mirrors `/api/v1/demo/start`)
 *   2. Cloudflare Turnstile siteverify — 403 on failure
 *   3. Zod body validation — 422 on malformed input
 *   4. SaasCrm.upsertLead({ source: "sales-form", ... })
 *
 * Availability: returns 404 when `SaasCrm.available === false` (i.e.
 * self-hosted without enterprise OR SaaS that failed boot verification).
 * Same shape as the existing 404 `not_available` envelope used by other
 * enterprise-gated routes.
 *
 * Turnstile context: apps/www is hosted on Railway BEHIND Cloudflare —
 * Cloudflare Turnstile is the natural bot-protection fit (Vercel BotID
 * doesn't apply outside Vercel). The siteverify call uses the secret
 * key + token + client IP per Cloudflare's documented contract:
 *   https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * The route is publicly reachable from the browser — no auth required.
 * Rate-limit + Turnstile are the only abuse guards.
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { createLogger } from "@atlas/api/lib/logger";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { SaasCrm, RequestContext } from "@atlas/api/lib/effect/services";
import { checkContactRateLimit } from "@atlas/api/lib/contact";
import { verifyTurnstile } from "@atlas/api/lib/turnstile";

import { withRequestId, type AuthEnv } from "./middleware";
import { validationHook } from "./validation-hook";

const log = createLogger("contact");

/** Same permissive envelope shape used by other public routes. */
const ContactErrorSchema = z.record(z.string(), z.unknown());

/**
 * Public form schema. Bounded lengths mirror Twenty's documented column
 * limits (free-text fields tolerate large input; `name`/`company` are
 * VARCHAR-bounded). The `message` cap is generous — sales prospects
 * occasionally paste RFP requirements; 4000 char fits a comfortable
 * page of text without giving abusers room to flood Twenty.
 */
export const ContactBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().email("A valid work email is required").max(320),
  company: z.string().trim().min(1, "Company is required").max(200),
  planInterest: z
    .string()
    .trim()
    .min(1, "Plan interest is required")
    .max(80),
  message: z.string().trim().min(1, "Message is required").max(4000),
  /**
   * Cloudflare Turnstile widget token. Cloudflare's docs cap the token
   * at 2048 chars; we accept up to 4096 as a safety margin in case of
   * future format changes. Missing / empty is a validation error, not a
   * Turnstile failure — the latter requires a server round-trip we want
   * to skip when the client clearly didn't run the widget.
   */
  turnstileToken: z
    .string()
    .min(1, "turnstileToken is required")
    .max(4096),
});

const ContactSuccessSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
});

const contactRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Contact"],
  summary: "Submit a talk-to-sales form",
  description:
    "Public talk-to-sales endpoint backing the /pricing Business tier dialog. " +
    "Verifies the Cloudflare Turnstile token, rate-limits per IP, and enqueues " +
    "the lead for durable dispatch to Twenty (Person + Note). Returns 404 when " +
    "the SaaS CRM integration is not available (self-hosted without enterprise).",
  request: {
    body: {
      content: { "application/json": { schema: ContactBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Submission accepted (outbox handles dispatch)",
      content: { "application/json": { schema: ContactSuccessSchema } },
    },
    400: {
      description: "Malformed JSON body",
      content: { "application/json": { schema: ContactErrorSchema } },
    },
    403: {
      description: "Cloudflare Turnstile verification failed",
      content: { "application/json": { schema: ContactErrorSchema } },
    },
    404: {
      description: "Sales CRM not available on this deployment",
      content: { "application/json": { schema: ContactErrorSchema } },
    },
    422: {
      description: "Validation error (missing or malformed field)",
      content: { "application/json": { schema: ContactErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded (per-IP)",
      content: { "application/json": { schema: ContactErrorSchema } },
    },
    500: {
      description: "Unexpected server error",
      content: { "application/json": { schema: ContactErrorSchema } },
    },
  },
});

const contact = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

contact.use(withRequestId);

// OpenAPIHono's body validator parses JSON before our handler runs. When
// the request body is malformed JSON, the validator throws an
// HTTPException(400) with a text/plain body — we promote it to a JSON
// envelope here so the API surface stays uniform (same shape as the
// demo route's onError, #2730).
contact.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

contact.openapi(contactRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;

      // ── 1. Rate limit ─────────────────────────────────────────────
      const ip = getClientIP(c.req.raw);
      const rateCheck = checkContactRateLimit(ip ?? "anon-contact");
      if (!rateCheck.allowed) {
        const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
        return c.json(
          {
            error: "rate_limited",
            message: "Too many requests. Please wait before submitting again.",
            retryAfterSeconds,
            requestId,
          },
          { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
        );
      }

      // ── 2. Parse body ─────────────────────────────────────────────
      const bodyResult = yield* Effect.tryPromise({
        try: () => c.req.json(),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.either);
      if (bodyResult._tag === "Left") {
        log.debug({ err: bodyResult.left.message }, "Contact: invalid JSON body");
        return c.json(
          { error: "invalid_request", message: "Invalid JSON body.", requestId },
          400,
        );
      }
      const parsed = ContactBodySchema.safeParse(bodyResult.right);
      if (!parsed.success) {
        return c.json(
          {
            error: "validation_error",
            message: "One or more fields failed validation.",
            details: parsed.error.issues,
            requestId,
          },
          422,
        );
      }
      const body = parsed.data;

      // ── 3. SaasCrm availability ───────────────────────────────────
      // Resolved BEFORE the Turnstile siteverify so self-hosted /
      // non-enterprise deployments don't burn a round-trip on a 404'd
      // endpoint. The marketing site shouldn't be calling /api/v1/contact
      // on self-hosted anyway — the 404 surfaces a misconfiguration
      // (e.g. NEXT_PUBLIC_ATLAS_API_URL pointing at the wrong host).
      const crm = yield* SaasCrm;
      if (!crm.available) {
        log.warn(
          { requestId, event: "contact.saas_crm_unavailable" },
          "Contact form submitted but SaasCrm is not available on this deployment",
        );
        return c.json(
          {
            error: "not_available",
            message:
              "Sales contact submission is not available on this deployment. " +
              "Email sales@useatlas.dev directly.",
            requestId,
          },
          404,
        );
      }

      // ── 4. Cloudflare Turnstile ───────────────────────────────────
      const verifyResult = yield* Effect.promise(() =>
        verifyTurnstile({
          token: body.turnstileToken,
          remoteIp: ip,
          requestId,
        }),
      );
      if (!verifyResult.ok) {
        log.warn(
          {
            requestId,
            event: "contact.turnstile_failed",
            errorCodes: verifyResult.errorCodes,
            reason: verifyResult.reason,
          },
          "Cloudflare Turnstile verification failed for contact submission",
        );
        return c.json(
          {
            error: "turnstile_failed",
            message: "Bot protection check failed. Refresh the page and try again.",
            requestId,
          },
          403,
        );
      }

      // ── 5. Enqueue lead ───────────────────────────────────────────
      // upsertLead's Effect has no failure channel today (the layer
      // catches enqueue errors internally and logs them — see
      // ee/src/saas-crm/index.ts). The user sees confirmation
      // regardless; a Twenty outage / pg blip is invisible at this
      // boundary by design — outbox catches up on the next tick.
      const userAgent = c.req.header("user-agent") ?? null;
      yield* crm.upsertLead({
        source: "sales-form",
        email: body.email,
        name: body.name,
        company: body.company,
        planInterest: body.planInterest,
        message: body.message,
        ip,
        userAgent,
      });

      log.info(
        {
          requestId,
          // Light obfuscation of the email — same pattern as captureDemoLead.
          emailMasked: body.email.replace(/(.{2}).*(@.*)/, "$1***$2"),
          company: body.company,
          planInterest: body.planInterest,
          event: "contact.submitted",
        },
        "Talk-to-sales submission accepted — queued for Twenty dispatch",
      );

      return c.json(
        {
          ok: true as const,
          message: "Thanks — our team will be in touch within one business day.",
        },
        200,
      );
    }),
    { label: "contact submit" },
  );
});

export { contact };
