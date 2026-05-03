/**
 * Tests for `PluginConfigGuardLive` (#1988 C8).
 *
 * Lives in a dedicated file because the guard lazy-imports
 * `lib/db/internal`, `lib/plugins/registry`, and
 * `lib/plugins/validation` — mocking those via `mock.module()` would
 * leak into unrelated tests in `saas-guards.test.ts` (bun's mock scope
 * is per-file). Validation function unit tests in
 * `lib/plugins/__tests__/validation.test.ts` cover the per-row logic.
 */

import { describe, test, expect, mock } from "bun:test";
import { Effect, Exit, Layer } from "effect";

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

import type { Config as TConfig, ConfigShape } from "../layers";
import type {
  PluginConfigStaleError as TPluginConfigStaleError,
  PluginConfigCheckFailedError as TPluginConfigCheckFailedError,
  PluginConfigIssue,
} from "../saas-guards";

const {
  PluginConfigGuardLive,
  PluginConfigStaleError,
  PluginConfigCheckFailedError,
} = await import("../saas-guards");
const { Config } = await import("../layers");

function makeTestConfigLayer(
  config: Record<string, unknown> = {},
): Layer.Layer<TConfig> {
  return Layer.succeed(Config, {
    config: config as unknown as ConfigShape["config"],
  });
}

const ENV_KEYS = ["ATLAS_DEPLOY_MODE", "ATLAS_STRICT_PLUGIN_SECRETS"] as const;

function withCleanEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return run().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });
}

// Mock the lazy-imported modules. The validator returns a flat
// `Promise<readonly PluginConfigIssue[]>` post the C8 review pass —
// the tests reflect the new return shape.
function mockValidator(
  result: { kind: "ok"; issues: readonly PluginConfigIssue[] } | { kind: "throws"; error: Error },
): void {
  mock.module("@atlas/api/lib/plugins/validation", () => ({
    validateStoredPluginConfigs: async () => {
      if (result.kind === "throws") throw result.error;
      return result.issues;
    },
  }));
  mock.module("@atlas/api/lib/db/internal", () => ({
    hasInternalDB: () => true,
  }));
  mock.module("@atlas/api/lib/plugins/registry", () => ({
    plugins: {
      getAll: () => [],
      get: () => undefined,
    },
  }));
}

describe("PluginConfigGuardLive", () => {
  test("succeeds (warn-only) when issues exist but ATLAS_STRICT_PLUGIN_SECRETS is not set", async () => {
    await withCleanEnv(async () => {
      mockValidator({
        kind: "ok",
        issues: [
          { catalogId: "plugin-a", installationId: "inst-1", workspaceId: "ws-1", reason: "stored key removed" },
        ],
      });
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            PluginConfigGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("fails boot when ATLAS_STRICT_PLUGIN_SECRETS=true and any issue is present", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
      const issues: PluginConfigIssue[] = [
        { catalogId: "plugin-a", installationId: "inst-1", workspaceId: "ws-1", reason: "missing required field 'apiKey'" },
        { catalogId: "plugin-b", installationId: "inst-2", workspaceId: "ws-2", reason: "field type drift" },
      ];
      mockValidator({ kind: "ok", issues });
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            PluginConfigGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(PluginConfigStaleError);
      expect((failure as TPluginConfigStaleError)._tag).toBe("PluginConfigStaleError");
      expect((failure as TPluginConfigStaleError).issues.length).toBe(2);
      expect((failure as TPluginConfigStaleError).message).toContain("#1988");
      expect((failure as TPluginConfigStaleError).message).toContain("ATLAS_STRICT_PLUGIN_SECRETS");
    });
  });

  test("succeeds in strict mode when no issues are reported", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
      mockValidator({ kind: "ok", issues: [] });
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            PluginConfigGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted without strict mode + issues (warn-only path)", async () => {
    await withCleanEnv(async () => {
      mockValidator({
        kind: "ok",
        issues: [
          { catalogId: "plugin-a", installationId: "inst-1", workspaceId: "ws-1", reason: "stale" },
        ],
      });
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            PluginConfigGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "self-hosted" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  // Defect-channel narrowing tests — without the inner try/catch in
  // PluginConfigGuardLive, a validator throw would land in the Effect
  // defect channel and bypass the typed E channel. These tests pin
  // the contract: throws become a typed `PluginConfigCheckFailedError`
  // in strict mode, and a silent boot-continue in warn-only mode.

  test("warn-only path swallows validator throw without failing boot", async () => {
    await withCleanEnv(async () => {
      mockValidator({ kind: "throws", error: new Error("third-party plugin getConfigSchema() blew up") });
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            PluginConfigGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("strict mode promotes validator throw to PluginConfigCheckFailedError (typed E channel)", async () => {
    await withCleanEnv(async () => {
      process.env.ATLAS_STRICT_PLUGIN_SECRETS = "true";
      const cause = new Error("validation crashed: malformed JSONB at row 42");
      mockValidator({ kind: "throws", error: cause });
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            PluginConfigGuardLive.pipe(
              Layer.provide(makeTestConfigLayer({ deployMode: "saas" })),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(PluginConfigCheckFailedError);
      expect((failure as TPluginConfigCheckFailedError)._tag).toBe("PluginConfigCheckFailedError");
      // The original Error is preserved on the typed error so the boot
      // log line names the actual underlying issue.
      expect((failure as TPluginConfigCheckFailedError).cause).toBe(cause);
      expect((failure as TPluginConfigCheckFailedError).message).toContain("validation crashed");
      expect((failure as TPluginConfigCheckFailedError).message).toContain("#1988");
    });
  });
});
