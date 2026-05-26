/**
 * Outbox flusher lifecycle — startup-recovery + shutdown-finalizer
 * wiring around `makeSchedulerLive`.
 *
 * AC #7 (restart safety) and AC #9 (graceful shutdown) from #2729 both
 * rely on `recoverInFlight` being invoked on the Layer's scope
 * boundaries. The unit + PG tests already cover `recoverInFlight`
 * itself; this file proves the scheduler Layer actually calls it.
 *
 * We mock `lib/db/internal` (hasInternalDB + internalQuery) so the
 * outbox flusher branch wires without standing up a real Postgres,
 * and provide a SaasCrm Layer with `available: true` + a stub
 * dispatcher. The mock observes every SQL invocation so we can assert
 * the recovery sweep ran on both boot and dispose.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";

// `import type` is erased at runtime, so it doesn't compete with the
// mock.module() installations below — we still get static type names
// for `SaasCrm` / `SaasCrmShape` without forcing the services module
// to load before our mocks are wired.
import type { SaasCrm as SaasCrmTag, SaasCrmShape } from "../services";

// ── Module mocks MUST be installed before importing layers.ts ───────
// Per CLAUDE.md the partial-mock rule requires re-exporting all
// existing symbols — we splat the real module and only override
// `hasInternalDB` + `internalQuery`. We fetch the real module first via
// a dynamic `require`-style call so the splat resolves to all named
// exports without us having to enumerate them by hand.

interface CapturedQuery {
  sql: string;
  params: unknown[];
}
const sqlLog: CapturedQuery[] = [];
let internalDbAvailable = true;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal") as Record<string, unknown>;

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => internalDbAvailable,
  internalQuery: async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    sqlLog.push({ sql, params: params ?? [] });
    if (/RETURNING id/i.test(sql)) return [] as unknown as T[];
    return [] as unknown as T[];
  },
}));

// Silence logger noise from the booted Layer.
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { makeSchedulerLive } = await import("../layers");
const { SaasCrm, NoopEnterpriseDefaultsLayer } = await import("../services");

// ── Test layer: SaasCrm with available=true + stub dispatcher ───────

function makeAvailableSaasCrmLayer(): Layer.Layer<SaasCrmTag> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: () => Effect.void,
    dispatcher: async () => ({ kind: "ok" as const }),
  } satisfies SaasCrmShape);
}

beforeEach(() => {
  sqlLog.length = 0;
  internalDbAvailable = true;
});

afterEach(() => {
  internalDbAvailable = true;
});

describe("outbox flusher lifecycle (#2729 AC #7 + #9)", () => {
  test("Layer scope boundary triggers startup recovery AND shutdown recovery", async () => {
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const baseLayer = makeSchedulerLive(config);
    // Compose enterprise defaults FIRST so AuditPurgeScheduler etc. are
    // provided, then override SaasCrm with our test-controlled shape.
    const deps = Layer.mergeAll(
      NoopEnterpriseDefaultsLayer,
      makeAvailableSaasCrmLayer(),
    );
    const layer = baseLayer.pipe(Layer.provide(deps));

    const rt = ManagedRuntime.make(layer);
    // Building the runtime triggers Layer.scoped init — that's the
    // startup-recovery call inside makeSchedulerLive.
    await Effect.runPromise(rt.runtimeEffect);

    // Disposing the runtime triggers the finalizer chain — that's the
    // shutdown-recovery call.
    await rt.dispose();

    // Each recoverInFlight call runs TWO statements: dead-letter
    // exhausted rows, then reset stale rows. So one boot + one
    // finalizer = 4 SQL invocations that target in_flight.
    const recoveryCalls = sqlLog.filter((q) =>
      /WHERE status = 'in_flight'/i.test(q.sql),
    );
    expect(recoveryCalls.length).toBe(4);
  });

  test("Layer skips flusher wiring when hasInternalDB() returns false", async () => {
    internalDbAvailable = false;
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const baseLayer = makeSchedulerLive(config);
    // Compose enterprise defaults FIRST so AuditPurgeScheduler etc. are
    // provided, then override SaasCrm with our test-controlled shape.
    const deps = Layer.mergeAll(
      NoopEnterpriseDefaultsLayer,
      makeAvailableSaasCrmLayer(),
    );
    const layer = baseLayer.pipe(Layer.provide(deps));

    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();

    const recoveryCalls = sqlLog.filter((q) =>
      /WHERE status = 'in_flight'/i.test(q.sql),
    );
    // Neither boot nor finalizer touch the DB when the flusher is unwired.
    expect(recoveryCalls.length).toBe(0);
  });

  test("Layer skips flusher wiring when SaasCrm.available is false", async () => {
    const noopSaasCrm: Layer.Layer<SaasCrmTag> = Layer.succeed(SaasCrm, {
      available: false,
      upsertLead: () => Effect.void,
    } satisfies SaasCrmShape);

    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const baseLayer = makeSchedulerLive(config);
    // NoopEnterpriseDefaultsLayer already provides a Noop SaasCrm — but
    // `noopSaasCrm` is composed on top to make the test intent explicit
    // (and to guard against a future EE default that flips `available`).
    const deps = Layer.mergeAll(NoopEnterpriseDefaultsLayer, noopSaasCrm);
    const layer = baseLayer.pipe(Layer.provide(deps));

    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();

    const recoveryCalls = sqlLog.filter((q) =>
      /WHERE status = 'in_flight'/i.test(q.sql),
    );
    expect(recoveryCalls.length).toBe(0);
  });
});
