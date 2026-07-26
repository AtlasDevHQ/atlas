/**
 * One catalog id, one ingest target (#4770).
 *
 * This guard exists BECAUSE of a review finding, and it is the kind of code
 * that can be deleted without anything going red — the cycle walk would simply
 * start silently misrouting. So the tests are written as the mutations they
 * must catch:
 *
 *   - remove either registry's claim call → a collision registers cleanly;
 *   - make the duplicate check unreachable → same;
 *   - go back to a blanket `clear()` in the reset → the check is defeated
 *     inside CI, which is the only place it is ever exercised.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetCatalogIngestClaims,
  claimCatalogIngestTarget,
  getCatalogIngestTarget,
} from "@atlas/api/lib/knowledge/catalog-claims";
import {
  _resetKnowledgeSyncConnectors,
  registerKnowledgeSyncConnector,
} from "@atlas/api/lib/knowledge/connectors";
import {
  _resetBrainSourceConnectors,
  registerBrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";

const CATALOG = "catalog:collision";

function knowledgeConnector(catalogId = CATALOG) {
  return {
    catalogId,
    vendor: "fixture",
    createClient: () => ({
      fetchChanges: async () => ({ documents: [], highWaterMark: null }),
      fetchAll: async () => ({ documents: [], highWaterMark: null }),
    }),
  };
}

function brainConnector(catalogId = CATALOG) {
  return {
    catalogId,
    source: "fixture",
    createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
  };
}

afterEach(() => {
  _resetKnowledgeSyncConnectors();
  _resetBrainSourceConnectors();
});

describe("claimCatalogIngestTarget", () => {
  it("records the holder", () => {
    claimCatalogIngestTarget(CATALOG, "brain-episodes");
    expect(getCatalogIngestTarget(CATALOG)).toBe("brain-episodes");
  });

  it("is idempotent for the same target — a double boot registration is a no-op", () => {
    claimCatalogIngestTarget(CATALOG, "knowledge-documents");
    expect(() => claimCatalogIngestTarget(CATALOG, "knowledge-documents")).not.toThrow();
  });

  it("refuses a second target, naming why the routing depends on it", () => {
    claimCatalogIngestTarget(CATALOG, "knowledge-documents");
    expect(() => claimCatalogIngestTarget(CATALOG, "brain-episodes")).toThrow(
      /exactly one ingest target/,
    );
  });
});

describe("the two registries are disjoint IN BOTH DIRECTIONS", () => {
  it("refuses a brain source on an id a knowledge connector already holds", () => {
    registerKnowledgeSyncConnector(knowledgeConnector());
    expect(() => registerBrainSourceConnector(brainConnector())).toThrow(
      /exactly one ingest target/,
    );
  });

  it("refuses a knowledge connector on an id a brain source already holds", () => {
    // The direction the first, one-sided guard missed — and the one that can
    // actually happen, since brain sources register LAST in `register.ts`.
    registerBrainSourceConnector(brainConnector());
    expect(() => registerKnowledgeSyncConnector(knowledgeConnector())).toThrow(
      /exactly one ingest target/,
    );
  });

  it("leaves distinct catalog ids alone", () => {
    registerKnowledgeSyncConnector(knowledgeConnector("catalog:docs"));
    expect(() => registerBrainSourceConnector(brainConnector("catalog:chat"))).not.toThrow();
  });
});

describe("the test-only reset is target-scoped", () => {
  it("resetting ONE registry does not release the other's claims", () => {
    // A blanket `clear()` here would let a colliding id register cleanly right
    // after — defeating the guard in the only environment that runs it.
    registerBrainSourceConnector(brainConnector());
    _resetKnowledgeSyncConnectors();
    expect(getCatalogIngestTarget(CATALOG)).toBe("brain-episodes");
    expect(() => registerKnowledgeSyncConnector(knowledgeConnector())).toThrow(
      /exactly one ingest target/,
    );
  });

  it("releases its own, so a suite can re-register the same fixture id", () => {
    registerKnowledgeSyncConnector(knowledgeConnector());
    _resetKnowledgeSyncConnectors();
    expect(getCatalogIngestTarget(CATALOG)).toBeUndefined();
    expect(() => registerKnowledgeSyncConnector(knowledgeConnector())).not.toThrow();
  });

  it("only clears the named target", () => {
    claimCatalogIngestTarget("catalog:docs", "knowledge-documents");
    claimCatalogIngestTarget("catalog:chat", "brain-episodes");
    _resetCatalogIngestClaims("knowledge-documents");
    expect(getCatalogIngestTarget("catalog:docs")).toBeUndefined();
    expect(getCatalogIngestTarget("catalog:chat")).toBe("brain-episodes");
  });
});
