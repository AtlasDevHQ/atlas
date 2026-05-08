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

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  },
  ADMIN_ACTIONS: {
    mcp_session: {
      start: "mcp_session.start",
      rateLimited: "mcp_session.rate_limited",
    },
  },
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  internalQuery: async () => [],
}));

beforeEach(() => {
  auditCalls.length = 0;
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
});
