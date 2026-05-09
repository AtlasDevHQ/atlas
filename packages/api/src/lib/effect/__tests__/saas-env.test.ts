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
 *      each value flows through (`ATLAS_RATE_LIMIT_RPM` parses to ≥ 1
 *      per `RateLimitGuardLive`; `BETTER_AUTH_SECRET` ≥ 32 chars per
 *      `parseAuthSecret` in `lib/auth/server.ts` — that one is not
 *      a Atlas guard, but the API process exits at boot if it fails).
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

describe("indirect-read drift guard", () => {
  // The contract claim in saas-env.ts is that the fixture covers every
  // SaaS-required env var, including reads outside `effect/`. These
  // tests pin that claim by walking the indirect-read sites' source
  // and asserting every `process.env.X` they read is listed in
  // SAAS_ENV_KEYS — so a rename in either file (or a new read added
  // to either file) trips this test before reaching CI's boot smoke.
  // The discovery is via static-text grep, not runtime: the import
  // graph for these modules pulls in the full server, which the test
  // file deliberately avoids.

  async function readProcessEnvKeys(relativePath: string): Promise<Set<string>> {
    const fs = await import("fs/promises");
    const path = await import("path");
    // Resolve from packages/api/src/. import.meta.dir is the test
    // dir (lib/effect/__tests__) — three `..` walks back to src/.
    const abs = path.resolve(import.meta.dir, "..", "..", "..", relativePath);
    const src = await fs.readFile(abs, "utf8");
    const matches = src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
    return new Set([...matches].map((m) => m[1] as string));
  }

  test("every process.env.X in lib/email/dpa-guard.ts is in SAAS_ENV_KEYS", async () => {
    const reads = await readProcessEnvKeys("lib/email/dpa-guard.ts");
    expect(reads.size).toBeGreaterThan(0); // sanity: file did read at least one env var
    for (const key of reads) {
      expect(SAAS_ENV_KEYS).toContain(key as (typeof SAAS_ENV_KEYS)[number]);
    }
  });

  test("every process.env.X in lib/db/encryption-keys.ts is in SAAS_ENV_KEYS", async () => {
    const reads = await readProcessEnvKeys("lib/db/encryption-keys.ts");
    expect(reads.size).toBeGreaterThan(0);
    for (const key of reads) {
      expect(SAAS_ENV_KEYS).toContain(key as (typeof SAAS_ENV_KEYS)[number]);
    }
  });
});
