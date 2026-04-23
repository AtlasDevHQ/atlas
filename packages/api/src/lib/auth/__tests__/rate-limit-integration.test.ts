import { describe, it, expect } from "bun:test";
import { betterAuth } from "better-auth";
import {
  buildAuthOptions,
  buildAdvancedConfig,
  buildEmailAndPasswordConfig,
  resolveAuthRateLimitConfig,
  resolveRequireEmailVerification,
  type BuildAuthOptionsDeps,
} from "../server";

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
 *      adapter and verifying the rate-limit loop (10×401, then 429).
 *   3. Signing up twice with the same email and asserting the response
 *      envelope is indistinguishable between new and existing email —
 *      the invariant Better Auth's `requireEmailVerification: true` path
 *      relies on to close the signup-enumeration oracle.
 *
 * Stable across repeated runs because (a) each scenario uses a unique
 * client IP to keep rate-limit buckets isolated, and (b) the memory
 * adapter starts empty per test-file subprocess under Atlas's isolated
 * test runner.
 */

const SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars — satisfies the BETTER_AUTH_SECRET length guard.

/** Baseline deps: rate limiting on, verification on, no plugins, memory adapter. */
function makeDeps(overrides: Partial<BuildAuthOptionsDeps> = {}): BuildAuthOptionsDeps {
  return {
    env: {
      ATLAS_AUTH_RATE_LIMIT_ENABLED: "true",
      ATLAS_REQUIRE_EMAIL_VERIFICATION: "true",
    } as NodeJS.ProcessEnv,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    // `undefined` → Better Auth falls back to its built-in memory adapter.
    database: undefined,
    internalDbAvailable: false,
    cookieDomain: undefined,
    socialProviders: undefined,
    plugins: [],
    trustedOrigins: ["http://localhost:3000"],
    adminEmail: undefined,
    allowFirstSignupAdmin: false,
    ...overrides,
  };
}

/**
 * Build a live Better Auth instance wired via `buildAuthOptions`. The
 * options pass through the exact call path used by `getAuthInstance()`
 * in production — so a test against this instance exercises the same
 * wiring operators get at runtime.
 */
function makeAuth(overrides: Partial<BuildAuthOptionsDeps> = {}) {
  const options = buildAuthOptions(makeDeps(overrides));
  // `as never`: Better Auth's `betterAuth(...)` is a generic function that
  // infers the instance type from the plugin tuple. Our `buildAuthOptions`
  // returns the base options type (no plugin tuple), and re-threading the
  // plugin generics through this test helper would force callers to spell
  // out the empty-plugin intersection. Cast once here; instance.handler is
  // the only surface we use.
  return betterAuth(options as never);
}

/**
 * Recursively replace fields that legitimately differ per request (id,
 * timestamps) with a placeholder, and fill in `image: null` when absent.
 * Lets the enumeration-parity test compare the meaningful envelope
 * shape without false-flagging on nondeterministic fields.
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
    // Better Auth's synthetic-user branch sets `image: null`; the real
    // createdUser omits the field. Tracked upstream / as follow-up in
    // #1792 — this test normalizes the asymmetry so the rest of the
    // envelope stays the focus.
    if ("email" in out && !("image" in out)) {
      out.image = null;
    }
    return out;
  }
  return value;
}

/** Return a JSON-safe copy with keys sorted, so serialization order differences don't matter. */
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

/** Build a POST /api/auth/<path> request with a pinned IP bucket. */
function authRequest(path: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Matches `buildAdvancedConfig(undefined).ipAddress.ipAddressHeaders`.
      // Without it, Better Auth's rate limiter has no bucket key and
      // skips limiting — which would make 10×401 + 1×429 a flake.
      "x-atlas-client-ip": ip,
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
    const expected = resolveAuthRateLimitConfig(deps.env, deps.internalDbAvailable);
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
    expect(options.emailAndPassword).toEqual(buildEmailAndPasswordConfig(requireEmailVerification));
    // With requireEmailVerification=true, autoSignIn MUST be false.
    // `buildEmailAndPasswordConfig` pins this; the options wiring must
    // not override it with a hand-rolled object that flips autoSignIn on.
    expect(options.emailAndPassword?.autoSignIn).toBe(false);
  });

  it("wires the outer `.catch()` on sendVerificationEmail so rejections don't propagate", async () => {
    // Inject a sendVerificationEmail impl that rejects. If the options
    // builder drops the outer `.catch()`, the built callback's floating
    // promise becomes an unhandled rejection — which under
    // --unhandled-rejections=strict would crash the process mid-signup
    // and turn a 200 into a 500, reopening the enumeration oracle as a
    // side channel.
    const options = buildAuthOptions(
      makeDeps({
        sendVerificationEmail: async () => {
          throw new Error("boom — simulated dispatcher crash");
        },
      }),
    );

    const callback = options.emailVerification?.sendVerificationEmail;
    expect(typeof callback).toBe("function");

    // Capture unhandled rejections during the callback + one macrotask
    // tick (long enough for the microtask chain from `.catch()` to run).
    let unhandled: unknown = null;
    const handler = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", handler);
    try {
      // Better Auth invokes the callback with `({ user, url, token }, request)`.
      // Cast needed — the unrefined callback type from @better-auth/core is a
      // broad union. Only the fields we actually read are supplied.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow Better Auth callback type for test invocation
      await (callback as any)({
        user: { email: "wire@example.com" },
        url: "https://example.com/verify?token=x",
        token: "x",
      });
      // Let the floating promise's microtasks / rejection bubble.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toBeNull();
  });
});

describe("live rate-limit loop — /sign-in/email", () => {
  it("returns 10×401 then 1×429 against /api/auth/sign-in/email", async () => {
    const auth = makeAuth();
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

    // The precise invariant: the first 10 requests hit the credential
    // check and return 401 (INVALID_EMAIL_OR_PASSWORD); the 11th tripwires
    // the rate limit (window=60, max=10) and returns 429. If someone
    // drops `rateLimit: rateLimitConfig` from the options, the 11th is
    // still 401 and this test goes red.
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
    const firstBody = await firstRes.json();

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
    const secondBody = await secondRes.json();

    // Status parity — no 422/500 leak from the existing-email branch.
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    // Body parity — both envelopes are the same shape and serialize the
    // same way modulo fields that legitimately differ per request
    // (id, createdAt, updatedAt). Strip those before comparing so a
    // regression that adds a new differentiating field (e.g. an
    // `emailVerified: true` on the real user but `false` on the
    // synthetic) shows up as a diff in the normalized body.
    //
    // `image` is also normalized: Better Auth's synthetic-user branch
    // sets `image: image || null`, but `parseUserOutput` on the real
    // createdUser omits `image` when not provided, producing an
    // `{"image": null}` vs absent-key leak on signup bodies that don't
    // include an image. Tracked in #1792 — normalizing here keeps this
    // file focused on Atlas's wiring rather than absorbing an upstream
    // asymmetry as a false negative.
    const normalize = (body: unknown): string =>
      JSON.stringify(sortKeys(scrub(body)));

    expect(normalize(firstBody)).toBe(normalize(secondBody));
  });
});
