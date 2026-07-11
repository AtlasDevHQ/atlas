/**
 * Content-mode dual-apply carve-out (#4517).
 *
 * Amendment approval is the publish gate: `applyAmendmentToEntity` writes the
 * PUBLISHED row. When a `draft` sibling of the entity exists, the SAME amendment
 * is also applied to the draft (convergent by upsert-by-identity), so a later
 * publish (`draft → published`) can't clobber the approved change. A draft that
 * removed the amendment's target — or tombstoned the entity — records a VISIBLE
 * skip (a version snapshot on the draft) instead of failing the published apply
 * or silently dropping the divergence.
 *
 * Mocks the DB/disk layer so we assert the dual-apply routing, not persistence.
 * The live-PG end-to-end (draft → approve → publish → change survives) is pinned
 * separately in `lib/semantic/__tests__/amendment-dual-apply-pg.test.ts`.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import * as yaml from "js-yaml";
import type { AnalysisResult } from "../types";

class AmbiguousEntityError extends Error {}

type Row = {
  id: string;
  org_id: string;
  connection_group_id: string | null;
  status: string;
  yaml_content: string;
};

// --- Published baseline (getEntity, "published" mode) -----------------------
// Two dimensions so an update_dimension on "status" resolves on the published
// row even when the draft has removed it.
const PUBLISHED_YAML = [
  "table: orders",
  "description: Orders",
  "dimensions:",
  "  - name: id",
  "    sql: id",
  "    type: number",
  "  - name: status",
  "    sql: status",
  "    type: string",
].join("\n");

const publishedRow: Row = {
  id: "orders-pub",
  org_id: "org-1",
  connection_group_id: null,
  status: "published",
  yaml_content: PUBLISHED_YAML,
};

// The draft sibling served to the dual-apply — a test swaps this per scenario.
let draftRow: Row | null = null;

const getEntity = mock(
  async (_org: string, _type: string, _name: string, _group?: string | null): Promise<Row> => publishedRow,
);
const upsertEntityForGroup = mock(async (): Promise<void> => {});
const createVersion = mock(
  async (
    _id: string, _org: string, _type: string, _name: string, _yaml: string,
    _summary: string | null, _authorId: string | null, _authorLabel: string | null,
  ): Promise<string> => "version-1",
);
const generateChangeSummary = mock(async (): Promise<string> => "summary");
const invalidateOrgWhitelist = mock((): void => {});
const syncEntityToDisk = mock(async (): Promise<void> => {});
const getDraftEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _group?: string | null): Promise<Row | null> => draftRow,
);
const upsertDraftEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _yaml: string, _group?: string | null): Promise<void> => {},
);

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

const { applyAmendmentToEntity } = await import(`../apply.ts?t=${Date.now()}`);

function makeAmendment(
  amendmentType: AnalysisResult["amendmentType"],
  amendment: Record<string, unknown>,
): AnalysisResult {
  return {
    category: "coverage_gaps",
    entityName: "orders",
    group: "default",
    amendmentType,
    amendment,
    rationale: "test",
    impact: 0.6,
    confidence: 0.9,
    staleness: 0,
    score: 0.5,
  };
}

/** Parse the YAML written to the draft by the last upsertDraftEntityForGroup. */
function writtenDraftYaml(): Record<string, unknown> {
  const call = upsertDraftEntityForGroup.mock.calls.at(-1);
  if (!call) throw new Error("upsertDraftEntityForGroup was not called");
  return yaml.load(call[3] as string) as Record<string, unknown>;
}

/** The createVersion call recorded against the DRAFT row (the skip audit). */
function draftSkipVersionCall() {
  return createVersion.mock.calls.find((c) => c[0] === "orders-draft");
}

beforeEach(() => {
  draftRow = null;
  getEntity.mockClear();
  upsertEntityForGroup.mockClear();
  createVersion.mockClear();
  getDraftEntityForGroup.mockClear();
  upsertDraftEntityForGroup.mockClear();
});

describe("applyAmendmentToEntity — content-mode dual-apply (#4517)", () => {
  it("no draft sibling → publishes only, reports no-draft, never touches a draft", async () => {
    const result = await applyAmendmentToEntity(
      "org-1", makeAmendment("add_dimension", { name: "region", sql: "region", type: "string" }), "req-1",
    );

    expect(result.draftDualApply).toEqual({ kind: "no-draft" });
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1); // published write only
    expect(upsertDraftEntityForGroup).not.toHaveBeenCalled();
  });

  it("draft exists → applies the SAME amendment to the draft, converging by identity", async () => {
    // The draft carries unpublished work (an extra dimension) on top of the
    // published shape. The approved add_dimension must land on the draft WITHOUT
    // dropping that work — so publish (draft → published) carries `region`.
    draftRow = {
      id: "orders-draft",
      org_id: "org-1",
      connection_group_id: null,
      status: "draft",
      yaml_content: [
        "table: orders",
        "description: Orders (draft edit)",
        "dimensions:",
        "  - name: id",
        "    sql: id",
        "    type: number",
        "  - name: draft_only_dim",
        "    sql: draft_only",
        "    type: string",
      ].join("\n"),
    };

    const result = await applyAmendmentToEntity(
      "org-1", makeAmendment("add_dimension", { name: "region", sql: "region", type: "string" }), "req-2",
    );

    expect(result.draftDualApply).toEqual({ kind: "applied" });
    expect(upsertDraftEntityForGroup).toHaveBeenCalledTimes(1);

    const dims = writtenDraftYaml().dimensions as Record<string, unknown>[];
    const names = dims.map((d) => d.name);
    // The approved change landed AND the draft's own work survived.
    expect(names).toContain("region");
    expect(names).toContain("draft_only_dim");
    // The draft write targets the SAME group the baseline resolved to.
    expect(upsertDraftEntityForGroup.mock.calls[0][4]).toBeNull();
  });

  it("draft removed the amendment's target → visible skip, published apply still succeeds", async () => {
    // The draft removed the "status" dimension the update targets. Published has
    // it (apply succeeds there); the draft can't take it → skip, not a failure.
    draftRow = {
      id: "orders-draft",
      org_id: "org-1",
      connection_group_id: null,
      status: "draft",
      yaml_content: [
        "table: orders",
        "description: Orders",
        "dimensions:",
        "  - name: id",
        "    sql: id",
        "    type: number",
      ].join("\n"),
    };

    const result = await applyAmendmentToEntity(
      "org-1",
      makeAmendment("update_dimension", { name: "status", type: "enum", description: "updated" }),
      "req-3",
    );

    // The published write still happened (approval is the publish gate).
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    // The draft write did NOT — the target is absent from the draft.
    expect(upsertDraftEntityForGroup).not.toHaveBeenCalled();
    expect(result.draftDualApply.kind).toBe("skipped");
    if (result.draftDualApply.kind === "skipped") {
      // The reason names the failure and carries the underlying detail.
      expect(result.draftDualApply.reason).toContain("could not apply to the draft");
      expect(result.draftDualApply.reason).toContain("not found");
    }
    // The skip is VISIBLE on the draft: a version snapshot on the draft row.
    const skip = draftSkipVersionCall();
    expect(skip).toBeDefined();
    expect(skip?.[5]).toContain("Skipped applying the approved amendment");
  });

  it("draft tombstoned the entity → visible skip warning publish would remove it", async () => {
    draftRow = {
      id: "orders-draft",
      org_id: "org-1",
      connection_group_id: null,
      status: "draft_delete",
      yaml_content: "",
    };

    const result = await applyAmendmentToEntity(
      "org-1", makeAmendment("add_dimension", { name: "region", sql: "region", type: "string" }), "req-4",
    );

    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1); // published still applied
    expect(upsertDraftEntityForGroup).not.toHaveBeenCalled();
    expect(result.draftDualApply.kind).toBe("skipped");
    if (result.draftDualApply.kind === "skipped") {
      expect(result.draftDualApply.reason).toContain("draft deletion");
    }
    expect(draftSkipVersionCall()).toBeDefined();
  });

  it("a draft-side write failure is loud and reported skipped — never un-approves the published change", async () => {
    draftRow = {
      id: "orders-draft",
      org_id: "org-1",
      connection_group_id: null,
      status: "draft",
      yaml_content: PUBLISHED_YAML,
    };
    upsertDraftEntityForGroup.mockImplementationOnce(async () => {
      throw new Error("draft write refused");
    });

    const result = await applyAmendmentToEntity(
      "org-1", makeAmendment("add_dimension", { name: "region", sql: "region", type: "string" }), "req-5",
    );

    // Published apply is durable; the draft failure does not throw out of apply.
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(result.draftDualApply.kind).toBe("skipped");
    if (result.draftDualApply.kind === "skipped") {
      expect(result.draftDualApply.reason).toContain("failed to write the draft");
    }
  });
});
