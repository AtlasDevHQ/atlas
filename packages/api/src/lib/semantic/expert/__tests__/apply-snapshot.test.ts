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

const ordersYaml = ["name: orders", "description: Orders", "dimensions:", "  - name: id", "    type: number"].join("\n");

const ordersRow = { id: "orders-row", connection_group_id: null, yaml_content: ordersYaml };

// Failure-injection switches.
let refetchReturnsNull = false;
let createVersionThrows = false;
let syncThrows = false;

let getEntityCalls = 0;
const getEntity = mock(async () => {
  getEntityCalls++;
  // First call resolves the baseline; the post-upsert refetch (2nd) can be
  // forced to miss.
  if (getEntityCalls > 1 && refetchReturnsNull) return null;
  return { ...ordersRow };
});
const upsertEntityForGroup = mock(async (): Promise<void> => {});
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

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  getEntity,
  upsertEntityForGroup,
  createVersion,
  generateChangeSummary,
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

  it("createVersion failure rejects the apply (rollback-ability is part of the apply)", async () => {
    createVersionThrows = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Version snapshot failed .*versions table unavailable/,
    );
    // The disk sync never runs on a failed apply.
    expect(syncEntityToDisk).not.toHaveBeenCalled();
  });

  it("post-upsert refetch miss rejects the apply (no snapshot possible)", async () => {
    refetchReturnsNull = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Version snapshot failed .*not found after upsert/,
    );
  });

  it("caches are invalidated even when the snapshot fails — the upsert has landed", async () => {
    createVersionThrows = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow();
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(invalidateOrgWhitelist).toHaveBeenCalledTimes(1);
  });

  it("disk-mirror sync failure stays warn-only — the apply still succeeds", async () => {
    syncThrows = true;

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).resolves.toBeUndefined();
    expect(createVersion).toHaveBeenCalledTimes(1);
  });
});
