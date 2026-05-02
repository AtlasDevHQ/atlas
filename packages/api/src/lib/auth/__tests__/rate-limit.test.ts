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
  _sendVerificationEmail,
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
    const config = buildAdvancedConfig(undefined);
    // Adding 'x-forwarded-for' here would make the IP bucket client-
    // spoofable and reopen F-06. Removing the list entirely would
    // fall back to Better Auth's default (x-forwarded-for) — same
    // result. The list must be exactly our one custom header.
    expect(config.ipAddress.ipAddressHeaders).toEqual(["x-atlas-client-ip"]);
  });

  it("omits defaultCookieAttributes when cookieDomain is undefined", () => {
    const config = buildAdvancedConfig(undefined);
    expect(config.defaultCookieAttributes).toBeUndefined();
  });

  it("sets a subdomain cookie when cookieDomain is provided", () => {
    const config = buildAdvancedConfig("useatlas.dev");
    expect(config.defaultCookieAttributes).toEqual({ domain: ".useatlas.dev" });
  });
});

describe("_sendVerificationEmail", () => {
  // Mock ALL runtime exports of the delivery module — partial mocks
  // can surface as SyntaxError in sibling test files that import
  // `sendEmailWithTransport` after this file mutates the module cache.
  const installDeliveryMock = (sendEmail: (msg: { to: string; subject: string; html: string }) => Promise<{ success: boolean; provider: string; error?: string }>): void => {
    mock.module("@atlas/api/lib/email/delivery", () => ({
      sendEmail,
      sendEmailWithTransport: async () => ({ success: true, provider: "resend" as const }),
      getEmailTransport: async () => null,
    }));
  };

  it("calls sendEmail with the verification URL in an <a href>", async () => {
    const calls: Array<{ to: string; subject: string; html: string }> = [];
    installDeliveryMock(async (msg) => {
      calls.push(msg);
      return { success: true, provider: "resend" };
    });

    await _sendVerificationEmail({
      to: "verify@example.com",
      url: "https://example.com/verify?token=abc123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("verify@example.com");
    expect(calls[0].subject).toContain("Verify");
    // & is HTML-escaped in attribute values; the literal URL becomes
    // `...?token=abc123` with `&amp;` separators, but a single-arg
    // URL has no & to escape. Assert containment on a unique token
    // substring instead so the escaper is allowed to change.
    expect(calls[0].html).toContain("token=abc123");
    expect(calls[0].html).toContain("<a href=");
  });

  it("HTML-escapes URLs that contain attribute-breaking characters", async () => {
    const calls: Array<{ html: string }> = [];
    installDeliveryMock(async (msg) => {
      calls.push({ html: msg.html });
      return { success: true, provider: "resend" };
    });

    // If a malformed Better Auth URL somehow contained a quote or &,
    // the raw interpolation would break the href attribute. The
    // escape pass prevents that from rendering as broken markup.
    await _sendVerificationEmail({
      to: "verify@example.com",
      url: 'https://example.com/verify?a=1&b="2"',
    });

    expect(calls[0].html).not.toContain('b="2"');
    expect(calls[0].html).toContain("&amp;");
    expect(calls[0].html).toContain("&quot;");
  });

  // Each XML-special character must round-trip through the href
  // attribute as its HTML entity. Dropping any of these would either
  // break attribute parsing in email clients (rendering the link
  // inert) or, worst case, create an XSS vector if a future Better
  // Auth URL carried user-controlled data.
  it.each([
    { char: "'", entity: "&#39;", fragment: "?x='y" },
    { char: "<", entity: "&lt;", fragment: "?x=<y" },
    { char: ">", entity: "&gt;", fragment: "?x=>y" },
  ] as const)("escapes $char to $entity inside the href attribute", async ({ char, entity, fragment }: { char: string; entity: string; fragment: string }) => {
    const calls: Array<{ html: string }> = [];
    installDeliveryMock(async (msg) => {
      calls.push({ html: msg.html });
      return { success: true, provider: "resend" };
    });

    await _sendVerificationEmail({
      to: "verify@example.com",
      url: `https://example.com/verify${fragment}`,
    });

    // Extract the href="..." attribute value and assert on it only —
    // the surrounding template legitimately contains <, >, and '.
    const hrefMatch = calls[0].html.match(/href="([^"]+)"/);
    expect(hrefMatch).not.toBeNull();
    const hrefValue = hrefMatch![1];
    expect(hrefValue).not.toContain(char);
    expect(hrefValue).toContain(entity);
  });

  it("does not throw when delivery returns success: false (preserves enumeration protection)", async () => {
    installDeliveryMock(async () => ({
      success: false,
      provider: "log" as const,
      error: "No email delivery backend configured",
    }));

    // If this throws, the Better Auth handler would 500 and the
    // attacker could distinguish "new email + no provider" (500)
    // from "existing email" (200) — resurrecting the enumeration
    // oracle through a different channel.
    await expect(
      _sendVerificationEmail({
        to: "verify@example.com",
        url: "https://example.com/verify?token=abc123",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when sendEmail itself throws (provider SDK crash / network error)", async () => {
    installDeliveryMock(async () => {
      throw new Error("Simulated provider crash");
    });

    // Same contract: thrown rejections must NOT propagate, otherwise
    // the Better Auth callback becomes an unhandled rejection that
    // either spams stderr or — with --unhandled-rejections=strict —
    // terminates the process mid-signup.
    await expect(
      _sendVerificationEmail({
        to: "verify@example.com",
        url: "https://example.com/verify?token=abc123",
      }),
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
