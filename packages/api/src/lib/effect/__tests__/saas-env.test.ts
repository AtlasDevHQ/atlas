/**
 * Tests for the SaaS env contract single-source-of-truth (#2226).
 *
 * `SaasEnv` enumerates every env var the SaaS-mode boot guards read.
 * `makeBootSmokeFixture()` returns a complete shape with sane CI
 * defaults. These tests pin shape-level invariants:
 *
 *   1. Adding a field to `SaasEnv` without appending it to
 *      `SAAS_ENV_KEYS` (the exhaustiveness array) is caught at
 *      compile time by the `_ExhaustiveCheck` clause AND at runtime
 *      here.
 *   2. Per-field fixture values satisfy the parser-level requirements
 *      that each guard reads (`ATLAS_RATE_LIMIT_RPM` parses to ≥ 1,
 *      `BETTER_AUTH_SECRET` ≥ 32 chars, etc.).
 *
 * Guard-level acceptance — does the fixture actually pass each guard's
 * `Effect.fail` branch? — is the boot-smoke workflow's job; running
 * every guard against the fixture would duplicate that integration
 * coverage at unit level. If a guard tightens a parser-level rule
 * (e.g. requires `ATLAS_RATE_LIMIT_RPM` ≥ 60), update both the per-field
 * assertion below and the fixture default.
 */

import { describe, test, expect } from "bun:test";
import {
  SAAS_ENV_KEYS,
  makeBootSmokeFixture,
  readSaasEnv,
  type SaasEnv,
} from "../saas-env";

describe("SAAS_ENV_KEYS", () => {
  test("enumerates every key in SaasEnv", () => {
    // Build an exhaustive SaasEnv literal — the type narrows so any
    // missing key is a compile error here. The runtime check then
    // confirms SAAS_ENV_KEYS lists each one.
    const exhaustive: SaasEnv = {
      ATLAS_DEPLOY_MODE: undefined,
      ATLAS_ENTERPRISE_ENABLED: undefined,
      DATABASE_URL: undefined,
      ATLAS_DATASOURCE_URL: undefined,
      ATLAS_ENCRYPTION_KEYS: undefined,
      ATLAS_ENCRYPTION_KEY: undefined,
      BETTER_AUTH_SECRET: undefined,
      ATLAS_RATE_LIMIT_RPM: undefined,
      ATLAS_API_REGION: undefined,
      ATLAS_REGION_US_DB_URL: undefined,
      ATLAS_REGION_EU_DB_URL: undefined,
      ATLAS_REGION_APAC_DB_URL: undefined,
      ATLAS_STRICT_PLUGIN_SECRETS: undefined,
      ATLAS_SMTP_URL: undefined,
      RESEND_API_KEY: undefined,
      BETTER_AUTH_URL: undefined,
      BETTER_AUTH_TRUSTED_ORIGINS: undefined,
    };
    const expectedKeys: readonly string[] = Object.keys(exhaustive).sort();
    const actualKeys: readonly string[] = [...SAAS_ENV_KEYS].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  test("has no duplicates", () => {
    const set = new Set(SAAS_ENV_KEYS);
    expect(set.size).toBe(SAAS_ENV_KEYS.length);
  });
});

describe("readSaasEnv", () => {
  test("reads from a custom env object when provided", () => {
    const env = readSaasEnv({
      ATLAS_DEPLOY_MODE: "saas",
      DATABASE_URL: "postgresql://x/y",
    } as NodeJS.ProcessEnv);
    expect(env.ATLAS_DEPLOY_MODE).toBe("saas");
    expect(env.DATABASE_URL).toBe("postgresql://x/y");
    expect(env.RESEND_API_KEY).toBeUndefined();
  });
});

describe("makeBootSmokeFixture", () => {
  test("returns valid SaaS values for every required guard input", () => {
    const fixture = makeBootSmokeFixture();
    // Each of these is read by a guard that fails boot when missing or
    // misshapen. If any is dropped from the fixture, the boot-smoke
    // gate can't pass.
    expect(fixture.ATLAS_DEPLOY_MODE).toBe("saas");
    expect(fixture.ATLAS_ENTERPRISE_ENABLED).toBe("true");
    expect(fixture.DATABASE_URL).toMatch(/^postgresql:\/\//);
    expect(fixture.ATLAS_DATASOURCE_URL).toMatch(/^postgresql:\/\//);
    expect(fixture.ATLAS_ENCRYPTION_KEYS).toMatch(/^v1:/);
    // RateLimit guard rejects n < 1; "300" parses to 300.
    expect(Number(fixture.ATLAS_RATE_LIMIT_RPM)).toBeGreaterThanOrEqual(1);
    // Better Auth requires ≥ 32 chars (parseAuthSecret in lib/auth/server.ts).
    expect(fixture.BETTER_AUTH_SECRET?.length ?? 0).toBeGreaterThanOrEqual(32);
    expect(fixture.ATLAS_API_REGION).toBe("us");
    expect(fixture.RESEND_API_KEY).toBeTruthy();
  });

  test("databaseUrl override flows to internal + datasource + every region", () => {
    const fixture = makeBootSmokeFixture({
      databaseUrl: "postgresql://probe/db",
    });
    expect(fixture.DATABASE_URL).toBe("postgresql://probe/db");
    expect(fixture.ATLAS_DATASOURCE_URL).toBe("postgresql://probe/db");
    expect(fixture.ATLAS_REGION_US_DB_URL).toBe("postgresql://probe/db");
    expect(fixture.ATLAS_REGION_EU_DB_URL).toBe("postgresql://probe/db");
    expect(fixture.ATLAS_REGION_APAC_DB_URL).toBe("postgresql://probe/db");
  });

  test("overrides win over fixture defaults", () => {
    const fixture = makeBootSmokeFixture({
      overrides: { ATLAS_RATE_LIMIT_RPM: "1200", RESEND_API_KEY: undefined },
    });
    expect(fixture.ATLAS_RATE_LIMIT_RPM).toBe("1200");
    expect(fixture.RESEND_API_KEY).toBeUndefined();
  });
});
