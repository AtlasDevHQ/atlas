/**
 * `applyAmendmentToEntity` / `applyAmendmentFromPayload` against a mocked
 * semantic store — every store-backed contract of `apply.ts` in one file.
 *
 * Formerly five files, merged in #5645: `apply-glossary.test.ts` (#4518),
 * `apply-from-payload.test.ts` (#3613/#4511), `apply-group-scope.test.ts`
 * (#3284), `apply-dual-apply.test.ts` (#4517) and `apply-snapshot.test.ts`
 * (#4506). They mocked the SAME three modules and were separate only because
 * each needed a different fixed `getEntity` — `mock.module()` is registered
 * once per file and the last registration wins. The registration is
 * file-scoped; the spies inside it are not. `installSemanticStoreMock()`
 * registers once, and each `describe` below installs the baseline it needs in
 * its own `beforeEach` (`@atlas/api/testing/semantic-store`).
 *
 * Every test is carried over with its inputs and assertions unchanged. The
 * failure-injection SWITCHES the old files reached for (`createVersionThrows`,
 * `refetchReturnsNull`, …) became direct `mockImplementation` calls in the
 * test that needs them — the generalisation of the pattern
 * the former `apply-snapshot.test.ts` already used.
 *
 * The pure YAML mutation (`applyAmendment`, `applyGlossaryAmendment`) stays in
 * `apply.test.ts`, which mocks nothing. The live-PG end-to-end for the
 * dual-apply (draft → approve → publish → change survives) is pinned in
 * `lib/semantic/__tests__/amendment-dual-apply-pg.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as yaml from "js-yaml";
import { installSemanticStoreMock, type MockEntityRow } from "@atlas/api/testing/semantic-store";
import { installLoggerMock } from "@atlas/api/testing/logger";
import type { AnalysisResult } from "../types";
// Real diff primitives (unmocked): apply.ts imports the SAME singleton, so the
// hash the guard computes and `instanceof StaleBaselineError` both line up (#4511).
import { normalizeEntityYaml, hashBaselineYaml, StaleBaselineError } from "../diff";

const store = installSemanticStoreMock();
installLoggerMock();

const { applyAmendmentToEntity, applyAmendmentFromPayload, applyAmendment, analysisResultFromStoredPayload } =
  await import("../apply");

beforeEach(() => {
  store.reset();
});

// ── Glossary routing (#4518) — formerly apply-glossary.test.ts ───────────────
//
// Proves `applyAmendmentToEntity` routes a glossary amendment to the group's
// glossary DOCUMENT — never the entity named in `entityName` (the host table the
// term was found under):
//
//   1. it reads + writes the `entity_type = "glossary"`, `name = "glossary"` row
//      (not the entity), scoped to the amendment's Connection group;
//   2. the mutated glossary YAML actually contains the new/updated term;
//   3. the version snapshot is of the GLOSSARY document, not an unrelated entity
//      (the "junk snapshot of an unchanged entity" bug this closes);
//   4. an absent glossary is seeded, so the FIRST term creates the document;
//   5. the default-group label maps to the flat (null) scope, a named group to
//      that group — end-to-end (lookup + upsert + version + disk sync).
describe("applyAmendmentToEntity — glossary routing (#4518)", () => {
  // A per-(type,group) glossary store. `null` group = the flat default scope.
  let glossaryRows: Map<string, MockEntityRow>;
  function key(group: string | null): string {
    return group ?? "__default__";
  }

  beforeEach(() => {
    glossaryRows = new Map();
    // The baseline: only the glossary document is readable — an entity read is
    // the bug this suite exists to catch, so it throws rather than resolving.
    store.getEntity.mockImplementation(async (_org, type, name, group) => {
      if (type !== "glossary" || name !== "glossary") {
        throw new Error(`unexpected read: type=${type} name=${name} (glossary apply must not touch entities)`);
      }
      return glossaryRows.get(key(group ?? null)) ?? null;
    });
    store.upsertEntityForGroup.mockImplementation(async (_org, type, name, yamlContent, group) => {
      if (type !== "glossary" || name !== "glossary") {
        throw new Error(`unexpected write: type=${type} name=${name}`);
      }
      glossaryRows.set(key(group ?? null), {
        id: `glossary-${key(group ?? null)}`,
        connection_group_id: group ?? null,
        yaml_content: yamlContent,
      });
    });
    store.generateChangeSummary.mockImplementation(async () => "added term");
  });

  function glossaryAmendment(
    type: "add_glossary_term" | "update_glossary_term",
    amendment: Record<string, unknown>,
    group: string | undefined,
  ): AnalysisResult {
    return {
      category: "glossary_gaps",
      // The host entity the term was found under — NOT the write target.
      entityName: "orders",
      ...(group !== undefined ? { group } : {}),
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

  it("creates the default-group glossary on the first term (absent glossary is seeded, not an error)", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "default"),
      "req-1",
    );

    // Read + write targeted the glossary DOC in the null (default) scope.
    expect(store.getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "glossary", "glossary", null]);
    expect(store.upsertEntityForGroup.mock.calls[0].slice(0, 3)).toEqual(["org-1", "glossary", "glossary"]);
    expect(store.upsertEntityForGroup.mock.calls[0][4]).toBeNull();
    // The written glossary actually contains the term.
    expect(storedTerms(null).MRR).toEqual({ definition: "Monthly Recurring Revenue" });
  });

  it("snapshots the GLOSSARY document, never an unrelated entity (the junk-snapshot bug)", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "default"),
      "req-1",
    );

    expect(store.createVersion).toHaveBeenCalledTimes(1);
    // createVersion(entityId, org, TYPE, NAME, yaml, ...) — type + name are the
    // glossary doc, and the versioned YAML carries the term.
    const versionCall = store.createVersion.mock.calls[0];
    expect(versionCall[2]).toBe("glossary");
    expect(versionCall[3]).toBe("glossary");
    expect(String(versionCall[4])).toContain("MRR");
    // Caches invalidated + disk mirror synced to the glossary doc.
    expect(store.invalidateOrgWhitelist).toHaveBeenCalledTimes(1);
    expect(store.syncEntityToDisk.mock.calls[0].slice(1, 3)).toEqual(["glossary", "glossary"]);
  });

  it("writes a NAMED group's glossary into that group's scope, never the default", async () => {
    await applyAmendmentToEntity(
      "org-1",
      glossaryAmendment("add_glossary_term", { term: "GMV", definition: "Gross Merchandise Value" }, "eu_prod"),
      "req-2",
    );

    expect(store.getEntity.mock.calls[0][3]).toBe("eu_prod");
    expect(store.upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod");
    expect(store.syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
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
    store.createVersion.mockImplementation(async () => {
      throw new Error("versions table unavailable");
    });

    await expect(
      applyAmendmentToEntity(
        "org-1",
        glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "default"),
        "req-roll",
      ),
    ).rejects.toThrow(/Version snapshot failed for glossary "glossary".*rolled back/);

    // The rollback (2nd upsert) restores the empty pre-image, so the compensated
    // "pending" row is truthful — the term did not persist.
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(2);
    expect(store.upsertEntityForGroup.mock.calls[1][3]).toBe("");
    // The disk sync never runs on a failed apply.
    expect(store.syncEntityToDisk).not.toHaveBeenCalled();
  });

  it("raises StaleBaselineError with a fresh glossary diff for a stale hash-carried claim (#4511/#4518)", async () => {
    // Glossary is a first-class citizen of the hash-carried stale-baseline check:
    // an approve carrying a hash that no longer matches the current glossary
    // surfaces inline update-and-confirm, never a silent apply against an unseen
    // baseline.
    glossaryRows.set(key("eu_prod"), {
      id: "glossary-eu_prod",
      connection_group_id: "eu_prod",
      yaml_content: yaml.dump({ terms: { arr: { definition: "Annual Recurring Revenue" } } }),
    });

    let caught: unknown;
    try {
      await applyAmendmentToEntity(
        "org-1",
        glossaryAmendment("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }, "eu_prod"),
        "req-stale",
        { expectedBaselineHash: "a-hash-that-will-not-match" },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(StaleBaselineError);
    const err = caught as StaleBaselineError;
    expect(err.diff).toContain("semantic/groups/eu_prod/glossary.yml");
    expect(err.diff).toContain("MRR");
    // The stale check fires BEFORE any write — nothing persisted.
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
    expect(store.createVersion).not.toHaveBeenCalled();
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

    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
    expect(store.createVersion).not.toHaveBeenCalled();
  });
});

// ── Payload reconstruction (#3613) + hash-carried claim (#4511) ──────────────
// Formerly apply-from-payload.test.ts.
//
// Proves the shared envelope→`AnalysisResult` reconstruction that every admin
// approve path delegates to:
//
//   1. it feeds the YAML mutation the INNER `amendment` object — the dimension
//      lands in the entity, NOT the surrounding envelope (`entityName`,
//      `amendmentType`, `rationale`, …). This is the regression guard for the
//      pre-#3613 bug where the whole payload was passed as `amendment`;
//   2. it accepts the raw payload as either a JSON string or a parsed object;
//   3. it recovers the Connection group (NULL → explicit `"default"` scope);
//   4. malformed payloads throw rather than silently corrupt the entity.
//
// The baseline: a synthetic `orders` row in whatever group was asked for. No
// draft sibling (the fixture default), so the dual-apply is a no-op and these
// suites assert only the published write.

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
  const lastCall = store.upsertEntityForGroup.mock.calls.at(-1);
  if (!lastCall) throw new Error("upsertEntityForGroup was not called");
  return yaml.load(lastCall[3]) as Record<string, unknown>;
}

function installSyntheticOrdersRow(): void {
  store.getEntity.mockImplementation(async (_org, _type, _name, group) => ({
    id: "orders-row",
    connection_group_id: group === undefined ? null : group,
    yaml_content: BASELINE_YAML,
  }));
}

describe("applyAmendmentFromPayload (#3613)", () => {
  beforeEach(installSyntheticOrdersRow);

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
    expect(store.getEntity.mock.calls[0][3]).toBeNull();
  });

  it("scopes the lookup to a named connection group", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: "eu_prod",
      rawPayload: ENVELOPE,
      requestId: "req-4",
    });
    expect(store.getEntity.mock.calls[0][3]).toBe("eu_prod");
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
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
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
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
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

  beforeEach(installSyntheticOrdersRow);

  it("matching baseline hash → applies (the admin reviewed the current baseline)", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-hash-ok",
      expectedBaselineHash: currentHash,
    });
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1);
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
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
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
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
  });

  it("no expectedBaselineHash → applies unconditionally (scheduler / auto-approve path)", async () => {
    await applyAmendmentFromPayload({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: null,
      rawPayload: ENVELOPE,
      requestId: "req-no-hash",
    });
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1);
  });
});

// ── Group-aware routing (#3284) — formerly apply-group-scope.test.ts ─────────
//
// Proves `applyAmendmentToEntity` targets the Connection group the amendment
// was analyzed against — never a 409-ambiguity for a name shared across groups,
// and never a wrong-scope (default) write:
//
//   1. an explicit group scopes the `getEntity` lookup, so a name in 2+ groups
//      resolves cleanly instead of throwing `AmbiguousEntityError` (the bug);
//   2. the write-back (upsert + version + disk sync) always uses the resolved
//      row's OWN `connection_group_id`, so an amendment for a group entity can
//      never land in the default scope;
//   3. the legacy interactive path (group undefined) keeps the unscoped lookup
//      and still writes back to the resolved row's group.
describe("applyAmendmentToEntity — group-aware routing (#3284)", () => {
  // Simulated `semantic_entities` rows:
  //   "orders"   — exists in BOTH the default (null) scope AND group "eu_prod"
  //                (the multi-group reality that 409s an unscoped lookup).
  //   "products" — exists in exactly ONE group ("eu_prod"); an unscoped lookup
  //                resolves it without ambiguity.
  function lookupRow(name: string, group: string | null | undefined): MockEntityRow | null {
    if (name === "orders") {
      if (group === undefined) {
        throw new store.AmbiguousEntityError({
          message: "orders exists in 2 environments",
          groups: [null, "eu_prod"],
        });
      }
      if (group === "eu_prod") return { id: "orders-eu", connection_group_id: "eu_prod", yaml_content: "table: orders\n" };
      if (group === null) return { id: "orders-default", connection_group_id: null, yaml_content: "table: orders\n" };
      return null;
    }
    if (name === "products") {
      if (group === undefined || group === "eu_prod") {
        return { id: "products-eu", connection_group_id: "eu_prod", yaml_content: "table: products\n" };
      }
      return null;
    }
    return null;
  }

  beforeEach(() => {
    store.getEntity.mockImplementation(async (_org, _type, name, group) => lookupRow(name, group));
  });

  function amendment(entityName: string, group: string | undefined): AnalysisResult {
    return {
      category: "coverage_gaps",
      entityName,
      ...(group !== undefined ? { group } : {}),
      amendmentType: "add_dimension",
      amendment: { name: "region", sql: "region", type: "string" },
      rationale: "add region dimension",
      impact: 0.6,
      confidence: 0.9,
      staleness: 0,
      score: 0.54,
    };
  }

  it("scopes the lookup AND every write to the explicit group (no 409, no default-scope write)", async () => {
    await applyAmendmentToEntity("org-1", amendment("orders", "eu_prod"), "req-1");

    // Lookup scoped to "eu_prod" — never the unscoped ambiguity check.
    expect(store.getEntity.mock.calls[0].slice(0, 4)).toEqual(["org-1", "entity", "orders", "eu_prod"]);
    // Upsert + version + disk sync all target "eu_prod", NOT the default (null).
    expect(store.upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod");
    expect(store.syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
    expect(store.createVersion.mock.calls[0][0]).toBe("orders-eu"); // versioned the eu_prod row
  });

  it("maps the 'default' group label to a NULL-scoped lookup + write", async () => {
    await applyAmendmentToEntity("org-1", amendment("orders", "default"), "req-2");

    expect(store.getEntity.mock.calls[0][3]).toBeNull(); // explicit null scope, not undefined
    expect(store.upsertEntityForGroup.mock.calls[0][4]).toBeNull();
    expect(store.syncEntityToDisk.mock.calls[0][4]).toBeNull();
    expect(store.createVersion.mock.calls[0][0]).toBe("orders-default");
  });

  it("the OLD unscoped lookup would 409 on a name shared across groups — the bug the explicit group fixes", async () => {
    // group=undefined reproduces the pre-#3284 behavior: the unscoped lookup
    // throws AmbiguousEntityError, which the route maps to 409.
    await expect(applyAmendmentToEntity("org-1", amendment("orders", undefined), "req-3")).rejects.toThrow(
      "exists in 2 environments",
    );
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled(); // never wrote
  });

  it("interactive path (group undefined, single-group entity) writes back to the resolved row's OWN group", async () => {
    // "products" lives only in eu_prod; the unscoped lookup resolves it, and the
    // write-back uses the row's connection_group_id ("eu_prod") — never default.
    await applyAmendmentToEntity("org-1", amendment("products", undefined), "req-4");

    expect(store.getEntity.mock.calls[0][3]).toBeUndefined(); // unscoped lookup preserved
    expect(store.upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod"); // row's own group, not null
    expect(store.syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
  });

  it("falls back to an unscoped lookup when the persisted group misses, then writes back to the row's group", async () => {
    // A stale/mismatched explicit group (e.g. an interactive amendment whose
    // flat-root entity was imported under a datasource group) misses the scoped
    // lookup; the fallback resolves the unique row and the write-back targets
    // its own group — never the stale label, never default. (#3284 fix for the
    // default-vs-unknown conflation Codex flagged.)
    await applyAmendmentToEntity("org-1", amendment("products", "stale_group"), "req-5");

    expect(store.getEntity.mock.calls[0][3]).toBe("stale_group"); // scoped attempt first
    expect(store.getEntity.mock.calls[1][3]).toBeUndefined(); // unscoped fallback
    expect(store.upsertEntityForGroup.mock.calls[0][4]).toBe("eu_prod"); // row's own group
    expect(store.syncEntityToDisk.mock.calls[0][4]).toBe("eu_prod");
  });
});

// ── Content-mode dual-apply (#4517) — formerly apply-dual-apply.test.ts ──────
//
// Amendment approval is the publish gate: `applyAmendmentToEntity` writes the
// PUBLISHED row. When a `draft` sibling of the entity exists, the SAME amendment
// is also applied to the draft (convergent by upsert-by-identity), so a later
// publish (`draft → published`) can't clobber the approved change. A draft that
// removed the amendment's target — or tombstoned the entity — records a VISIBLE
// skip (a version snapshot on the draft) instead of failing the published apply
// or silently dropping the divergence.
describe("applyAmendmentToEntity — content-mode dual-apply (#4517)", () => {
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

  const publishedRow: MockEntityRow = {
    id: "orders-pub",
    org_id: "org-1",
    connection_group_id: null,
    status: "published",
    yaml_content: PUBLISHED_YAML,
  };

  // The draft sibling served to the dual-apply — a test swaps this per scenario.
  let draftRow: MockEntityRow | null = null;

  beforeEach(() => {
    draftRow = null;
    store.getEntity.mockImplementation(async () => publishedRow);
    store.getDraftEntityForGroup.mockImplementation(async () => draftRow);
  });

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
    const call = store.upsertDraftEntityForGroup.mock.calls.at(-1);
    if (!call) throw new Error("upsertDraftEntityForGroup was not called");
    return yaml.load(call[3]) as Record<string, unknown>;
  }

  /** The createVersion call recorded against the DRAFT row (the skip audit). */
  function draftSkipVersionCall() {
    return store.createVersion.mock.calls.find((c) => c[0] === "orders-draft");
  }

  it("no draft sibling → publishes only, reports no-draft, never touches a draft", async () => {
    const result = await applyAmendmentToEntity(
      "org-1", makeAmendment("add_dimension", { name: "region", sql: "region", type: "string" }), "req-1",
    );

    expect(result.draftDualApply).toEqual({ kind: "no-draft" });
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1); // published write only
    expect(store.upsertDraftEntityForGroup).not.toHaveBeenCalled();
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
    expect(store.upsertDraftEntityForGroup).toHaveBeenCalledTimes(1);

    const dims = writtenDraftYaml().dimensions as Record<string, unknown>[];
    const names = dims.map((d) => d.name);
    // The approved change landed AND the draft's own work survived.
    expect(names).toContain("region");
    expect(names).toContain("draft_only_dim");
    // The draft write targets the SAME group the baseline resolved to.
    expect(store.upsertDraftEntityForGroup.mock.calls[0][4]).toBeNull();
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
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1);
    // The draft write did NOT — the target is absent from the draft.
    expect(store.upsertDraftEntityForGroup).not.toHaveBeenCalled();
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

    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1); // published still applied
    expect(store.upsertDraftEntityForGroup).not.toHaveBeenCalled();
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
    store.upsertDraftEntityForGroup.mockImplementationOnce(async () => {
      throw new Error("draft write refused");
    });

    const result = await applyAmendmentToEntity(
      "org-1", makeAmendment("add_dimension", { name: "region", sql: "region", type: "string" }), "req-5",
    );

    // Published apply is durable; the draft failure does not throw out of apply.
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(result.draftDualApply.kind).toBe("skipped");
    if (result.draftDualApply.kind === "skipped") {
      expect(result.draftDualApply.reason).toContain("failed to write the draft");
    }
  });
});

// ── Write-path failure contract (#4506) — formerly apply-snapshot.test.ts ────
//
// Rollback-ability is part of the apply: a version-snapshot failure (or a
// post-upsert refetch miss) FAILS the whole apply, so the decide seam
// compensates and the row returns to pending — an `approved` amendment always
// has a recorded version to roll back to. The disk-mirror sync stays
// warn-only. Cache invalidation runs as soon as the upsert lands, even when
// the snapshot then fails.
describe("applyAmendmentToEntity — snapshot failure fails the apply (#4506)", () => {
  const ordersYaml = ["name: orders", "table: orders", "description: Orders", "dimensions:", "  - name: id", "    type: number"].join("\n");
  // A structurally-broken baseline missing `table:` — the post-apply EntityShape
  // gate (#4513) must reject any amendment applied on top of it.
  const ordersYamlNoTable = ["name: orders", "description: Orders", "dimensions:", "  - name: id", "    type: number"].join("\n");

  const ordersRow: MockEntityRow = { id: "orders-row", connection_group_id: null, yaml_content: ordersYaml };

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
    store.getEntity.mockImplementation(async () => ordersRow);
    store.generateChangeSummary.mockImplementation(async () => "added region");
  });

  it("happy path: upserts, invalidates caches, snapshots, syncs", async () => {
    await applyAmendmentToEntity("org-1", result, "req-1");

    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(1);
    expect(store.invalidateOrgWhitelist).toHaveBeenCalledTimes(1);
    expect(store.createVersion).toHaveBeenCalledTimes(1);
    expect(store.syncEntityToDisk).toHaveBeenCalledTimes(1);
  });

  it("createVersion failure rejects the apply and rolls the upsert back to the pre-image", async () => {
    store.createVersion.mockImplementation(async () => {
      throw new Error("versions table unavailable");
    });

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Version snapshot failed .*versions table unavailable.*rolled back/,
    );
    // The rollback restores the exact pre-image YAML into the same group
    // scope, so the compensated "pending" row is truthful about the layer.
    expect(store.upsertEntityForGroup).toHaveBeenCalledTimes(2);
    expect(store.upsertEntityForGroup.mock.calls[1][3]).toBe(ordersYaml);
    // Caches invalidated for BOTH writes — the mutation landed, then the
    // restore landed.
    expect(store.invalidateOrgWhitelist).toHaveBeenCalledTimes(2);
    // The disk sync never runs on a failed apply.
    expect(store.syncEntityToDisk).not.toHaveBeenCalled();
  });

  it("post-upsert refetch miss rejects the apply (no snapshot possible)", async () => {
    // First call resolves the baseline; the post-upsert refetch (2nd) misses.
    store.getEntity.mockImplementationOnce(async () => ordersRow);
    store.getEntity.mockImplementation(async () => null);

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Version snapshot failed .*not found after upsert/,
    );
  });

  it("failed rollback is loud: the error says the change is still LIVE, never a neutral reason", async () => {
    // Snapshot fails AND the restore write fails — the row will read pending
    // while the change is applied, so the visible reason must warn the admin
    // off rejecting it.
    store.createVersion.mockImplementation(async () => {
      throw new Error("versions table unavailable");
    });
    // The FIRST upsert (the apply) lands; the SECOND (the rollback) is refused.
    store.upsertEntityForGroup.mockImplementationOnce(async () => {});
    store.upsertEntityForGroup.mockImplementation(async () => {
      throw new Error("rollback write refused");
    });

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /still applied .*do not reject/,
    );
  });

  it("disk-mirror sync failure stays warn-only — the apply still succeeds", async () => {
    store.syncEntityToDisk.mockImplementation(async () => {
      throw new Error("disk full");
    });

    // The apply resolves (no throw) and reports no draft sibling to converge.
    await expect(applyAmendmentToEntity("org-1", result, "req-1")).resolves.toMatchObject({
      draftDualApply: { kind: "no-draft" },
    });
    expect(store.createVersion).toHaveBeenCalledTimes(1);
  });

  it("post-apply EntityShape failure fails the apply BEFORE any write (#4513, composes with decide compensation)", async () => {
    // The mutated document does not parse as a semantic entity (no `table:`).
    store.getEntity.mockImplementation(async () => ({ ...ordersRow, yaml_content: ordersYamlNoTable }));

    await expect(applyAmendmentToEntity("org-1", result, "req-1")).rejects.toThrow(
      /Post-apply validation failed .*does not parse as a semantic entity/,
    );
    // Nothing was written — the gate fires before the upsert, so the decide
    // seam's compensation returns the claimed row to pending with this reason
    // and no snapshot/rollback dance is needed.
    expect(store.upsertEntityForGroup).not.toHaveBeenCalled();
    expect(store.createVersion).not.toHaveBeenCalled();
    expect(store.syncEntityToDisk).not.toHaveBeenCalled();
  });
});
