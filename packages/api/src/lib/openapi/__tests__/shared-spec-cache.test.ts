/**
 * Tests for the cross-workspace shared spec/graph cache (`shared-spec-cache.ts`,
 * #2970). Covers the isolation gate, canonical identity + version pinning,
 * resolve-time "normalize once across workspaces", install-time "no re-download
 * for the second workspace", the conditional-GET refresh cycle (304 vs 200), and
 * eviction.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isShareableSpec,
  sharedGraphFromSnapshot,
  probeShared,
  refreshSharedSpecsCycle,
  invalidateSharedSpec,
  canonicalSpecKey,
  contentHashOf,
  sharedSpecCacheStats,
  __resetSharedSpecCacheForTests,
  type ConditionalProbeFn,
} from "../shared-spec-cache";
import { buildSnapshot } from "../probe";
import { buildOperationGraph } from "../spec";
import { DATA_CANDIDATES, STRIPE_DATA_CANDIDATE } from "../data-candidates";
import { MOCK_OPENAPI_SPEC } from "@atlas/api/testing/openapi-datasource";

const CATALOG = "catalog:stripe-data";
const SPEC_URL = "https://raw.githubusercontent.com/example/openapi/master/spec.json";

/** Build a persisted snapshot from a doc (the resolver's input shape). */
function makeSnapshot(doc: unknown, probedAt = "2026-05-30T00:00:00.000Z") {
  return buildSnapshot(doc, buildOperationGraph(doc), probedAt);
}

/** A V2 doc — same shape, bumped `info.version` (the version-pinning fixture). */
const MOCK_SPEC_V2 = { ...MOCK_OPENAPI_SPEC, info: { ...MOCK_OPENAPI_SPEC.info, version: "2.0.0" } };

/**
 * A conditional-probe stub that records every call and returns scripted results
 * in order (or a default 200 with the given doc). Lets a test assert the network
 * was (or wasn't) hit and which validators were sent.
 */
function makeProbeStub(opts: {
  doc?: unknown;
  etag?: string;
  scripted?: Array<Awaited<ReturnType<ConditionalProbeFn>>>;
}): { fn: ConditionalProbeFn; calls: Array<{ specUrl: string; etag?: string; lastModified?: string }> } {
  const calls: Array<{ specUrl: string; etag?: string; lastModified?: string }> = [];
  let i = 0;
  const fn: ConditionalProbeFn = async (specUrl, options) => {
    calls.push({
      specUrl,
      ...(options.etag ? { etag: options.etag } : {}),
      ...(options.lastModified ? { lastModified: options.lastModified } : {}),
    });
    if (opts.scripted && i < opts.scripted.length) return opts.scripted[i++]!;
    const doc = opts.doc ?? MOCK_OPENAPI_SPEC;
    return {
      notModified: false,
      doc,
      graph: buildOperationGraph(doc),
      ...(opts.etag ? { etag: opts.etag } : {}),
    };
  };
  return { fn, calls };
}

beforeEach(() => __resetSharedSpecCacheForTests());
afterEach(() => __resetSharedSpecCacheForTests());

describe("isShareableSpec (the isolation gate)", () => {
  it("is shareable when the spec host differs from the API host (credential withheld)", () => {
    expect(isShareableSpec("https://raw.githubusercontent.com/x/spec.json", "https://api.stripe.com")).toBe(true);
  });

  it("is NOT shareable when the spec host equals the API host (credential could be sent)", () => {
    expect(isShareableSpec("https://api.example.com/openapi.json", "https://api.example.com")).toBe(false);
  });

  it("is NOT shareable when no API host is declared (a generic install)", () => {
    expect(isShareableSpec("https://raw.githubusercontent.com/x/spec.json", undefined)).toBe(false);
  });

  it("is NOT shareable when either URL is unparseable (fail-safe)", () => {
    expect(isShareableSpec("not a url", "https://api.stripe.com")).toBe(false);
    expect(isShareableSpec("https://raw.githubusercontent.com/x/spec.json", "also not a url")).toBe(false);
  });

  it("classifies every built-in data candidate as shareable (public spec, withheld credential)", () => {
    for (const c of DATA_CANDIDATES) {
      expect(isShareableSpec(c.openapiUrl, c.apiBaseUrl)).toBe(true);
    }
    // Spot-check Stripe explicitly: spec on GitHub CDN, API on api.stripe.com.
    expect(isShareableSpec(STRIPE_DATA_CANDIDATE.openapiUrl, STRIPE_DATA_CANDIDATE.apiBaseUrl)).toBe(true);
  });
});

describe("contentHashOf + canonicalSpecKey", () => {
  it("is stable for the same document and differs for different documents", () => {
    expect(contentHashOf(MOCK_OPENAPI_SPEC)).toBe(contentHashOf(MOCK_OPENAPI_SPEC));
    expect(contentHashOf(MOCK_OPENAPI_SPEC)).not.toBe(contentHashOf(MOCK_SPEC_V2));
  });

  it("keys include catalog, version, and content hash (divergent versions don't collide)", () => {
    const k1 = canonicalSpecKey({ catalogId: CATALOG, version: "1.0.0", contentHash: "abc" });
    const k2 = canonicalSpecKey({ catalogId: CATALOG, version: "2.0.0", contentHash: "abc" });
    expect(k1).toBe(`${CATALOG}@1.0.0#abc`);
    expect(k1).not.toBe(k2);
  });
});

describe("sharedGraphFromSnapshot (resolve-time: normalize once across workspaces)", () => {
  it("returns the SAME graph object for two workspaces on the same spec identity", () => {
    const snap = makeSnapshot(MOCK_OPENAPI_SPEC);
    const graphA = sharedGraphFromSnapshot(CATALOG, snap); // workspace A resolves
    const graphB = sharedGraphFromSnapshot(CATALOG, snap); // workspace B resolves
    expect(graphB).toBe(graphA); // referential identity ⇒ normalized exactly once
  });

  it("pins versions: divergent-version workspaces get distinct graphs (no collision)", () => {
    const g1 = sharedGraphFromSnapshot(CATALOG, makeSnapshot(MOCK_OPENAPI_SPEC));
    const g2 = sharedGraphFromSnapshot(CATALOG, makeSnapshot(MOCK_SPEC_V2));
    expect(g2).not.toBe(g1);
    expect(g1.info.version).toBe("1.0.0");
    expect(g2.info.version).toBe("2.0.0");
  });

  it("seeds the catalog's 'current' pointer so the refresh cycle has a working set", () => {
    expect(sharedSpecCacheStats().catalogs).toBe(0);
    sharedGraphFromSnapshot(CATALOG, makeSnapshot(MOCK_OPENAPI_SPEC));
    expect(sharedSpecCacheStats().catalogs).toBe(1);
    expect(sharedSpecCacheStats().identities).toBe(1);
  });

  it("throws (fail-loud) on a corrupt snapshot doc the caller skips", () => {
    const corrupt = { ...makeSnapshot(MOCK_OPENAPI_SPEC), doc: { not: "an openapi doc" } };
    expect(() => sharedGraphFromSnapshot(CATALOG, corrupt)).toThrow();
  });
});

describe("probeShared (install-time: no re-download for the second workspace)", () => {
  it("downloads once, then a second install within the TTL reuses the cache with no network", async () => {
    const { fn, calls } = makeProbeStub({ doc: MOCK_OPENAPI_SPEC });
    let clock = 1_000_000;
    const nowFn = () => clock;

    const first = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: fn, nowFn });
    expect(first.source).toBe("network-200");
    expect(calls.length).toBe(1);

    // Second workspace installs the same upstream moments later — cache hit, no network.
    clock += 1000;
    const second = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: fn, nowFn });
    expect(second.source).toBe("cache");
    expect(second.doc).toBe(first.doc);
    expect(calls.length).toBe(1); // still 1 — no re-download
  });

  it("past the TTL, does a CONDITIONAL GET; a 304 reuses the cached doc for free", async () => {
    const stub = makeProbeStub({
      etag: 'W/"v1"',
      scripted: [
        { notModified: false, doc: MOCK_OPENAPI_SPEC, graph: buildOperationGraph(MOCK_OPENAPI_SPEC), etag: 'W/"v1"' },
        { notModified: true, etag: 'W/"v1"' },
      ],
    });
    let clock = 1_000_000;
    const nowFn = () => clock;

    const first = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn, nowFn });
    expect(first.source).toBe("network-200");

    clock += 2 * 60 * 60 * 1000; // advance past the 1h default TTL
    const second = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn, nowFn });
    expect(second.source).toBe("network-304");
    expect(second.doc).toBe(first.doc);
    // The conditional GET carried the cached validator.
    expect(stub.calls[1]?.etag).toBe('W/"v1"');
  });

  it("a 200 with a changed upstream re-normalizes once and advances 'current'", async () => {
    const stub = makeProbeStub({
      scripted: [
        { notModified: false, doc: MOCK_OPENAPI_SPEC, graph: buildOperationGraph(MOCK_OPENAPI_SPEC) },
        { notModified: false, doc: MOCK_SPEC_V2, graph: buildOperationGraph(MOCK_SPEC_V2) },
      ],
    });
    let clock = 1_000_000;
    const nowFn = () => clock;

    const first = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn, nowFn });
    expect(first.identity.version).toBe("1.0.0");

    clock += 2 * 60 * 60 * 1000;
    const second = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn, nowFn });
    expect(second.source).toBe("network-200");
    expect(second.identity.version).toBe("2.0.0");
    // Both versions remain cached (the old one still pins existing workspaces).
    expect(sharedSpecCacheStats().identities).toBe(2);
    expect(sharedSpecCacheStats().catalogs).toBe(1);
  });

  it("force re-downloads unconditionally (no validators) and replaces the entry", async () => {
    const stub = makeProbeStub({ doc: MOCK_OPENAPI_SPEC, etag: 'W/"v1"' });
    let clock = 1_000_000;
    const nowFn = () => clock;

    await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn, nowFn });
    clock += 1000; // still within TTL — force must bypass the short-circuit
    const forced = await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn, nowFn, force: true });
    expect(forced.source).toBe("network-200");
    expect(stub.calls.length).toBe(2);
    // Forced refresh sends NO conditional validators (unconditional re-download).
    expect(stub.calls[1]?.etag).toBeUndefined();
  });
});

describe("refreshSharedSpecsCycle (Tier-1 periodic conditional-GET)", () => {
  async function seed(catalogId: string): Promise<void> {
    const stub = makeProbeStub({ doc: MOCK_OPENAPI_SPEC });
    await probeShared({ catalogId, specUrl: SPEC_URL, probe: stub.fn });
  }

  it("a 304 counts as not-modified and serves the cache for free", async () => {
    await seed(CATALOG);
    const probe: ConditionalProbeFn = async () => ({ notModified: true });
    const result = await refreshSharedSpecsCycle({
      probe,
      specUrlFor: () => SPEC_URL,
      nowFn: () => Date.now() + 5 * 60 * 60 * 1000, // force past TTL so a conditional GET fires
    });
    expect(result.inspected).toBe(1);
    expect(result.notModified).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.outcomes[0]).toEqual({ catalogId: CATALOG, kind: "not_modified" });
  });

  it("a 200 with a new version counts as updated", async () => {
    await seed(CATALOG);
    const probe: ConditionalProbeFn = async () => ({
      notModified: false,
      doc: MOCK_SPEC_V2,
      graph: buildOperationGraph(MOCK_SPEC_V2),
    });
    const result = await refreshSharedSpecsCycle({
      probe,
      specUrlFor: () => SPEC_URL,
      nowFn: () => Date.now() + 5 * 60 * 60 * 1000,
    });
    expect(result.updated).toBe(1);
    expect(result.outcomes[0]).toEqual({ catalogId: CATALOG, kind: "updated", version: "2.0.0" });
  });

  it("skips a cached catalog with no resolvable spec URL (registry drift)", async () => {
    await seed(CATALOG);
    const result = await refreshSharedSpecsCycle({
      probe: async () => ({ notModified: true }),
      specUrlFor: () => undefined,
    });
    expect(result.inspected).toBe(1);
    expect(result.notModified).toBe(0);
    expect(result.outcomes.length).toBe(0); // skipped, not probed
  });

  it("isolates a per-catalog failure without stalling the others", async () => {
    await seed("catalog:a");
    await seed("catalog:b");
    const probe: ConditionalProbeFn = async (specUrl) => {
      if (specUrl.includes("boom")) throw new Error("upstream down");
      return { notModified: true };
    };
    const result = await refreshSharedSpecsCycle({
      probe,
      specUrlFor: (id) => (id === "catalog:a" ? "https://x/boom.json" : SPEC_URL),
      nowFn: () => Date.now() + 5 * 60 * 60 * 1000,
    });
    expect(result.inspected).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.notModified).toBe(1);
    expect(result.outcomes).toContainEqual({ catalogId: "catalog:a", kind: "failed", error: "upstream down" });
  });
});

describe("invalidateSharedSpec", () => {
  it("drops a catalog's entries so the next probe re-downloads", async () => {
    const stub = makeProbeStub({ doc: MOCK_OPENAPI_SPEC });
    await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn });
    expect(sharedSpecCacheStats().identities).toBe(1);

    invalidateSharedSpec(CATALOG);
    expect(sharedSpecCacheStats().identities).toBe(0);
    expect(sharedSpecCacheStats().catalogs).toBe(0);

    await probeShared({ catalogId: CATALOG, specUrl: SPEC_URL, probe: stub.fn });
    expect(stub.calls.length).toBe(2); // re-downloaded after eviction
  });
});
