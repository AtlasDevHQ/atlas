/**
 * Tests for the per-OAuth-client rate-limit middleware (#2071).
 *
 * The pure limiter is exercised in `oauth-client.test.ts`. This file
 * pins the wiring layer:
 *
 *   - The DB loader is called exactly once per (orgId, clientId).
 *   - The denied envelope matches the AtlasMcpToolError #2030 shape:
 *     `{ code: "rate_limited", retry_after, hint, message }`.
 *   - `mcp_session.rate_limited` audit row is emitted on denial.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { _resetClientRateLimitsForTests } from "../oauth-client";

// `mock.module()` factories are sync per the bun-test gotcha noted in
// memory; the audit + internal-db modules export the small surface we
// need plus the AdminActionEntry type, so we replace them entirely.

const auditCalls: Array<Record<string, unknown>> = [];
let auditThrows = false;

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
    if (auditThrows) {
      // Stress the contract: the middleware must build the envelope
      // even if audit emission throws. `logAdminAction` documents
      // "NEVER throws" but the contract is JSDoc, not type-enforced.
      throw new Error("synthetic audit failure");
    }
  },
  ADMIN_ACTIONS: {
    mcp_session: {
      start: "mcp_session.start",
      rateLimited: "mcp_session.rate_limited",
    },
  },
}));

// Toggleable internal-DB state: defaults are "DB present, circuit closed"
// so loader-failure / circuit-open tests can flip the bits inline.
let _hasInternalDB = false;
let _circuitOpen = false;
let _internalQueryThrows = false;
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => _hasInternalDB,
  internalQuery: async () => {
    if (_internalQueryThrows) throw new Error("synthetic DB outage");
    return [];
  },
  isInternalCircuitOpen: () => _circuitOpen,
}));

const metricsCalls: Array<{ counter: string; value: number; attrs: Record<string, unknown> }> = [];
mock.module("@atlas/api/lib/metrics", () => ({
  rateLimitAuditDropped: {
    add: (value: number, attrs: Record<string, unknown> = {}) => {
      metricsCalls.push({ counter: "rate_limit.audit_dropped", value, attrs });
    },
  },
  rateLimitLoaderFailures: {
    add: (value: number, attrs: Record<string, unknown> = {}) => {
      metricsCalls.push({ counter: "rate_limit.loader_failures", value, attrs });
    },
  },
}));

beforeEach(() => {
  auditCalls.length = 0;
  auditThrows = false;
  _hasInternalDB = false;
  _circuitOpen = false;
  _internalQueryThrows = false;
  metricsCalls.length = 0;
  delete process.env.ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED;
  _resetClientRateLimitsForTests();
});

afterEach(() => {
  _resetClientRateLimitsForTests();
});

const baseInput = {
  orgId: "org_a",
  clientId: "client_x",
  userId: "user_1",
  toolName: "executeSQL",
};

describe("enforceClientRateLimit", () => {
  it("uses DEFAULT_REQUESTS_PER_MINUTE when no loader returns null (self-hosted bootstrap)", async () => {
    // hasInternalDB() === false in this test file's mock — the
    // defaultLoader path returns null and resolveRateLimitFor falls
    // through to the documented default. Pin via an exhaustive drain.
    const { enforceClientRateLimit } = await import("../middleware");
    const { DEFAULT_REQUESTS_PER_MINUTE } = await import("../oauth-client");
    const nullLoader = async () => null;
    const light = { ...baseInput, toolName: "listEntities" };
    // Drain exactly DEFAULT_REQUESTS_PER_MINUTE light calls.
    for (let i = 0; i < DEFAULT_REQUESTS_PER_MINUTE; i++) {
      const outcome = await enforceClientRateLimit(light, nullLoader);
      expect(outcome.kind).toBe("ok");
    }
    const denied = await enforceClientRateLimit(light, nullLoader);
    expect(denied.kind).toBe("denied");
  });

  it("loads the override exactly once per (orgId, clientId)", async () => {
    const { enforceClientRateLimit } = await import("../middleware");
    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls++;
      return 100;
    };

    await enforceClientRateLimit(baseInput, loader);
    await enforceClientRateLimit(baseInput, loader);
    await enforceClientRateLimit(baseInput, loader);

    expect(loaderCalls).toBe(1);
  });

  it("returns kind: 'ok' under quota", async () => {
    const { enforceClientRateLimit } = await import("../middleware");
    const outcome = await enforceClientRateLimit(baseInput, async () => 100);
    expect(outcome.kind).toBe("ok");
  });

  it("emits an AtlasMcpToolError envelope on denial", async () => {
    const { enforceClientRateLimit } = await import("../middleware");
    // Tight budget: 1 weighted request — second executeSQL is denied
    const tightLoader = async () => 1;
    await enforceClientRateLimit(baseInput, tightLoader);
    const denied = await enforceClientRateLimit(baseInput, tightLoader);

    expect(denied.kind).toBe("denied");
    if (denied.kind !== "denied") return;
    expect(denied.envelope.code).toBe("rate_limited");
    expect(denied.envelope.retry_after).toBe(denied.retryAfterSec);
    expect(denied.envelope.message).toContain("client_x");
    expect(denied.envelope.hint).toBeTruthy();
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("emits a mcp_session.rate_limited audit row on denial", async () => {
    const { enforceClientRateLimit } = await import("../middleware");
    const tightLoader = async () => 1;
    await enforceClientRateLimit(baseInput, tightLoader);
    auditCalls.length = 0;
    const denied = await enforceClientRateLimit(baseInput, tightLoader);
    expect(denied.kind).toBe("denied");

    expect(auditCalls).toHaveLength(1);
    const row = auditCalls[0];
    expect(row.actionType).toBe("mcp_session.rate_limited");
    expect(row.targetType).toBe("mcp_session");
    expect(row.targetId).toBe("client_x");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.clientId).toBe("client_x");
    expect(meta.userId).toBe("user_1");
    expect(meta.tool).toBe("executeSQL");
    const state = meta.ratelimitState as Record<string, unknown>;
    expect(state.limit).toBe(1);
    expect(state.weight).toBeGreaterThan(0);
    expect(state.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("does not audit the allowed path", async () => {
    const { enforceClientRateLimit } = await import("../middleware");
    const outcome = await enforceClientRateLimit(baseInput, async () => 100);
    expect(outcome.kind).toBe("ok");
    expect(auditCalls).toHaveLength(0);
  });

  // ── #2183 item 4: optional fail-closed loader mode ──────────────────

  it("fail-open by default — a loader DB outage falls through to DEFAULT_REQUESTS_PER_MINUTE and increments the fail_open counter", async () => {
    _hasInternalDB = true;
    _internalQueryThrows = true;
    const { enforceClientRateLimit } = await import("../middleware");
    const { DEFAULT_REQUESTS_PER_MINUTE } = await import("../oauth-client");
    // The default loader is selected by enforceClientRateLimit when the
    // caller passes no loader argument — that's the production path.
    const lightInput = { ...baseInput, toolName: "listEntities" };
    const outcome = await enforceClientRateLimit(lightInput);
    expect(outcome.kind).toBe("ok");

    // The fall-through used the default quota — drain to confirm.
    let allowed = 1; // one already consumed
    while (allowed < DEFAULT_REQUESTS_PER_MINUTE) {
      const r = await enforceClientRateLimit(lightInput);
      if (r.kind !== "ok") break;
      allowed++;
    }
    expect(allowed).toBe(DEFAULT_REQUESTS_PER_MINUTE);

    expect(metricsCalls).toContainEqual(
      expect.objectContaining({
        counter: "rate_limit.loader_failures",
        attrs: expect.objectContaining({ disposition: "fail_open" }),
      }),
    );
  });

  it("fail-closed under ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED=true denies with the override-degraded hint", async () => {
    process.env.ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED = "true";
    _hasInternalDB = true;
    _internalQueryThrows = true;
    const { enforceClientRateLimit } = await import("../middleware");
    const outcome = await enforceClientRateLimit(baseInput);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.envelope.code).toBe("rate_limited");
    expect(outcome.envelope.hint).toMatch(/override service degraded/i);
    expect(outcome.envelope.retry_after).toBeGreaterThan(0);

    expect(metricsCalls).toContainEqual(
      expect.objectContaining({
        counter: "rate_limit.loader_failures",
        attrs: expect.objectContaining({ disposition: "fail_closed" }),
      }),
    );
  });

  it("fail-closed denial still emits an audit row so the forensic trail captures the degradation", async () => {
    process.env.ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED = "true";
    _hasInternalDB = true;
    _internalQueryThrows = true;
    const { enforceClientRateLimit } = await import("../middleware");
    auditCalls.length = 0;
    const outcome = await enforceClientRateLimit(baseInput);
    expect(outcome.kind).toBe("denied");

    expect(auditCalls).toHaveLength(1);
    const row = auditCalls[0];
    expect(row.actionType).toBe("mcp_session.rate_limited");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("loader_failure");
  });

  // ── #2183 item 3: audit row silent-drop visibility ──────────────────

  it("emits the audit-dropped counter + log.error when the internal-DB circuit is open on denial", async () => {
    // Surface the visibility gap the silent-failure-hunter Finding #5
    // flagged: with a fire-and-forget audit and an open circuit, the
    // pino warn line from logAdminAction looks identical to a generic
    // admin row. The middleware must light up a differentiated
    // `atlas.rate_limit.audit_dropped` counter + `log.error` so the
    // operator dashboard sees the drop. A regression that drops the
    // counter call would let an attacker hit the rate limit during a
    // DB outage and leave no audit trail.
    _hasInternalDB = true;
    _circuitOpen = true;
    const { enforceClientRateLimit } = await import("../middleware");
    const tightLoader = async () => 1;
    await enforceClientRateLimit(baseInput, tightLoader);
    metricsCalls.length = 0;
    const denied = await enforceClientRateLimit(baseInput, tightLoader);
    expect(denied.kind).toBe("denied");

    expect(metricsCalls).toContainEqual(
      expect.objectContaining({
        counter: "rate_limit.audit_dropped",
        value: 1,
        attrs: expect.objectContaining({
          reason: "circuit_open",
          "client.id": "client_x",
          "tool.name": "executeSQL",
        }),
      }),
    );
  });

  it("does NOT emit audit-dropped when the circuit is closed (the row is presumed written)", async () => {
    _hasInternalDB = true;
    _circuitOpen = false;
    const { enforceClientRateLimit } = await import("../middleware");
    const tightLoader = async () => 1;
    await enforceClientRateLimit(baseInput, tightLoader);
    metricsCalls.length = 0;
    const denied = await enforceClientRateLimit(baseInput, tightLoader);
    expect(denied.kind).toBe("denied");
    const dropped = metricsCalls.filter(
      (c) => c.counter === "rate_limit.audit_dropped",
    );
    expect(dropped).toHaveLength(0);
  });

  it("does NOT emit audit-dropped when there is no internal DB (self-hosted bootstrap)", async () => {
    // The drop-detection only makes sense when there's a DB to drop the
    // row into. Without one, the pino line IS the only trail by design,
    // not a gap — emitting the counter would confuse operators.
    _hasInternalDB = false;
    _circuitOpen = true; // would-be-tripped, but no DB to write to
    const { enforceClientRateLimit } = await import("../middleware");
    const tightLoader = async () => 1;
    await enforceClientRateLimit(baseInput, tightLoader);
    metricsCalls.length = 0;
    const denied = await enforceClientRateLimit(baseInput, tightLoader);
    expect(denied.kind).toBe("denied");
    const dropped = metricsCalls.filter(
      (c) => c.counter === "rate_limit.audit_dropped",
    );
    expect(dropped).toHaveLength(0);
  });

  it("propagates an audit-emission throw — the per-tool try/catch must catch it", async () => {
    // Silent-failure-hunter Finding #2: if `rateLimitOrNull` lived
    // OUTSIDE the per-tool try, an audit throw on denial would
    // propagate past the envelope and the agent would see a
    // transport-level error. The fix moved the limiter inside the
    // per-tool try, so this test exists to pin that the middleware
    // itself does NOT swallow the throw — it is the tool-layer's
    // job to translate it into an `internal_error` envelope. A
    // regression that adds a defensive try/catch here would silently
    // hide audit-emission bugs and break the explicit-translation
    // contract that finding #2 fixed.
    auditThrows = true;
    const { enforceClientRateLimit } = await import("../middleware");
    // Light tool so the budget admits one allowed call before denial.
    // executeSQL (weight 5) against a budget of 1 would trip the
    // single-weight-exceeds-limit branch on the very first dispatch.
    const lightInput = { ...baseInput, toolName: "listEntities" };
    const tightLoader = async () => 1;
    const first = await enforceClientRateLimit(lightInput, tightLoader);
    expect(first.kind).toBe("ok");
    await expect(
      enforceClientRateLimit(lightInput, tightLoader),
    ).rejects.toThrow(/synthetic audit failure/);
  });
});
