/**
 * Tests for the SaaS boot-guard family (#1978).
 *
 * Each guard has a test pair — SaaS+misconfig → throws at boot,
 * self-hosted+anything → ok — and the tagged error class is asserted
 * directly on the failure cause so the `_tag` field's purpose
 * (discriminating which misconfig class fired) is exercised.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import {
  EnterpriseGuardLive,
  EnterpriseRequiredError,
  EncryptionKeyGuardLive,
  EncryptionKeyMissingError,
  EncryptionKeyMalformedError,
  InternalDbGuardLive,
  InternalDatabaseRequiredError,
  warnIfDeployModeSilentlyDowngraded,
} from "../saas-guards";
import { Config, type ConfigShape } from "../layers";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

// ── Test helpers ────────────────────────────────────────────────────

function makeTestConfigLayer(
  config: Record<string, unknown> = {},
): Layer.Layer<Config> {
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
      expect((failure as EnterpriseRequiredError)._tag).toBe("EnterpriseRequiredError");
      expect((failure as EnterpriseRequiredError).source).toBe("env");
      expect((failure as EnterpriseRequiredError).message).toContain("#1978");
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
      expect((failure as EncryptionKeyMissingError)._tag).toBe("EncryptionKeyMissingError");
      expect((failure as EncryptionKeyMissingError).message).toContain("#1978");
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
      expect((failure as EncryptionKeyMalformedError)._tag).toBe("EncryptionKeyMalformedError");
      expect((failure as EncryptionKeyMalformedError).cause).toContain("vlatest");
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
      expect((failure as InternalDatabaseRequiredError)._tag).toBe("InternalDatabaseRequiredError");
      expect((failure as InternalDatabaseRequiredError).message).toContain("#1978");
      expect((failure as InternalDatabaseRequiredError).message).toContain("DATABASE_URL");
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
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.ATLAS_DEPLOY_MODE = savedEnv;
    else delete process.env.ATLAS_DEPLOY_MODE;
  });

  test("does not throw — observable side-effect is the log line", () => {
    expect(() =>
      warnIfDeployModeSilentlyDowngraded({
        resolvedDeployMode: "self-hosted",
        configFileValue: "saas",
      }),
    ).not.toThrow();
  });

  test("returns silently when resolved is saas (no downgrade)", () => {
    expect(() =>
      warnIfDeployModeSilentlyDowngraded({
        resolvedDeployMode: "saas",
        configFileValue: "saas",
      }),
    ).not.toThrow();
  });

  test("returns silently when env is set to saas (handled by EnterpriseGuardLive)", () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(() =>
      warnIfDeployModeSilentlyDowngraded({
        resolvedDeployMode: "self-hosted",
        configFileValue: "saas",
      }),
    ).not.toThrow();
  });

  test("returns silently when config file did not request saas", () => {
    expect(() =>
      warnIfDeployModeSilentlyDowngraded({
        resolvedDeployMode: "self-hosted",
        configFileValue: "auto",
      }),
    ).not.toThrow();
  });
});
