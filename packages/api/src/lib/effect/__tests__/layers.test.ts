import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Exit, ManagedRuntime } from "effect";
import {
  Telemetry,
  TelemetryLive,
  Config,
  Migration,
  MigrationLive,
  ConnectionsHydrate,
  makeConnectionsHydrateLive,
  SemanticSync,
  SemanticSyncLive,
  Settings,
  SettingsLive,
  Scheduler,
  makeSchedulerLive,
  buildAppLayer,
  DpaGuardLive,
  MigrationGuardLive,
  ImplementationStatusOverride,
  ImplementationStatusOverrideLive,
  CatalogSeed,
  BuiltinDatasourceCatalogSeed,
  SCHEDULER_CLEANUP_SPAN_NAMES,
  SCHEDULER_WORK_SPAN_NAMES,
  type ConfigShape,
  type MigrationShape,
  type SettingsShape,
} from "../layers";
import { MigrationsRequiredError } from "../saas-guards";
import { createPluginTestLayer } from "../services";
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
    ...(partial.error !== undefined && { error: partial.error }),
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

// ── ConnectionsHydrate (#2482) ─────────────────────────────────────

describe("ConnectionsHydrateLive", () => {
  function runHydrate(
    load: () => Promise<number>,
    gates: { available: boolean; migrated: boolean },
  ) {
    const layer = makeConnectionsHydrateLive(load).pipe(
      Layer.provide(
        Layer.mergeAll(
          createInternalDBTestLayer({ available: gates.available }),
          makeTestMigrationLayer({ migrated: gates.migrated }),
          // #3743 — ConnectionsHydrate now also depends on PluginRegistry as an
          // ordering barrier (datasource plugins must be registered first).
          createPluginTestLayer({}),
        ),
      ),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* ConnectionsHydrate;
      }).pipe(Effect.provide(layer)),
    );
  }

  test("outcome 'skipped-gate' when InternalDB is unavailable", async () => {
    const result = await runHydrate(
      async () => {
        throw new Error("load should not run when gates fail");
      },
      { available: false, migrated: true },
    );
    expect(result.outcome).toBe("skipped-gate");
    expect(result.count).toBe(0);
    expect(result.error).toBeUndefined();
  });

  test("outcome 'skipped-gate' when Migration did not succeed", async () => {
    const result = await runHydrate(
      async () => {
        throw new Error("load should not run when gates fail");
      },
      { available: true, migrated: false },
    );
    expect(result.outcome).toBe("skipped-gate");
    expect(result.count).toBe(0);
  });

  test("outcome 'empty' when load returns zero rows", async () => {
    const result = await runHydrate(async () => 0, {
      available: true,
      migrated: true,
    });
    expect(result.outcome).toBe("empty");
    expect(result.count).toBe(0);
    expect(result.error).toBeUndefined();
  });

  test("outcome 'registered' when load returns a positive count", async () => {
    const result = await runHydrate(async () => 3, {
      available: true,
      migrated: true,
    });
    expect(result.outcome).toBe("registered");
    expect(result.count).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("outcome 'error' when load throws — Effect.catchAll keeps boot non-fatal", async () => {
    // Regression guard for the acceptance criterion "encryption-key rotation
    // failures surface as logged warnings, not boot crash" — if a future
    // refactor removes Effect.catchAll, this layer would fail and crash boot
    // through buildAppLayer.
    const result = await runHydrate(
      async () => {
        throw new Error("simulated hydrate failure");
      },
      { available: true, migrated: true },
    );
    expect(result.outcome).toBe("error");
    expect(result.count).toBe(0);
    expect(result.error).toContain("simulated hydrate failure");
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
  // Post-#2569 the scheduler yields `AuditPurgeScheduler` (split out of
  // `AuditRetention` in #2587) to start the EE purge worker via the Tag,
  // so the test composes the no-op `NoopEnterpriseDefaultsLayer` as a dep
  // before providing `Scheduler`. The noop fails with `EnterpriseError`;
  // the boot site catches it and logs at debug so the boot Layer still
  // builds cleanly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NoopEnterpriseDefaultsLayer } = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");

  // #3446 — `makeSchedulerLive` requires `Migration` as an ordering
  // barrier for the billing-reconcile boot tick; tests satisfy it with
  // the immediate test layer.
  const schedulerDeps = Layer.merge(NoopEnterpriseDefaultsLayer, makeTestMigrationLayer());

  test("returns 'none' backend when no scheduler configured", async () => {
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config).pipe(Layer.provide(schedulerDeps));

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
    const layer = makeSchedulerLive(config).pipe(Layer.provide(schedulerDeps));

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
    const layer = makeSchedulerLive(config).pipe(Layer.provide(schedulerDeps));

    // Use ManagedRuntime to verify disposal works
    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);

    // Disposing should not throw
    await rt.dispose();
  });

  // #3446 — the eager billing-reconcile boot tick must not run before
  // MigrationLive completes. The barrier is the `yield* Migration` in
  // `makeSchedulerLive`'s gen: the Scheduler service cannot finish
  // building until the Migration layer's effect resolves. Pin that with
  // a gated Migration layer — Scheduler construction stays pending while
  // the gate is closed and completes only after it opens.
  test("Scheduler construction waits for the Migration barrier (#3446)", async () => {
    let releaseMigration!: () => void;
    const migrationGate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const gatedMigrationLayer = Layer.effect(
      Migration,
      Effect.promise(async () => {
        await migrationGate;
        return { migrated: true } satisfies MigrationShape;
      }),
    );

    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config).pipe(
      Layer.provide(Layer.merge(NoopEnterpriseDefaultsLayer, gatedMigrationLayer)),
    );

    let schedulerBuilt = false;
    const pending = Effect.runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        schedulerBuilt = true;
        return scheduler.backend;
      }).pipe(Effect.provide(layer)),
    );

    // Give the runtime ample turns — without the Migration edge the
    // scheduler builds immediately and this trips.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(schedulerBuilt).toBe(false);

    releaseMigration();
    const backend = await pending;
    expect(schedulerBuilt).toBe(true);
    expect(backend).toBe("none");
  });

  // ── Per-tick observability spans on the periodic fibers (#2945, #2944, #2987) ──
  // The inline-forked periodic fibers are not exposed through the `Scheduler`
  // Tag, so the span wrapping can't be asserted by introspecting OTel without
  // standing up an in-memory trace exporter (would add
  // `@opentelemetry/sdk-trace-base` to @atlas/api devDeps — out of scope).
  // Instead, for each single-source span-name record:
  //   (a) the production wrap sites derive their span name from the record,
  //       and the derivation/prefix guard below pins that record's shape; and
  //   (b) a structural source-scan guard asserts each key is referenced by a
  //       `withEffectSpan(<RECORD>.<key>` call site, and that the call-site
  //       count matches the record exactly.
  // Together these make "rename a span" AND "delete a wrap at a call site"
  // (the precise regression these spans exist to prevent) both fail here.
  //
  // Two records: cleanup/sweep fibers (#2945/#2944) and background-work fibers
  // (#2987). The CRM/email outbox flushers are deliberately absent from both —
  // they carry heartbeat + stall-watchdog liveness instead of a per-tick span
  // (see the layers.ts block comment for the rationale and exclusion list).
  const layersSource = readFileSync(
    fileURLToPath(new URL("../layers.ts", import.meta.url)),
    "utf8",
  );

  const SPAN_RECORDS = [
    {
      // Cleanup/sweep fibers. Eight were retrofitted by #2945;
      // `orphan_task_reconcile` (#2944) shipped with its span and is the only
      // member (of either record) that also attaches a result attribute (the
      // orphan count).
      constName: "SCHEDULER_CLEANUP_SPAN_NAMES",
      record: SCHEDULER_CLEANUP_SPAN_NAMES as Record<string, string>,
      expectedKeys: [
        "oauth_state_cleanup",
        "rate_limit_cleanup",
        "demo_rate_limit_cleanup",
        "contact_rate_limit_cleanup",
        "abuse_cleanup",
        "dashboard_rate_limit_cleanup",
        "conversation_rate_sweep",
        "share_token_cleanup",
        "orphan_task_reconcile",
      ],
    },
    {
      // Background-work fibers spanned by #2987. `settings_refresh` is forked
      // in `SettingsLive`; the other three in `makeSchedulerLive`. The source
      // scan reads the whole file, so the defining function doesn't matter.
      constName: "SCHEDULER_WORK_SPAN_NAMES",
      record: SCHEDULER_WORK_SPAN_NAMES as Record<string, string>,
      expectedKeys: [
        "sub_processor_publisher",
        "settings_refresh",
        "onboarding_email",
        "expert_scheduler",
        "promote_decay",
        "billing_reconcile",
      ],
    },
  ] as const;

  for (const { constName, record, expectedKeys } of SPAN_RECORDS) {
    describe(`${constName} per-tick spans`, () => {
      // The fiber keys are the real contract — each fiber must emit a per-tick
      // span.
      test("covers exactly the named fibers", () => {
        expect(Object.keys(record).toSorted()).toEqual(
          [...expectedKeys].toSorted(),
        );
      });

      test("derives each span name as dotted atlas.scheduler.<fiber> (no bare snake_case label)", () => {
        for (const [fiber, span] of Object.entries(record)) {
          // Convention guard from the #2945 LOW finding: the dotted prefix
          // must survive; the op segment intentionally mirrors the fiber's
          // `withFiberDeathLog` label (underscores within the op are fine).
          expect(span).toBe(`atlas.scheduler.${fiber}`);
          expect(span.startsWith("atlas.scheduler.")).toBe(true);
          expect(span).not.toBe(fiber);
        }
      });

      // Structural wiring guard: the name-set test above proves the const is
      // correct, but a wrap site can be deleted while every other test stays
      // green — re-hiding the exact regression these spans prevent. Scan the
      // `layers.ts` source and assert each key is referenced by a
      // `withEffectSpan(<constName>.<key>` call AND that the call-site count
      // matches the record exactly, so deleting/adding a wrap fails here.
      // (A full in-memory OTel exporter test was rejected as too heavy — see
      // the block comment above; this source scan is the pragmatic guard.)
      describe("wrap-site wiring guard", () => {
        // Matches `withEffectSpan(<constName>.<key>` tolerating arbitrary
        // whitespace/newlines around the call paren and the dot.
        const wrapCallRegex = new RegExp(
          `withEffectSpan\\s*\\(\\s*${constName}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`,
          "g",
        );

        test("each fiber has a withEffectSpan wrap site", () => {
          for (const key of expectedKeys) {
            const perKey = new RegExp(
              `withEffectSpan\\s*\\(\\s*${constName}\\s*\\.\\s*${key}\\b`,
            );
            expect(layersSource).toMatch(perKey);
          }
        });

        test(`there are exactly ${expectedKeys.length} ${constName} wrap sites`, () => {
          const matchedKeys = [...layersSource.matchAll(wrapCallRegex)].map(
            (m) => m[1],
          );
          expect(matchedKeys).toHaveLength(expectedKeys.length);
          // Every matched call site references a known fiber key — guards
          // against a typo'd `.foo` reference that wouldn't type-check anyway
          // but keeps the scan honest if the const is widened later.
          expect(matchedKeys.toSorted()).toEqual([...expectedKeys].toSorted());
        });
      });
    });
  }
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

// ── MigrationGuardLive (#1988 C9) ──────────────────────────────────

describe("MigrationGuardLive", () => {
  // The guard depends on Config + Migration. We compose both via
  // Layer.merge — Migration's Tag value is the same singleton across
  // both `MigrationLive` and the test layer, so the guard reads the
  // overridden `migrated` flag deterministically.
  function runGuard(opts: {
    deployMode: string;
    migrated: boolean;
    error?: string;
    databaseUrl?: string | undefined;
  }): Promise<Exit.Exit<void, MigrationsRequiredError>> {
    const savedDb = process.env.DATABASE_URL;
    if (opts.databaseUrl !== undefined) {
      process.env.DATABASE_URL = opts.databaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    const layer = MigrationGuardLive.pipe(
      Layer.provide(
        Layer.merge(
          makeTestConfigLayer({ deployMode: opts.deployMode }),
          makeTestMigrationLayer({
            migrated: opts.migrated,
            ...(opts.error !== undefined && { error: opts.error }),
          }),
        ),
      ),
    );
    return Effect.runPromiseExit(Effect.void.pipe(Effect.provide(layer))).finally(() => {
      if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
      else delete process.env.DATABASE_URL;
    });
  }

  test("fails boot in SaaS when migrated=false and DATABASE_URL is set", async () => {
    const exit = await runGuard({
      deployMode: "saas",
      migrated: false,
      databaseUrl: "postgres://u:p@h:5432/db",
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
    expect(failure).toBeInstanceOf(MigrationsRequiredError);
    expect((failure as MigrationsRequiredError)._tag).toBe("MigrationsRequiredError");
    expect((failure as MigrationsRequiredError).message).toContain("#1988");
  });

  test("threads underlying error from MigrationLive into cause + message", async () => {
    // Pin the contract: `MigrationGuardLive` promotes the captured
    // MigrationLive error into `cause` (so Sentry / log queries can
    // group on it) and inlines it into the operator-actionable message
    // so "see prior log" punting goes away.
    const exit = await runGuard({
      deployMode: "saas",
      migrated: false,
      error: "drizzle: relation 'sessions' does not exist",
      databaseUrl: "postgres://u:p@h:5432/db",
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : null;
    expect(failure).toBeInstanceOf(MigrationsRequiredError);
    expect((failure as MigrationsRequiredError).cause).toBe(
      "drizzle: relation 'sessions' does not exist",
    );
    expect((failure as MigrationsRequiredError).message).toContain("Underlying error:");
    expect((failure as MigrationsRequiredError).message).toContain("drizzle:");
  });

  test("succeeds in SaaS when migrated=true", async () => {
    const exit = await runGuard({
      deployMode: "saas",
      migrated: true,
      databaseUrl: "postgres://u:p@h:5432/db",
    });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("succeeds in SaaS when DATABASE_URL is unset (defers to InternalDbGuardLive)", async () => {
    // No DATABASE_URL → MigrationGuardLive intentionally no-ops because
    // InternalDbGuardLive already fails boot for that case. A duplicate
    // failure here would obscure the actual misconfig.
    const exit = await runGuard({ deployMode: "saas", migrated: false });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("succeeds on self-hosted regardless of migration state", async () => {
    const exit = await runGuard({
      deployMode: "self-hosted",
      migrated: false,
      databaseUrl: "postgres://u:p@h:5432/db",
    });
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

// ── buildAppLayer ──────────────────────────────────────────────────

describe("buildAppLayer", () => {
  // #3687 — the SaaS canary tests below assert that exactly ONE sibling guard
  // fails in `Layer.mergeAll`. `McpSpineGuardLive` is a new SaaS fail-fast guard
  // that fails when no OAuth valid-audiences are derivable, so satisfy that input
  // here (a derivable `BETTER_AUTH_URL`) the same way these tests already satisfy
  // every other sibling guard — otherwise it would race the guard-under-test to
  // the failure channel. (Its policy-store probe is warn-only, so it never
  // competes.) Self-hosted canary tests are unaffected — the guard skips.
  let savedBetterAuthUrl: string | undefined;
  beforeEach(() => {
    savedBetterAuthUrl = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://api.useatlas.dev";
  });
  afterEach(() => {
    if (savedBetterAuthUrl !== undefined) process.env.BETTER_AUTH_URL = savedBetterAuthUrl;
    else delete process.env.BETTER_AUTH_URL;
  });

  test("composes all layers into a single app layer", async () => {
    const config = {} as Parameters<typeof buildAppLayer>[0];
    const layer = buildAppLayer(config);

    // Verify all services are accessible
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        const configSvc = yield* Config;
        const migration = yield* Migration;
        const hydrate = yield* ConnectionsHydrate;
        const semanticSync = yield* SemanticSync;
        const settings = yield* Settings;
        const scheduler = yield* Scheduler;
        return {
          hasTelemetry: typeof telemetry.shutdown === "function",
          hasConfig: configSvc.config != null,
          hasMigration: typeof migration.migrated === "boolean",
          hasHydrate: typeof hydrate.count === "number",
          hasSync: typeof semanticSync.reconciled === "boolean",
          hasSettings: typeof settings.loaded === "number",
          hasScheduler: typeof scheduler.backend === "string",
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.hasTelemetry).toBe(true);
    expect(result.hasConfig).toBe(true);
    expect(result.hasMigration).toBe(true);
    expect(result.hasHydrate).toBe(true);
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

  // #1978 — wiring regression guard. The "composes all layers" test
  // above provides `{}` as config, so every SaaS-only guard short-
  // circuits via `deployMode !== "saas"`. Without this end-to-end
  // assertion, a merge that accidentally drops a guard line from
  // `Layer.mergeAll(...)` would still pass the wiring test. Here we
  // build the full app layer with `deployMode: "saas"` and a
  // misconfigured env (no DATABASE_URL), and assert that the
  // `InternalDatabaseRequiredError` actually reaches the boot Layer's
  // failure channel — proving the wiring is intact.
  test("buildAppLayer wires InternalDbGuardLive — missing DATABASE_URL fails the layer in SaaS", async () => {
    const savedDb = process.env.DATABASE_URL;
    const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
    const savedProvider = process.env.ATLAS_PROVIDER;
    delete process.env.DATABASE_URL;
    // Provide a valid encryption key so EncryptionKeyGuardLive doesn't
    // also fail and hide the InternalDbGuardLive failure.
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:wiring-regression-test-key-32-bytes-long-aaa";
    // Satisfy ProviderKeyGuardLive (#3178) with a keyless provider so its
    // failure doesn't mix into the cause this test asserts on.
    process.env.ATLAS_PROVIDER = "ollama";

    try {
      const config = { deployMode: "saas" } as Parameters<typeof buildAppLayer>[0];
      const layer = buildAppLayer(config);

      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      // Confirm the failure carries the specific tagged error, proving
      // the guard layer was actually evaluated rather than silently
      // dropped from the merge.
      const text = String(Exit.isFailure(exit) ? exit.cause : "");
      expect(text).toContain("InternalDatabaseRequiredError");
    } finally {
      if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
      if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
      else delete process.env.ATLAS_ENCRYPTION_KEYS;
      if (savedProvider !== undefined) process.env.ATLAS_PROVIDER = savedProvider;
      else delete process.env.ATLAS_PROVIDER;
    }
  });

  // Same shape as the InternalDbGuardLive wiring test above. Without
  // this end-to-end assertion, a future merge that drops the
  // `rateLimitGuardLayer` line from `Layer.mergeAll(...)` would still
  // pass the per-guard unit tests in `saas-guards.test.ts` because
  // those tests provide the guard Layer directly. The boot path going
  // through `buildAppLayer` is the only place the wiring is observed.
  test("buildAppLayer wires RateLimitGuardLive — missing ATLAS_RATE_LIMIT_RPM fails the layer in SaaS", async () => {
    const savedDb = process.env.DATABASE_URL;
    const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
    const savedRpm = process.env.ATLAS_RATE_LIMIT_RPM;
    const savedProvider = process.env.ATLAS_PROVIDER;
    // Satisfy the other SaaS guards so the failure cause carries
    // exclusively the rate-limit error — not the encryption-key,
    // internal-DB, or provider-key error from a sibling guard firing first.
    process.env.DATABASE_URL = "postgresql://localhost:5432/wiring-test";
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:wiring-regression-test-key-32-bytes-long-aaa";
    process.env.ATLAS_PROVIDER = "ollama"; // keyless provider — satisfies ProviderKeyGuardLive
    delete process.env.ATLAS_RATE_LIMIT_RPM;

    try {
      const config = { deployMode: "saas" } as Parameters<typeof buildAppLayer>[0];
      const layer = buildAppLayer(config);

      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const text = String(Exit.isFailure(exit) ? exit.cause : "");
      expect(text).toContain("RateLimitRequiredError");
    } finally {
      if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
      else delete process.env.DATABASE_URL;
      if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
      else delete process.env.ATLAS_ENCRYPTION_KEYS;
      if (savedRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM = savedRpm;
      else delete process.env.ATLAS_RATE_LIMIT_RPM;
      if (savedProvider !== undefined) process.env.ATLAS_PROVIDER = savedProvider;
      else delete process.env.ATLAS_PROVIDER;
    }
  });

  // #3178 — same canary shape as the two guards above. Without this end-to-end
  // assertion a future merge that drops `providerKeyGuardLayer` from
  // `Layer.mergeAll(...)` would still pass the unit tests in saas-guards.test.ts
  // (which provide the guard Layer directly). Boot the full app layer in SaaS
  // with a configured provider whose key is absent and assert the tagged error
  // reaches the boot Layer's failure channel.
  test("buildAppLayer wires ProviderKeyGuardLive — missing provider key fails the layer in SaaS", async () => {
    const savedDb = process.env.DATABASE_URL;
    const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
    const savedRpm = process.env.ATLAS_RATE_LIMIT_RPM;
    const savedProvider = process.env.ATLAS_PROVIDER;
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    // Satisfy the sibling guards so the cause carries exclusively the
    // provider-key error.
    process.env.DATABASE_URL = "postgresql://localhost:5432/wiring-test";
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:wiring-regression-test-key-32-bytes-long-aaa";
    process.env.ATLAS_RATE_LIMIT_RPM = "300";
    process.env.ATLAS_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const config = { deployMode: "saas" } as Parameters<typeof buildAppLayer>[0];
      const layer = buildAppLayer(config);

      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const text = String(Exit.isFailure(exit) ? exit.cause : "");
      expect(text).toContain("ProviderKeyMissingError");
    } finally {
      if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
      else delete process.env.DATABASE_URL;
      if (savedKeys !== undefined) process.env.ATLAS_ENCRYPTION_KEYS = savedKeys;
      else delete process.env.ATLAS_ENCRYPTION_KEYS;
      if (savedRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM = savedRpm;
      else delete process.env.ATLAS_RATE_LIMIT_RPM;
      if (savedProvider !== undefined) process.env.ATLAS_PROVIDER = savedProvider;
      else delete process.env.ATLAS_PROVIDER;
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // Wiring regression for the #1988 C7/C8/C9 guards is intentionally
  // not added end-to-end. The InternalDbGuard + RateLimitGuard wiring
  // tests above are the family canary — their failure proves
  // `Layer.mergeAll(...)` honors every Layer.effectDiscard guard added
  // to it. Per-#1988-guard end-to-end tests would force the same
  // real-DB-URL workaround for marginal additional coverage beyond the
  // existing unit-level guard tests.

  // #3435 + #3703 — canary that `billingConfigGuardLayer` is actually wired
  // into `Layer.mergeAll(...)`. Uses the env-only fail-fast path (missing
  // STRIPE_WEBHOOK_SECRET) so it never reaches the network price-resolution
  // branch — no Stripe SDK / mock needed. Since #3703 a missing PRICE ID is a
  // warn (not a boot crash), so the webhook-secret gap is the remaining
  // pure fail-fast trigger. STRIPE_SECRET_KEY must be set (the guard gates on it).
  test("buildAppLayer wires BillingConfigGuardLive — missing webhook secret fails the layer in SaaS", async () => {
    const savedDb = process.env.DATABASE_URL;
    const savedKeys = process.env.ATLAS_ENCRYPTION_KEYS;
    const savedRpm = process.env.ATLAS_RATE_LIMIT_RPM;
    const savedProvider = process.env.ATLAS_PROVIDER;
    const savedStripeKey = process.env.STRIPE_SECRET_KEY;
    const savedWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    const savedResend = process.env.RESEND_API_KEY;
    // Satisfy the sibling SaaS guards so the cause carries exclusively the
    // billing error. RESEND_API_KEY satisfies DpaGuardLive, which (like the
    // billing guard since #3703) is Settings-gated and would otherwise race it.
    process.env.DATABASE_URL = "postgresql://localhost:5432/wiring-test";
    process.env.ATLAS_ENCRYPTION_KEYS = "v1:wiring-regression-test-key-32-bytes-long-aaa";
    process.env.ATLAS_RATE_LIMIT_RPM = "300";
    process.env.ATLAS_PROVIDER = "ollama"; // keyless provider
    process.env.RESEND_API_KEY = "re_wiring_test";
    process.env.STRIPE_SECRET_KEY = "sk_test_wiring";
    // Webhook secret absent → env-only fail-fast before any network call.
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      const config = { deployMode: "saas" } as Parameters<typeof buildAppLayer>[0];
      const layer = buildAppLayer(config);

      const exit = await Effect.runPromiseExit(
        Effect.void.pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const text = String(Exit.isFailure(exit) ? exit.cause : "");
      expect(text).toContain("BillingConfigInvalidError");
    } finally {
      const restore = (key: string, val: string | undefined) => {
        if (val !== undefined) process.env[key] = val;
        else delete process.env[key];
      };
      restore("DATABASE_URL", savedDb);
      restore("ATLAS_ENCRYPTION_KEYS", savedKeys);
      restore("ATLAS_RATE_LIMIT_RPM", savedRpm);
      restore("ATLAS_PROVIDER", savedProvider);
      restore("STRIPE_SECRET_KEY", savedStripeKey);
      restore("STRIPE_WEBHOOK_SECRET", savedWebhook);
      restore("RESEND_API_KEY", savedResend);
    }
  });
});

// ── ImplementationStatusOverrideLive (#2747 — 1.5.3 slice 9) ──────────

describe("ImplementationStatusOverrideLive", () => {
  // The Tag dependencies on `CatalogSeed` + `BuiltinDatasourceCatalogSeed`
  // encode the "override-runs-after-both-seeds" ordering. The two stubs
  // below are accepted by the Layer's Effect.gen even though their
  // values are never read — the `yield* CatalogSeed; yield*
  // BuiltinDatasourceCatalogSeed` lines in the Live impl are
  // load-bearing for ordering, not for value, and removing them would
  // race the catalog-seeder's `EXCLUDED.implementation_status` upsert
  // against our UPDATEs.
  const seedStubLayer = Layer.merge(
    Layer.succeed(CatalogSeed, {
      insertedCount: 0,
      updatedCount: 0,
      preservedCount: 0,
      orphanSlugs: [],
      outcome: "seeded" as const,
    }),
    Layer.succeed(BuiltinDatasourceCatalogSeed, {
      insertedSlugs: [],
      preservedSlugs: [],
      outcome: "seeded" as const,
    }),
  );

  function runOverride(gates: { available: boolean; migrated: boolean }) {
    const layer = ImplementationStatusOverrideLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          createInternalDBTestLayer({ available: gates.available }),
          makeTestMigrationLayer({ migrated: gates.migrated }),
          seedStubLayer,
        ),
      ),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* ImplementationStatusOverride;
      }).pipe(Effect.provide(layer)),
    );
  }

  test("outcome 'skipped-gate' when InternalDB is unavailable (gate path)", async () => {
    const result = await runOverride({ available: false, migrated: true });
    expect(result.outcome).toBe("skipped-gate");
    expect(result.updatedCount).toBe(0);
    expect(result.error).toBeUndefined();
  });

  test("outcome 'skipped-gate' when Migration has not run", async () => {
    const result = await runOverride({ available: true, migrated: false });
    expect(result.outcome).toBe("skipped-gate");
    expect(result.updatedCount).toBe(0);
  });

  // Note: gates-pass paths (`skipped-empty` / `applied` / `error`) are
  // covered by `runImplementationStatusOverrideBoot (discriminated
  // outcomes)` in `lib/integrations/__tests__/implementation-status-override.test.ts`.
  // The wrapper covers the boot-time side of the contract; this Layer
  // test covers only the upstream-gate branch that can't be reached
  // from the wrapper alone.
});
