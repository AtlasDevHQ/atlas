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
  probeSpec,
  buildSnapshot,
  summarizeOperations,
  snapshotToGraph,
  OpenApiProbeError,
  __resetSnapshotGraphCacheForTests,
} from "../probe";
import { buildOperationGraph } from "../spec";
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

  it("throws on oauth2 (deferred to slice 6)", () => {
    expect(() => buildResolvedAuth("oauth2", "x", undefined, undefined)).toThrow(OpenApiProbeError);
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

  it("rebuilds the graph from a snapshot and memoizes by (installId, probedAt)", () => {
    const snap = buildSnapshot(MOCK_OPENAPI_SPEC, graph, "2026-05-29T00:00:00.000Z");
    const g1 = snapshotToGraph("ds-1", snap);
    const g2 = snapshotToGraph("ds-1", snap);
    expect(g1).toBe(g2); // same reference = cache hit
    expect(g1.operations.has("listWidgets")).toBe(true);
  });

  it("fail-loud (unparseable) on a corrupt cached doc", () => {
    const corrupt = { ...buildSnapshot(MOCK_OPENAPI_SPEC, graph, "t"), doc: { not: "valid" } };
    expect(() => snapshotToGraph("ds-corrupt", corrupt)).toThrow(OpenApiProbeError);
  });
});
