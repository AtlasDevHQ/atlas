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
  "table: orders",
  "description: Orders (eu_prod DB-backed)",
  "dimensions:",
  "  - name: id",
  "    type: number",
].join("\n");

// The group the "orders" row lives in for the current scenario: "eu_prod" for
// the group-scoped tests, null (the default flat group) for the default-scope
// test. Reset in beforeEach.
let activeGroup: string | null = "eu_prod";

const ordersRowFor = (group: string | null) => ({
  id: group === null ? "orders-default" : `orders-${group}`,
  connection_group_id: group,
  yaml_content: ordersYaml,
});

// Scoped lookups resolve "orders" ONLY at the row's own scope (`activeGroup`).
// The UNSCOPED lookup (4th arg absent — resolveAmendmentBaseline's back-compat
// fallback) resolves only in the default-scope scenario, where the
// propose-time request group ("eu_prod") legitimately misses; in the
// group-scoped scenario it stays a hard miss, so any fallback reliance fails
// loudly instead of silently resolving.
const getEntity = mock(
  async (_org: string, _type: string, name: string, group?: string | null) => {
    if (name !== "orders") return null;
    if (group === undefined) return activeGroup === null ? ordersRowFor(null) : null;
    return group === activeGroup ? ordersRowFor(activeGroup) : null;
  },
);
const upsertEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _yaml: string, _group?: string | null): Promise<void> => {},
);
const createVersion = mock(async (): Promise<string> => "version-1");
const generateChangeSummary = mock(async (): Promise<string> => "added region");
const invalidateOrgWhitelist = mock((_org: string): void => {});
const syncEntityToDisk = mock(async (): Promise<void> => {});
// #4517 — no draft sibling by default, so the content-mode dual-apply is a
// no-op and these group-scope routing assertions see only the published write.
const getDraftEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _group?: string | null): Promise<null> => null,
);
const upsertDraftEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _yaml: string, _group?: string | null): Promise<void> => {},
);

class AmbiguousEntityError extends Error {}

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

// Arg shape mirrors the REAL (now required, #4498) `connectionGroupId` field —
// `string | null`, not optional — so a caller regressing to omit it is visible
// here as `undefined` in the persisted-args assertions.
//
// The auto-approve path now runs the REAL decide seam (#4506), whose DB
// surface is the claim helpers below. The stateful claim mock hands the seam
// back the LAST INSERTED row — so the end-to-end assertion "the apply writes
// exactly what propose persisted" runs through the seam's stored-payload
// apply, not a caller-side copy.
interface InsertArgs {
  sourceEntity: string;
  amendmentPayload: AmendmentPayload;
  connectionGroupId: string | null;
}
let insertAutoApprove = true;
let lastInserted: { id: string; args: InsertArgs } | null = null;
const insertSemanticAmendment = mock((args: InsertArgs) => {
  lastInserted = { id: "prop-1", args };
  return Promise.resolve({ id: "prop-1", autoApprove: insertAutoApprove });
});
const claimPendingAmendment = mock(async (id: string) => {
  if (!lastInserted || lastInserted.id !== id) return null;
  return {
    id,
    source_entity: lastInserted.args.sourceEntity,
    connection_group_id: lastInserted.args.connectionGroupId,
    amendment_payload: lastInserted.args.amendmentPayload as unknown as Record<string, unknown>,
    claimed_at: "2026-07-10T00:00:00+00",
  };
});
const stampClaimedAmendmentApproved = mock(async (_id: string, _claimedAt: string) => true);
const releaseClaimedAmendment = mock(async (_id: string, _claimedAt: string, _reason: string) => true);
const rejectPendingAmendment = mock(async () => false);

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment,
  claimPendingAmendment,
  stampClaimedAmendmentApproved,
  releaseClaimedAmendment,
  rejectPendingAmendment,
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
  // The propose seam validates embedded SQL (#4513); the amendment carries
  // `sql: "region"`, so validateSQL is exercised. Stubbed valid — this file
  // pins baseline scoping, not SQL validation.
  validateSQL: mock(() => Promise.resolve({ valid: true })),
}));

// The propose seam resolves the amendment's group to its primary connection for
// the embedded-SQL validation + test query (#4513). Stubbed so this file's
// baseline-scoping assertions don't depend on the group-reach DB surface.
void mock.module("@atlas/api/lib/group-reach/lookup", () => ({
  resolveGroupPrimaryConnectionId: mock(async (_org: string | undefined, groupId: string | null | undefined) =>
    groupId ?? "default",
  ),
  loadVisibleGroups: mock(async () => []),
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
    activeGroup = "eu_prod";
    insertAutoApprove = true;
    lastInserted = null;
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    syncEntityToDisk.mockClear();
    insertSemanticAmendment.mockClear();
    claimPendingAmendment.mockClear();
    stampClaimedAmendmentApproved.mockClear();
    releaseClaimedAmendment.mockClear();
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
    // resolved group (asserted via upsert above). The proposal is auto-applied
    // via the seam (claim → apply → stamp), never left approved-but-unapplied
    // and never compensated on this happy path.
    const persisted = insertSemanticAmendment.mock.calls[0][0];
    expect(persisted.sourceEntity).toBe("orders");
    expect(persisted.amendmentPayload.amendment).toMatchObject({ name: "region" });
    expect(stampClaimedAmendmentApproved).toHaveBeenCalledTimes(1);
    expect(releaseClaimedAmendment).not.toHaveBeenCalled();
  });

  it("persists the resolved applyGroupId as the row's connection_group_id (#4498)", async () => {
    await run();
    // The stored row must carry the group the baseline was resolved from —
    // NOT NULL. A NULL group forces the human-review approve into the
    // default-scope → unscoped-fallback path, which 409s the moment the
    // entity name exists in a second group (elevation-audit M5 dead-end).
    const persisted = insertSemanticAmendment.mock.calls[0][0];
    expect(persisted.connectionGroupId).toBe("eu_prod");
  });

  it("human-review approve of the persisted row resolves the same group-scoped row, no unscoped fallback (#4498)", async () => {
    // Queue the proposal instead of auto-approving, so the ONLY apply in this
    // test is the simulated human review below.
    insertAutoApprove = false;
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("queued");
    expect(upsertEntityForGroup).not.toHaveBeenCalled();

    // Replay the review-route approve (admin-semantic-improve.ts, POST
    // /amendments/:id/review) against the persisted row: it applies with the
    // row's `connection_group_id ?? null`.
    const persisted = insertSemanticAmendment.mock.calls[0][0];
    getEntity.mockClear();
    const { applyAmendmentFromPayload } = await import("@atlas/api/lib/semantic/expert/apply");
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: persisted.sourceEntity,
      connectionGroupId: persisted.connectionGroupId ?? null,
      rawPayload: persisted.amendmentPayload,
      requestId: "req-review",
      label: "prop-1",
    });

    // Every lookup during the review apply is SCOPED to the persisted group —
    // the unscoped back-compat fallback (4th arg undefined) never runs. The
    // getEntity mock only resolves `group === "eu_prod"`, so a NULL persisted
    // group (the pre-fix behavior: default scope → scoped miss → unscoped
    // fallback → miss) would have thrown "Entity not found" above.
    expect(getEntity.mock.calls.length).toBeGreaterThan(0);
    for (const call of getEntity.mock.calls) {
      expect(call[3]).toBe("eu_prod");
    }

    // And the write lands in the same row the propose-time diff was computed
    // against: the eu_prod scope, with the DB baseline plus the new dimension.
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod");
    const parsed = loadYaml(upsertEntityForGroup.mock.calls[0][3]) as {
      description?: string;
      dimensions?: Array<{ name?: string }>;
    };
    expect(parsed.description).toBe("Orders (eu_prod DB-backed)");
    expect((parsed.dimensions ?? []).map((d) => d.name)).toContain("region");
  });

  it("persists NULL for a default-scope entity resolved via the fallback; review applies with the explicit default scope (#4498)", async () => {
    // The entity lives in the default (flat) group. The request's group
    // ("eu_prod") misses the scoped lookup, so the baseline resolves through
    // the unscoped fallback — and the persisted group must be the ROW's own
    // scope (NULL), not the request's label.
    activeGroup = null;
    insertAutoApprove = false;
    const result = await run();
    expect(result.error).toBeUndefined();
    const persisted = insertSemanticAmendment.mock.calls[0][0];
    expect(persisted.connectionGroupId).toBeNull();

    // Review replay: a NULL stored group maps to the explicit `"default"`
    // label, so every apply-time lookup is EXPLICITLY default-scoped (4th arg
    // null) — never the unscoped ambiguity check (4th arg undefined), which
    // would 409 if the name also existed in a group.
    getEntity.mockClear();
    const { applyAmendmentFromPayload } = await import("@atlas/api/lib/semantic/expert/apply");
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: persisted.sourceEntity,
      connectionGroupId: persisted.connectionGroupId ?? null,
      rawPayload: persisted.amendmentPayload,
      requestId: "req-review-default",
      label: "prop-2",
    });
    expect(getEntity.mock.calls.length).toBeGreaterThan(0);
    for (const call of getEntity.mock.calls) {
      expect(call[3]).toBeNull();
    }
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(upsertEntityForGroup.mock.calls[0][4]).toBeNull();
  });
});
