/**
 * Tests for the SaaS boot-guard family (#1978).
 *
 * Each guard has a test pair — SaaS+misconfig → throws at boot,
 * self-hosted+anything → ok — and the tagged error class is asserted
 * directly on the failure cause so the `_tag` field's purpose
 * (discriminating which misconfig class fired) is exercised.
 *
 * The logger mock at module level was originally introduced to capture
 * `warnIfDeployModeSilentlyDowngraded` emissions. That helper has since
 * moved to `lib/config.ts` (its tests moved with it); the mock stays
 * here so future tests in this file can observe `saas-guards.ts` log
 * output without rewiring imports.
 */

import { describe, test, expect, mock } from "bun:test";
import { Effect, Exit, Layer } from "effect";

// Logger no-op mock — keeps these tests quiet (and isolated from any
// real logger configuration the test runner has set up). All log calls
// inside `saas-guards.ts` are observational; nothing in this file
// asserts log content (the deploy-mode-warning emission test moved to
// `lib/__tests__/config-deploy-mode-warning.test.ts` when the helper
// was inlined into `lib/config.ts`).
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
}));

// Type-only imports for the tagged error classes and the `Config` Tag
// type — needed because the runtime values are pulled in via dynamic
// `await import(...)` after the logger mock is installed, which gives
// us values but not types.
import type { Config as TConfig, ConfigShape } from "../layers";
import type {
  EnterpriseRequiredError as TEnterpriseRequiredError,
  EncryptionKeyMissingError as TEncryptionKeyMissingError,
  EncryptionKeyMalformedError as TEncryptionKeyMalformedError,
  InternalDatabaseRequiredError as TInternalDatabaseRequiredError,
  RateLimitRequiredError as TRateLimitRequiredError,
  RegionMisconfiguredError as TRegionMisconfiguredError,
} from "../saas-guards";

const {
  EnterpriseGuardLive,
  EnterpriseRequiredError,
  EncryptionKeyGuardLive,
  EncryptionKeyMissingError,
  EncryptionKeyMalformedError,
  InternalDbGuardLive,
  InternalDatabaseRequiredError,
  RateLimitGuardLive,
  RateLimitRequiredError,
  RegionGuardLive,
  RegionMisconfiguredError,
} = await import("../saas-guards");
const { Config } = await import("../layers");
const { _resetEncryptionKeyCache } = await import("@atlas/api/lib/db/encryption-keys");

// ── Test helpers ────────────────────────────────────────────────────

function makeTestConfigLayer(
  config: Record<string, unknown> = {},
): Layer.Layer<TConfig> {
  return Layer.succeed(Config, {
    config: config as unknown as ConfigShape["config"],
  });
}

const GUARD_ENV_KEYS = [
  "ATLAS_DEPLOY_MODE",
  "ATLAS_ENCRYPTION_KEYS",
  "ATLAS_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "ATLAS_RATE_LIMIT_RPM",
  "ATLAS_API_REGION",
  "ATLAS_STRICT_PLUGIN_SECRETS",
] as const;

function withCleanEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of GUARD_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  _resetEncryptionKeyCache();
  return run().finally(() => {
    for (const key of GUARD_ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    _resetEncryptionKeyCache();
  });
}

// ══════════════════════════════════════════════════════════════════════
// ██  EnterpriseGuardLive
// ══════════════════════════════════════════════════════════════════════

describe("EnterpriseGuardLive", () => {
  test("fails boot when ATLAS_DEPLOY_MODE=saas in env but resolved deployMode is self-hosted", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_DEPLOY_MODE = "saas";
      // Resolved deployMode is self-hosted because enterprise was not enabled.
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EnterpriseGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(EnterpriseRequiredError);
      expect((failure as TEnterpriseRequiredError)._tag).toBe("EnterpriseRequiredError");
      expect((failure as TEnterpriseRequiredError).message).toContain("#1978");
      // Env-only is a structural invariant — config-file rejections fall
      // through to `warnIfDeployModeSilentlyDowngraded` and never construct
      // this error class. Keep the env-trigger assertion explicit.
      expect((failure as TEnterpriseRequiredError).message).toContain("ATLAS_DEPLOY_MODE=saas");
    });
  });

  test("succeeds when ATLAS_DEPLOY_MODE=saas and resolved deployMode is also saas", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_DEPLOY_MODE = "saas";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EnterpriseGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted regardless of resolved value", async () => {
    await withCleanEnv(async () => {
      // No env override; config-file resolution
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EnterpriseGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("does not fail boot when env requests self-hosted explicitly", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_DEPLOY_MODE = "self-hosted";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EnterpriseGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// ██  EncryptionKeyGuardLive
// ══════════════════════════════════════════════════════════════════════

describe("EncryptionKeyGuardLive", () => {
  test("fails boot in SaaS when no encryption key env var is set", async () => {
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(EncryptionKeyMissingError);
      expect((failure as TEncryptionKeyMissingError)._tag).toBe("EncryptionKeyMissingError");
      expect((failure as TEncryptionKeyMissingError).message).toContain("#1978");
    });
  });

  test("fails boot in SaaS when ATLAS_ENCRYPTION_KEYS is malformed (vlatest:)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "vlatest:abc";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(EncryptionKeyMalformedError);
      expect((failure as TEncryptionKeyMalformedError)._tag).toBe("EncryptionKeyMalformedError");
      // `cause` is the original Error from the parser — verify both that
      // it's an Error instance (preserved stack) and that its message
      // identifies the malformed entry.
      const cause = (failure as TEncryptionKeyMalformedError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).toContain("vlatest");
    });
  });

  test("fails boot in SaaS when ATLAS_ENCRYPTION_KEYS has duplicate versions", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:secret-a,v1:secret-b";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(EncryptionKeyMalformedError);
    });
  });

  test("succeeds in SaaS when ATLAS_ENCRYPTION_KEYS is well-formed", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "v1:thisisaverysecretkeyatleast32characterslong";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds in SaaS when only ATLAS_ENCRYPTION_KEY (legacy single-key) is set", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_ENCRYPTION_KEY = "thisisaverysecretkeyatleast32characterslong";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  // Source-precedence regression guard. `getEncryptionKeyset()` checks
  // env vars in priority order (KEYS → KEY → BETTER_AUTH_SECRET) and
  // throws on the first malformed input — it does NOT fall through to
  // a valid lower-priority var. A future "fall back on parse error"
  // refactor would silently downgrade ciphertext compatibility (a
  // write under v2 would 500 on read after fallback to v1). This test
  // codifies the strict-precedence contract.
  test("fails in SaaS when malformed KEYS shadows a valid BETTER_AUTH_SECRET (precedence is load-bearing)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "vlatest:abc";
      process.env.BETTER_AUTH_SECRET = "thisisaverysecretkeyatleast32characterslong";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(EncryptionKeyMalformedError);
    });
  });

  test("succeeds in SaaS when only BETTER_AUTH_SECRET is set (deprecated fallback path)", async () => {
    await withCleanEnv(async () => {
      process.env.BETTER_AUTH_SECRET = "thisisaverysecretkeyatleast32characterslong";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted regardless of key configuration", async () => {
    await withCleanEnv(async () => {
      // No keys at all — self-hosted preserves dev-friendly passthrough.
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("self-hosted with malformed ATLAS_ENCRYPTION_KEYS does not fail boot (operator owns the risk)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_ENCRYPTION_KEYS = "vlatest:abc";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            EncryptionKeyGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      // Self-hosted skips the eager check entirely — the lazy throw at first
      // I/O is acceptable for AGPL-core users running their own deployment.
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// ██  InternalDbGuardLive
// ══════════════════════════════════════════════════════════════════════

describe("InternalDbGuardLive", () => {
  test("fails boot in SaaS when DATABASE_URL is unset", async () => {
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            InternalDbGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(InternalDatabaseRequiredError);
      expect((failure as TInternalDatabaseRequiredError)._tag).toBe("InternalDatabaseRequiredError");
      expect((failure as TInternalDatabaseRequiredError).message).toContain("#1978");
      expect((failure as TInternalDatabaseRequiredError).message).toContain("DATABASE_URL");
    });
  });

  test("succeeds in SaaS when DATABASE_URL is set", async () => {
    await withCleanEnv(async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            InternalDbGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted with DATABASE_URL unset (warning-only path)", async () => {
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            InternalDbGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// ██  RateLimitGuardLive (#1983)
// ══════════════════════════════════════════════════════════════════════

describe("RateLimitGuardLive", () => {
  test("fails boot in SaaS when ATLAS_RATE_LIMIT_RPM is unset", async () => {
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RateLimitRequiredError);
      expect((failure as TRateLimitRequiredError)._tag).toBe("RateLimitRequiredError");
      expect((failure as TRateLimitRequiredError).message).toContain("#1983");
      expect((failure as TRateLimitRequiredError).message).toContain("ATLAS_RATE_LIMIT_RPM");
    });
  });

  test("fails boot in SaaS when ATLAS_RATE_LIMIT_RPM is empty string", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RateLimitRequiredError);
    });
  });

  // "0" is the documented disabled-rate-limit sentinel in the runtime
  // path (`getRpmLimit()` returns 0 → `checkRateLimit` short-circuits
  // to "always allowed") — but in SaaS that's the DDoS hole the issue
  // describes. Boot must fail rather than accept the explicit-disable.
  test("fails boot in SaaS when ATLAS_RATE_LIMIT_RPM=0 (disabled sentinel)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "0";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RateLimitRequiredError);
    });
  });

  // The guard tightens the runtime parser at the `0` boundary AND
  // rejects fractional `0 < n < 1` (where `Math.floor(n) === 0` would
  // disable the limiter at runtime). A typo (`-300`, `abc`) rejects via
  // the non-finite branch.
  test("fails boot in SaaS when ATLAS_RATE_LIMIT_RPM is non-numeric", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "not-a-number";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RateLimitRequiredError);
    });
  });

  // Parser-divergence regression guard. Runtime path:
  // `getRpmLimit()` returns `Math.floor(0.5) === 0`, then
  // `checkRateLimit` short-circuits on `limit === 0` → disabled.
  // The boot guard rejects via `n < 1` so the silent runtime-disabled
  // state can't pass boot. Loosening this branch back to `n <= 0`
  // would re-open the hole.
  test("fails boot in SaaS when ATLAS_RATE_LIMIT_RPM is fractional (Math.floor disables at runtime)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "0.5";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RateLimitRequiredError);
    });
  });

  test("fails boot in SaaS when ATLAS_RATE_LIMIT_RPM=0.99 (floor still 0)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "0.99";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  // `n < 1` boundary — `1` itself must pass.
  test("succeeds in SaaS when ATLAS_RATE_LIMIT_RPM=1 (boundary)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "1";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds in SaaS when ATLAS_RATE_LIMIT_RPM is a positive number", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_RATE_LIMIT_RPM = "300";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted with ATLAS_RATE_LIMIT_RPM unset (warning-only path)", async () => {
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RateLimitGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});

// Note: tests for `warnIfDeployModeSilentlyDowngraded` previously lived
// here. The helper was inlined into `lib/config.ts` to break a static-
// reachability chain that broke the create-atlas standalone scaffold
// build (Next.js's App Router tracer pulled `lib/effect/layers.ts` and
// its dynamic `@opentelemetry/sdk-node` import into the request graph).
// The replacement coverage lives in
// `lib/__tests__/config-deploy-mode-warning.test.ts`, which spies the
// logger via `mock.module` to verify the inlined log emission.

// ══════════════════════════════════════════════════════════════════════
// ██  RegionGuardLive (#1988 C7)
// ══════════════════════════════════════════════════════════════════════

describe("RegionGuardLive", () => {
  test("fails boot in SaaS when ATLAS_API_REGION is not in residency.regions", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_API_REGION = "eu-typo";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RegionGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({
                deployMode: "saas",
                residency: {
                  regions: { "eu-west": { databaseUrl: "postgres://u:p@h:5432/db" } },
                  defaultRegion: "eu-west",
                },
              })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RegionMisconfiguredError);
      expect((failure as TRegionMisconfiguredError)._tag).toBe("RegionMisconfiguredError");
      expect((failure as TRegionMisconfiguredError).claimedRegion).toBe("eu-typo");
      expect((failure as TRegionMisconfiguredError).availableRegions).toEqual(["eu-west"]);
      expect((failure as TRegionMisconfiguredError).cause).toBe("unknown_region");
      expect((failure as TRegionMisconfiguredError).message).toContain("#1988");
    });
  });

  test("fails boot in SaaS when claimed region's databaseUrl is malformed", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_API_REGION = "eu-west";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RegionGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({
                deployMode: "saas",
                residency: {
                  regions: { "eu-west": { databaseUrl: "not-a-url" } },
                  defaultRegion: "eu-west",
                },
              })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(RegionMisconfiguredError);
      // The cause discriminator is load-bearing — programmatic
      // consumers branch on it without parsing `message`.
      expect((failure as TRegionMisconfiguredError).cause).toBe("malformed_database_url");
      expect((failure as TRegionMisconfiguredError).message).toContain("databaseUrl");
    });
  });

  test("falls back to residency.defaultRegion when ATLAS_API_REGION is unset", async () => {
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RegionGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({
                deployMode: "saas",
                residency: {
                  regions: { "eu-west": { databaseUrl: "postgres://u:p@h:5432/db" } },
                  defaultRegion: "eu-west",
                },
              })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds in SaaS with no region configured at all", async () => {
    // Mirrors `getApiRegion()` returning null — misrouting middleware
    // also no-ops in this case, so the guard intentionally does too.
    await withCleanEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RegionGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted with bogus region (regression: must not affect self-hosted)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_API_REGION = "eu-typo";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            RegionGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});

// `PluginConfigGuardLive` tests live in their own file
// (`plugin-config-guard.test.ts`) — the validator is mocked via
// `mock.module()` and bun's mock scope is per-file, so isolating
// avoids leaking the mocks into the other guards' tests in this file.
