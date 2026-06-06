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
    expect(terms.map((t) => t.term)).toEqual(["arr"]);
    expect(terms[0].ambiguous).toBe(true);
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

  it("returns empty when the semantic root has no entities", async () => {
    const entities = await loadEntitiesFromDisk();
    expect(entities).toEqual([]);
  });
});
