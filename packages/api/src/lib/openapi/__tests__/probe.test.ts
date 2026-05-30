/**
 * Tests for the spec-probe primitive (`probe.ts`, #2926) — the shared machinery
 * the form install handler (probe-on-install) and the admin rediscover endpoint
 * both build on. Covers auth resolution across kinds, probe success + each
 * failure class, snapshot assembly, the operations summary the detail page
 * renders, and the in-process graph cache (incl. corrupt-snapshot fail-loud).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildResolvedAuth,
  resolveAuthFromDecryptedConfig,
  probeSpec,
  buildSnapshot,
  summarizeOperations,
  snapshotToGraph,
  invalidateInstallGraphCache,
  assertSpecUrlAllowed,
  OpenApiProbeError,
  __resetSnapshotGraphCacheForTests,
} from "../probe";
import { buildOperationGraph } from "../spec";
import { narrowSupportedAuthKind } from "../catalog";
import { MOCK_OPENAPI_SPEC } from "@atlas/api/testing/openapi-datasource";

function fetchReturning(spec: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(spec), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => __resetSnapshotGraphCacheForTests());
afterEach(() => __resetSnapshotGraphCacheForTests());

describe("buildResolvedAuth", () => {
  it("maps each supported kind to ResolvedAuth", () => {
    expect(buildResolvedAuth("none", undefined, undefined, undefined)).toEqual({ kind: "none" });
    expect(buildResolvedAuth("bearer", "tok", undefined, undefined)).toEqual({ kind: "bearer", token: "tok" });
    expect(buildResolvedAuth("basic", "user:pass", undefined, undefined)).toEqual({
      kind: "basic",
      username: "user",
      password: "pass",
    });
    expect(buildResolvedAuth("apikey-header", "k", "X-Key", undefined)).toEqual({
      kind: "apiKey",
      value: "k",
      placement: { in: "header", name: "X-Key" },
    });
    expect(buildResolvedAuth("apikey-query", "k", undefined, "api_key")).toEqual({
      kind: "apiKey",
      value: "k",
      placement: { in: "query", name: "api_key" },
    });
  });

  it("splits basic on the first colon (password may contain colons)", () => {
    expect(buildResolvedAuth("basic", "u:p:with:colons", undefined, undefined)).toEqual({
      kind: "basic",
      username: "u",
      password: "p:with:colons",
    });
  });

  it("excludes oauth2 from the executable kinds (narrowed away before buildResolvedAuth)", () => {
    // oauth2 (slice 6) is unrepresentable in buildResolvedAuth's SupportedAuthKind
    // param — callers narrow first; the deferred kind resolves to null.
    expect(narrowSupportedAuthKind("oauth2")).toBeNull();
    expect(narrowSupportedAuthKind("bearer")).toBe("bearer");
    expect(narrowSupportedAuthKind("apikey-query")).toBe("apikey-query");
  });
});

describe("probeSpec", () => {
  it("fetches + normalizes a spec into a graph", async () => {
    const { doc, graph } = await probeSpec("https://x.com/openapi.json", { kind: "none" }, {
      fetchImpl: fetchReturning(MOCK_OPENAPI_SPEC),
    });
    expect(doc).toBeDefined();
    expect(graph.operations.has("listWidgets")).toBe(true);
    expect(graph.info.title).toBe("Mock Widget API");
  });

  it("sends bearer auth on the probe request", async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify(MOCK_OPENAPI_SPEC), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await probeSpec("https://x.com/o.json", { kind: "bearer", token: "abc" }, { fetchImpl });
    expect(seen.Authorization).toBe("Bearer abc");
  });

  it("throws http_error on a non-2xx spec fetch", async () => {
    const err = await probeSpec("https://x.com/o.json", { kind: "none" }, { fetchImpl: fetchReturning({}, 503) }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpenApiProbeError);
    expect((err as OpenApiProbeError).reason).toBe("http_error");
    expect((err as OpenApiProbeError).httpStatus).toBe(503);
  });

  it("throws unreachable when fetch rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const err = await probeSpec("https://x.com/o.json", { kind: "none" }, { fetchImpl }).catch((e) => e);
    expect((err as OpenApiProbeError).reason).toBe("unreachable");
  });

  it("throws unparseable on a non-OpenAPI document", async () => {
    const err = await probeSpec("https://x.com/o.json", { kind: "none" }, {
      fetchImpl: fetchReturning({ not: "an openapi doc" }),
    }).catch((e) => e);
    expect((err as OpenApiProbeError).reason).toBe("unparseable");
  });

  it("throws no_operations on a spec with zero operations", async () => {
    const empty = { openapi: "3.1.0", info: { title: "Empty", version: "1.0.0" }, paths: {} };
    const err = await probeSpec("https://x.com/o.json", { kind: "none" }, {
      fetchImpl: fetchReturning(empty),
    }).catch((e) => e);
    expect((err as OpenApiProbeError).reason).toBe("no_operations");
  });
});

describe("assertSpecUrlAllowed (SSRF guard, #3006)", () => {
  const ORIGINAL = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = ORIGINAL;
  });

  it("rejects private/internal spec URLs by default in EVERY deploy mode (no implicit non-SaaS skip)", () => {
    // The pre-#3006 guard was a no-op off SaaS, leaving self-hosted unprotected.
    // It is now ON everywhere unless the operator opts out explicitly.
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    delete process.env.ATLAS_DEPLOY_MODE; // even with no deploy mode set, the guard fires
    for (const url of [
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://localhost/openapi.json",
      "https://127.0.0.1/openapi.json",
      "https://10.0.0.5/openapi.json",
      "https://192.168.1.10/openapi.json",
      "https://[::ffff:169.254.169.254]/openapi.json", // IPv4-mapped metadata
      "https://metadata.google.internal/v1/", // GCP metadata hostname
      "http://crm.example.com/openapi.json", // non-HTTPS
    ]) {
      expect(() => assertSpecUrlAllowed(url), url).toThrow(OpenApiProbeError);
    }
  });

  it("allows a public HTTPS spec URL", () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    expect(() => assertSpecUrlAllowed("https://crm.example.com/rest/open-api/core")).not.toThrow();
  });

  it("opts the guard out when ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true (self-hosted internal services)", () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    expect(() => assertSpecUrlAllowed("http://localhost:9000/openapi.json")).not.toThrow();
    expect(() => assertSpecUrlAllowed("http://10.0.0.5/openapi.json")).not.toThrow();
  });

  it("probeSpec fires the guard before the host-side fetch", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response(JSON.stringify(MOCK_OPENAPI_SPEC), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const err = await probeSpec("https://127.0.0.1/o.json", { kind: "none" }, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenApiProbeError);
    expect((err as OpenApiProbeError).reason).toBe("unreachable");
    expect(fetched).toBe(false); // guard rejected before any request left the box
  });

  it("probeSpec rejects a public→internal redirect (TOCTOU)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let hops = 0;
    const fetchImpl = (async (url: string) => {
      hops++;
      // The up-front guard passes (public host); the upstream then 302s to metadata.
      if (new URL(url).hostname === "public.example.com") {
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
      }
      return new Response(JSON.stringify(MOCK_OPENAPI_SPEC), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const err = await probeSpec("https://public.example.com/o.json", { kind: "none" }, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenApiProbeError);
    expect((err as OpenApiProbeError).reason).toBe("unreachable");
    expect(hops).toBe(1); // followed nothing past the blocked redirect
  });
});

describe("buildSnapshot + summarizeOperations", () => {
  const graph = buildOperationGraph(MOCK_OPENAPI_SPEC);

  it("captures spec identity + doc in the snapshot", () => {
    const snap = buildSnapshot(MOCK_OPENAPI_SPEC, graph, "2026-05-29T00:00:00.000Z");
    expect(snap.title).toBe("Mock Widget API");
    expect(snap.operationCount).toBe(2);
    expect(snap.probedAt).toBe("2026-05-29T00:00:00.000Z");
    expect(snap.doc).toBe(MOCK_OPENAPI_SPEC);
  });

  it("summarizes operations sorted by operationId", () => {
    const ops = summarizeOperations(graph);
    expect(ops.map((o) => o.operationId)).toEqual(["getWidget", "listWidgets"]);
    expect(ops[0]).toMatchObject({ operationId: "getWidget", method: "GET", path: "/widgets/{id}" });
  });
});

describe("snapshotToGraph", () => {
  const graph = buildOperationGraph(MOCK_OPENAPI_SPEC);

  it("rebuilds the graph from a snapshot and memoizes by (workspaceId, installId, probedAt)", () => {
    const snap = buildSnapshot(MOCK_OPENAPI_SPEC, graph, "2026-05-29T00:00:00.000Z");
    const g1 = snapshotToGraph("ws-1", "ds-1", snap);
    const g2 = snapshotToGraph("ws-1", "ds-1", snap);
    expect(g1).toBe(g2); // same reference = cache hit
    expect(g1.operations.has("listWidgets")).toBe(true);
  });

  it("fail-loud (unparseable) on a corrupt cached doc", () => {
    const corrupt = { ...buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t"), doc: { not: "valid" } };
    expect(() => snapshotToGraph("ws-1", "ds-corrupt", corrupt)).toThrow(OpenApiProbeError);
  });

  // The #3010 defense-in-depth regression guard: a process-global cache keyed on
  // a non-globally-unique `install_id` would serve workspace A's operation
  // surface to workspace B when both mint the SAME install_id (a future non-UUID
  // install path). The workspaceId prefix makes that collision impossible.
  it("scopes the cache by workspaceId — same installId + probedAt across two workspaces never collide (#3010)", () => {
    // Two DIFFERENT specs (different operations), but SAME installId + SAME probedAt.
    const specA = MOCK_OPENAPI_SPEC; // listWidgets / getWidget
    const specB = {
      openapi: "3.1.0",
      info: { title: "Gadgets", version: "1.0.0" },
      servers: [{ url: "https://gadgets.example.com/api" }],
      paths: {
        "/gadgets": {
          get: { operationId: "listGadgets", responses: { "200": { description: "OK" } } },
        },
      },
    };
    const probedAt = "2026-05-29T00:00:00.000Z";
    const snapA = buildSnapshot(specA, buildOperationGraph(specA), probedAt);
    const snapB = buildSnapshot(specB, buildOperationGraph(specB), probedAt);

    const gA = snapshotToGraph("ws-A", "shared-install-id", snapA);
    const gB = snapshotToGraph("ws-B", "shared-install-id", snapB);

    expect(gA).not.toBe(gB); // distinct cache entries — no cross-workspace bleed
    expect(gA.operations.has("listWidgets")).toBe(true);
    expect(gB.operations.has("listGadgets")).toBe(true);
    // ws-B must NOT have received ws-A's cached shape.
    expect(gB.operations.has("listWidgets")).toBe(false);
  });
});

describe("invalidateInstallGraphCache", () => {
  const graph = buildOperationGraph(MOCK_OPENAPI_SPEC);

  it("evicts an install's cached graph so the next resolve rebuilds (#3009)", () => {
    const snap = buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t1");
    const g1 = snapshotToGraph("ws-1", "ds-1", snap);
    expect(snapshotToGraph("ws-1", "ds-1", snap)).toBe(g1); // cached

    invalidateInstallGraphCache("ws-1", "ds-1");

    const g2 = snapshotToGraph("ws-1", "ds-1", snap);
    expect(g2).not.toBe(g1); // rebuilt after eviction (fresh reference)
  });

  it("prefix-deletes every probedAt revision for the install (rediscover hygiene)", () => {
    const gOld = snapshotToGraph("ws-1", "ds-1", buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t1"));
    const gNew = snapshotToGraph("ws-1", "ds-1", buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t2"));

    invalidateInstallGraphCache("ws-1", "ds-1");

    expect(snapshotToGraph("ws-1", "ds-1", buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t1"))).not.toBe(gOld);
    expect(snapshotToGraph("ws-1", "ds-1", buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t2"))).not.toBe(gNew);
  });

  it("is scoped to (workspaceId, installId) — never evicts another workspace's same installId", () => {
    const snap = buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t1");
    const g1 = snapshotToGraph("ws-1", "ds-1", snap);
    const g2 = snapshotToGraph("ws-2", "ds-1", snap);

    invalidateInstallGraphCache("ws-1", "ds-1");

    expect(snapshotToGraph("ws-2", "ds-1", snap)).toBe(g2); // ws-2 untouched
    expect(snapshotToGraph("ws-1", "ds-1", snap)).not.toBe(g1); // ws-1 rebuilt
  });

  it("does not evict a sibling install whose id is a prefix (the trailing `:` guard)", () => {
    const snap = buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t1");
    const g1 = snapshotToGraph("ws-1", "ds-1", snap);
    const g10 = snapshotToGraph("ws-1", "ds-10", snap);

    invalidateInstallGraphCache("ws-1", "ds-1");

    expect(snapshotToGraph("ws-1", "ds-10", snap)).toBe(g10); // ds-10 survives (not a ds-1 match)
    expect(snapshotToGraph("ws-1", "ds-1", snap)).not.toBe(g1); // ds-1 evicted
  });
});

describe("resolveAuthFromDecryptedConfig", () => {
  it("builds a ResolvedAuth from a supported decrypted config (ok: true)", () => {
    const result = resolveAuthFromDecryptedConfig({
      auth_kind: "apikey-header",
      auth_value: "k123",
      auth_header_name: "X-My-Key",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth).toEqual({
        kind: "apiKey",
        value: "k123",
        placement: { in: "header", name: "X-My-Key" },
      });
    }
  });

  it("defaults a missing auth_kind to none (ok: true)", () => {
    const result = resolveAuthFromDecryptedConfig({});
    expect(result).toEqual({ ok: true, auth: { kind: "none" } });
  });

  it("returns ok: false for the deferred oauth2 kind, carrying the raw value", () => {
    const result = resolveAuthFromDecryptedConfig({ auth_kind: "oauth2" });
    expect(result).toEqual({ ok: false, rawAuthKind: "oauth2" });
  });

  it("returns ok: false for a drifted / garbage auth_kind", () => {
    const result = resolveAuthFromDecryptedConfig({ auth_kind: "totally-bogus" });
    expect(result).toEqual({ ok: false, rawAuthKind: "totally-bogus" });
  });
});
