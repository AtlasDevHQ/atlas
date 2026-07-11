/**
 * The single decide seam (#4506) — `decideAmendment`.
 *
 * Pins the claim-then-apply ordering and the compensation contract that make
 * "approved means applied" hold by construction, at the seam every caller
 * shares (review route, interactive auto-approve, scheduler):
 *   - approve claims (conditional UPDATE) BEFORE applying; the loser of a
 *     concurrent claim gets `already_reviewed` and never touches YAML;
 *   - an apply failure (incl. a version-snapshot failure surfaced by the apply)
 *     reverts the claim to pending and returns `apply_failed` with a reason;
 *   - a null/corrupt payload is an apply error, never a silent stamp;
 *   - a cross-group `AmbiguousEntityError` is reverted-then-rethrown (409).
 *
 * Mocks the DB claim primitive + the apply seam so the ordering and
 * compensation are observable without a real DB or YAML write.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { AmbiguousEntityError } from "@atlas/api/lib/effect/errors";

// ---------------------------------------------------------------------------
// Mocks (before importing the seam)
// ---------------------------------------------------------------------------

interface ClaimedRow {
  id: string;
  source_entity: string;
  connection_group_id: string | null;
  amendment_payload: Record<string, unknown> | null;
}

// Shared sequence log — proves the claim runs strictly before the apply.
let callOrder: string[] = [];

// reviewSemanticAmendment is the atomic claim/reject primitive. Default: the
// transition succeeds and returns the row. Tests override to model a lost race
// (null = the row was already moved out of `pending`).
const mockReview: Mock<
  (id: string, orgId: string | null, decision: "approved" | "rejected", by: string) => Promise<ClaimedRow | null>
> = mock((id: string) => {
  callOrder.push("claim");
  return Promise.resolve({
    id,
    source_entity: "orders",
    connection_group_id: "eu_prod",
    amendment_payload: { amendment: { name: "total_revenue" }, amendmentType: "add_measure" },
  });
});

const mockRevert: Mock<(id: string) => Promise<boolean>> = mock(() => Promise.resolve(true));

void mock.module("@atlas/api/lib/db/internal", () => ({
  reviewSemanticAmendment: mockReview,
  revertAmendmentToPending: mockRevert,
}));

// The apply seam. Default: succeeds. Tests override to throw (apply / snapshot
// failure, ambiguous entity, null-payload rejection).
const mockApply: Mock<(args: Record<string, unknown>) => Promise<void>> = mock(() => {
  callOrder.push("apply");
  return Promise.resolve();
});

void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentFromPayload: mockApply,
  applyAmendmentToEntity: mock(async () => {}),
  applyAmendment: mock((e: Record<string, unknown>) => e),
  resolveAmendmentBaseline: mock(async () => ({ row: {}, targetGroupId: null, parsed: {} })),
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { decideAmendment } = await import("../decide");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const base = { orgId: "org-1", reviewedBy: "admin", requestId: "req-1" } as const;

describe("decideAmendment — claim-then-apply seam (#4506)", () => {
  beforeEach(() => {
    callOrder = [];
    mockReview.mockClear();
    mockReview.mockImplementation((id: string) => {
      callOrder.push("claim");
      return Promise.resolve({
        id,
        source_entity: "orders",
        connection_group_id: "eu_prod",
        amendment_payload: { amendment: { name: "total_revenue" }, amendmentType: "add_measure" },
      });
    });
    mockRevert.mockClear();
    mockRevert.mockResolvedValue(true);
    mockApply.mockClear();
    mockApply.mockImplementation(() => {
      callOrder.push("apply");
      return Promise.resolve();
    });
  });

  describe("approve", () => {
    it("claims BEFORE applying, then returns approved", async () => {
      const result = await decideAmendment({ id: "amd-1", decision: "approved", ...base });

      expect(result).toEqual({ outcome: "approved", id: "amd-1" });
      // Ordering invariant: the conditional claim runs strictly before the apply.
      expect(callOrder).toEqual(["claim", "apply"]);
      // The claim is a pending→approved transition (the only writer of approved).
      expect(mockReview).toHaveBeenCalledTimes(1);
      expect(mockReview.mock.calls[0]).toEqual(["amd-1", "org-1", "approved", "admin"]);
      // Apply threads the CLAIMED row's entity + group + payload.
      expect(mockApply).toHaveBeenCalledTimes(1);
      expect(mockApply.mock.calls[0][0]).toMatchObject({
        orgId: "org-1",
        sourceEntity: "orders",
        connectionGroupId: "eu_prod",
        label: "amd-1",
      });
      // A successful apply is never compensated.
      expect(mockRevert).not.toHaveBeenCalled();
    });

    it("the loser of a concurrent claim gets already_reviewed and NEVER applies YAML", async () => {
      // Model the race loser: the conditional UPDATE matched no pending row.
      mockReview.mockImplementation(() => {
        callOrder.push("claim");
        return Promise.resolve(null);
      });

      const result = await decideAmendment({ id: "amd-1", decision: "approved", ...base });

      expect(result).toEqual({ outcome: "already_reviewed" });
      // No apply, no revert — the loser mutates nothing.
      expect(mockApply).not.toHaveBeenCalled();
      expect(mockRevert).not.toHaveBeenCalled();
      expect(callOrder).toEqual(["claim"]);
    });

    it("apply failure reverts the claim to pending and returns apply_failed with the reason", async () => {
      mockApply.mockImplementation(() => {
        callOrder.push("apply");
        return Promise.reject(new Error("yaml apply failed"));
      });

      const result = await decideAmendment({ id: "amd-1", decision: "approved", ...base });

      expect(result).toEqual({
        outcome: "apply_failed",
        id: "amd-1",
        reason: "yaml apply failed",
        revertedToPending: true,
      });
      // Compensation ran with the claimed id — never left approved-but-unapplied.
      expect(mockRevert).toHaveBeenCalledTimes(1);
      expect(mockRevert.mock.calls[0][0]).toBe("amd-1");
    });

    it("a version-snapshot failure (surfaced by the apply) reverts to pending", async () => {
      // The apply throws when it cannot take a rollback snapshot — the seam
      // treats it like any apply failure and compensates.
      mockApply.mockImplementation(() =>
        Promise.reject(new Error("could not snapshot a rollback point — failing the apply")),
      );

      const result = await decideAmendment({ id: "amd-9", decision: "approved", ...base });

      expect(result.outcome).toBe("apply_failed");
      if (result.outcome === "apply_failed") {
        expect(result.reason).toContain("snapshot");
        expect(result.revertedToPending).toBe(true);
      }
      expect(mockRevert).toHaveBeenCalledTimes(1);
    });

    it("a null/corrupt payload is an apply error that reverts — never a silent stamp", async () => {
      // The claim returns a row with a null payload; the apply seam rejects it.
      mockReview.mockImplementation((id: string) => {
        callOrder.push("claim");
        return Promise.resolve({
          id,
          source_entity: "orders",
          connection_group_id: null,
          amendment_payload: null,
        });
      });
      mockApply.mockImplementation((args: Record<string, unknown>) => {
        if (!args.rawPayload) return Promise.reject(new Error("has no amendment_payload"));
        return Promise.resolve();
      });

      const result = await decideAmendment({ id: "amd-2", decision: "approved", ...base });

      expect(result.outcome).toBe("apply_failed");
      expect(mockRevert).toHaveBeenCalledTimes(1);
    });

    it("surfaces revertedToPending=false when BOTH the apply and the revert fail", async () => {
      mockApply.mockImplementation(() => Promise.reject(new Error("apply exploded")));
      mockRevert.mockImplementation(() => Promise.reject(new Error("revert exploded")));

      const result = await decideAmendment({ id: "amd-3", decision: "approved", ...base });

      expect(result).toEqual({
        outcome: "apply_failed",
        id: "amd-3",
        reason: "apply exploded",
        revertedToPending: false,
      });
    });

    it("a cross-group AmbiguousEntityError is reverted then rethrown (→ 409 group picker)", async () => {
      const ambiguous = new AmbiguousEntityError({
        message: "orders exists in 2 groups",
        entityName: "orders",
        entityType: "entity",
        groups: ["us_prod", "eu_prod"],
      });
      mockApply.mockImplementation(() => Promise.reject(ambiguous));

      await expect(decideAmendment({ id: "amd-4", decision: "approved", ...base })).rejects.toBe(
        ambiguous,
      );
      // The claim is still reverted before the rethrow, so the row stays reviewable.
      expect(mockRevert).toHaveBeenCalledTimes(1);
      expect(mockRevert.mock.calls[0][0]).toBe("amd-4");
    });

    it("ambiguous WITH a failed revert returns apply_failed, not a 409 the admin can't resolve", async () => {
      // Worst case: cross-group ambiguity AND the compensating revert fails, so
      // the row is stuck `approved`. A 409 group-picker would send the admin
      // into a retry that 404s against the pending-only claim — surface the
      // stuck row via apply_failed instead of rethrowing the ambiguity.
      const ambiguous = new AmbiguousEntityError({
        message: "orders exists in 2 groups",
        entityName: "orders",
        entityType: "entity",
        groups: ["us_prod", "eu_prod"],
      });
      mockApply.mockImplementation(() => Promise.reject(ambiguous));
      mockRevert.mockImplementation(() => Promise.reject(new Error("revert exploded")));

      const result = await decideAmendment({ id: "amd-7", decision: "approved", ...base });

      expect(result).toEqual({
        outcome: "apply_failed",
        id: "amd-7",
        reason: "orders exists in 2 groups",
        revertedToPending: false,
      });
    });
  });

  describe("reject", () => {
    it("rejects atomically without applying YAML", async () => {
      const result = await decideAmendment({ id: "amd-5", decision: "rejected", ...base });

      expect(result).toEqual({ outcome: "rejected", id: "amd-5" });
      expect(mockReview.mock.calls[0]).toEqual(["amd-5", "org-1", "rejected", "admin"]);
      expect(mockApply).not.toHaveBeenCalled();
      expect(mockRevert).not.toHaveBeenCalled();
    });

    it("returns already_reviewed when the reject loses the race", async () => {
      mockReview.mockResolvedValue(null);

      const result = await decideAmendment({ id: "amd-6", decision: "rejected", ...base });

      expect(result).toEqual({ outcome: "already_reviewed" });
      expect(mockApply).not.toHaveBeenCalled();
    });
  });
});
