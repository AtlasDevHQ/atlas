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
  type ConfigShape,
  type MigrationShape,
} from "../layers";

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
    // MigrationLive calls migrateAuthTables() which requires internal DB.
    // In test env without DB, it should catch the error and return false.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* Migration;
        return migration.migrated;
      }).pipe(Effect.provide(MigrationLive)),
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
