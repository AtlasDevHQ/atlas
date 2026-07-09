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

// oxlint-disable-next-line @typescript-eslint/no-require-imports
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

const { makeSchedulerLive, Migration } = await import("../layers");
const { SaasCrm, NoopEnterpriseDefaultsLayer } = await import("../services");
const { NoopDurableSessionLayer } = await import("../durable-session");
const { NoopDurableStateLayer } = await import("../durable-state");
const { setActiveFlusherSignal } = await import("@atlas/api/lib/lead-outbox");

// #3446 — `makeSchedulerLive` requires `Migration` as an ordering barrier
// for the billing-reconcile boot tick; satisfy it immediately here.
// #3745 — it also requires `DurableSession`; the Noop layer suffices for the
// outbox-flusher lifecycle tests (the retention-sweep fiber forks but no-ops).
// #3757 — it additionally requires `DurableState` for the memory sweep on the
// same fiber; the Noop layer no-ops it too.
const testMigrationLayer = Layer.mergeAll(
  Layer.succeed(Migration, { migrated: true }),
  NoopDurableSessionLayer,
  NoopDurableStateLayer,
);

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
  // Defensive: every mounted flusher de-registers its doorbell in its
  // scope finalizer, but clear here too so a test that throws before
  // dispose can't leak the process-global into the next test's
  // registry assertions (#2874).
  setActiveFlusherSignal(null);
});

describe("outbox flusher lifecycle (#2729 AC #7 + #9)", () => {
  test("Layer scope boundary triggers startup recovery AND shutdown recovery", async () => {
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const baseLayer = makeSchedulerLive(config);
    // Compose enterprise defaults FIRST so AuditPurgeScheduler etc. are
    // provided, then override SaasCrm with our test-controlled shape.
    const deps = Layer.mergeAll(
      NoopEnterpriseDefaultsLayer,
      testMigrationLayer,
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
      testMigrationLayer,
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
    // Post-#2874 the fiber is edge-triggered, but the FIRST tick after
    // boot still runs immediately (trigger `boot`, a full tick) — so the
    // queryDepthSnapshot SELECT remains the canary that the fiber survived
    // the gen returning. Without forkScoped this test sees zero
    // depth-snapshot queries.
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const baseLayer = makeSchedulerLive(config);
    const deps = Layer.mergeAll(
      NoopEnterpriseDefaultsLayer,
      testMigrationLayer,
      makeAvailableSaasCrmLayer(),
    );
    const layer = baseLayer.pipe(Layer.provide(deps));

    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);

    // The boot tick fires ~immediately on fork; a short window covers
    // scheduler latency on contended CI runners. The depth snapshot SELECT
    // is the boot tick's first observable side effect.
    await new Promise((r) => setTimeout(r, 500));
    await rt.dispose();

    // queryDepthSnapshot reads from crm_outbox without an in_flight
    // filter — distinguishes it from the recovery sweep queries.
    const depthSnapshotCalls = sqlLog.filter(
      (q) =>
        /FROM crm_outbox/i.test(q.sql) && !/WHERE status = 'in_flight'/i.test(q.sql),
    );
    expect(depthSnapshotCalls.length).toBeGreaterThan(0);
  });

  test("registers the edge-trigger doorbell on mount, clears it on shutdown (#2874)", async () => {
    // The process-global doorbell is how the request-path `enqueue`
    // reaches the live flusher. Mount must register it; the scope
    // finalizer must clear it so a post-shutdown kick is inert (and a
    // re-mount on the next boot starts from a clean registry).
    const { getActiveFlusherSignal } = await import("@atlas/api/lib/lead-outbox");
    expect(getActiveFlusherSignal()).toBeNull();

    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config).pipe(
      Layer.provide(Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, makeAvailableSaasCrmLayer())),
    );
    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    expect(getActiveFlusherSignal()).not.toBeNull();

    await rt.dispose();
    expect(getActiveFlusherSignal()).toBeNull();
  });

  test("ATLAS_CRM_OUTBOX_FLUSHER_ENABLED=false skips the tick fork but keeps recovery sweeps", async () => {
    // Region-gate path (#2890): EU/APAC API pods set this to `false`
    // because the lead-capture pipeline only writes to US's internal
    // Postgres. The edge-triggered flusher loop (boot tick + kick +
    // backstop) is skipped entirely, AND the doorbell is NOT registered
    // (so an enqueue kick in this region is inert), but the boot +
    // shutdown recovery sweeps must still run so a future flip-back-on
    // inherits clean state (#2874 AC).
    process.env.ATLAS_CRM_OUTBOX_FLUSHER_ENABLED = "false";
    const { getActiveFlusherSignal } = await import("@atlas/api/lib/lead-outbox");
    try {
      const config = {} as Parameters<typeof makeSchedulerLive>[0];
      const baseLayer = makeSchedulerLive(config);
      const deps = Layer.mergeAll(
        NoopEnterpriseDefaultsLayer,
        testMigrationLayer,
        makeAvailableSaasCrmLayer(),
      );
      const layer = baseLayer.pipe(Layer.provide(deps));

      const rt = ManagedRuntime.make(layer);
      await Effect.runPromise(rt.runtimeEffect);
      // The boot tick would fire ~immediately if the gate were ignored;
      // a short window catches a regression. With the gate honored we see
      // zero tick queries AND no registered doorbell.
      await new Promise((r) => setTimeout(r, 500));
      expect(getActiveFlusherSignal()).toBeNull();
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
    const deps = Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, noopSaasCrm);
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
    const deps = Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, tenantOnlySaasCrm);
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

// ═══════════════════════════════════════════════════════════════════════
// Email outbox flusher lifecycle (#2942)
// ═══════════════════════════════════════════════════════════════════════
//
// The email_outbox flusher (transactional-email durability) is wired in
// the SAME scheduler Layer as the CRM flusher but gated differently: it
// mounts on `hasInternalDB()` ALONE — there is no SaasCrm / enterprise
// gate, because password-reset / verification email happens in every
// deploy mode with a DB. The CRM-side tests above were scoped to
// `crm_outbox` so they don't observe this flusher; these tests assert the
// email flusher's mount + recovery + tick-gate directly.

describe("email outbox flusher lifecycle (#2942)", () => {
  // email_outbox recovery sweeps (MARK_EXHAUSTED + RECOVER_STALE) — the
  // only email statements carrying `WHERE status = 'in_flight'`.
  const emailRecoverySweeps = () =>
    sqlLog.filter(
      (q) => q.sql.includes("email_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
    );
  // email tick observable side effects: the depth-snapshot SELECT and the
  // CLAIM UPDATE both read `FROM email_outbox` and neither contains the
  // `WHERE status = 'in_flight'` recovery predicate.
  const emailTickCalls = () =>
    sqlLog.filter(
      (q) => /FROM email_outbox/i.test(q.sql) && !/WHERE status = 'in_flight'/i.test(q.sql),
    );

  test("runs email_outbox recovery sweeps on boot AND shutdown", async () => {
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config).pipe(
      Layer.provide(Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, makeAvailableSaasCrmLayer())),
    );
    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();

    // One boot + one finalizer × two statements (dead-letter exhausted +
    // reset stale) = 4 email_outbox in_flight sweeps.
    expect(emailRecoverySweeps().length).toBe(4);
  });

  test("mounts INDEPENDENTLY of SaasCrm — fires even when SaasCrm.dispatcher is null", async () => {
    // The key divergence from crm_outbox: a self-hosted / no-EE deploy has
    // a null SaasCrm dispatcher (CRM flusher skipped) but still sends
    // password-reset email, so the email flusher MUST mount on the DB gate
    // alone. The dispatcher-null shape would skip the CRM flusher entirely.
    const noopSaasCrm: Layer.Layer<SaasCrmTag> = Layer.succeed(SaasCrm, {
      available: false,
      upsertLead: () => Effect.void,
      stampConversion: () => Effect.void,
      dispatcher: null,
    } satisfies SaasCrmShape);
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config).pipe(
      Layer.provide(Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, noopSaasCrm)),
    );
    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();

    // CRM sweeps must be zero (dispatcher null), email sweeps must fire.
    const crmSweeps = sqlLog.filter(
      (q) => q.sql.includes("crm_outbox") && /WHERE status = 'in_flight'/i.test(q.sql),
    );
    expect(crmSweeps.length).toBe(0);
    expect(emailRecoverySweeps().length).toBeGreaterThan(0);
  });

  test("does NOT mount when hasInternalDB() returns false", async () => {
    internalDbAvailable = false;
    const config = {} as Parameters<typeof makeSchedulerLive>[0];
    const layer = makeSchedulerLive(config).pipe(
      Layer.provide(Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, makeAvailableSaasCrmLayer())),
    );
    const rt = ManagedRuntime.make(layer);
    await Effect.runPromise(rt.runtimeEffect);
    await rt.dispose();

    expect(emailRecoverySweeps().length).toBe(0);
    expect(emailTickCalls().length).toBe(0);
  });

  test("forked email tick fiber actually runs (regression: forkScoped not fork)", async () => {
    // Mirror of the CRM #2864 canary for the email fiber: prove the tick
    // fiber survives the gen returning. Without forkScoped we'd see zero
    // `FROM email_outbox` depth-snapshot queries.
    process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS = "1";
    try {
      const config = {} as Parameters<typeof makeSchedulerLive>[0];
      const layer = makeSchedulerLive(config).pipe(
        Layer.provide(Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, makeAvailableSaasCrmLayer())),
      );
      const rt = ManagedRuntime.make(layer);
      await Effect.runPromise(rt.runtimeEffect);
      await new Promise((r) => setTimeout(r, 2_500));
      await rt.dispose();
      expect(emailTickCalls().length).toBeGreaterThan(0);
    } finally {
      delete process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS;
    }
  });

  test("ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED=false skips the tick but keeps recovery sweeps", async () => {
    process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED = "false";
    process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS = "1";
    try {
      const config = {} as Parameters<typeof makeSchedulerLive>[0];
      const layer = makeSchedulerLive(config).pipe(
        Layer.provide(Layer.mergeAll(NoopEnterpriseDefaultsLayer, testMigrationLayer, makeAvailableSaasCrmLayer())),
      );
      const rt = ManagedRuntime.make(layer);
      await Effect.runPromise(rt.runtimeEffect);
      await new Promise((r) => setTimeout(r, 2_500));
      await rt.dispose();

      // Tick gated off → no FROM email_outbox tick queries.
      expect(emailTickCalls().length).toBe(0);
      // Recovery sweeps run regardless of the gate → boot + shutdown = 4.
      expect(emailRecoverySweeps().length).toBe(4);
    } finally {
      delete process.env.ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED;
      delete process.env.ATLAS_EMAIL_OUTBOX_TICK_SECONDS;
    }
  });
});
