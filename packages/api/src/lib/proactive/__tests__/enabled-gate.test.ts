/**
 * Unit tests for `createProactiveEnabledGate` (#2616, slice 2c of #2607).
 *
 * Covers:
 *   - Enterprise enabled + workspace enabled → true
 *   - Enterprise enabled + workspace disabled (enabled = false) → false
 *   - Enterprise enabled + workspace row missing → false
 *   - Enterprise DISABLED (Tag yields EnterpriseError) → false; no DB query
 *   - Enterprise enabled + DB query throws → false + log.warn called
 *   - Caching: enterprise check runs once across many calls; workspace
 *     flag re-queried every call.
 *
 * Mock notes:
 *   - `mock.module()` factories are sync — async + inner await hangs the
 *     bun loader (CLAUDE.md `feedback_bun_test_async_mock_module`).
 *   - The logger mock returns a fully-stubbed shape (no
 *     `...realLogger`) — re-requiring `@atlas/api/lib/logger` from
 *     inside its own mock factory body deadlocks the loader.
 *   - Modules under test are loaded via `require()` AFTER mocks are
 *     installed; `await import(...)` between mock + load is also a
 *     known deadlock path.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  type Mock,
} from "bun:test";

// ── Logger mock ─────────────────────────────────────────────────────
//
// Installed FIRST so the `lib/effect/services` chain (transitively
// imports `createLogger`) sees the stub. The mock returns a fully-
// stubbed pino-shaped object — `realLogger.createLogger(...)` recursion
// inside the mock factory hangs the bun loader.

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    warn: mockLogWarn,
    info: () => {},
    debug: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    child: () => ({
      warn: mockLogWarn,
      info: () => {},
      debug: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      silent: () => {},
    }),
  }),
}));

// ── DB internal mock ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

const mockInternalQuery: Mock<
  (sql: string, params: unknown[]) => Promise<unknown[]>
> = mock(async () => []);

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: (sql: string, params: unknown[]) =>
    mockInternalQuery(sql, params),
}));

// ── Real modules (loaded AFTER mocks via sync require) ───────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Effect, Layer, ManagedRuntime } = require("effect") as typeof import("effect");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProactiveGate } = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EnterpriseError } = require("@atlas/api/lib/effect/errors") as typeof import("@atlas/api/lib/effect/errors");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProactiveEnabledGate } = require("../enabled-gate") as typeof import("../enabled-gate");

// ── Test layer helpers ──────────────────────────────────────────────

type RequireEnabledFn = () => ReturnType<
  InstanceType<typeof ProactiveGate>["requireEnabled"]
>;

function buildGateLayer(opts: {
  enabled: boolean;
  spy?: Mock<RequireEnabledFn>;
}) {
  const fallback: RequireEnabledFn = () =>
    opts.enabled
      ? (Effect.void as ReturnType<RequireEnabledFn>)
      : (Effect.fail(
          new EnterpriseError(
            "Enterprise features (proactive-chat) are not enabled.",
          ),
        ) as ReturnType<RequireEnabledFn>);
  const requireEnabled = opts.spy ?? mock(fallback);
  if (!opts.spy) {
    requireEnabled.mockImplementation(fallback);
  }
  return Layer.succeed(ProactiveGate, {
    requireEnabled: () => requireEnabled(),
  });
}

function buildRuntime(layer: ReturnType<typeof buildGateLayer>) {
  return ManagedRuntime.make(layer);
}

// ── Per-test reset ──────────────────────────────────────────────────

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => []);
  mockLogWarn.mockClear();
});

afterEach(() => {
  mockInternalQuery.mockClear();
  mockLogWarn.mockClear();
});

// ── Tests ───────────────────────────────────────────────────────────

describe("createProactiveEnabledGate", () => {
  it("returns true when enterprise is enabled AND workspace flag is true", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(true);

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("workspace_proactive_config");
    expect(sql).toContain("SELECT enabled");
    expect(params).toEqual(["ws-1"]);
  });

  it("returns false when enterprise is enabled but workspace flag is false", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: false }]);

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });

  it("returns false when enterprise is enabled but the workspace row is missing", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));
    mockInternalQuery.mockImplementation(async () => []);

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    // Row-missing is the expected "not opted in" path — no warning.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns false when enterprise is disabled (Tag fails with EnterpriseError) — and skips DB query entirely", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: false }));
    // If the gate accidentally queries the DB, the test would still
    // pass on the boolean — but the call-count assertion proves the
    // workspace SELECT short-circuited.
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);
    expect(mockInternalQuery).not.toHaveBeenCalled();
    // EnterpriseError is the expected self-hosted path — no warn.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns false + logs warn when the workspace DB query throws", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection refused");
    });

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.err).toBe("connection refused");
    expect(message).toContain("workspace_proactive_config");
  });

  it("type-narrows non-Error throws in the DB path", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));
    mockInternalQuery.mockImplementation(async () => {
      // Defensive: covers the `String(err)` branch (CLAUDE.md
      // "type-narrow caught errors").
      throw "string-thrown";
    });

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);

    const [payload] = mockLogWarn.mock.calls[0] as [Record<string, unknown>];
    expect(payload.err).toBe("string-thrown");
  });

  it("caches the enterprise check — ProactiveGate.requireEnabled yielded exactly once across many calls", async () => {
    const spy: Mock<RequireEnabledFn> = mock(
      () => Effect.void as ReturnType<RequireEnabledFn>,
    );
    const runtime = buildRuntime(buildGateLayer({ enabled: true, spy }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gate = createProactiveEnabledGate(runtime);
    await gate("ws-1");
    await gate("ws-1");
    await gate("ws-1");
    await gate("ws-1");

    // The Tag's `requireEnabled` is invoked ONCE — subsequent calls
    // hit the per-closure cache. The workspace SELECT runs every time.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockInternalQuery).toHaveBeenCalledTimes(4);
  });

  it("caches a false enterprise result — subsequent calls return false without yielding the Tag or hitting the DB", async () => {
    const spy: Mock<RequireEnabledFn> = mock(
      () =>
        Effect.fail(
          new EnterpriseError(
            "Enterprise features (proactive-chat) are not enabled.",
          ),
        ) as ReturnType<RequireEnabledFn>,
    );
    const runtime = buildRuntime(buildGateLayer({ enabled: false, spy }));

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);
    expect(await gate("ws-1")).toBe(false);
    expect(await gate("ws-1")).toBe(false);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("workspace flag flips between calls — uncached, picks up the new value immediately", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));

    let workspaceEnabled = true;
    mockInternalQuery.mockImplementation(async () => [
      { enabled: workspaceEnabled },
    ]);

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(true);

    workspaceEnabled = false;
    expect(await gate("ws-1")).toBe(false);

    workspaceEnabled = true;
    expect(await gate("ws-1")).toBe(true);
  });

  it("each createProactiveEnabledGate call returns an independent closure with its own enterprise cache", async () => {
    // Post-#2620 the factory is workspaceId-less; closures are bound
    // once per process and serve N tenants. This test proves that two
    // independent closures (e.g. built in two different bridges) keep
    // their own enterprise caches without sharing state.
    const spyA: Mock<RequireEnabledFn> = mock(
      () => Effect.void as ReturnType<RequireEnabledFn>,
    );
    const spyB: Mock<RequireEnabledFn> = mock(
      () => Effect.void as ReturnType<RequireEnabledFn>,
    );
    const runtimeA = buildRuntime(buildGateLayer({ enabled: true, spy: spyA }));
    const runtimeB = buildRuntime(buildGateLayer({ enabled: true, spy: spyB }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gateA = createProactiveEnabledGate(runtimeA);
    const gateB = createProactiveEnabledGate(runtimeB);

    expect(await gateA("ws-A")).toBe(true);
    expect(await gateB("ws-B")).toBe(true);

    // Each closure yields its own Tag once (independent caches).
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    // Each closure ran the workspace SELECT once with its arg.
    expect(mockInternalQuery).toHaveBeenCalledTimes(2);
    const params = mockInternalQuery.mock.calls.map((c) => c[1]);
    expect(params).toEqual([["ws-A"], ["ws-B"]]);
  });

  it("one closure serves multiple tenants — single enterprise cache, per-call workspace SELECT", async () => {
    // The core #2620 multi-tenant correctness assertion: a single
    // closure built ONCE per process must serve N tenants. The
    // enterprise check is cached (per-closure / process-lifetime
    // constant) and the workspace SELECT re-runs every call with the
    // caller-supplied workspaceId.
    const spy: Mock<RequireEnabledFn> = mock(
      () => Effect.void as ReturnType<RequireEnabledFn>,
    );
    const runtime = buildRuntime(buildGateLayer({ enabled: true, spy }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gate = createProactiveEnabledGate(runtime);

    expect(await gate("ws-A")).toBe(true);
    expect(await gate("ws-B")).toBe(true);
    expect(await gate("ws-C")).toBe(true);

    // Tag yielded once — caches across all three calls.
    expect(spy).toHaveBeenCalledTimes(1);
    // Workspace SELECT ran per call with each workspaceId.
    expect(mockInternalQuery).toHaveBeenCalledTimes(3);
    const params = mockInternalQuery.mock.calls.map((c) => c[1]);
    expect(params).toEqual([["ws-A"], ["ws-B"], ["ws-C"]]);
  });

  it("transient runtime defect (non-EnterpriseError throw) does NOT cache — next call retries the Tag", async () => {
    // Simulate a `ManagedRuntime` that throws a non-`EnterpriseError`
    // out of `runPromise` (Layer construction failure, init race,
    // etc.). The gate must fail the current call closed but leave the
    // cache as `undefined` so the next call retries — otherwise a
    // single boot-time blip closes the gate for the whole process
    // lifetime.
    let throwOnce = true;
    const spy: Mock<RequireEnabledFn> = mock(() => {
      if (throwOnce) {
        throwOnce = false;
        // Throw a non-`EnterpriseError` *defect* by wrapping in
        // `Effect.sync` — this becomes an unhandled defect that
        // surfaces as a thrown error out of `runtime.runPromise`,
        // bypassing the inner `Effect.catchAll` (which handles the
        // `E` channel only).
        return Effect.sync(() => {
          throw new Error("layer construction failed");
        }) as ReturnType<RequireEnabledFn>;
      }
      // Second call: succeed.
      return Effect.void as ReturnType<RequireEnabledFn>;
    });
    const runtime = buildRuntime(buildGateLayer({ enabled: true, spy }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gate = createProactiveEnabledGate(runtime);

    // First call: defect → fails closed, does NOT cache.
    expect(await gate("ws-1")).toBe(false);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.retry).toBe(true);
    expect(message).toContain("transient");
    // No DB query — the workspace check is gated on a positive
    // enterprise resolution.
    expect(mockInternalQuery).not.toHaveBeenCalled();

    // Second call: retries the Tag, succeeds, hits the DB.
    expect(await gate("ws-1")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });

  it("__reset() clears the per-closure enterprise cache so the next call re-yields the Tag", async () => {
    const spy: Mock<RequireEnabledFn> = mock(
      () => Effect.void as ReturnType<RequireEnabledFn>,
    );
    const runtime = buildRuntime(buildGateLayer({ enabled: true, spy }));
    mockInternalQuery.mockImplementation(async () => [{ enabled: true }]);

    const gate = createProactiveEnabledGate(runtime);

    // Prime the cache.
    expect(await gate("ws-1")).toBe(true);
    expect(await gate("ws-1")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Reset, then call again — Tag should be re-yielded.
    gate.__reset();
    expect(await gate("ws-1")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("includes the pg error `code` on the workspace DB warn payload", async () => {
    const runtime = buildRuntime(buildGateLayer({ enabled: true }));
    // Construct a pg-shaped error: `Error` instance with a `.code`.
    const err = Object.assign(new Error("admin shutdown"), {
      code: "57P01",
    });
    mockInternalQuery.mockImplementation(async () => {
      throw err;
    });

    const gate = createProactiveEnabledGate(runtime);
    expect(await gate("ws-1")).toBe(false);

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockLogWarn.mock.calls[0] as [Record<string, unknown>];
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.err).toBe("admin shutdown");
    expect(payload.code).toBe("57P01");
  });
});
