import { describe, it, expect } from "bun:test";
import {
  resolveDeployEnv,
  getEnvProfile,
  resolveRequireEmailVerification,
  resolveOnboardingEmailsEnabled,
  resolveCookiePrefix,
  resolveRateLimitRpm,
  resolveMcpMaxSessions,
  resolveMailSink,
  resolveSeedDemo,
} from "@atlas/api/lib/env-profile";

describe("resolveDeployEnv", () => {
  it("defaults to production when ATLAS_DEPLOY_ENV is unset (preserves existing behavior)", () => {
    expect(resolveDeployEnv({})).toBe("production");
  });

  it("returns explicit production", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "production" })).toBe("production");
  });

  it("returns staging", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "staging" })).toBe("staging");
  });

  it("returns development", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "development" })).toBe("development");
  });

  it("is case-insensitive (STAGING/Production/etc.)", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "STAGING" })).toBe("staging");
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "Production" })).toBe("production");
  });

  it("trims whitespace", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "  staging  " })).toBe("staging");
  });

  it("falls back to production for unknown values (no hard-fail on typos)", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "qa" })).toBe("production");
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "prod" })).toBe("production");
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "" })).toBe("production");
  });
});

describe("getEnvProfile", () => {
  it("production profile: verification on, onboarding emails on, cookiePrefix atlas", () => {
    const p = getEnvProfile({ ATLAS_DEPLOY_ENV: "production" });
    expect(p.requireEmailVerification).toBe(true);
    expect(p.onboardingEmailsEnabled).toBe(true);
    expect(p.cookiePrefix).toBe("atlas");
    // Phase 2 (#2937): production/dev have NO managed rate-limit default so
    // self-hosted stays disabled-by-default; mcp cap 100; sink + seed defaults.
    expect(p.rateLimitRpm).toBeNull();
    expect(p.mcpMaxSessions).toBe(100);
    expect(p.mailSink).toBe("staging-mail@useatlas.dev");
    expect(p.seedDemo).toBe(false);
  });

  it("staging profile: verification off, onboarding off, cookiePrefix atlas-staging", () => {
    const p = getEnvProfile({ ATLAS_DEPLOY_ENV: "staging" });
    expect(p.requireEmailVerification).toBe(false);
    expect(p.onboardingEmailsEnabled).toBe(false);
    expect(p.cookiePrefix).toBe("atlas-staging");
    // Staging carries a real rate-limit default (300); same sink as every
    // profile (region↔env-mismatch leak guard); cap 100; no auto-seed.
    expect(p.rateLimitRpm).toBe(300);
    expect(p.mcpMaxSessions).toBe(100);
    expect(p.mailSink).toBe("staging-mail@useatlas.dev");
    expect(p.seedDemo).toBe(false);
  });

  it("development profile: verification off, onboarding off, cookiePrefix atlas-dev", () => {
    const p = getEnvProfile({ ATLAS_DEPLOY_ENV: "development" });
    expect(p.requireEmailVerification).toBe(false);
    expect(p.onboardingEmailsEnabled).toBe(false);
    expect(p.cookiePrefix).toBe("atlas-dev");
    expect(p.rateLimitRpm).toBeNull();
    expect(p.mcpMaxSessions).toBe(100);
    expect(p.mailSink).toBe("staging-mail@useatlas.dev");
    expect(p.seedDemo).toBe(false);
  });

  it("unset env falls through to production profile", () => {
    const p = getEnvProfile({});
    expect(p.requireEmailVerification).toBe(true);
    expect(p.onboardingEmailsEnabled).toBe(true);
  });
});

describe("resolveRequireEmailVerification", () => {
  it("env var unset + production profile → true (existing prod behavior)", () => {
    expect(resolveRequireEmailVerification({ ATLAS_DEPLOY_ENV: "production" })).toBe(true);
  });

  it("env var unset + staging profile → false", () => {
    expect(resolveRequireEmailVerification({ ATLAS_DEPLOY_ENV: "staging" })).toBe(false);
  });

  it("env var = false overrides profile (operator escape hatch)", () => {
    expect(
      resolveRequireEmailVerification({
        ATLAS_DEPLOY_ENV: "production",
        ATLAS_REQUIRE_EMAIL_VERIFICATION: "false",
      }),
    ).toBe(false);
  });

  it("env var = true overrides staging profile (e.g. a staging service that wants verification on)", () => {
    expect(
      resolveRequireEmailVerification({
        ATLAS_DEPLOY_ENV: "staging",
        ATLAS_REQUIRE_EMAIL_VERIFICATION: "true",
      }),
    ).toBe(true);
  });

  it("env var accepts 0/no/off as opt-out (case-insensitive)", () => {
    expect(resolveRequireEmailVerification({ ATLAS_REQUIRE_EMAIL_VERIFICATION: "0" })).toBe(false);
    expect(resolveRequireEmailVerification({ ATLAS_REQUIRE_EMAIL_VERIFICATION: "NO" })).toBe(false);
    expect(resolveRequireEmailVerification({ ATLAS_REQUIRE_EMAIL_VERIFICATION: "Off" })).toBe(false);
  });

  it("env var with unrecognized value → true (preserves pre-migration default semantics)", () => {
    expect(resolveRequireEmailVerification({ ATLAS_REQUIRE_EMAIL_VERIFICATION: "yes" })).toBe(true);
    expect(resolveRequireEmailVerification({ ATLAS_REQUIRE_EMAIL_VERIFICATION: "1" })).toBe(true);
  });
});

describe("resolveOnboardingEmailsEnabled", () => {
  it("env var unset + production profile → true", () => {
    expect(resolveOnboardingEmailsEnabled({ ATLAS_DEPLOY_ENV: "production" })).toBe(true);
  });

  it("env var unset + staging profile → false", () => {
    expect(resolveOnboardingEmailsEnabled({ ATLAS_DEPLOY_ENV: "staging" })).toBe(false);
  });

  it("env var = true overrides staging profile", () => {
    expect(
      resolveOnboardingEmailsEnabled({
        ATLAS_DEPLOY_ENV: "staging",
        ATLAS_ONBOARDING_EMAILS_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("env var = false overrides production profile (silences onboarding on a prod hotfix scenario)", () => {
    expect(
      resolveOnboardingEmailsEnabled({
        ATLAS_DEPLOY_ENV: "production",
        ATLAS_ONBOARDING_EMAILS_ENABLED: "false",
      }),
    ).toBe(false);
  });

  it("env var with any non-true value → false (preserves pre-migration narrow grammar)", () => {
    expect(resolveOnboardingEmailsEnabled({ ATLAS_ONBOARDING_EMAILS_ENABLED: "1" })).toBe(false);
    expect(resolveOnboardingEmailsEnabled({ ATLAS_ONBOARDING_EMAILS_ENABLED: "yes" })).toBe(false);
    expect(resolveOnboardingEmailsEnabled({ ATLAS_ONBOARDING_EMAILS_ENABLED: "" })).toBe(false);
  });
});

describe("resolveCookiePrefix", () => {
  it("env unset → production profile prefix 'atlas' (self-hosted default)", () => {
    expect(resolveCookiePrefix({})).toBe("atlas");
    expect(resolveCookiePrefix({ ATLAS_DEPLOY_ENV: "production" })).toBe("atlas");
  });

  it("staging profile → 'atlas-staging' (isolated from prod's cookie slot)", () => {
    expect(resolveCookiePrefix({ ATLAS_DEPLOY_ENV: "staging" })).toBe("atlas-staging");
  });

  it("development profile → 'atlas-dev'", () => {
    expect(resolveCookiePrefix({ ATLAS_DEPLOY_ENV: "development" })).toBe("atlas-dev");
  });

  it("ATLAS_COOKIE_PREFIX override wins over the profile default", () => {
    expect(
      resolveCookiePrefix({ ATLAS_DEPLOY_ENV: "staging", ATLAS_COOKIE_PREFIX: "custom" }),
    ).toBe("custom");
  });

  it("blank/whitespace ATLAS_COOKIE_PREFIX falls back to the profile (no empty prefix)", () => {
    expect(resolveCookiePrefix({ ATLAS_DEPLOY_ENV: "staging", ATLAS_COOKIE_PREFIX: "   " })).toBe(
      "atlas-staging",
    );
    expect(resolveCookiePrefix({ ATLAS_COOKIE_PREFIX: "" })).toBe("atlas");
  });
});

describe("resolveRateLimitRpm (#2937)", () => {
  it("production/development profile → undefined (no managed default; self-hosted disabled)", () => {
    expect(resolveRateLimitRpm({ ATLAS_DEPLOY_ENV: "production" })).toBeUndefined();
    expect(resolveRateLimitRpm({ ATLAS_DEPLOY_ENV: "development" })).toBeUndefined();
    // Unset env → production profile → undefined (the self-hosted default path).
    expect(resolveRateLimitRpm({})).toBeUndefined();
  });

  it("staging profile → '300' (string, slots into getSetting's string contract)", () => {
    expect(resolveRateLimitRpm({ ATLAS_DEPLOY_ENV: "staging" })).toBe("300");
  });

  it("env var overrides the profile default verbatim", () => {
    expect(resolveRateLimitRpm({ ATLAS_DEPLOY_ENV: "staging", ATLAS_RATE_LIMIT_RPM: "500" })).toBe(
      "500",
    );
    // Override a production deploy to opt into a limit.
    expect(
      resolveRateLimitRpm({ ATLAS_DEPLOY_ENV: "production", ATLAS_RATE_LIMIT_RPM: "120" }),
    ).toBe("120");
  });

  it("explicit empty env var wins (operator's deliberate 'disable'), not the profile", () => {
    // "" is a set value → returned verbatim so getRpmLimit() treats it as
    // disabled, rather than falling through to the staging profile's 300.
    expect(resolveRateLimitRpm({ ATLAS_DEPLOY_ENV: "staging", ATLAS_RATE_LIMIT_RPM: "" })).toBe("");
  });
});

describe("resolveMcpMaxSessions (#2937)", () => {
  it("every profile defaults to 100 (preserves the historical flat default)", () => {
    expect(resolveMcpMaxSessions({ ATLAS_DEPLOY_ENV: "production" })).toBe(100);
    expect(resolveMcpMaxSessions({ ATLAS_DEPLOY_ENV: "staging" })).toBe(100);
    expect(resolveMcpMaxSessions({ ATLAS_DEPLOY_ENV: "development" })).toBe(100);
    expect(resolveMcpMaxSessions({})).toBe(100);
  });

  it("a positive-integer env var overrides the profile default", () => {
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "250" })).toBe(250);
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "  42  " })).toBe(42);
  });

  it("malformed / non-positive overrides fall back to the profile default", () => {
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "abc" })).toBe(100);
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "0" })).toBe(100);
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "-5" })).toBe(100);
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "" })).toBe(100);
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "   " })).toBe(100);
  });

  it("parseInt-truncates a decimal override (parity with the legacy parser)", () => {
    // Number.parseInt("12.9", 10) === 12 — same as the prior raw read.
    expect(resolveMcpMaxSessions({ ATLAS_MCP_MAX_SESSIONS: "12.9" })).toBe(12);
  });
});

describe("resolveMailSink (#2937)", () => {
  it("every profile default is the same sink (region↔env-mismatch leak guard)", () => {
    expect(resolveMailSink({ ATLAS_DEPLOY_ENV: "production" })).toBe("staging-mail@useatlas.dev");
    expect(resolveMailSink({ ATLAS_DEPLOY_ENV: "staging" })).toBe("staging-mail@useatlas.dev");
    expect(resolveMailSink({ ATLAS_DEPLOY_ENV: "development" })).toBe("staging-mail@useatlas.dev");
    expect(resolveMailSink({})).toBe("staging-mail@useatlas.dev");
  });

  it("honors STAGING_MAIL_SINK when set", () => {
    expect(resolveMailSink({ STAGING_MAIL_SINK: "soak-inbox@staging.useatlas.dev" })).toBe(
      "soak-inbox@staging.useatlas.dev",
    );
  });

  it("empty / whitespace-only STAGING_MAIL_SINK falls back to the default (|| not ??)", () => {
    // The anti-footgun the staging clamp relies on: a blank override must not
    // blank the recipient. `.trim()` collapses a whitespace-only value too.
    expect(resolveMailSink({ STAGING_MAIL_SINK: "" })).toBe("staging-mail@useatlas.dev");
    expect(resolveMailSink({ STAGING_MAIL_SINK: "   " })).toBe("staging-mail@useatlas.dev");
  });
});

describe("resolveSeedDemo (#2937)", () => {
  it("every profile defaults to false (demo seeding is opt-in via the env var)", () => {
    expect(resolveSeedDemo({ ATLAS_DEPLOY_ENV: "production" })).toBe(false);
    expect(resolveSeedDemo({ ATLAS_DEPLOY_ENV: "staging" })).toBe(false);
    expect(resolveSeedDemo({ ATLAS_DEPLOY_ENV: "development" })).toBe(false);
    expect(resolveSeedDemo({})).toBe(false);
  });

  it("ATLAS_SEED_DEMO=true enables (the demo template's explicit opt-in)", () => {
    expect(resolveSeedDemo({ ATLAS_SEED_DEMO: "true" })).toBe(true);
  });

  it("mirrors the shell `= \"true\"` check EXACTLY: any other set value is false, never the profile", () => {
    // A set-but-not-"true" value means "do not seed" and must NOT fall through
    // to the profile default — matching `[ "$ATLAS_SEED_DEMO" = "true" ]`.
    expect(resolveSeedDemo({ ATLAS_SEED_DEMO: "false" })).toBe(false);
    expect(resolveSeedDemo({ ATLAS_SEED_DEMO: "1" })).toBe(false);
    expect(resolveSeedDemo({ ATLAS_SEED_DEMO: "TRUE" })).toBe(false); // case-sensitive, like shell
    expect(resolveSeedDemo({ ATLAS_SEED_DEMO: "" })).toBe(false);
    expect(resolveSeedDemo({ ATLAS_SEED_DEMO: " true " })).toBe(false); // shell wouldn't match with spaces
  });
});
