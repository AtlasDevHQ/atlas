/**
 * Tests for {@link makeChatIntegrationCapGate} — the shared
 * {@link SingletonInstallCapGate} the six chat-pillar singleton handlers
 * (five static-bot + Slack OAuth) pass to `persistSingletonInstall` (#4352).
 *
 * The three arms pinned here (allowed → rows; cap → 429; count-failed → 503)
 * are the cap-decision block that used to be hand-copied across all six
 * handlers. The gate RETURNS a denial (never throws it) so the generic spine
 * can tell it apart from a raw write-path throw, which passes straight
 * through — pinned by the last case.
 */

import { afterEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

type GateResult =
  | { allowed: true; rows: Array<Record<string, unknown>> }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };

const mockCheckChatLimitAndInstall: Mock<
  (
    orgId: string | undefined,
    catalogId: string,
    insert: { sql: string; params: readonly unknown[] },
  ) => Promise<GateResult>
> = mock(() => Promise.resolve({ allowed: true as const, rows: [{ id: "row-1" }] }));

// Mock every value export — a partial `mock.module()` breaks other importers
// of the module (CLAUDE.md "mock all exports"). Only the atomic gate is used;
// the rest are inert no-ops.
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkChatIntegrationLimitAndInstall: mockCheckChatLimitAndInstall,
  checkChatIntegrationLimit: () => Promise.resolve({ allowed: true }),
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
  resolveAbuseCeilingPercent: () => Promise.resolve(null),
  resolveSpendPolicy: () => Promise.resolve("continue"),
  resolveUsageCeiling: () => Promise.resolve({ spendPolicy: "continue", ceilingPercent: null }),
  computeOverageDollars: () => 0,
  getTrialDaysRemaining: () => Promise.resolve(null),
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
}));

const { makeChatIntegrationCapGate } = await import("../chat-integration-cap-gate");

const noopLog = { error: () => {}, info: () => {} };
const insert = { sql: "INSERT INTO workspace_plugins ...", params: ["a", "b"] as const };

function gate() {
  return makeChatIntegrationCapGate({
    orgId: "ws-1" as WorkspaceId,
    catalogId: "catalog:telegram",
    displayName: "Telegram",
    log: noopLog,
  });
}

afterEach(() => {
  mockCheckChatLimitAndInstall.mockReset();
  mockCheckChatLimitAndInstall.mockImplementation(() =>
    Promise.resolve({ allowed: true as const, rows: [{ id: "row-1" }] }),
  );
});

describe("makeChatIntegrationCapGate", () => {
  it("forwards (orgId, catalogId, insert) to the atomic gate and returns its RETURNING rows on allow", async () => {
    const result = await gate()(insert);
    expect(result).toEqual({ ok: true, rows: [{ id: "row-1" }] });
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [org, catalog, passedInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(org).toBe("ws-1");
    expect(catalog).toBe("catalog:telegram");
    expect(passedInsert).toBe(insert);
  });

  it("maps a cap_reached denial to a returned (not thrown) ChatIntegrationLimitError (429)", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: false, reason: "cap_reached", errorMessage: "at cap", limit: 1 }),
    );
    const result = await gate()(insert);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.error).toMatchObject({ _tag: "ChatIntegrationLimitError", limit: 1, workspaceId: "ws-1" });
  });

  it("maps a check_failed denial to a returned BillingCheckFailedError (503), not the 429", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: false, reason: "check_failed", errorMessage: "try again" }),
    );
    const result = await gate()(insert);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.error).toMatchObject({ _tag: "BillingCheckFailedError", workspaceId: "ws-1" });
  });

  it("lets a raw write-path throw (routing 23505 / driver fault) propagate for the spine to classify", async () => {
    const boom = new Error("duplicate key value violates unique constraint");
    mockCheckChatLimitAndInstall.mockImplementationOnce(() => Promise.reject(boom));
    await expect(gate()(insert)).rejects.toBe(boom);
  });
});
