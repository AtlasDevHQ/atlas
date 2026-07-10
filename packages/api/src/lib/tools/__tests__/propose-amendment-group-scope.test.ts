/**
 * Regression (#4488): proposeAmendment resolves its baseline through the same
 * org/group-aware DB read the apply path uses — never the flat disk root.
 *
 * Before the fix the tool read `getSemanticRoot()/entities/<name>.yml`, so a
 * group-scoped entity (present only in `semantic_entities`, ADR-0012) either
 * errored "Entity file not found" or the tool diffed a stale flat-root file
 * while approval mutated the DB row — the diff didn't describe what apply wrote.
 *
 * This test uses the REAL apply module end-to-end (resolveAmendmentBaseline +
 * applyAmendment + applyAmendmentFromPayload → applyAmendmentToEntity), mocking
 * only the DB/entities/disk layer, and proves:
 *   1. the baseline comes from the DB row scoped to the request's Connection
 *      group ("eu_prod"), NOT the flat root (the flat root is a dead path here);
 *   2. the previewed diff and the applied write agree — both derive from the
 *      SAME DB document and produce the same new dimension;
 *   3. the apply targets the entity's OWN group scope, not the NULL default.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { loadYaml } from "@atlas/api/lib/semantic/yaml";
import type { AmendmentPayload } from "@useatlas/types";

// The group-scoped entity as it lives in `semantic_entities` — with a
// distinctive description that could ONLY come from the DB row, so the diff
// proving the baseline source is unambiguous.
const ordersYaml = [
  "name: orders",
  "description: Orders (eu_prod DB-backed)",
  "dimensions:",
  "  - name: id",
  "    type: number",
].join("\n");

const ordersRow = {
  id: "orders-eu",
  connection_group_id: "eu_prod",
  yaml_content: ordersYaml,
};

// getEntity resolves "orders" ONLY in group "eu_prod" (scoped or the refreshed
// version read). Any other name/scope is a miss.
const getEntity = mock(
  async (_org: string, _type: string, name: string, group?: string | null) =>
    name === "orders" && group === "eu_prod" ? ordersRow : null,
);
const upsertEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _yaml: string, _group?: string | null): Promise<void> => {},
);
const createVersion = mock(async (): Promise<string> => "version-1");
const generateChangeSummary = mock(async (): Promise<string> => "added region");
const invalidateOrgWhitelist = mock((_org: string): void => {});
const syncEntityToDisk = mock(async (): Promise<void> => {});

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

const insertSemanticAmendment = mock(
  (_args: { sourceEntity: string; amendmentPayload: AmendmentPayload }) =>
    Promise.resolve({ id: "prop-1", status: "approved" }),
);
const revertAmendmentToPending = mock(() => Promise.resolve(true));

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment,
  revertAmendmentToPending,
}));

// Request context: the org + Connection group the turn resolves entities
// against. `connectionGroupId: "eu_prod"` is what threads the group scope.
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => ({
    requestId: "req-1",
    user: { activeOrganizationId: "org-1" },
    connectionGroupId: "eu_prod",
  }),
}));

// A flat root that does NOT contain orders.yml — so if the tool ever fell back
// to the disk path it would error "Entity file not found", making the DB path
// the only way this test can succeed.
void mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/nonexistent-flat-root",
}));

void mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mock(() => Promise.resolve({ kind: "ok", columns: [], rows: [], rowCount: 0, executionMs: 0, truncated: false })),
}));

const { proposeAmendment } = await import("@atlas/api/lib/tools/propose-amendment");

type ProposeResult = { proposalId?: string; status?: string; diff?: string; error?: string };

async function run(): Promise<ProposeResult> {
  return (await proposeAmendment.execute!(
    {
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "region", sql: "region", type: "string", description: "Region" },
      rationale: "Add a region dimension",
      confidence: 0.95,
    },
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK execute options are irrelevant here
    {} as any,
  )) as ProposeResult;
}

describe("proposeAmendment baseline resolution is org/group-aware (#4488)", () => {
  beforeEach(() => {
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    syncEntityToDisk.mockClear();
    insertSemanticAmendment.mockClear();
    insertSemanticAmendment.mockResolvedValue({ id: "prop-1", status: "approved" });
    revertAmendmentToPending.mockClear();
  });

  it("reads the baseline from the DB row scoped to the request's group, not the flat root", async () => {
    const result = await run();

    // No flat-root "Entity file not found" — the pre-#4488 failure mode.
    expect(result.error).toBeUndefined();
    // The FIRST entity read is scoped to the request's Connection group. Since
    // the flat root has no orders.yml, resolving a diff at all is only possible
    // via the DB row — the pre-#4488 flat-root read would have errored here.
    expect(getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "entity", "orders", "eu_prod"]);
    // The diff is computed against the DB document: the baseline `id` dimension
    // (context) plus the added `region` dimension.
    expect(result.diff).toContain("name: id");
    expect(result.diff).toContain("name: region");
  });

  it("the previewed diff and the applied write agree on the same change", async () => {
    const result = await run();
    expect(result.status).toBe("auto_approved");

    // Apply wrote back to the entity's OWN group scope ("eu_prod"), never NULL.
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    const writtenGroup = upsertEntityForGroup.mock.calls[0][4];
    expect(writtenGroup).toBe("eu_prod");

    // Both the preview read AND the apply re-read (+ the refreshed post-upsert
    // read) resolve the SAME scope — the "single shared resolver" contract. If
    // the apply path scoped its read differently from the preview, the diff
    // would no longer describe what apply wrote.
    expect(getEntity.mock.calls.length).toBeGreaterThan(1);
    for (const call of getEntity.mock.calls) {
      expect(call[3]).toBe("eu_prod");
    }

    // The YAML apply persisted parses to the SAME structural change the diff
    // previewed: the original `id` dimension plus the new `region` dimension,
    // both derived from the one DB baseline.
    const writtenYaml = upsertEntityForGroup.mock.calls[0][3];
    const parsed = loadYaml(writtenYaml) as { description?: string; dimensions?: Array<{ name?: string }> };
    expect(parsed.description).toBe("Orders (eu_prod DB-backed)");
    const dimNames = (parsed.dimensions ?? []).map((d) => d.name);
    expect(dimNames).toContain("id");
    expect(dimNames).toContain("region");
  });

  it("threads the resolved group through to the apply payload envelope", async () => {
    await run();
    // The persisted amendment carries the entity name; the apply targeted the
    // resolved group (asserted via upsert above). The proposal is auto-applied,
    // never left approved-but-unapplied.
    const persisted = insertSemanticAmendment.mock.calls[0][0];
    expect(persisted.sourceEntity).toBe("orders");
    expect(persisted.amendmentPayload.amendment).toMatchObject({ name: "region" });
    expect(revertAmendmentToPending).not.toHaveBeenCalled();
  });
});
