import { describe, it, expect } from "bun:test";
import {
  resolveDeployEnv,
  getEnvProfile,
  resolveRequireEmailVerification,
  resolveOnboardingEmailsEnabled,
  resolveCookiePrefix,
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
  });

  it("staging profile: verification off, onboarding off, cookiePrefix atlas-staging", () => {
    const p = getEnvProfile({ ATLAS_DEPLOY_ENV: "staging" });
    expect(p.requireEmailVerification).toBe(false);
    expect(p.onboardingEmailsEnabled).toBe(false);
    expect(p.cookiePrefix).toBe("atlas-staging");
  });

  it("development profile: verification off, onboarding off, cookiePrefix atlas-dev", () => {
    const p = getEnvProfile({ ATLAS_DEPLOY_ENV: "development" });
    expect(p.requireEmailVerification).toBe(false);
    expect(p.onboardingEmailsEnabled).toBe(false);
    expect(p.cookiePrefix).toBe("atlas-dev");
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
