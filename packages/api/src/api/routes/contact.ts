/**
 * Talk-to-sales contact form route.
 *
 * `POST /api/v1/contact` accepts a sales-form submission from the
 * marketing site (apps/www `/pricing` Business tier dialog) and hands
 * it off to the SaaS CRM outbox for durable dispatch into Twenty
 * (Person + Note).
 *
 * Request pipeline (executed in this order):
 *   1. IP-based rate limit — 429 on overshoot
 *   2. JSON body parse — 400 on malformed body
 *   3. Zod body validation — 422 on missing/invalid fields
 *   4. `SaasCrm.available` check — 404 on self-hosted (no Turnstile
 *      round-trip burned on a 404'd endpoint)
 *   5. Cloudflare Turnstile siteverify — 403 on failure
 *   6. `SaasCrm.upsertLead({ source: "sales-form", ... })` — 503 if the
 *      Postgres outbox write fails so the user can retry
 *
 * Twenty-side dispatch failures happen AFTER enqueue under the
 * scheduler-backed flusher and stay invisible at this boundary — the
 * outbox row retries on the next tick.
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

let warnedNoTrustProxy = false;

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
    503: {
      description: "Outbox enqueue failed (Postgres unreachable) — caller should retry",
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
// demo route's onError).
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
      if (ip === null && !warnedNoTrustProxy) {
        // Without ATLAS_TRUST_PROXY=true `getClientIP` returns null on
        // every request, and `ip ?? "anon-contact"` collapses the per-IP
        // rate-limit into one global bucket — the SaaS-Cloudflare-fronted
        // deployment shape this route is designed for. Warn loud once so
        // an operator who deployed without TRUST_PROXY sees the gap
        // before legitimate traffic gets blocked under shared 5 RPM.
        warnedNoTrustProxy = true;
        log.warn(
          { event: "contact.no_trust_proxy" },
          "ATLAS_TRUST_PROXY is not set — contact-form per-IP rate-limit collapses to one global bucket. Set ATLAS_TRUST_PROXY=true behind a trusted proxy (Cloudflare, Railway edge) to enable per-IP enforcement.",
        );
      }
      const rateCheck = yield* Effect.promise(() => checkContactRateLimit(ip ?? "anon-contact"));
      if (!rateCheck.allowed) {
        const retryAfterSeconds = Math.ceil(rateCheck.retryAfterMs / 1000);
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

      // ── 2. Body (parsed + validated by the OpenAPIHono validator) ─
      // Malformed JSON → 400 from the contact.onError handler below.
      // Schema mismatch → 422 from `validationHook` (the `defaultHook`
      // passed to `new OpenAPIHono`). By the time we reach here, `body`
      // is the typed result of `ContactBodySchema`.
      const body = c.req.valid("json");

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
      // upsertLead surfaces the enqueue error (a Postgres write blip)
      // so the route can return 503 — the user sees "try again in a
      // minute" instead of a false "we got your note" on a lost lead.
      // Twenty-side dispatch failures are different: those happen
      // AFTER enqueue under the scheduler-backed flusher and stay
      // invisible at this boundary by design (the outbox row retries).
      const userAgent = c.req.header("user-agent") ?? null;
      const enqueueResult = yield* crm
        .upsertLead({
          source: "sales-form",
          email: body.email,
          name: body.name,
          company: body.company,
          planInterest: body.planInterest,
          message: body.message,
          ip,
          userAgent,
        })
        .pipe(Effect.either);
      if (enqueueResult._tag === "Left") {
        // The Live layer already logged the structured `saas_crm.enqueue_failed`
        // event with the underlying pg error; here we just return the
        // user-facing envelope so the form can prompt a retry.
        return c.json(
          {
            error: "enqueue_failed",
            message:
              "We couldn't record your message right now. Please try again in a minute, or email sales@useatlas.dev directly.",
            requestId,
          },
          503,
        );
      }

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
