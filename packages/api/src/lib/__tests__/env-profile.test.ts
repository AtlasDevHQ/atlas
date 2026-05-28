import { describe, it, expect } from "bun:test";
import { resolveDeployEnv, getEnvProfile } from "@atlas/api/lib/env-profile";

describe("resolveDeployEnv", () => {
  it("defaults to production when ATLAS_DEPLOY_ENV is unset", () => {
    expect(resolveDeployEnv({})).toBe("production");
  });

  it("returns production for explicit production", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "production" })).toBe("production");
  });

  it("returns staging for staging", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "staging" })).toBe("staging");
  });

  it("returns development for development", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "development" })).toBe("development");
  });

  it("is case-insensitive", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "STAGING" })).toBe("staging");
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "Production" })).toBe("production");
  });

  it("trims whitespace", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "  staging  " })).toBe("staging");
  });

  it("falls back to production for unknown values (no hard-fail)", () => {
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "qa" })).toBe("production");
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "prod" })).toBe("production");
    expect(resolveDeployEnv({ ATLAS_DEPLOY_ENV: "" })).toBe("production");
  });
});

describe("getEnvProfile", () => {
  it("production uses parent cookieDomainStrategy (preserves existing behavior)", () => {
    expect(getEnvProfile({}).cookieDomainStrategy).toBe("parent");
    expect(getEnvProfile({ ATLAS_DEPLOY_ENV: "production" }).cookieDomainStrategy).toBe("parent");
  });

  it("staging uses host-only cookieDomainStrategy (isolates from prod parent)", () => {
    expect(getEnvProfile({ ATLAS_DEPLOY_ENV: "staging" }).cookieDomainStrategy).toBe("host-only");
  });

  it("development uses host-only cookieDomainStrategy", () => {
    expect(getEnvProfile({ ATLAS_DEPLOY_ENV: "development" }).cookieDomainStrategy).toBe("host-only");
  });

  it("unknown env falls through to production profile", () => {
    expect(getEnvProfile({ ATLAS_DEPLOY_ENV: "garbage" }).cookieDomainStrategy).toBe("parent");
  });
});
