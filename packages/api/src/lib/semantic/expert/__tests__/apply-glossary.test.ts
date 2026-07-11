/**
 * Glossary Amendment apply seam (#4518).
 *
 * Proves `applyAmendmentToEntity` routes a glossary amendment to the group's
 * glossary DOCUMENT — never the entity named in `entityName` (the host table the
 * term was found under):
 *
 *   1. it reads + writes the `entity_type = "glossary"`, `name = "glossary"` row
 *      (not the entity), scoped to the amendment's Connection group;
 *   2. the mutated glossary YAML actually contains the new/updated term;
 *   3. the version snapshot is of the GLOSSARY document, not an unrelated entity
 *      (the "junk snapshot of an unchanged entity" bug this closes);
 *   4. an absent glossary is seeded, so the FIRST term creates the document;
 *   5. the default-group label maps to the flat (null) scope, a named group to
 *      that group — end-to-end (lookup + upsert + version + disk sync).
 *
 * Mocks the DB/disk layer so we assert routing + content, not persistence.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import * as yaml from "js-yaml";
import type { AnalysisResult } from "../types";

class AmbiguousEntityError extends Error {}

type Row = { id: string; connection_group_id: string | null; yaml_content: string };

// A per-(type,group) glossary store. `null` group = the flat default scope.
let glossaryRows: Map<string, Row>;
function key(group: string | null): string {
  return group ?? "__default__";
}

const getEntity = mock(
  async (_org: string, type: string, name: string, group?: string | null): Promise<Row | null> => {
    if (type !== "glossary" || name !== "glossary") {
      throw new Error(`unexpected read: type=${type} name=${name} (glossary apply must not touch entities)`);
    }
    return glossaryRows.get(key(group ?? null)) ?? null;
  },
);
const upsertEntityForGroup = mock(
  async (_org: string, type: string, name: string, yamlContent: string, group?: string | null): Promise<void> => {
    if (type !== "glossary" || name !== "glossary") {
      throw new Error(`unexpected write: type=${type} name=${name}`);
    }
    glossaryRows.set(key(group ?? null), {
      id: `glossary-${key(group ?? null)}`,
      connection_group_id: group ?? null,
      yaml_content: yamlContent,
    });
  },
);
// When set, the version snapshot fails — exercising the shared rollback tail.
let createVersionThrows = false;
const createVersion = mock(
  async (
    _id: string, _org: string, _type: string, _name: string, _yaml: string,
    _summary: string | null, _authorId: string | null, _authorLabel: string | null,
  ): Promise<string> => {
    if (createVersionThrows) throw new Error("versions table unavailable");
    return "version-1";
  },
);
const generateChangeSummary = mock(async (_before: string, _after: string): Promise<string> => "added term");
const invalidateOrgWhitelist = mock((_org: string): void => {});
const syncEntityToDisk = mock(
  async (_org: string, _name: string, _type: string, _yaml: string, _group?: string | null): Promise<void> => {},
);

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

const { applyAmendmentToEntity } = await import(`../apply.ts?t=${Date.now()}`);

function glossaryAmendment(
  type: "add_glossary_term" | "update_glossary_term",
  amendment: Record<string, unknown>,
  group: string | undefined,
): AnalysisResult {
  return {
    category: "glossary_gaps",
    // The host entity the term was found under — NOT the write target.
    entityName: "orders",
    group,
    amendmentType: type,
    amendment,
    rationale: "define the term",
    impact: 0.5,
    confidence: 0.6,
    staleness: 0,
    score: 0.3,
  };
}

function storedTerms(group: string | null): Record<string, Record<string, unknown>> {
  const row = glossaryRows.get(key(group));
  const doc = (row ? yaml.load(row.yaml_content) : {}) as { terms?: Record<string, Record<string, unknown>> };
  return doc.terms ?? {};
}

describe("applyAmendmentToEntity — glossary routing (#4518)", () => {
  beforeEach(() => {
    glossaryRows = new Map();
    createVersionThrows = false;
    getEntity.mockClear();
    upsertEntityForGroup.mockClear();
    createVersion.mockClear();
    generateChangeSummary.mockClear();
    invalidateOrgWhitelist.mockClear();
    syncEntityToDisk.mockClear();
  });

  it("creates the default-group glossary on the first term (absent glossary is seeded, not an error)", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "default"),
      "req-1",
    );

    // Read + write targeted the glossary DOC in the null (default) scope.
    expect(getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "glossary", "glossary", null]);
    expect(upsertEntityForGroup.mock.calls[0].slice(0, 3)).toEqual(["org-1", "glossary", "glossary"]);
    expect(upsertEntityForGroup.mock.calls[0][4]).toBeNull();
    // The written glossary actually contains the term.
    expect(storedTerms(null).MRR).toEqual({ definition: "Monthly Recurring Revenue" });
  });

  it("snapshots the GLOSSARY document, never an unrelated entity (the junk-snapshot bug)", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "default"),
      "req-1",
    );

    expect(createVersion).toHaveBeenCalledTimes(1);
    // createVersion(entityId, org, TYPE, NAME, yaml, ...) — type + name are the
    // glossary doc, and the versioned YAML carries the term.
    const versionCall = createVersion.mock.calls[0];
    expect(versionCall[2]).toBe("glossary");
    expect(versionCall[3]).toBe("glossary");
    expect(String(versionCall[4])).toContain("MRR");
    // Caches invalidated + disk mirror synced to the glossary doc.
    expect(invalidateOrgWhitelist).toHaveBeenCalledTimes(1);
    expect(syncEntityToDisk.mock.calls[0].slice(1, 3)).toEqual(["glossary", "glossary"]);
  });

  it("writes a NAMED group's glossary into that group's scope, never the default", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "GMV", definition: "Gross Merchandise Value" }, "eu_prod"),
      "req-2",
    );

    expect(getEntity.mock.calls[0][3]).toBe("eu_prod");
    expect(upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod");
    expect(syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
    // The default-scope glossary was never touched.
    expect(glossaryRows.has(key(null))).toBe(false);
    expect(storedTerms("eu_prod").GMV).toEqual({ definition: "Gross Merchandise Value" });
  });

  it("keeps default-group and named-group glossaries independent (group-scoped writes)", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "MRR", definition: "default MRR" }, "default"),
      "req-3",
    );
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "MRR", definition: "eu MRR" }, "eu_prod"),
      "req-4",
    );

    expect(storedTerms(null).MRR).toEqual({ definition: "default MRR" });
    expect(storedTerms("eu_prod").MRR).toEqual({ definition: "eu MRR" });
  });

  it("update_glossary_term amends an existing term in the group glossary", async () => {
    // Seed an existing eu_prod glossary.
    glossaryRows.set(key("eu_prod"), {
      id: "glossary-eu_prod",
      connection_group_id: "eu_prod",
      yaml_content: yaml.dump({ terms: { churn: { definition: "old", note: "keep me" } } }),
    });

    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("update_glossary_term", { term: "churn", definition: "Customer attrition rate" }, "eu_prod"),
      "req-5",
    );

    const term = storedTerms("eu_prod").churn;
    expect(term.definition).toBe("Customer attrition rate");
    // Non-declared attributes preserved.
    expect(term.note).toBe("keep me");
  });

  it("snapshot failure on a brand-new glossary rolls back to an empty document (empty pre-image)", async () => {
    // First-ever term in the default group → no prior row → pre-image is "".
    createVersionThrows = true;

    await expect(
      applyAmendmentToEntity(
        "org-1",
        glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "default"),
        "req-roll",
      ),
    ).rejects.toThrow(/Version snapshot failed for glossary "glossary".*rolled back/);

    // The rollback (2nd upsert) restores the empty pre-image, so the compensated
    // "pending" row is truthful — the term did not persist.
    expect(upsertEntityForGroup).toHaveBeenCalledTimes(2);
    expect(upsertEntityForGroup.mock.calls[1][3]).toBe("");
    // The disk sync never runs on a failed apply.
    expect(syncEntityToDisk).not.toHaveBeenCalled();
  });

  it("update_glossary_term on an undefined term fails the apply (no write)", async () => {
    glossaryRows.set(key(null), {
      id: "glossary-default",
      connection_group_id: null,
      yaml_content: yaml.dump({ terms: {} }),
    });

    await expect(
      applyAmendmentToEntity(
        "org-1",
        glossaryAmendment("update_glossary_term", { term: "ghost", definition: "nope" }, "default"),
        "req-6",
      ),
    ).rejects.toThrow(/Cannot update glossary term "ghost"/);

    expect(upsertEntityForGroup).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });
});
