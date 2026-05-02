import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { betterAuth } from "better-auth";
import {
  buildAuthOptions,
  buildAdvancedConfig,
  buildEmailAndPasswordConfig,
  parseAuthSecret,
  resolveAuthRateLimitConfig,
  resolveRequireEmailVerification,
  type BuildAuthOptionsDeps,
} from "../server";
import { normalizeSignupResponseBody } from "../signup-response";

/**
 * End-to-end wiring regressions for #1741.
 *
 * The unit tests in `rate-limit.test.ts` pin the pure helpers
 * (`resolveAuthRateLimitConfig`, `buildAdvancedConfig`,
 * `buildEmailAndPasswordConfig`, `_sendVerificationEmail`) — but they do
 * not catch a refactor that silently drops `advanced:` or `rateLimit:` or
 * the outer `.catch()` on `sendVerificationEmail` from the options handed
 * to `betterAuth()`. A PR that flips any of those to `undefined` would
 * reopen the enumeration-oracle-via-500 path without failing a single
 * existing test.
 *
 * This file adds the missing barrier by:
 *   1. Asserting the composed shape returned by `buildAuthOptions(deps)`.
 *   2. Driving a live Better Auth instance with the built-in in-memory
 *      adapter and verifying the rate-limit loop (10×401, then 429) AND
 *      the spoof-resistant IP bucketing (swapping `x-forwarded-for`
 *      without changing `x-atlas-client-ip` still trips the 11th).
 *   3. Signing up twice with the same email and asserting the response
 *      envelope is indistinguishable between new and existing email —
 *      the invariant Better Auth's `requireEmailVerification: true` path
 *      relies on to close the signup-enumeration oracle.
 *
 * Stable across repeated runs because (a) each scenario uses a unique
 * client IP to keep rate-limit buckets isolated, and (b) the memory
 * adapter starts empty per test-file subprocess under Atlas's isolated
 * test runner. Tests scrub env leakage in `beforeEach` as a defensive
 * measure in case a sibling test (now or future) mutates `process.env`.
 */

// Explicitly tracked env vars the builder + its dependencies read.
// Listed here so the beforeEach scrub captures everything that could
// leak cross-test.
const AUTH_ENV_VARS = [
  "ATLAS_AUTH_RATE_LIMIT_ENABLED",
  "ATLAS_AUTH_RATE_LIMIT_WINDOW",
  "ATLAS_AUTH_RATE_LIMIT_MAX",
  "ATLAS_REQUIRE_EMAIL_VERIFICATION",
  "ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of AUTH_ENV_VARS) ORIGINAL_ENV[key] = process.env[key];

beforeEach(() => {
  for (const key of AUTH_ENV_VARS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTH_ENV_VARS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

// 32 chars — satisfies the BETTER_AUTH_SECRET length floor enforced by parseAuthSecret.
const SECRET = parseAuthSecret("0123456789abcdef0123456789abcdef");

/** Baseline deps: rate limiting on, verification on, no plugins, memory adapter. */
function makeDeps(overrides: Partial<BuildAuthOptionsDeps> = {}): BuildAuthOptionsDeps {
  return {
    env: {
      ATLAS_AUTH_RATE_LIMIT_ENABLED: "true",
      ATLAS_REQUIRE_EMAIL_VERIFICATION: "true",
    } as NodeJS.ProcessEnv,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    // `undefined` → Better Auth falls back to its built-in memory adapter;
    // the builder also derives `internalDbAvailable: false` from this.
    database: undefined,
    cookieDomain: undefined,
    socialProviders: undefined,
    plugins: [],
    trustedOrigins: ["http://localhost:3000"],
    bootstrapAdmin: { mode: "none" },
    ...overrides,
  };
}

/**
 * Build a live Better Auth instance wired via `buildAuthOptions`. The
 * options pass through the exact call path used by `getAuthInstance()`
 * in production — so a test against this instance exercises the same
 * wiring operators get at runtime.
 *
 * The cast to `BetterAuthOptions` narrows from `Parameters<typeof
 * betterAuth>[0]` (the plugin-generic signature) to the non-generic
 * options type Better Auth's minimal entry expects. We assert on
 * `.handler`, the one surface this file uses; bugs that would surface
 * in the plugin-extended API would never be reached here anyway.
 */
function makeAuth(overrides: Partial<BuildAuthOptionsDeps> = {}): ReturnType<typeof betterAuth> {
  const options = buildAuthOptions(makeDeps(overrides));
  return betterAuth(options as Parameters<typeof betterAuth>[0]);
}

/**
 * Canonicalize a signup response envelope for byte-for-byte parity
 * comparison between the new-email and existing-email paths.
 *
 * Scrubs only per-request non-determinism — `id`, `createdAt`,
 * `updatedAt` — replacing each with the literal string `"<scrubbed>"`.
 *
 * Everything else is compared literally — including types, field
 * presence, and nested shape — so a future upstream change that starts
 * leaking, say, `emailVerified: true` on the real path vs `false` on
 * the synthetic would show up red. The `image` asymmetry that used to
 * be normalized here (#1792) is now closed in the Atlas signup handler
 * itself; the parity test exercises the real diff.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "id" || k === "createdAt" || k === "updatedAt") {
        out[k] = "<scrubbed>";
      } else {
        out[k] = scrub(v);
      }
    }
    return out;
  }
  return value;
}

/** Sort object keys at every level so JSON.stringify is stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * Build a POST /api/auth/<path> request with pinned IP headers.
 *
 * `x-atlas-client-ip` must match `buildAdvancedConfig(undefined).ipAddress.ipAddressHeaders`
 * — it's the single header Better Auth should read. `x-forwarded-for`
 * is supplied so the IP-spoof-resistance test can vary it without
 * affecting the rate-limit bucket; the default `forwardedFor === ip`
 * keeps other tests agnostic.
 */
function authRequest(
  path: string,
  body: unknown,
  ip: string,
  forwardedFor: string = ip,
): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atlas-client-ip": ip,
      "x-forwarded-for": forwardedFor,
      "origin": "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

describe("config wiring snapshot — buildAuthOptions", () => {
  it("wires `advanced` to buildAdvancedConfig (F-06 IP header pin)", () => {
    const options = buildAuthOptions(makeDeps({ cookieDomain: "useatlas.dev" }));
    expect(options.advanced).toEqual(buildAdvancedConfig("useatlas.dev"));
    // The ipAddressHeaders list MUST be exactly [`x-atlas-client-ip`].
    // Adding `x-forwarded-for` here reopens F-06 — attackers spoof the
    // rate-limit bucket by sending the header themselves.
    expect(options.advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-atlas-client-ip"]);
  });

  it("wires `rateLimit` to resolveAuthRateLimitConfig (F-06 /api/auth rules)", () => {
    const deps = makeDeps();
    const options = buildAuthOptions(deps);
    const expected = resolveAuthRateLimitConfig(deps.env, deps.database !== undefined);
    expect(options.rateLimit).toEqual(expected);
    // Per-endpoint rules must be pinned — a future refactor that drops
    // `customRules` would silently fall back to the global ceiling
    // (100/min) and lose brute-force protection on /sign-in/email.
    expect(options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 60, max: 10 });
    expect(options.rateLimit?.customRules?.["/sign-up/email"]).toEqual({ window: 60, max: 5 });
  });

  it("wires `emailAndPassword` to buildEmailAndPasswordConfig (F-05 autoSignIn invariant)", () => {
    const options = buildAuthOptions(makeDeps());
    const requireEmailVerification = resolveRequireEmailVerification(makeDeps().env);
    // The wiring layer adds an inline `sendResetPassword` that depends on
    // private module references (`_sendPasswordResetEmail`), so we can't
    // call `buildEmailAndPasswordConfig` here and `toEqual` the whole
    // shape — the function reference will differ. Pin every other field
    // individually instead, plus assert the callback exists.
    const expected = buildEmailAndPasswordConfig({
      requireEmailVerification,
      sendResetPassword: async () => {},
    });
    expect(options.emailAndPassword?.enabled).toBe(expected.enabled);
    expect(options.emailAndPassword?.requireEmailVerification).toBe(expected.requireEmailVerification);
    // With requireEmailVerification=true, autoSignIn MUST be false.
    // `buildEmailAndPasswordConfig` pins this; the options wiring must
    // not override it with a hand-rolled object that flips autoSignIn on.
    expect(options.emailAndPassword?.autoSignIn).toBe(false);
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(options.emailAndPassword?.resetPasswordTokenExpiresIn).toBe(60 * 60);
    expect(typeof options.emailAndPassword?.sendResetPassword).toBe("function");
  });

  it("wires the outer `.catch()` on sendResetPassword so rejections don't propagate", async () => {
    // Symmetric with the sendVerificationEmail wiring test below — pins
    // the same belt-and-suspenders contract for the password-reset
    // dispatch. An unhandled rejection here would either spam stderr
    // with no correlation or, with --unhandled-rejections=strict,
    // crash the process mid-reset and turn the enumeration-safe 200
    // response into a 500 side channel.
    const sentinel = new Error("boom — simulated reset dispatcher crash");
    const options = buildAuthOptions(
      makeDeps({
        testOverrides: {
          sendPasswordResetEmail: async () => { throw sentinel; },
        },
      }),
    );

    const callback = options.emailAndPassword?.sendResetPassword;
    expect(typeof callback).toBe("function");

    let unhandled: unknown = null;
    const handler = (reason: unknown) => {
      if (reason === sentinel) unhandled = reason;
    };
    process.on("unhandledRejection", handler);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow Better Auth callback type for test invocation
      await (callback as any)({
        user: { email: "reset@example.com" },
        url: "https://example.com/reset?token=x",
        token: "x",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toBeNull();
  });

  it("wires the outer `.catch()` on sendVerificationEmail so rejections don't propagate", async () => {
    // Inject a sendVerificationEmail impl that rejects with a sentinel
    // error. If the options builder drops the outer `.catch()`, the
    // built callback's floating promise becomes an unhandled rejection
    // — which Bun's test runner treats as a test failure and which,
    // under Node's `--unhandled-rejections=strict`, would crash the
    // process mid-signup and reopen the enumeration oracle as a
    // 500-vs-200 side channel.
    //
    // Two mechanisms combine to catch regressions: (1) the attached
    // `unhandledRejection` handler captures the rejection and the
    // sentinel-message assertion below flips red, and (2) Bun's own
    // test-runner rejection tracking fails the test directly. Either
    // is sufficient; having both guards against future runtime
    // behavior changes.
    const sentinel = new Error("boom — simulated dispatcher crash");
    const options = buildAuthOptions(
      makeDeps({
        testOverrides: {
          sendVerificationEmail: async () => { throw sentinel; },
        },
      }),
    );

    const callback = options.emailVerification?.sendVerificationEmail;
    expect(typeof callback).toBe("function");

    let unhandled: unknown = null;
    const handler = (reason: unknown) => {
      // Only capture our sentinel — guards against false positives from
      // an unrelated rejection that happens to fire during the window.
      if (reason === sentinel) unhandled = reason;
    };
    process.on("unhandledRejection", handler);
    try {
      // Better Auth invokes the callback with `({ user, url, token }, request)`.
      // Cast needed — the Better Auth callback type is a complex union we
      // only invoke with the fields we know the wired implementation reads.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow Better Auth callback type for test invocation
      await (callback as any)({
        user: { email: "wire@example.com" },
        url: "https://example.com/verify?token=x",
        token: "x",
      });
      // Give the microtask chain (from `.catch()` or a floating reject)
      // a tick to resolve before detaching the handler.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toBeNull();
  });
});

describe("live rate-limit loop — /sign-in/email", () => {
  it("returns 10×401 then 1×429 against /api/auth/sign-in/email", async () => {
    // ATLAS_AUTH_RATE_LIMIT_MAX=9999 raises the GLOBAL ceiling way above
    // the 11 we're about to send — so a 429 can only come from the
    // per-endpoint rule (customRules["/sign-in/email"] = { max: 10 }).
    // A refactor that drops `customRules` would fall back to 9999/min
    // and the 11th request would be 401, not 429 — red.
    const auth = makeAuth({
      env: {
        ATLAS_AUTH_RATE_LIMIT_ENABLED: "true",
        ATLAS_AUTH_RATE_LIMIT_MAX: "9999",
        ATLAS_REQUIRE_EMAIL_VERIFICATION: "true",
      } as NodeJS.ProcessEnv,
    });
    const ip = "192.0.2.10"; // TEST-NET-1 — never a real client IP
    const statuses: number[] = [];

    for (let i = 0; i < 11; i++) {
      const req = authRequest("/sign-in/email", {
        email: "noone@example.com",
        password: "not-a-real-password",
      }, ip);
      const res = await auth.handler(req);
      statuses.push(res.status);
    }

    // Precise invariant: first 10 return 401 (INVALID_EMAIL_OR_PASSWORD);
    // the 11th tripwires the per-endpoint rule at window=60, max=10 and
    // returns 429. If `rateLimit:` is dropped, all 11 stay 401 — red.
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(statuses[10]).toBe(429);
  });

  it("rate-limits by x-atlas-client-ip even when x-forwarded-for rotates (F-06 spoof resistance)", async () => {
    // If `advanced` is dropped, Better Auth falls back to default IP
    // detection — which reads `x-forwarded-for`. An attacker rotating
    // that header would then be bucketed per-header-value instead of
    // per-real-client, defeating the rate limit. With `advanced` wired,
    // the limiter reads ONLY `x-atlas-client-ip`, so rotating
    // `x-forwarded-for` has no effect on bucket membership and the
    // 11th request still trips 429.
    const auth = makeAuth({
      env: {
        ATLAS_AUTH_RATE_LIMIT_ENABLED: "true",
        ATLAS_AUTH_RATE_LIMIT_MAX: "9999",
        ATLAS_REQUIRE_EMAIL_VERIFICATION: "true",
      } as NodeJS.ProcessEnv,
    });
    const realIp = "192.0.2.30";
    const statuses: number[] = [];

    for (let i = 0; i < 11; i++) {
      const req = authRequest(
        "/sign-in/email",
        { email: "noone@example.com", password: "not-a-real-password" },
        realIp,
        `10.0.0.${i + 1}`, // different forwarded-for every request
      );
      const res = await auth.handler(req);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(statuses[10]).toBe(429);
  });
});

describe("signup enumeration response parity — /sign-up/email", () => {
  it("returns indistinguishable envelopes for new vs existing email", async () => {
    const auth = makeAuth();
    const ip = "192.0.2.20";
    const email = `parity-${Date.now()}@example.com`;

    const firstReq = authRequest("/sign-up/email", {
      name: "Parity User",
      email,
      password: "correct horse battery staple",
    }, ip);
    const firstRes = await auth.handler(firstReq);
    const firstBodyRaw = await firstRes.json();

    // Second signup with the SAME email. With requireEmailVerification=true,
    // Better Auth returns a synthetic success envelope instead of the
    // USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL 422 — which is exactly the
    // enumeration closure the `emailAndPassword` wiring depends on.
    const secondReq = authRequest("/sign-up/email", {
      name: "Parity User",
      email,
      password: "correct horse battery staple",
    }, ip);
    const secondRes = await auth.handler(secondReq);
    const secondBodyRaw = await secondRes.json();

    // Apply the Atlas-side normalization that the Hono handler in
    // packages/api/src/api/routes/auth.ts wraps around the Better Auth
    // /sign-up/email response. This closes #1792: Better Auth's real
    // `parseUserOutput` omits `image` entirely when the signup body
    // doesn't supply one, while the synthetic existing-email envelope
    // always includes `image: null`. The Hono layer fills the gap on
    // the real path before the response leaves the API.
    const firstBody = normalizeSignupResponseBody(firstBodyRaw);
    const secondBody = normalizeSignupResponseBody(secondBodyRaw);

    // Status parity — no 422/500 leak from the existing-email branch.
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    // F-P3 (#1792) — the field the oracle used to leak. Both envelopes
    // must have `user.image === null` after Atlas normalization, not
    // just undefined on one side and null on the other. If this fails
    // on either side, the signup response distinguishes new vs
    // existing email to a client that inspects key presence.
    const userOf = (body: unknown): Record<string, unknown> => {
      if (!body || typeof body !== "object") return {};
      const user = (body as { user?: unknown }).user;
      return user && typeof user === "object" ? (user as Record<string, unknown>) : {};
    };
    expect(userOf(firstBody)).toHaveProperty("image", null);
    expect(userOf(secondBody)).toHaveProperty("image", null);

    // Shape parity — top-level keys and nested user-object keys must
    // match between branches. Doing this before the value-level scrub
    // would surface a regression that added an enumeration-leaking key
    // (e.g. an `existingAccount: true` flag) even if its value is
    // scrubbed by value-level normalization.
    const topKeys = (body: unknown): string[] =>
      body && typeof body === "object" ? Object.keys(body).toSorted() : [];
    const userKeys = (body: unknown): string[] => Object.keys(userOf(body)).toSorted();
    expect(topKeys(firstBody)).toEqual(topKeys(secondBody));
    expect(userKeys(firstBody)).toEqual(userKeys(secondBody));

    // Value parity — both envelopes serialize byte-for-byte identically
    // modulo `id`/`createdAt`/`updatedAt` (legitimately non-deterministic
    // per request). No field-level normalization here: every other key
    // must match literally, so a future Better Auth change that leaks a
    // new key on one branch only will show up red.
    const normalize = (body: unknown): string => JSON.stringify(sortKeys(scrub(body)));
    expect(normalize(firstBody)).toBe(normalize(secondBody));
  });
});
