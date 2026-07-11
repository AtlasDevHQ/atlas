/**
 * proposeAmendment → approve, end-to-end for GLOSSARY amendments (#4518).
 *
 * Uses the REAL apply module (resolveGlossaryBaseline + applyGlossaryAmendment +
 * applyAmendmentMutation + applyAmendmentFromPayload → applyAmendmentToEntity),
 * mocking only the DB/entities/disk layer, and proves:
 *   1. the propose-time diff is a GLOSSARY-document diff — attributed to the
 *      group's glossary.yml, showing the added term (the "live diff renders the
 *      glossary document change" acceptance criterion), never an entity diff;
 *   2. the auto-approve write (real decide seam) upserts the group's GLOSSARY
 *      row (`entity_type = "glossary"`, `name = "glossary"`) scoped to the
 *      request's Connection group, and the version snapshot is of the glossary
 *      document — not the unrelated `orders` entity the term was found under
 *      (the junk-snapshot bug this closes).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import * as yaml from "js-yaml";
import type { AmendmentPayload } from "@useatlas/types";

// The group's existing glossary as it lives in `semantic_entities`
// (entity_type="glossary", name="glossary"), so the diff of the added term is
// unambiguously a glossary-document diff.
const epGlossaryYaml = yaml.dump({ terms: { arr: { definition: "Annual Recurring Revenue" } } });

// Records the last glossary YAML written, so we can assert the applied document.
let lastGlossaryWrite: { name: string; type: string; yaml: string; group: string | null } | null = null;

const getEntity = mock(
  async (_org: string, type: string, name: string, group?: string | null) => {
    // Glossary reads (baseline + post-upsert refetch) for the eu_prod group.
    if (type === "glossary" && name === "glossary" && group === "eu_prod") {
      return { id: "glossary-eu_prod", connection_group_id: "eu_prod", yaml_content: lastGlossaryWrite?.yaml ?? epGlossaryYaml };
    }
    return null;
  },
);
const upsertEntityForGroup = mock(
  async (_org: string, type: string, name: string, yamlContent: string, group?: string | null): Promise<void> => {
    if (type === "glossary") {
      lastGlossaryWrite = { name, type, yaml: yamlContent, group: group ?? null };
    }
  },
);
const createVersion = mock(
  async (
    _id: string, _org: string, _type: string, _name: string, _yaml: string,
    _summary: string | null, _authorId: string | null, _authorLabel: string | null,
  ): Promise<string> => "version-1",
);
const generateChangeSummary = mock(async (): Promise<string> => "added term MRR");
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

interface InsertArgs {
  sourceEntity: string;
  amendmentPayload: AmendmentPayload;
  connectionGroupId: string | null;
}
let lastInserted: { id: string; args: InsertArgs } | null = null;
const insertSemanticAmendment = mock((args: InsertArgs) => {
  lastInserted = { id: "prop-1", args };
  return Promise.resolve({ id: "prop-1", autoApprove: true });
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
const stampClaimedAmendmentApproved = mock(async () => true);
const releaseClaimedAmendment = mock(async () => true);
const rejectPendingAmendment = mock(async () => false);

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment,
  claimPendingAmendment,
  stampClaimedAmendmentApproved,
  releaseClaimedAmendment,
  rejectPendingAmendment,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => ({
    requestId: "req-1",
    user: { activeOrganizationId: "org-1" },
    connectionGroupId: "eu_prod",
  }),
}));

void mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/nonexistent-flat-root",
}));

void mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mock(() => Promise.resolve({ kind: "ok", columns: [], rows: [], rowCount: 0, executionMs: 0, truncated: false })),
  validateSQL: mock(() => Promise.resolve({ valid: true })),
}));

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
      // The host entity the term relates to — NOT the write target.
      entityName: "orders",
      amendmentType: "add_glossary_term",
      amendment: { term: "MRR", definition: "Monthly Recurring Revenue" },
      rationale: "MRR appears in columns but is not defined in the glossary",
      confidence: 0.95,
    },
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK execute options are irrelevant here
    {} as any,
  )) as ProposeResult;
}

describe("proposeAmendment — glossary amendments write the glossary document (#4518)", () => {
  beforeEach(() => {
    lastInserted = null;
    lastGlossaryWrite = null;
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    insertSemanticAmendment.mockClear();
    claimPendingAmendment.mockClear();
    stampClaimedAmendmentApproved.mockClear();
  });

  it("the live diff renders the GLOSSARY document change, attributed to the group's glossary.yml", async () => {
    const result = await run();

    expect(result.error).toBeUndefined();
    // The baseline read is the group's glossary DOC, not the entity.
    expect(getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "glossary", "glossary", "eu_prod"]);
    // The diff is attributed to the group glossary.yml (ADR-0012 layout), never
    // an entity file.
    expect(result.diff).toContain("semantic/groups/eu_prod/glossary.yml");
    expect(result.diff).not.toContain("semantic/entities/orders.yml");
    // It shows the added term against the existing baseline term.
    expect(result.diff).toContain("MRR");
    expect(result.diff).toContain("Monthly Recurring Revenue");
    expect(result.diff).toContain("arr"); // existing baseline term, as context
  });

  it("persists the glossary amendment scoped to the request's Connection group", async () => {
    await run();

    expect(insertSemanticAmendment).toHaveBeenCalledTimes(1);
    expect(lastInserted?.args.connectionGroupId).toBe("eu_prod");
    expect(lastInserted?.args.amendmentPayload.amendmentType).toBe("add_glossary_term");
  });

  it("auto-approve writes the group GLOSSARY row + snapshots the glossary, not an entity", async () => {
    const result = await run();

    expect(result.status).toBe("auto_approved");
    // The write targeted the glossary doc in the eu_prod scope, and the written
    // YAML carries the new term alongside the existing one.
    expect(lastGlossaryWrite).not.toBeNull();
    expect(lastGlossaryWrite?.name).toBe("glossary");
    expect(lastGlossaryWrite?.type).toBe("glossary");
    expect(lastGlossaryWrite?.group).toBe("eu_prod");
    const doc = yaml.load(lastGlossaryWrite!.yaml) as { terms: Record<string, Record<string, unknown>> };
    expect(doc.terms.MRR).toEqual({ definition: "Monthly Recurring Revenue" });
    expect(doc.terms.arr).toEqual({ definition: "Annual Recurring Revenue" });

    // The version snapshot is of the GLOSSARY document — the junk-snapshot bug
    // recorded a version of the unchanged `orders` entity instead.
    const versionCall = createVersion.mock.calls.at(-1)!;
    expect(versionCall[2]).toBe("glossary");
    expect(versionCall[3]).toBe("glossary");
  });
});
