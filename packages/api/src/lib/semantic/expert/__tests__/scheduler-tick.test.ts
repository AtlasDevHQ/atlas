/**
 * runExpertSchedulerTick auto-approve invariant (#4486).
 *
 * The scheduler stamps eligible proposals `approved` at insert and applies them
 * immediately. This pins the two behaviors the invariant "status='approved' ⇒
 * applied" depends on, so a future edit that drops the apply or the revert ships
 * red instead of green:
 *   - approved + apply succeeds  → autoApproved, row NOT reverted
 *   - approved + apply fails      → row reverted to pending with the insert's id,
 *                                    counted as an error (never left approved)
 *
 * A separate file from scheduler.test.ts (which only tests the config getters)
 * so the tick's module mocks don't leak into those tests.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AnalysisResult } from "../types";

const proposal: AnalysisResult = {
  category: "coverage_gaps",
  entityName: "companies",
  group: "default",
  amendmentType: "add_dimension",
  amendment: { name: "region", type: "string", description: "Region" },
  rationale: "Adds region dimension",
  impact: 0.9,
  confidence: 0.95,
  staleness: 0,
  score: 0.85,
};

// One entity so the tick clears the `entities.length === 0` early return; the
// analyzer is mocked to return our proposal regardless of inputs.
void mock.module("../context-loader", () => ({
  loadEntitiesFromDisk: async () => [{ name: "companies" }],
  loadGlossaryFromDisk: async () => [],
  loadAuditPatterns: async () => [],
  loadRejectedKeys: async () => new Set<string>(),
}));

void mock.module("../profile-cache", () => ({
  loadCachedProfiles: () => [],
}));

let proposals: AnalysisResult[] = [proposal];
void mock.module("../analyzer", () => ({
  analyzeSemanticLayer: () => proposals,
}));

const mockApplyAmendmentToEntity: Mock<() => Promise<void>> = mock(() => Promise.resolve());
void mock.module("../apply", () => ({
  applyAmendmentToEntity: mockApplyAmendmentToEntity,
}));

const mockInsertSemanticAmendment: Mock<() => Promise<{ id: string; status: string }>> = mock(() =>
  Promise.resolve({ id: "sch-1", status: "approved" }),
);
const mockRevertAmendmentToPending: Mock<(id: string) => Promise<boolean>> = mock(() =>
  Promise.resolve(true),
);
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
  revertAmendmentToPending: mockRevertAmendmentToPending,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  // scheduler.ts now reads this to force-disable on SaaS (#4487); the tick
  // tests exercise the self-hosted path, so keep it false (not SaaS).
  isSaasModeForGuard: () => false,
}));

const { runExpertSchedulerTick } = await import("../scheduler");

describe("runExpertSchedulerTick auto-approve → apply invariant (#4486)", () => {
  beforeEach(() => {
    proposals = [proposal];
    mockApplyAmendmentToEntity.mockClear();
    mockApplyAmendmentToEntity.mockResolvedValue(undefined);
    mockInsertSemanticAmendment.mockClear();
    mockInsertSemanticAmendment.mockResolvedValue({ id: "sch-1", status: "approved" });
    mockRevertAmendmentToPending.mockClear();
    mockRevertAmendmentToPending.mockResolvedValue(true);
  });

  it("applies an auto-approved proposal and does not revert it", async () => {
    const result = await runExpertSchedulerTick();

    expect(mockApplyAmendmentToEntity).toHaveBeenCalledTimes(1);
    expect(mockRevertAmendmentToPending).not.toHaveBeenCalled();
    expect(result.autoApproved).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("reverts the row to pending (with the insert id) when apply fails", async () => {
    mockApplyAmendmentToEntity.mockRejectedValue(new Error("entity not found"));

    const result = await runExpertSchedulerTick();

    // The row must not linger `approved`-but-unapplied: revert is called with
    // the exact id the insert returned.
    expect(mockRevertAmendmentToPending).toHaveBeenCalledTimes(1);
    expect(mockRevertAmendmentToPending.mock.calls[0][0]).toBe("sch-1");
    expect(result.autoApproved).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("does not apply or revert when the proposal lands pending", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ id: "sch-2", status: "pending" });

    const result = await runExpertSchedulerTick();

    expect(mockApplyAmendmentToEntity).not.toHaveBeenCalled();
    expect(mockRevertAmendmentToPending).not.toHaveBeenCalled();
    expect(result.queued).toBe(1);
    expect(result.errors).toBe(0);
  });
});
