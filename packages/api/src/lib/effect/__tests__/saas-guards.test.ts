/**
 * Tests for the SaaS boot-guard family (#1978).
 *
 * Each guard has a test pair — SaaS+misconfig → throws at boot,
 * self-hosted+anything → ok — and the tagged error class is asserted
 * directly on the failure cause so the `_tag` field's purpose
 * (discriminating which misconfig class fired) is exercised.
 *
 * The logger is mocked at module level so that
 * `warnIfDeployModeSilentlyDowngraded` log emissions can be observed
 * directly — without that, tests can only assert "doesn't throw"
 * which would pass even for a no-op helper.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Effect, Exit, Layer } from "effect";

// Logger spy — captures every log call from saas-guards.ts. Must be
// installed before `../saas-guards` is imported. The spy resets in
// `beforeEach` for each test file group below.
type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const _logCalls: LogCall[] = [];

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => _logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => _logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => _logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => _logCalls.push({ level: "debug", payload, message }),
  }),
  // Other logger exports kept as no-ops; callers in saas-guards.ts only
  // touch createLogger.
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
} from "../saas-guards";

const {
  EnterpriseGuardLive,
  EnterpriseRequiredError,
  EncryptionKeyGuardLive,
  EncryptionKeyMissingError,
  EncryptionKeyMalformedError,
  InternalDbGuardLive,
  InternalDatabaseRequiredError,
  warnIfDeployModeSilentlyDowngraded,
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
// ██  warnIfDeployModeSilentlyDowngraded — no throw, just observable log
// ══════════════════════════════════════════════════════════════════════

describe("warnIfDeployModeSilentlyDowngraded", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ATLAS_DEPLOY_MODE;
    delete process.env.ATLAS_DEPLOY_MODE;
    _logCalls.length = 0;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.ATLAS_DEPLOY_MODE = savedEnv;
    else delete process.env.ATLAS_DEPLOY_MODE;
  });

  // Asserting the log emission directly — without this, a regression
  // that turned the helper into a no-op would still pass `not.toThrow()`.
  test("emits CRITICAL error log when config file requests saas but resolved is self-hosted", () => {
    warnIfDeployModeSilentlyDowngraded({
      resolvedDeployMode: "self-hosted",
      configFileValue: "saas",
    });

    const errorLogs = _logCalls.filter((c) => c.level === "error");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain("CRITICAL");
    expect(errorLogs[0].message).toContain("#1978");
    expect((errorLogs[0].payload as Record<string, unknown>).source).toBe("atlas.config.ts");
    expect((errorLogs[0].payload as Record<string, unknown>).requested).toBe("saas");
  });

  test("does NOT log when resolved is saas (no downgrade)", () => {
    warnIfDeployModeSilentlyDowngraded({
      resolvedDeployMode: "saas",
      configFileValue: "saas",
    });
    expect(_logCalls.filter((c) => c.level === "error")).toHaveLength(0);
  });

  test("does NOT log when env is set to saas (handled by EnterpriseGuardLive)", () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    warnIfDeployModeSilentlyDowngraded({
      resolvedDeployMode: "self-hosted",
      configFileValue: "saas",
    });
    expect(_logCalls.filter((c) => c.level === "error")).toHaveLength(0);
  });

  test("does NOT log when config file did not request saas", () => {
    warnIfDeployModeSilentlyDowngraded({
      resolvedDeployMode: "self-hosted",
      configFileValue: "auto",
    });
    expect(_logCalls.filter((c) => c.level === "error")).toHaveLength(0);
  });
});
