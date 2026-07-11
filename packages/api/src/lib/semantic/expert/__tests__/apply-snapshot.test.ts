/**
 * applyAmendmentToEntity write-path failure contract (#4506).
 *
 * Rollback-ability is part of the apply: a version-snapshot failure (or a
 * post-upsert refetch miss) FAILS the whole apply, so the decide seam
 * compensates and the row returns to pending — an `approved` amendment always
 * has a recorded version to roll back to. The disk-mirror sync stays
 * warn-only. Cache invalidation runs as soon as the upsert lands, even when
 * the snapshot then fails.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AnalysisResult } from "../types";

const ordersYaml = ["name: orders", "table: orders", "description: Orders", "dimensions:", "  - name: id", "    type: number"].join("\n");
// A structurally-broken baseline missing `table:` — the post-apply EntityShape
// gate (#4513) must reject any amendment applied on top of it.
const ordersYamlNoTable = ["name: orders", "description: Orders", "dimensions:", "  - name: id", "    type: number"].join("\n");

const ordersRow = { id: "orders-row", connection_group_id: null, yaml_content: ordersYaml };

// Failure-injection switches.
let refetchReturnsNull = false;
let createVersionThrows = false;
let syncThrows = false;
// When true, the SECOND upsert (the snapshot-failure rollback) fails too.
let rollbackUpsertThrows = false;
// When true, the resolved baseline is missing `table:` — the post-apply gate
// must fail the apply before any write.
let baselineMissingTable = false;

let getEntityCalls = 0;
const getEntity = mock(async () => {
  getEntityCalls++;
  // First call resolves the baseline; the post-upsert refetch (2nd) can be
  // forced to miss.
  if (getEntityCalls > 1 && refetchReturnsNull) return null;
  return { ...ordersRow, yaml_content: baselineMissingTable ? ordersYamlNoTable : ordersYaml };
});
const upsertEntityForGroup = mock(async (): Promise<void> => {
  if (rollbackUpsertThrows && upsertEntityForGroup.mock.calls.length > 1) {
    throw new Error("rollback write refused");
  }
});
const createVersion = mock(async (): Promise<string> => {
  if (createVersionThrows) throw new Error("versions table unavailable");
  return "version-1";
});
const generateChangeSummary = mock(async (): Promise<string> => "added region");
const invalidateOrgWhitelist = mock((): void => {});
const syncEntityToDisk = mock(async (): Promise<void> => {
  if (syncThrows) throw new Error("disk full");
});

class AmbiguousEntityError extends Error {}

// #4517 — no draft sibling by default: the dual-apply is a no-op, so the
// snapshot-failure contract below is unchanged (it fires before the dual-apply).
const getDraftEntityForGroup = mock(async (): Promise<null> => null);
const upsertDraftEntityForGroup = mock(async (): Promise<void> => {});

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  getEntity,
  upsertEntityForGroup,
  createVersion,
  generateChangeSummary,
  getDraftEntityForGroup,
  upsertDraftEntityForGroup,
  AmbiguousEntityError,
}));
void mock.module("@atlas/api/lib/semantic", () => ({ invalidateOrgWhitelist }));
void mock.module("@atlas/api/lib/semantic/sync", () => ({ syncEntityToDisk }));
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { applyAmendmentToEntity } = await import("../apply");

const result: AnalysisResult = {
  category: "coverage_gaps",
  entityName: "orders",
  group: "default",
  amendmentType: "add_dimension",
  amendment: { name: "region", type: "string" },
  rationale: "Adds region",
  impact: 0.5,
  confidence: 0.9,
  staleness: 0,
  score: 0.5,
};

beforeEach(() => {
  refetchReturnsNull = false;
  createVersionThrows = false;
  syncThrows = false;
  rollbackUpsertThrows = false;
  baselineMissingTable = false;
  getEntityCalls = 0;
  getEntity.mockClear();
  upsertEntityForGroup.mockClear();
  createVersion.mockClear();
  invalidateOrgWhitelist.mockClear();
  syncEntityToDisk.mockClear();
});

describe("applyAmendmentToEntity — snapshot failure fails the apply (#4506)", () => {
  it("happy path: upserts, invalidates caches, snapshots, syncs", async () => {
    await applyAmendmentToEntity("org-1", result, "req-1");

    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(invalidateOrgWhitelist).toHaveBeenCalledTimes(1);
    expect(createVersion).toHaveBeenCalledTimes(1);
    expect(syncEntityToDisk).toHaveBeenCalledTimes(1);
  });

  it("createVersion failure rejects the apply and rolls the upsert back to the pre-image", async () => {
    createVersionThrows = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Version snapshot failed .*versions table unavailable.*rolled back/,
    );
    // The rollback restores the exact pre-image YAML into the same group
    // scope, so the compensated "pending" row is truthful about the layer.
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(2);
    const rollbackCall = upsertEntityForGroup.mock.calls[1] as unknown as [string, string, string, string, string | null];
    expect(rollbackCall[3]).toBe(ordersYaml);
    // Caches invalidated for BOTH writes — the mutation landed, then the
    // restore landed.
    expect(invalidateOrgWhitelist).toHaveBeenCalledTimes(2);
    // The disk sync never runs on a failed apply.
    expect(syncEntityToDisk).not.toHaveBeenCalled();
  });

  it("post-upsert refetch miss rejects the apply (no snapshot possible)", async () => {
    refetchReturnsNull = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Version snapshot failed .*not found after upsert/,
    );
  });

  it("failed rollback is loud: the error says the change is still LIVE, never a neutral reason", async () => {
    // Snapshot fails AND the restore write fails — the row will read pending
    // while the change is applied, so the visible reason must warn the admin
    // off rejecting it.
    createVersionThrows = true;
    rollbackUpsertThrows = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /still applied .*do not reject/,
    );
  });

  it("disk-mirror sync failure stays warn-only — the apply still succeeds", async () => {
    syncThrows = true;

    // The apply resolves (no throw) and reports no draft sibling to converge.
    await expect(applyAmendmentToEntity("org-1", result, "req-1")).resolves.toMatchObject({
      draftDualApply: { kind: "no-draft" },
    });
    expect(createVersion).toHaveBeenCalledTimes(1);
  });

  it("post-apply EntityShape failure fails the apply BEFORE any write (#4513, composes with decide compensation)", async () => {
    // The mutated document does not parse as a semantic entity (no `table:`).
    baselineMissingTable = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Post-apply validation failed .*does not parse as a semantic entity/,
    );
    // Nothing was written — the gate fires before the upsert, so the decide
    // seam's compensation returns the claimed row to pending with this reason
    // and no snapshot/rollback dance is needed.
    expect(upsertEntityForGroup).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
    expect(syncEntityToDisk).not.toHaveBeenCalled();
  });
});
