import { describe, test, expect } from "bun:test";
import { Effect, Layer, Exit, ManagedRuntime } from "effect";
import {
  Telemetry,
  TelemetryLive,
  Config,
  Migration,
  MigrationLive,
  SemanticSync,
  SemanticSyncLive,
  Settings,
  SettingsLive,
  Scheduler,
  makeSchedulerLive,
  buildAppLayer,
  DpaGuardLive,
  type ConfigShape,
  type MigrationShape,
  type SettingsShape,
} from "../layers";
import { createInternalDBTestLayer } from "@atlas/api/lib/db/internal";
import { DpaInconsistencyError } from "@atlas/api/lib/email/dpa-guard";

// ── Test helpers ────────────────────────────────────────────────────

function makeTestConfigLayer(
  config: Record<string, unknown> = {},
): Layer.Layer<Config> {
  return Layer.succeed(Config, {
    config: config as unknown as ConfigShape["config"],
  });
}

function makeTestMigrationLayer(
  partial: Partial<MigrationShape> = {},
): Layer.Layer<Migration> {
  return Layer.succeed(Migration, {
    migrated: partial.migrated ?? true,
  });
}

// ── Telemetry ──────────────────────────────────────────────────────

describe("TelemetryLive", () => {
  test("creates service when OTEL endpoint not set", async () => {
    // OTEL_EXPORTER_OTLP_ENDPOINT is not set in test env
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* Effect.promise(() => telemetry.shutdown()); // should be a no-op
        return "ok";
      }).pipe(Effect.provide(TelemetryLive)),
    );

    expect(result).toBe("ok");
  });

  test("shutdown is a no-op when OTel is disabled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* Effect.promise(() => telemetry.shutdown());
        return true;
      }).pipe(Effect.provide(TelemetryLive)),
    );

    expect(result).toBe(true);
  });
});

// ── Config ─────────────────────────────────────────────────────────

describe("Config Layer", () => {
  test("test config layer provides config value", async () => {
    const testConfig = { scheduler: { backend: "bun" } };
    const layer = makeTestConfigLayer(testConfig);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { config } = yield* Config;
        return config as unknown as Record<string, unknown>;
      }).pipe(Effect.provide(layer)),
    );

    expect(result.scheduler).toEqual({
      backend: "bun",
    });
  });
});

// ── Migration ──────────────────────────────────────────────────────

describe("MigrationLive", () => {
  test("reports migration result", async () => {
    // MigrationLive depends on InternalDB — provide a test layer.
    // Without a real DB, it should catch the error and return false.
    const testInternalDB = createInternalDBTestLayer({ available: false });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* Migration;
        return migration.migrated;
      }).pipe(Effect.provide(MigrationLive.pipe(Layer.provide(testInternalDB)))),
    );

    // Without DATABASE_URL, migration either succeeds (no-op) or fails gracefully
    expect(typeof result).toBe("boolean");
  });

  test("test layer can override migration result", async () => {
    const layer = makeTestMigrationLayer({ migrated: false });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* Migration;
        return migration.migrated;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe(false);
  });
});

// ── SemanticSync ───────────────────────────────────────────────────

describe("SemanticSyncLive", () => {
  test("reconciles without crashing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* SemanticSync;
        return sync.reconciled;
      }).pipe(Effect.provide(SemanticSyncLive)),
    );

    expect(typeof result).toBe("boolean");
  });
});

// ── Settings ───────────────────────────────────────────────────────

describe("SettingsLive", () => {
  test("loads settings without crashing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* Settings;
        return settings.loaded;
      }).pipe(Effect.provide(SettingsLive)),
    );

    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });

  test("does not start refresh fiber in self-hosted mode", async () => {
    // SettingsLive in self-hosted mode should not fork a refresh fiber.
    // Verify by running and disposing — no errors on disposal means
    // no dangling fiber.
    const rt = ManagedRuntime.make(SettingsLive);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();
  });

  test("finalizer runs on disposal without error", async () => {
    const rt = ManagedRuntime.make(SettingsLive);
    await Effect.runPromise(rt.runtimeEffect);

    // Disposal should run the Effect finalizer without throwing
    await rt.dispose();
  });
});

// ── Scheduler ──────────────────────────────────────────────────────

describe("makeSchedulerLive", () => {
  test("returns 'none' backend when no scheduler configured", async () => {
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        return scheduler.backend;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("none");
  });

  test("returns 'vercel' backend when configured", async () => {
    const config = {
      scheduler: { backend: "vercel" },
    } as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        return scheduler.backend;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("vercel");
  });

  test("finalizer runs on disposal", async () => {
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config);

    // Use ManagedRuntime to verify disposal works
    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);

    // Disposing should not throw
    await rt.dispose();
  });
});

// ── DpaGuardLive (#1969) ───────────────────────────────────────────

const DPA_ENV_KEYS = ["ATLAS_EMAIL_PROVIDER", "ATLAS_SMTP_URL", "RESEND_API_KEY"] as const;

function withCleanDpaEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of DPA_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return run().finally(() => {
    for (const key of DPA_ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });
}

function settingsTestLayer(): Layer.Layer<Settings> {
  return Layer.succeed(Settings, { loaded: 0 } satisfies SettingsShape);
}

describe("DpaGuardLive", () => {
  test("fails the Layer with DpaInconsistencyError when SaaS + nothing configured", async () => {
    await withCleanDpaEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            DpaGuardLive.pipe(
              Layer.provide(Layer.merge(makeTestConfigLayer({ deployMode: "saas" }), settingsTestLayer())),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const cause = Exit.isFailure(exit) ? exit.cause : null;
      const text = String(cause);
      expect(text).toContain("DpaInconsistencyError");
      expect(text).toContain("#1969");
    });
  });

  test("succeeds when SaaS + RESEND_API_KEY present", async () => {
    await withCleanDpaEnv(async () => {
      process.env.RESEND_API_KEY = "re_test";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            DpaGuardLive.pipe(
              Layer.provide(Layer.merge(makeTestConfigLayer({ deployMode: "saas" }), settingsTestLayer())),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("succeeds on self-hosted regardless of transport", async () => {
    await withCleanDpaEnv(async () => {
      process.env.ATLAS_SMTP_URL = "http://example.com";
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            DpaGuardLive.pipe(
              Layer.provide(Layer.merge(makeTestConfigLayer({ deployMode: "self-hosted" }), settingsTestLayer())),
            ),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  // Regression: DpaInconsistencyError must reach the boot Layer's error
  // channel (not a tagged channel) so that server.ts's plain `.catch()`
  // logs and exits — verifies the Effect.try `instanceof Error` mapping
  // doesn't demote `_tag`.
  test("preserves _tag through the error channel", async () => {
    await withCleanDpaEnv(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(
          Effect.provide(
            DpaGuardLive.pipe(
              Layer.provide(Layer.merge(makeTestConfigLayer({ deployMode: "saas" }), settingsTestLayer())),
            ),
          ),
        ),
      );
      if (!Exit.isFailure(exit)) {
        throw new Error("expected failure");
      }
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(failure).toBeInstanceOf(DpaInconsistencyError);
      expect((failure as DpaInconsistencyError)?._tag).toBe("DpaInconsistencyError");
    });
  });
});

// ── buildAppLayer ──────────────────────────────────────────────────

describe("buildAppLayer", () => {
  test("composes all layers into a single app layer", async () => {
    const config = {} as Parameters<typeof buildAppLayer>[0];
    const layer = buildAppLayer(config);

    // Verify all services are accessible
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        const configSvc = yield* Config;
        const migration = yield* Migration;
        const semanticSync = yield* SemanticSync;
        const settings = yield* Settings;
        const scheduler = yield* Scheduler;
        return {
          hasTelemetry: typeof telemetry.shutdown === "function",
          hasConfig: configSvc.config != null,
          hasMigration: typeof migration.migrated === "boolean",
          hasSync: typeof semanticSync.reconciled === "boolean",
          hasSettings: typeof settings.loaded === "number",
          hasScheduler: typeof scheduler.backend === "string",
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.hasTelemetry).toBe(true);
    expect(result.hasConfig).toBe(true);
    expect(result.hasMigration).toBe(true);
    expect(result.hasSync).toBe(true);
    expect(result.hasSettings).toBe(true);
    expect(result.hasScheduler).toBe(true);
  });

  test("ManagedRuntime dispose tears down all layers", async () => {
    const config = {} as Parameters<typeof buildAppLayer>[0];
    const layer = buildAppLayer(config);

    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);

    // Disposal should run all finalizers without error
    await rt.dispose();
  });

  test("failing startup layer produces clear error", async () => {
    // Create a Config layer that fails during construction
    const failingConfigLayer = Layer.fail(
      new Error("Config failed: atlas.config.ts not found"),
    );

    // Combine with other layers that would depend on Config
    const layer = Layer.mergeAll(TelemetryLive, failingConfigLayer);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Telemetry;
        yield* Config;
        return "should not reach";
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
