import { describe, it, expect, mock } from "bun:test";
import {
  resolveAuthRateLimitConfig,
  resolveRequireEmailVerification,
  resolveSessionCookieCacheMaxAge,
  SESSION_COOKIE_CACHE_DEFAULT_SEC,
  SESSION_COOKIE_CACHE_MIN_SEC,
  SESSION_COOKIE_CACHE_MAX_SEC,
  buildEmailAndPasswordConfig,
  buildAdvancedConfig,
  deriveCookieDomain,
  _sendVerificationOTP,
} from "../server";

/**
 * Regression tests for #1732 (F-06) and #1731 (F-05).
 *
 * Before 1.2.3 the Better Auth config did not configure rate limits or
 * email verification. Phase 1.5 of the security audit repro'd:
 *
 *   1. 100 sequential /api/auth/sign-in/email from one IP — all 401, no
 *      429. Brute-force wide open.
 *   2. POST /api/auth/sign-up/email with an existing email returns HTTP
 *      422 with code USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL — reliable
 *      email-enumeration oracle.
 *
 * These tests pin the pure helpers that resolve the fix so a future
 * refactor can't silently reintroduce either attack surface.
 */

describe("resolveRequireEmailVerification", () => {
  it("defaults to true when unset", () => {
    expect(resolveRequireEmailVerification({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("defaults to true when empty string", () => {
    expect(
      resolveRequireEmailVerification({ ATLAS_REQUIRE_EMAIL_VERIFICATION: "" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it.each(["true", "TRUE", "1", "yes", "on", "anything-else"])(
    "stays true for affirmative or unrecognized value %j",
    (value: string) => {
      expect(
        resolveRequireEmailVerification({
          ATLAS_REQUIRE_EMAIL_VERIFICATION: value,
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    },
  );

  it.each(["false", "FALSE", "0", "no", "NO", "off", "  false  "])(
    "flips to false for explicit opt-out %j",
    (value: string) => {
      expect(
        resolveRequireEmailVerification({
          ATLAS_REQUIRE_EMAIL_VERIFICATION: value,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    },
  );
});

describe("resolveAuthRateLimitConfig", () => {
  it("defaults to enabled regardless of NODE_ENV", () => {
    const devConfig = resolveAuthRateLimitConfig(
      { NODE_ENV: "development" } as NodeJS.ProcessEnv,
      true,
    );
    const prodConfig = resolveAuthRateLimitConfig(
      { NODE_ENV: "production" } as NodeJS.ProcessEnv,
      true,
    );

    expect(devConfig.enabled).toBe(true);
    expect(prodConfig.enabled).toBe(true);
  });

  it("opts out only when ATLAS_AUTH_RATE_LIMIT_ENABLED='false'", () => {
    expect(
      resolveAuthRateLimitConfig(
        { ATLAS_AUTH_RATE_LIMIT_ENABLED: "false" } as NodeJS.ProcessEnv,
        true,
      ).enabled,
    ).toBe(false);

    expect(
      resolveAuthRateLimitConfig(
        { ATLAS_AUTH_RATE_LIMIT_ENABLED: "FALSE" } as NodeJS.ProcessEnv,
        true,
      ).enabled,
    ).toBe(false);
  });

  it("ignores unrecognized opt-out values (stays enabled)", () => {
    // "0" and "no" are not accepted for the rate-limit flag — only
    // literal "false". Different convention than requireEmailVerification
    // because rate limiting is strictly opt-out and the ambiguity of "0"
    // (disabled? zero requests?) is worse than a slightly stricter flag.
    expect(
      resolveAuthRateLimitConfig(
        { ATLAS_AUTH_RATE_LIMIT_ENABLED: "0" } as NodeJS.ProcessEnv,
        true,
      ).enabled,
    ).toBe(true);
  });

  it("uses database storage when internal DB is available, memory otherwise", () => {
    expect(resolveAuthRateLimitConfig({} as NodeJS.ProcessEnv, true).storage).toBe("database");
    expect(resolveAuthRateLimitConfig({} as NodeJS.ProcessEnv, false).storage).toBe("memory");
  });

  it("respects env overrides for window/max", () => {
    const config = resolveAuthRateLimitConfig(
      {
        ATLAS_AUTH_RATE_LIMIT_WINDOW: "120",
        ATLAS_AUTH_RATE_LIMIT_MAX: "50",
      } as NodeJS.ProcessEnv,
      true,
    );

    expect(config.window).toBe(120);
    expect(config.max).toBe(50);
  });

  it("falls back to defaults on invalid env values", () => {
    const config = resolveAuthRateLimitConfig(
      {
        ATLAS_AUTH_RATE_LIMIT_WINDOW: "not-a-number",
        ATLAS_AUTH_RATE_LIMIT_MAX: "-5",
      } as NodeJS.ProcessEnv,
      true,
    );

    expect(config.window).toBe(60);
    expect(config.max).toBe(100);
  });

  it("pins per-endpoint rules that cannot be loosened by env", () => {
    // These are the surfaces an attacker targets (signin, signup,
    // password-reset, verification-email resend). Relaxing any of them
    // would reintroduce the F-06 brute-force surface.
    const config = resolveAuthRateLimitConfig(
      {
        ATLAS_AUTH_RATE_LIMIT_WINDOW: "9999",
        ATLAS_AUTH_RATE_LIMIT_MAX: "9999",
      } as NodeJS.ProcessEnv,
      true,
    );

    expect(config.customRules["/sign-in/email"]).toEqual({ window: 60, max: 10 });
    expect(config.customRules["/sign-up/email"]).toEqual({ window: 60, max: 5 });
    // Better Auth 1.4+ renamed /forget-password → /request-password-reset.
    // The rule key is the path the limiter sees; an outdated key would
    // silently de-rate-limit the password-reset request endpoint and
    // reopen a flooding surface.
    expect(config.customRules["/request-password-reset"]).toEqual({ window: 60, max: 5 });
    expect(config.customRules["/reset-password"]).toEqual({ window: 60, max: 5 });
    expect(config.customRules["/send-verification-email"]).toEqual({ window: 60, max: 5 });
    expect(config.customRules["/verify-email"]).toEqual({ window: 60, max: 10 });
  });

  it("uses the default modelName so Better Auth's auto-migration creates the rateLimit table", () => {
    const config = resolveAuthRateLimitConfig({} as NodeJS.ProcessEnv, true);
    expect(config.modelName).toBe("rateLimit");
  });
});

describe("buildEmailAndPasswordConfig", () => {
  const noopSendReset = async () => {};

  it("pins autoSignIn OFF whenever requireEmailVerification is ON (F-05 invariant)", () => {
    const config = buildEmailAndPasswordConfig({
      requireEmailVerification: true,
      sendResetPassword: noopSendReset,
    });
    expect(config.enabled).toBe(true);
    expect(config.requireEmailVerification).toBe(true);
    // If this flips to true the signup flow becomes a login oracle —
    // attacker signs up with a victim's email, gets a session whether
    // or not the account existed.
    expect(config.autoSignIn).toBe(false);
  });

  it("allows autoSignIn when verification is disabled (self-hosted opt-out)", () => {
    const config = buildEmailAndPasswordConfig({
      requireEmailVerification: false,
      sendResetPassword: noopSendReset,
    });
    expect(config.enabled).toBe(true);
    expect(config.requireEmailVerification).toBe(false);
    expect(config.autoSignIn).toBe(true);
  });

  it("wires sendResetPassword through unchanged so Better Auth invokes our dispatcher", () => {
    // Without this, Better Auth's request-password-reset endpoint 400s
    // with `RESET_PASSWORD_DISABLED` and the /forgot-password UI has no
    // recovery path. Asserting reference identity (not just truthiness)
    // catches a future refactor that wraps the function in a pass-through
    // that drops thrown errors silently.
    const sendResetPassword = async () => {};
    const config = buildEmailAndPasswordConfig({
      requireEmailVerification: true,
      sendResetPassword,
    });
    expect(config.sendResetPassword).toBe(sendResetPassword);
  });

  it("revokes other sessions on password reset (recovery is the wrong moment to keep stale sessions live)", () => {
    const config = buildEmailAndPasswordConfig({
      requireEmailVerification: true,
      sendResetPassword: noopSendReset,
    });
    // Better Auth defaults this to false; our build pins true so a reset
    // initiated because "I think someone has my password" actually kicks
    // the attacker out of any other live session for that user.
    expect(config.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("pins resetPasswordTokenExpiresIn at one hour and lets callers tighten it", () => {
    const config = buildEmailAndPasswordConfig({
      requireEmailVerification: true,
      sendResetPassword: noopSendReset,
    });
    expect(config.resetPasswordTokenExpiresIn).toBe(60 * 60);

    const tighter = buildEmailAndPasswordConfig({
      requireEmailVerification: true,
      sendResetPassword: noopSendReset,
      resetPasswordTokenExpiresIn: 60 * 15,
    });
    expect(tighter.resetPasswordTokenExpiresIn).toBe(60 * 15);
  });
});

describe("buildAdvancedConfig", () => {
  it("pins ipAddressHeaders to exactly ['x-atlas-client-ip'] (F-06 invariant)", () => {
    const config = buildAdvancedConfig(undefined, "atlas");
    // Adding 'x-forwarded-for' here would make the IP bucket client-
    // spoofable and reopen F-06. Removing the list entirely would
    // fall back to Better Auth's default (x-forwarded-for) — same
    // result. The list must be exactly our one custom header.
    expect(config.ipAddress.ipAddressHeaders).toEqual(["x-atlas-client-ip"]);
  });

  it("omits defaultCookieAttributes when cookieDomain is undefined", () => {
    const config = buildAdvancedConfig(undefined, "atlas");
    expect(config.defaultCookieAttributes).toBeUndefined();
  });

  it("sets a subdomain cookie when cookieDomain is provided", () => {
    const config = buildAdvancedConfig("useatlas.dev", "atlas");
    expect(config.defaultCookieAttributes).toEqual({ domain: ".useatlas.dev" });
  });

  it("threads cookiePrefix through verbatim (env-isolation knob)", () => {
    expect(buildAdvancedConfig(undefined, "atlas-staging").cookiePrefix).toBe("atlas-staging");
    expect(buildAdvancedConfig("staging.useatlas.dev", "atlas-staging")).toEqual({
      ipAddress: { ipAddressHeaders: ["x-atlas-client-ip"] },
      cookiePrefix: "atlas-staging",
      defaultCookieAttributes: { domain: ".staging.useatlas.dev" },
    });
  });
});

describe("deriveCookieDomain", () => {
  // Second arg is the single canonical app origin (getWebOrigin() — the first
  // CORS entry), NOT the whole allowlist, so an unrelated allowlisted origin
  // can't veto the shared domain. The call site resolves it via getWebOrigin().
  it("returns undefined when either input is absent (host-only cookies / self-hosted single-origin)", () => {
    expect(deriveCookieDomain(undefined, "https://app.useatlas.dev")).toBeUndefined();
    expect(deriveCookieDomain("https://api.useatlas.dev", undefined)).toBeUndefined();
    expect(deriveCookieDomain(undefined, undefined)).toBeUndefined();
  });

  it("prod: api + app under useatlas.dev → useatlas.dev (covers www + apex siblings)", () => {
    expect(
      deriveCookieDomain("https://api.useatlas.dev", "https://app.useatlas.dev"),
    ).toBe("useatlas.dev");
  });

  it("staging: keeps the env-specific parent (regression for the slice(-2) bleed)", () => {
    // The old `host.split('.').slice(-2)` collapsed this to `useatlas.dev`,
    // the same slot as prod. The common-suffix derivation keeps it scoped.
    expect(
      deriveCookieDomain("https://api.staging.useatlas.dev", "https://app.staging.useatlas.dev"),
    ).toBe("staging.useatlas.dev");
  });

  it("ignores the rest of the CORS allowlist — only the app origin is passed (P1)", () => {
    // Codex P1: folding in an unrelated allowlisted origin would collapse the
    // common suffix to nothing. The fix passes ONLY the app origin (getWebOrigin),
    // so deriveCookieDomain literally never sees embed.partner.com and derives
    // the correct app/API parent regardless of what else is allowlisted.
    expect(
      deriveCookieDomain("https://api.useatlas.dev", "https://app.useatlas.dev"),
    ).toBe("useatlas.dev");
    // A hypothetical "both args" different-site pair still yields undefined —
    // proving the unrelated origin must never reach this function as arg 2.
    expect(
      deriveCookieDomain("https://api.useatlas.dev", "https://embed.partner.com"),
    ).toBeUndefined();
  });

  it("self-hosted on a custom domain derives that domain (not hardcoded)", () => {
    expect(
      deriveCookieDomain("https://api.acme.example.com", "https://app.acme.example.com"),
    ).toBe("acme.example.com");
  });

  it("returns undefined when the hosts share no 2+ label suffix (different sites)", () => {
    expect(
      deriveCookieDomain("https://api.useatlas.dev", "https://app.example.org"),
    ).toBeUndefined();
  });

  it("returns undefined for single-label hosts (localhost)", () => {
    expect(deriveCookieDomain("http://localhost:3001", "http://localhost:3000")).toBeUndefined();
  });

  it("returns undefined for bare IPv4 (cookie domains can't be IPs)", () => {
    expect(deriveCookieDomain("http://127.0.0.1:3001", "http://127.0.0.1:3000")).toBeUndefined();
  });

  it("returns undefined for IPv6 literals (host-only)", () => {
    expect(deriveCookieDomain("http://[::1]:3001", "http://[::1]:3000")).toBeUndefined();
  });

  it("returns undefined when the app origin is malformed", () => {
    expect(deriveCookieDomain("https://api.staging.useatlas.dev", "not-a-url")).toBeUndefined();
    expect(deriveCookieDomain("not-a-url", "https://app.staging.useatlas.dev")).toBeUndefined();
  });

  it("documents the public-suffix limitation: no PSL, so same-2-label-suffix hosts collapse to it", () => {
    // KNOWN LIMITATION (no public-suffix-list awareness). Two *different*
    // registrable domains under a 2-label public suffix collapse to that
    // suffix; browsers then reject `.co.uk` via the PSL so the cookie fails
    // to set (no leak). Atlas's API + app are always one registrable domain.
    expect(
      deriveCookieDomain("https://api.acme.co.uk", "https://app.other.co.uk"),
    ).toBe("co.uk");
    // Same-tenant multi-label TLD works correctly (3-label common suffix).
    expect(
      deriveCookieDomain("https://api.acme.co.uk", "https://app.acme.co.uk"),
    ).toBe("acme.co.uk");
  });
});

describe("_sendVerificationOTP", () => {
  // Full delivery-module mock so partial-mock SyntaxErrors in unrelated
  // test files don't surface; plus the fire-and-forget contract
  // assertions so a thrown rejection from the OTP send can never
  // propagate out of the auth callback.
  const installDeliveryMock = (
    sendEmail: (msg: { to: string; subject: string; html: string }) => Promise<{
      success: boolean;
      provider: string;
      error?: string;
    }>,
  ): void => {
    mock.module("@atlas/api/lib/email/delivery", () => ({
      sendEmail,
      sendEmailWithTransport: async () => ({ success: true, provider: "resend" as const }),
      getEmailTransport: async () => null,
    }));
  };

  it("renders the OTP into the email body", async () => {
    const calls: Array<{ to: string; subject: string; html: string }> = [];
    installDeliveryMock(async (msg) => {
      calls.push(msg);
      return { success: true, provider: "resend" };
    });

    await _sendVerificationOTP({ to: "otp@example.com", otp: "ABCD1234" });

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("otp@example.com");
    expect(calls[0].subject.toLowerCase()).toContain("verification");
    // Surface the literal OTP — `<a href>` parsing is intentionally
    // absent here since OTP emails should NEVER carry a clickable
    // verification link (that's the magic-link path we're moving away
    // from). Future regression that adds an `<a href>` would be a UX
    // smell worth catching.
    expect(calls[0].html).toContain("ABCD1234");
    expect(calls[0].html).not.toMatch(/<a\s+href=/i);
  });

  it("does not throw when delivery returns success: false (preserves enumeration protection)", async () => {
    installDeliveryMock(async () => ({
      success: false,
      provider: "log" as const,
      error: "No email delivery backend configured",
    }));

    await expect(
      _sendVerificationOTP({ to: "otp@example.com", otp: "ABCD1234" }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when sendEmail itself throws", async () => {
    installDeliveryMock(async () => {
      throw new Error("Simulated provider crash");
    });

    await expect(
      _sendVerificationOTP({ to: "otp@example.com", otp: "ABCD1234" }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Regression tests for #1733 (F-07).
 *
 * The earlier `cookieCache: { maxAge: 5 * 60 }` meant banned or
 * compromised users stayed authenticated for up to 5 minutes after
 * `auth.api.banUser(...)` or `revokeSession(...)` because the signed
 * cookie short-circuited the DB lookup that surfaces the revocation.
 * These tests pin the resolver so the default can't silently drift back
 * and env-overrides can't restore a multi-minute revocation blind spot.
 */
describe("resolveSessionCookieCacheMaxAge", () => {
  it("defaults to 30 seconds when the env var is unset", () => {
    expect(resolveSessionCookieCacheMaxAge({} as NodeJS.ProcessEnv)).toBe(30);
    expect(SESSION_COOKIE_CACHE_DEFAULT_SEC).toBe(30);
  });

  it("defaults when the env var is an empty string", () => {
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_DEFAULT_SEC);
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "   ",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_DEFAULT_SEC);
  });

  it("accepts valid values within the [5, 300] bound", () => {
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "5",
      } as NodeJS.ProcessEnv),
    ).toBe(5);
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "60",
      } as NodeJS.ProcessEnv),
    ).toBe(60);
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "300",
      } as NodeJS.ProcessEnv),
    ).toBe(300);
  });

  it("floors fractional values", () => {
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "30.9",
      } as NodeJS.ProcessEnv),
    ).toBe(30);
  });

  it("clamps below-minimum values up to 5 — never disables the cache silently", () => {
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_MIN_SEC);
    expect(SESSION_COOKIE_CACHE_MIN_SEC).toBe(5);
  });

  it("clamps above-maximum values down to 300 — F-07 never opens a multi-minute revocation window", () => {
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "3600",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_MAX_SEC);
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "3000000",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_MAX_SEC);
    expect(SESSION_COOKIE_CACHE_MAX_SEC).toBe(300);
  });

  it("falls back to the default on non-numeric or non-positive values", () => {
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_DEFAULT_SEC);
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_DEFAULT_SEC);
    expect(
      resolveSessionCookieCacheMaxAge({
        ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC: "-10",
      } as NodeJS.ProcessEnv),
    ).toBe(SESSION_COOKIE_CACHE_DEFAULT_SEC);
  });

  it("F-07 invariant: default is materially shorter than the prior 5-minute value", () => {
    // If someone edits SESSION_COOKIE_CACHE_DEFAULT_SEC back up to 300+,
    // this test flips red — which is the whole point of pinning F-07.
    expect(SESSION_COOKIE_CACHE_DEFAULT_SEC).toBeLessThan(5 * 60);
    expect(SESSION_COOKIE_CACHE_DEFAULT_SEC).toBeLessThanOrEqual(30);
  });
});
