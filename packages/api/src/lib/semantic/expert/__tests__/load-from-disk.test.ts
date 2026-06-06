/**
 * Unit test for the expert/`atlas improve` disk loaders `loadGlossaryFromDisk`
 * and `loadEntitiesFromDisk` (#3273).
 *
 * Pins the load-bearing contract: both loaders must discover the canonical
 * `groups/<group>/…` namespace (ADR-0012) — not just the flat root — so the
 * expert agent's context is complete on a multi-group deployment. Before #3273
 * the glossary loader read only `<root>/glossary.yml` (and only the array-term
 * shape, so it dropped the object-form glossaries the bundle ships) and the
 * entity loader read only `<root>/entities/`. Attribution must match the shared
 * discovery read paths: the directory is canonical in `groups/<group>/`; a
 * `group:`/`connection:` field overrides on the flat + legacy layouts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpRoot: string;
const ORIGINAL_SEMANTIC_ROOT = process.env.ATLAS_SEMANTIC_ROOT;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-load-from-disk-"));
  process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_SEMANTIC_ROOT === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = ORIGINAL_SEMANTIC_ROOT;
});

beforeEach(() => {
  // Reset the semantic-root fixture each test (path stays stable so the
  // ATLAS_SEMANTIC_ROOT env var set in beforeAll remains valid).
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

/** Write a fixture file relative to the semantic root, creating parents. */
function writeSemanticFile(rel: string, body: string): void {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

// Re-import per test file (matches the pattern used by sibling semantic tests;
// `getSemanticRoot()` reads ATLAS_SEMANTIC_ROOT at call time, so the import
// itself does not capture the root).
const mod = (await import(`../context-loader.ts?t=${Date.now()}`)) as typeof import("../context-loader");
const { loadGlossaryFromDisk, loadEntitiesFromDisk } = mod;

// ---------------------------------------------------------------------------
// Glossary — the primary #3273 gap
// ---------------------------------------------------------------------------

describe("loadGlossaryFromDisk (layout-aware, #3273)", () => {
  it("discovers object-form terms in the flat root glossary", async () => {
    // The bundled glossaries use the object form `terms: { name: { ... } }`,
    // which the prior array-only parser dropped entirely.
    writeSemanticFile(
      "glossary.yml",
      "terms:\n  arr:\n    status: ambiguous\n    note: ARR appears in multiple tables\n",
    );
    const terms = await loadGlossaryFromDisk();
    // `definition` falls back to "" when the object-form entry has only `note:`
    // (the analyzer reads `term`/length, not `definition`, but the fallback is a
    // contract the `GlossaryTerm` shape depends on — never `undefined`).
    expect(terms).toEqual([{ term: "arr", definition: "", ambiguous: true }]);
  });

  it("extracts the object-form definition field when present", async () => {
    writeSemanticFile("glossary.yml", "terms:\n  arr:\n    definition: Annual recurring revenue\n");
    const terms = await loadGlossaryFromDisk();
    expect(terms).toEqual([{ term: "arr", definition: "Annual recurring revenue", ambiguous: false }]);
  });

  it("discovers groups/<group>/glossary.yml and merges with the root (PRIMARY GAP)", async () => {
    writeSemanticFile("glossary.yml", "terms:\n  arr:\n    definition: Annual recurring revenue\n");
    writeSemanticFile("groups/eu_prod/glossary.yml", "terms:\n  vat:\n    status: ambiguous\n");
    writeSemanticFile("groups/us_prod/glossary.yml", "terms:\n  ltv:\n    definition: Lifetime value\n");

    const terms = await loadGlossaryFromDisk();
    expect(terms.map((t) => t.term).toSorted()).toEqual(["arr", "ltv", "vat"]);
    expect(terms.find((t) => t.term === "vat")?.ambiguous).toBe(true);
  });

  it("discovers legacy <source>/glossary.yml", async () => {
    writeSemanticFile("marketing/glossary.yml", "terms:\n  cac:\n    definition: Customer acquisition cost\n");
    const terms = await loadGlossaryFromDisk();
    expect(terms.map((t) => t.term)).toEqual(["cac"]);
  });

  it("still parses the legacy array-term shape", async () => {
    writeSemanticFile(
      "glossary.yml",
      "terms:\n  - term: mrr\n    definition: Monthly recurring revenue\n    ambiguous: true\n",
    );
    const terms = await loadGlossaryFromDisk();
    expect(terms).toHaveLength(1);
    expect(terms[0]).toEqual({ term: "mrr", definition: "Monthly recurring revenue", ambiguous: true });
  });

  it("derives `ambiguous` from either marker, in either shape, else false", async () => {
    // `ambiguous = (ambiguous === true) || (status === "ambiguous")` — the
    // crossed cells the headline tests don't reach: array-form `status:`,
    // object-form `ambiguous:`, and the negative (neither marker → false).
    writeSemanticFile(
      "glossary.yml",
      [
        "terms:",
        "  - term: status_arr", // array-form, status marker
        "    status: ambiguous",
        "  - term: plain", // array-form, no marker
        "    definition: nothing special",
      ].join("\n") + "\n",
    );
    writeSemanticFile(
      "groups/g/glossary.yml",
      "terms:\n  flag_obj:\n    ambiguous: true\n", // object-form, ambiguous flag
    );
    const terms = await loadGlossaryFromDisk();
    const byTerm = Object.fromEntries(terms.map((t) => [t.term, t.ambiguous]));
    expect(byTerm).toEqual({ status_arr: true, plain: false, flag_obj: true });
  });

  it("emits a duplicate when the same term name appears in two layouts (no dedup at this layer)", async () => {
    // The loader intentionally does NOT dedup — `categories.ts` keys off the
    // term name via a Set, so duplicates are harmless there; pinning this keeps
    // a future dedup from silently shifting the count `health.ts` sees.
    writeSemanticFile("glossary.yml", "terms:\n  arr:\n    definition: root\n");
    writeSemanticFile("groups/eu_prod/glossary.yml", "terms:\n  arr:\n    definition: eu\n");
    const terms = await loadGlossaryFromDisk();
    expect(terms.filter((t) => t.term === "arr")).toHaveLength(2);
  });

  it("one corrupt group glossary does not blank the rest of the union", async () => {
    writeSemanticFile("glossary.yml", "terms:\n  arr:\n    definition: ok\n");
    writeSemanticFile("groups/broken/glossary.yml", "terms: [unclosed\n"); // malformed YAML
    writeSemanticFile("groups/good/glossary.yml", "terms:\n  ltv:\n    definition: fine\n");
    const terms = await loadGlossaryFromDisk();
    // The corrupt file is logged + skipped; the valid root + group terms survive.
    expect(terms.map((t) => t.term).toSorted()).toEqual(["arr", "ltv"]);
  });

  it("returns empty when no glossary exists in any layout", async () => {
    writeSemanticFile("entities/orders.yml", "table: orders\n"); // present but no glossary
    const terms = await loadGlossaryFromDisk();
    expect(terms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Entities — the sibling root-only read (#3273 FIX bullet)
// ---------------------------------------------------------------------------

describe("loadEntitiesFromDisk (layout-aware, #3273)", () => {
  it("discovers entities across flat, groups/, and legacy layouts with discovery-matching attribution", async () => {
    writeSemanticFile("entities/orders.yml", "table: orders\n");
    writeSemanticFile("groups/eu_prod/entities/customers.yml", "table: customers\n");
    writeSemanticFile("marketing/entities/campaigns.yml", "table: campaigns\n");

    const entities = await loadEntitiesFromDisk();
    const connByTable = Object.fromEntries(entities.map((e) => [e.table, e.connection]));

    expect(Object.keys(connByTable).toSorted()).toEqual(["campaigns", "customers", "orders"]);
    // flat default → null connection (undefined), parity with the DB loaders.
    expect(connByTable.orders).toBeUndefined();
    // canonical groups/<group>/ → directory is canonical.
    expect(connByTable.customers).toBe("eu_prod");
    // legacy <source>/ → source name.
    expect(connByTable.campaigns).toBe("marketing");
  });

  it("directory is canonical in groups/<group>/ even when a connection: field disagrees", async () => {
    writeSemanticFile("groups/eu_prod/entities/customers.yml", "table: customers\nconnection: wrong\n");
    const entities = await loadEntitiesFromDisk();
    expect(entities).toHaveLength(1);
    expect(entities[0].connection).toBe("eu_prod"); // not "wrong"
  });

  it("honors a connection: field override on the flat layout", async () => {
    writeSemanticFile("entities/orders.yml", "table: orders\nconnection: legacy_grp\n");
    const entities = await loadEntitiesFromDisk();
    expect(entities[0].connection).toBe("legacy_grp");
  });

  it("honors the canonical `group:` field override on the flat layout", async () => {
    // `group:` is the canonical field (ADR-0012); `connection:` is the
    // deprecated alias. The override test above used the alias — pin the
    // canonical field new authors will actually write.
    writeSemanticFile("entities/orders.yml", "table: orders\ngroup: us_prod\n");
    const entities = await loadEntitiesFromDisk();
    expect(entities[0].connection).toBe("us_prod");
  });

  it("the canonical `group:` field wins over the deprecated `connection:` alias", async () => {
    writeSemanticFile("entities/orders.yml", "table: orders\ngroup: canonical_grp\nconnection: alias_grp\n");
    const entities = await loadEntitiesFromDisk();
    expect(entities[0].connection).toBe("canonical_grp");
  });

  it("returns empty when the semantic root has no entities", async () => {
    const entities = await loadEntitiesFromDisk();
    expect(entities).toEqual([]);
  });
});
