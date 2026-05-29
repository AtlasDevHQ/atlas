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
    stampConversion: () => Effect.void,
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
    // CRM-specific canary: the email_outbox flusher (#2942) also runs an
    // in_flight recovery sweep and mounts independently (gated on
    // hasInternalDB, not SaasCrm), so the bare `WHERE status =
    // 'in_flight'` predicate now matches both. Scope to `crm_outbox` so
    // this test still counts only the CRM sweeps it's asserting about.
    const recoveryCalls = sqlLog.filter(
      (q) => q.sql.includes("crm_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
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

    // CRM-specific canary: the email_outbox flusher (#2942) also runs an
    // in_flight recovery sweep and mounts independently (gated on
    // hasInternalDB, not SaasCrm), so the bare `WHERE status =
    // 'in_flight'` predicate now matches both. Scope to `crm_outbox` so
    // this test still counts only the CRM sweeps it's asserting about.
    const recoveryCalls = sqlLog.filter(
      (q) => q.sql.includes("crm_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
    );
    // Neither boot nor finalizer touch the DB when the flusher is unwired.
    expect(recoveryCalls.length).toBe(0);
  });

  test("forked tick fiber actually runs (regression: #2864 fork→forkScoped)", async () => {
    // Regression test for the #2864 silent stall: the outbox
    // flusher's tick fiber was spawned with `Effect.fork`, which links
    // the child fiber to the gen's parent fiber and interrupts it the
    // moment the gen returns. Result: zero ticks from boot, indefinitely.
    // `Effect.forkScoped` binds to the Layer scope instead.
    //
    // This test asserts the fiber actually runs by checking that the
    // tick's queryDepthSnapshot SELECT fires within a window slightly
    // longer than the tick interval. Without forkScoped this test would
    // see zero depth-snapshot queries — proving the regression canary.
    process.env.ATLAS_CRM_OUTBOX_TICK_SECONDS = "1";
    try {
      const config = {} as Parameters<typeof makeSchedulerLive>[0];
      const baseLayer = makeSchedulerLive(config);
      const deps = Layer.mergeAll(
        NoopEnterpriseDefaultsLayer,
        makeAvailableSaasCrmLayer(),
      );
      const layer = baseLayer.pipe(Layer.provide(deps));

      const rt = ManagedRuntime.make(layer);
      await Effect.runPromise(rt.runtimeEffect);

      // Wait > 2× tick interval (1s minimum-clamped) so the first
      // scheduled iteration of `Effect.repeat(Schedule.spaced)` has
      // comfortable slack on contended CI runners. The depth snapshot
      // SELECT is the tick's first observable side effect.
      await new Promise((r) => setTimeout(r, 2_500));
      await rt.dispose();

      // queryDepthSnapshot reads from crm_outbox without an in_flight
      // filter — distinguishes it from the recovery sweep queries.
      const depthSnapshotCalls = sqlLog.filter(
        (q) =>
          /FROM crm_outbox/i.test(q.sql) && !/WHERE status = 'in_flight'/i.test(q.sql),
      );
      expect(depthSnapshotCalls.length).toBeGreaterThan(0);
    } finally {
      delete process.env.ATLAS_CRM_OUTBOX_TICK_SECONDS;
    }
  });

  test("ATLAS_CRM_OUTBOX_FLUSHER_ENABLED=false skips the tick fork but keeps recovery sweeps", async () => {
    // Region-gate path (#2890): EU/APAC API pods set this to `false`
    // because the lead-capture pipeline only writes to US's internal
    // Postgres. The flusher polling loop is skipped, but the boot +
    // shutdown recovery sweeps must still run so a future flip-back-on
    // inherits clean state.
    process.env.ATLAS_CRM_OUTBOX_FLUSHER_ENABLED = "false";
    // Short tick so a regression (gate not honored) would surface
    // ticks quickly inside the wait window.
    process.env.ATLAS_CRM_OUTBOX_TICK_SECONDS = "1";
    try {
      const config = {} as Parameters<typeof makeSchedulerLive>[0];
      const baseLayer = makeSchedulerLive(config);
      const deps = Layer.mergeAll(
        NoopEnterpriseDefaultsLayer,
        makeAvailableSaasCrmLayer(),
      );
      const layer = baseLayer.pipe(Layer.provide(deps));

      const rt = ManagedRuntime.make(layer);
      await Effect.runPromise(rt.runtimeEffect);
      // Window > 2× tick interval — if the fork ran we'd see depth
      // snapshot queries pile up here. With the gate honored we see zero.
      await new Promise((r) => setTimeout(r, 2_500));
      await rt.dispose();

      // queryDepthSnapshot from the tick reads `FROM crm_outbox` WITHOUT
      // the `WHERE status = 'in_flight'` filter; the recovery sweeps do
      // the opposite. Splitting on that filter cleanly partitions the two.
      const tickCalls = sqlLog.filter(
        (q) =>
          /FROM crm_outbox/i.test(q.sql) && !/WHERE status = 'in_flight'/i.test(q.sql),
      );
      expect(tickCalls.length).toBe(0);

      // Recovery sweeps must still have fired: one boot + one shutdown
      // = 2 × 2 statements (dead-letter + reset) = 4 in_flight queries.
      // CRM-specific (see note above) — the email_outbox flusher's own
      // recovery sweep must not inflate this CRM-gate assertion.
      const recoveryCalls = sqlLog.filter(
        (q) => q.sql.includes("crm_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
      );
      expect(recoveryCalls.length).toBe(4);
    } finally {
      delete process.env.ATLAS_CRM_OUTBOX_FLUSHER_ENABLED;
      delete process.env.ATLAS_CRM_OUTBOX_TICK_SECONDS;
    }
  });

  test("Layer skips flusher wiring when SaasCrm.dispatcher is null (no EE / no internal DB)", async () => {
    const noopSaasCrm: Layer.Layer<SaasCrmTag> = Layer.succeed(SaasCrm, {
      available: false,
      upsertLead: () => Effect.void,
      stampConversion: () => Effect.void,
      // dispatcher: null is the gate post-#2849 — the flusher mounts on
      // `dispatcher !== null`, NOT on `available`. The tenant-only
      // shape (available: false + dispatcher present) is covered in a
      // separate test (`mounts flusher when only operator probe failed`).
      dispatcher: null,
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

    // CRM-specific canary: the email_outbox flusher (#2942) also runs an
    // in_flight recovery sweep and mounts independently (gated on
    // hasInternalDB, not SaasCrm), so the bare `WHERE status =
    // 'in_flight'` predicate now matches both. Scope to `crm_outbox` so
    // this test still counts only the CRM sweeps it's asserting about.
    const recoveryCalls = sqlLog.filter(
      (q) => q.sql.includes("crm_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
    );
    expect(recoveryCalls.length).toBe(0);
  });

  // ── Codex I2 (#2849) ────────────────────────────────────────────────
  // Pre-fix the flusher gated on `available`, which conflated "operator
  // pipeline broken" with "no dispatcher possible". A transient operator
  // Twenty outage left every customer-workspace row unclaimed.
  test("Layer mounts flusher when only operator probe failed (tenant-only shape, dispatcher present)", async () => {
    const tenantOnlySaasCrm: Layer.Layer<SaasCrmTag> = Layer.succeed(SaasCrm, {
      available: false,
      upsertLead: () => Effect.void,
      stampConversion: () => Effect.void,
      // Tenant-only shape: dispatcher is non-null even though the
      // operator probe failed. The flusher MUST mount so per-tenant
      // rows in crm_outbox keep flowing.
      dispatcher: async () => ({ kind: "ok" as const }),
    } satisfies SaasCrmShape);

    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const baseLayer = makeSchedulerLive(config);
    const deps = Layer.mergeAll(NoopEnterpriseDefaultsLayer, tenantOnlySaasCrm);
    const layer = baseLayer.pipe(Layer.provide(deps));

    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();

    // Recovery sweep is the canary — it only runs when the flusher
    // mounts. Presence of any in_flight reset/mark statement proves
    // the dispatcher-gated mount took effect.
    // CRM-specific canary: the email_outbox flusher (#2942) also runs an
    // in_flight recovery sweep and mounts independently (gated on
    // hasInternalDB, not SaasCrm), so the bare `WHERE status =
    // 'in_flight'` predicate now matches both. Scope to `crm_outbox` so
    // this test still counts only the CRM sweeps it's asserting about.
    const recoveryCalls = sqlLog.filter(
      (q) => q.sql.includes("crm_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
    );
    expect(recoveryCalls.length).toBeGreaterThan(0);
  });
});
