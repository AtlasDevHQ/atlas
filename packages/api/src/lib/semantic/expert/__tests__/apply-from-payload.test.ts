/**
 * Unit tests for `applyAmendmentFromPayload` (#3613).
 *
 * Proves the shared envelope→`AnalysisResult` reconstruction that every admin
 * approve path delegates to:
 *
 *   1. it feeds the YAML mutation the INNER `amendment` object — the dimension
 *      lands in the entity, NOT the surrounding envelope (`entityName`,
 *      `amendmentType`, `rationale`, …). This is the regression guard for the
 *      pre-#3613 bug where the whole payload was passed as `amendment`;
 *   2. it accepts the raw payload as either a JSON string or a parsed object;
 *   3. it recovers the Connection group (NULL → explicit `"default"` scope);
 *   4. malformed payloads throw rather than silently corrupt the entity.
 *
 * Mocks the DB/disk layer so we assert the reconstruction, not persistence.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import * as yaml from "js-yaml";
// Real diff primitives (unmocked): apply.ts imports the SAME singleton, so the
// hash the guard computes and `instanceof StaleBaselineError` both line up (#4511).
import { normalizeEntityYaml, hashBaselineYaml, StaleBaselineError } from "../diff";

class AmbiguousEntityError extends Error {
  readonly groups: (string | null)[];
  constructor(opts: { message: string; groups: (string | null)[] }) {
    super(opts.message);
    this.name = "AmbiguousEntityError";
    this.groups = opts.groups;
  }
}

type Row = { id: string; connection_group_id: string | null; yaml_content: string };

const getEntity = mock(
  async (_org: string, _type: string, _name: string, group?: string | null): Promise<Row | null> => ({
    id: "orders-row",
    connection_group_id: group === undefined ? null : group,
    yaml_content: "table: orders\ndescription: Orders\n",
  }),
);
const upsertEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _yaml: string, _group?: string | null): Promise<void> => {},
);
const createVersion = mock(
  async (
    _id: string, _org: string, _type: string, _name: string, _yaml: string,
    _summary: string | null, _authorId: string | null, _authorLabel: string | null,
  ): Promise<string> => "version-1",
);
const generateChangeSummary = mock(async (_before: string, _after: string): Promise<string> => "summary");
const invalidateOrgWhitelist = mock((_org: string): void => {});
const syncEntityToDisk = mock(
  async (_org: string, _name: string, _type: string, _yaml: string, _group?: string | null): Promise<void> => {},
);
// #4517 — the content-mode dual-apply reads the draft sibling and (when present)
// writes it. Default: no draft → dual-apply is a no-op, so these suites assert
// only the published write.
const getDraftEntityForGroup = mock(
  async (_org: string, _type: string, _name: string, _group?: string | null): Promise<Row | null> => null,
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

const { applyAmendmentFromPayload, applyAmendment, analysisResultFromStoredPayload } = await import(
  `../apply.ts?t=${Date.now()}`
);

/** The exact baseline the getEntity mock serves — the hash is taken over this. */
const BASELINE_YAML = "table: orders\ndescription: Orders\n";

const INNER_AMENDMENT = { name: "region", sql: "region", type: "string", description: "Customer region" };

const ENVELOPE = {
  entityName: "orders",
  amendmentType: "add_dimension",
  amendment: INNER_AMENDMENT,
  rationale: "Add a region dimension",
  category: "coverage_gaps",
  confidence: 0.9,
};

/** The YAML object written back by the last upsert. */
function writtenYaml(): Record<string, unknown> {
  const lastCall = upsertEntityForGroup.mock.calls.at(-1);
  if (!lastCall) throw new Error("upsertEntityForGroup was not called");
  return yaml.load(lastCall[3] as string) as Record<string, unknown>;
}

describe("applyAmendmentFromPayload (#3613)", () => {
  beforeEach(() => {
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    syncEntityToDisk.mockClear();
  });

  it("writes the INNER amendment object into the entity, not the envelope", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-1",
      label: "pat-1",
    });

    const doc = writtenYaml();
    const dims = doc.dimensions as Record<string, unknown>[];
    expect(dims).toHaveLength(1);
    // The dimension is the inner spec — NOT the envelope.
    expect(dims[0]).toEqual(INNER_AMENDMENT);
    expect(dims[0]).not.toHaveProperty("entityName");
    expect(dims[0]).not.toHaveProperty("amendmentType");
    expect(dims[0]).not.toHaveProperty("rationale");
  });

  it("accepts a raw payload supplied as a JSON string", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: JSON.stringify(ENVELOPE),
      requestId: "req-2",
    });

    const dims = writtenYaml().dimensions as Record<string, unknown>[];
    expect(dims[0]).toEqual(INNER_AMENDMENT);
  });

  it("recovers a NULL connection group as the explicit default scope", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-3",
    });
    // group "default" → null lookup scope (apply.ts groupToLookupScope).
    expect(getEntity.mock.calls[0][3]).toBeNull();
  });

  it("scopes the lookup to a named connection group", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: "eu_prod",
      rawPayload: ENVELOPE,
      requestId: "req-4",
    });
    expect(getEntity.mock.calls[0][3]).toBe("eu_prod");
  });

  it("throws on a payload missing its inner amendment object", async () => {
    await expect(
      applyAmendmentFromPayload({
        orgId: "org-1",
        sourceEntity: "orders",
        connectionGroupId: null,
        rawPayload: { amendmentType: "add_dimension", rationale: "no amendment key" },
        requestId: "req-5",
        label: "pat-bad",
      }),
    ).rejects.toThrow(/missing a valid `amendment` object/);
    expect(upsertEntityForGroup).not.toHaveBeenCalled();
  });

  it("throws on a corrupt JSON string payload", async () => {
    await expect(
      applyAmendmentFromPayload({
        orgId: "org-1",
        sourceEntity: "orders",
        connectionGroupId: null,
        rawPayload: "{not json",
        requestId: "req-6",
        label: "pat-corrupt",
      }),
    ).rejects.toThrow(/Corrupt amendment_payload JSON/);
    expect(upsertEntityForGroup).not.toHaveBeenCalled();
  });
});

// The REAL hash-carried claim guard (#4511) — the core review-integrity check
// that the decide/route suites can only mock. Drives the genuine
// `applyAmendmentToEntity` hash comparison against real getEntity/upsert mocks.
describe("applyAmendmentFromPayload — hash-carried claim (#4511)", () => {
  // The hash the review-render path would have carried: the current baseline,
  // normalized exactly as the guard normalizes it.
  const currentHash = hashBaselineYaml(
    normalizeEntityYaml(yaml.load(BASELINE_YAML) as Record<string, unknown>),
  );

  beforeEach(() => {
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    syncEntityToDisk.mockClear();
  });

  it("matching baseline hash → applies (the admin reviewed the current baseline)", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-hash-ok",
      expectedBaselineHash: currentHash,
    });
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect((writtenYaml().dimensions as Record<string, unknown>[])[0]).toEqual(INNER_AMENDMENT);
  });

  it("mismatching hash → StaleBaselineError carrying the FRESH diff; the write never lands", async () => {
    let caught: unknown;
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-hash-stale",
      expectedBaselineHash: "deadbeef-not-the-current-hash",
    }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(StaleBaselineError);
    const err = caught as StaleBaselineError;
    // The error carries the CURRENT baseline hash (the value to confirm against)
    // and a diff computed against that current baseline.
    expect(err.baselineHash).toBe(currentHash);
    expect(err.diff).toContain("region");
    // Approving against an unseen baseline is exactly what the guard prevents.
    expect(upsertEntityForGroup).not.toHaveBeenCalled();
  });

  it("the hash is taken over the BEFORE baseline, not the post-apply document", async () => {
    // If the guard hashed `updated`, this post-apply hash would MATCH and apply.
    // It must instead be treated as stale (the current baseline hash differs).
    const before = yaml.load(BASELINE_YAML) as Record<string, unknown>;
    const result = analysisResultFromStoredPayload({
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
    });
    const postApplyHash = hashBaselineYaml(normalizeEntityYaml(applyAmendment(before, result)));
    expect(postApplyHash).not.toBe(currentHash); // sanity: the two documents differ

    let caught: unknown;
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-hash-after",
      expectedBaselineHash: postApplyHash,
    }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(StaleBaselineError);
    expect(upsertEntityForGroup).not.toHaveBeenCalled();
  });

  it("no expectedBaselineHash → applies unconditionally (scheduler / auto-approve path)", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-no-hash",
    });
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(1);
  });
});
