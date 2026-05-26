/**
 * POST /api/v1/contact integration tests (#2730).
 *
 * Covers every status branch in `contact.ts` end-to-end via a mounted
 * Hono test app. The Hono → Effect bridge (`runEffect`) is stubbed to
 * inject test layers for `SaasCrm` + `RequestContext`; the real Tags
 * from `services.ts` are preserved so identity matches when the route
 * yields them.
 *
 * Acceptance criteria from the issue:
 *  - 403 when Turnstile siteverify fails
 *  - 404 when SaasCrm.available === false (self-hosted)
 *  - 422 on validation errors (bad email, missing fields)
 *  - 429 on rate-limit
 *  - 200 + outbox enqueue on the happy path
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import type {
  SaasCrmLeadInput,
  SaasCrmShape,
} from "@atlas/api/lib/effect/services";

// ── Mockable state ────────────────────────────────────────────────────

let saasAvailable = true;
let upsertLeadCalls: unknown[] = [];
let rateLimitAllowed = true;
let rateLimitRetryAfterMs = 0;
let turnstileOk = true;
let turnstileCallArgs: { token: string; remoteIp?: string | null } | null = null;

// ── Mock the side modules BEFORE importing the route ─────────────────

mock.module("@atlas/api/lib/contact", () => ({
  checkContactRateLimit: () => ({
    allowed: rateLimitAllowed,
    retryAfterMs: rateLimitAllowed ? undefined : rateLimitRetryAfterMs,
  }),
}));

mock.module("@atlas/api/lib/turnstile", () => ({
  verifyTurnstile: async (opts: { token: string; remoteIp?: string | null }) => {
    turnstileCallArgs = { token: opts.token, remoteIp: opts.remoteIp };
    if (turnstileOk) return { ok: true };
    return {
      ok: false,
      errorCodes: ["invalid-input-response"],
      reason: "siteverify_rejected",
    };
  },
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/auth/middleware", () => ({
  // Mock all exports — bun's mock.module replaces the whole surface.
  // Most aren't called by the contact route but are imported by sibling
  // modules that are pulled in transitively (e.g. routes/middleware.ts).
  getClientIP: () => "198.51.100.7",
  checkRateLimit: () => ({ allowed: true }),
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
  authenticateRequest: async () => ({ authenticated: false }),
  _setValidatorOverrides: () => {},
  _setSSOEnforcementOverride: () => {},
  _setAuditEnforcementBlockOverride: () => {},
}));

// ── Stub the Hono → Effect bridge to inject test layers ──────────────
//
// `runEffect` normally provides the EnterpriseSubsystem from the
// module-level ManagedRuntime. In tests we don't want to boot OTel /
// the real EE runtime — instead we provide a minimal layer that binds
// only the tags the route uses (`SaasCrm` + `RequestContext`).
mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (
    _c: unknown,
    program: Effect.Effect<unknown, unknown, unknown>,
    _opts?: unknown,
  ) => {
    // Late-import the real services.ts so we use the actual Tag identities.
    const services = await import("@atlas/api/lib/effect/services");
    const saasCrmStub: SaasCrmShape = saasAvailable
      ? {
          available: true,
          upsertLead: (input: SaasCrmLeadInput) => {
            upsertLeadCalls.push(input);
            return Effect.void;
          },
          // dispatcher is required by the available=true union arm but
          // tests don't exercise the flusher path.
          dispatcher: async () => ({ kind: "ok" as const }),
        }
      : {
          available: false,
          upsertLead: (input: SaasCrmLeadInput) => {
            upsertLeadCalls.push(input);
            return Effect.void;
          },
        };
    const layer = Layer.mergeAll(
      services.createRequestContextTestLayer({ requestId: "test-req-id" }),
      Layer.succeed(services.SaasCrm, saasCrmStub),
    );
    return Effect.runPromise(
      (program as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(layer)),
    );
  },
}));

// ── Late imports (after mocks) ───────────────────────────────────────

const { contact } = await import("../contact");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/contact", contact);

async function postContact(body: unknown, extraHeaders?: Record<string, string>) {
  const res = await app.request("http://localhost/api/v1/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return res;
}

function validBody() {
  return {
    name: "Alice Example",
    email: "alice@acme.com",
    company: "Acme Co",
    planInterest: "Business",
    message: "We need ten seats and SSO.",
    turnstileToken: "valid-token",
  };
}

beforeEach(() => {
  saasAvailable = true;
  upsertLeadCalls = [];
  rateLimitAllowed = true;
  rateLimitRetryAfterMs = 0;
  turnstileOk = true;
  turnstileCallArgs = null;
});

afterEach(() => {
  upsertLeadCalls = [];
});

describe("POST /api/v1/contact", () => {
  test("happy path — 200 + outbox enqueue with the normalized lead input", async () => {
    const res = await postContact(validBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("Thanks");

    // Turnstile invoked with the token + IP.
    expect(turnstileCallArgs).toEqual({
      token: "valid-token",
      remoteIp: "198.51.100.7",
    });

    // SaasCrm.upsertLead called once with the full sales-form shape.
    expect(upsertLeadCalls).toHaveLength(1);
    expect(upsertLeadCalls[0]).toEqual({
      source: "sales-form",
      email: "alice@acme.com",
      name: "Alice Example",
      company: "Acme Co",
      planInterest: "Business",
      message: "We need ten seats and SSO.",
      ip: "198.51.100.7",
      userAgent: null,
    });
  });

  test("403 — Turnstile siteverify failure", async () => {
    turnstileOk = false;
    const res = await postContact(validBody());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("turnstile_failed");
    // Lead must NOT be enqueued on a bot-protection failure.
    expect(upsertLeadCalls).toHaveLength(0);
  });

  test("404 — SaasCrm.available === false (self-hosted)", async () => {
    saasAvailable = false;
    const res = await postContact(validBody());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_available");
    expect(body.message).toContain("sales@useatlas.dev");
    // Turnstile not called — availability is checked BEFORE siteverify
    // so a self-hosted deployment doesn't burn a Cloudflare round-trip.
    expect(turnstileCallArgs).toBeNull();
    expect(upsertLeadCalls).toHaveLength(0);
  });

  test("422 — invalid email", async () => {
    const res = await postContact({ ...validBody(), email: "not-an-email" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      details: Array<{ message: string }>;
    };
    expect(body.error).toBe("validation_error");
    expect(JSON.stringify(body.details)).toContain("valid work email");
    expect(upsertLeadCalls).toHaveLength(0);
  });

  test("422 — missing message", async () => {
    const { message: _omit, ...rest } = validBody();
    const res = await postContact(rest);
    expect(res.status).toBe(422);
    expect(upsertLeadCalls).toHaveLength(0);
  });

  test("422 — empty turnstile token", async () => {
    const res = await postContact({ ...validBody(), turnstileToken: "" });
    expect(res.status).toBe(422);
    // siteverify never called — we caught the missing token before
    // burning a network round-trip.
    expect(turnstileCallArgs).toBeNull();
  });

  test("400 — malformed JSON body", async () => {
    const res = await postContact("{not-json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("429 — per-IP rate limit", async () => {
    rateLimitAllowed = false;
    rateLimitRetryAfterMs = 45_000;
    const res = await postContact(validBody());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
    const body = (await res.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(45);
    // Lead not enqueued — and Turnstile not invoked either (rate limit
    // is the first gate).
    expect(turnstileCallArgs).toBeNull();
    expect(upsertLeadCalls).toHaveLength(0);
  });

  test("happy path captures user-agent for the lead payload", async () => {
    await postContact(validBody(), { "User-Agent": "Mozilla/5.0 (test)" });
    expect(upsertLeadCalls).toHaveLength(1);
    expect((upsertLeadCalls[0] as { userAgent?: string }).userAgent).toBe(
      "Mozilla/5.0 (test)",
    );
  });
});
