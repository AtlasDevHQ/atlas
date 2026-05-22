/**
 * Unit tests for `LazyPluginLoader` (#2657, milestone 1.5.2 slice 3).
 *
 * The loader builds and caches per-Workspace plugin instances on first
 * use. `workspace_plugins.config` is the source of truth for per-install
 * config; the loader reads it once per `(workspaceId, catalogId)` and
 * memoizes the instantiated plugin until `evict` clears the entry. The
 * internal-DB module is mocked so we control the row set without
 * spinning up Postgres.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// `internalQuery` returns rows keyed by `(workspaceId, catalogId)`. We
// stash the row set on a mutable map so each test can stage the exact
// surface it needs. `hasInternalDB` is forced true — the loader is
// always called from request paths that already require an internal DB.
type StoredRow = { config: Record<string, unknown> };
const mockRowsByKey = new Map<string, StoredRow>();
const queryCalls: Array<{ sql: string; params: unknown[] }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    queryCalls.push({ sql, params });
    const [workspaceId, catalogId] = params as [string, string];
    const row = mockRowsByKey.get(`${workspaceId}::${catalogId}`);
    return row ? [row] : [];
  },
}));

const { LazyPluginLoader } = await import("../lazy-loader");
import type { LazyPluginBuilder } from "../lazy-loader";
import type { PluginLike } from "../registry";

function buildPlugin(args: { id: string; config: Record<string, unknown> }): PluginLike {
  return {
    id: args.id,
    types: ["context"],
    version: "1.0.0",
    config: args.config,
  };
}

function stageRow(workspaceId: string, catalogId: string, config: Record<string, unknown>): void {
  mockRowsByKey.set(`${workspaceId}::${catalogId}`, { config });
}

beforeEach(() => {
  mockRowsByKey.clear();
  queryCalls.length = 0;
});

describe("LazyPluginLoader.getOrInstantiate", () => {
  test("first call: constructs from workspace_plugins.config via the registered builder", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });

    const builder: LazyPluginBuilder = ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config });
    loader.registerBuilder("salesforce", builder);

    const instance = await loader.getOrInstantiate("ws-1", "salesforce");

    expect(instance.id).toBe("salesforce@ws-1");
    expect(instance.config).toEqual({ instanceUrl: "https://acme.my.salesforce.com" });
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].params).toEqual(["ws-1", "salesforce"]);
  });

  test("second call returns the same instance — builder runs once across repeat calls", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });

    let constructionCount = 0;
    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) => {
      constructionCount++;
      return buildPlugin({ id: `${catalogId}@${workspaceId}#${constructionCount}`, config });
    });

    const first = await loader.getOrInstantiate("ws-1", "salesforce");
    const second = await loader.getOrInstantiate("ws-1", "salesforce");

    expect(second).toBe(first);
    expect(constructionCount).toBe(1);
    // Only the first call touches `workspace_plugins` — cache hit short-circuits the read.
    expect(queryCalls).toHaveLength(1);
  });

  test("per-Workspace isolation: same catalogId across two workspaces returns distinct instances", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });
    stageRow("ws-2", "salesforce", { instanceUrl: "https://contoso.my.salesforce.com" });

    let constructionCount = 0;
    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) => {
      constructionCount++;
      return buildPlugin({ id: `${catalogId}@${workspaceId}`, config });
    });

    const acme = await loader.getOrInstantiate("ws-1", "salesforce");
    const contoso = await loader.getOrInstantiate("ws-2", "salesforce");

    expect(acme).not.toBe(contoso);
    expect(acme.config).toEqual({ instanceUrl: "https://acme.my.salesforce.com" });
    expect(contoso.config).toEqual({ instanceUrl: "https://contoso.my.salesforce.com" });
    expect(constructionCount).toBe(2);
  });

  test("evict removes the cache entry; subsequent getOrInstantiate reconstructs", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });

    let constructionCount = 0;
    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) => {
      constructionCount++;
      return buildPlugin({ id: `${catalogId}@${workspaceId}#${constructionCount}`, config });
    });

    const before = await loader.getOrInstantiate("ws-1", "salesforce");
    expect(constructionCount).toBe(1);

    const evicted = loader.evict("ws-1", "salesforce");
    expect(evicted).toBe(true);

    const after = await loader.getOrInstantiate("ws-1", "salesforce");
    expect(after).not.toBe(before);
    expect(after.id).toBe("salesforce@ws-1#2");
    expect(constructionCount).toBe(2);
  });

  test("different catalogIds in the same workspace get distinct instances", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });
    stageRow("ws-1", "jira", { siteUrl: "https://acme.atlassian.net" });

    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config }),
    );
    loader.registerBuilder("jira", ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config }),
    );

    const salesforce = await loader.getOrInstantiate("ws-1", "salesforce");
    const jira = await loader.getOrInstantiate("ws-1", "jira");

    expect(salesforce).not.toBe(jira);
    expect(salesforce.id).toBe("salesforce@ws-1");
    expect(jira.id).toBe("jira@ws-1");
  });

  test("throws when no builder is registered for the catalogId", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", {});

    await expect(loader.getOrInstantiate("ws-1", "salesforce")).rejects.toThrow(
      /no builder registered/i,
    );
  });

  test("throws when `workspace_plugins` has no row for the (workspaceId, catalogId) pair", async () => {
    const loader = new LazyPluginLoader();
    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config }),
    );

    await expect(loader.getOrInstantiate("ws-1", "salesforce")).rejects.toThrow(
      /no install row/i,
    );
  });

  test("concurrent calls coalesce — overlapping getOrInstantiate awaits one in-flight construction", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });

    let constructionCount = 0;
    let resolveBuild: (plugin: PluginLike) => void;
    const buildGate = new Promise<PluginLike>((resolve) => {
      resolveBuild = resolve;
    });
    loader.registerBuilder("salesforce", async ({ workspaceId, catalogId, config }) => {
      constructionCount++;
      return buildGate.then(() => buildPlugin({ id: `${catalogId}@${workspaceId}`, config }));
    });

    const a = loader.getOrInstantiate("ws-1", "salesforce");
    const b = loader.getOrInstantiate("ws-1", "salesforce");
    resolveBuild!(buildPlugin({ id: "ignored", config: {} }));

    const [first, second] = await Promise.all([a, b]);
    expect(second).toBe(first);
    expect(constructionCount).toBe(1);
  });

  test("failed builder does not cache — next call retries from scratch", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });

    let attempts = 0;
    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) => {
      attempts++;
      if (attempts === 1) throw new Error("transient OAuth refresh failure");
      return buildPlugin({ id: `${catalogId}@${workspaceId}`, config });
    });

    await expect(loader.getOrInstantiate("ws-1", "salesforce")).rejects.toThrow(
      /transient OAuth refresh failure/,
    );
    const recovered = await loader.getOrInstantiate("ws-1", "salesforce");
    expect(recovered.id).toBe("salesforce@ws-1");
    expect(attempts).toBe(2);
  });
});

describe("LazyPluginLoader.evict", () => {
  test("returns false when there's no cached entry for the pair", () => {
    const loader = new LazyPluginLoader();
    expect(loader.evict("ws-1", "salesforce")).toBe(false);
  });

  test("only clears the targeted (workspaceId, catalogId) — other entries survive", async () => {
    const loader = new LazyPluginLoader();
    stageRow("ws-1", "salesforce", { instanceUrl: "https://acme.my.salesforce.com" });
    stageRow("ws-2", "salesforce", { instanceUrl: "https://contoso.my.salesforce.com" });

    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config }),
    );

    const acmeBefore = await loader.getOrInstantiate("ws-1", "salesforce");
    const contosoBefore = await loader.getOrInstantiate("ws-2", "salesforce");

    expect(loader.evict("ws-1", "salesforce")).toBe(true);

    const acmeAfter = await loader.getOrInstantiate("ws-1", "salesforce");
    const contosoAfter = await loader.getOrInstantiate("ws-2", "salesforce");

    expect(acmeAfter).not.toBe(acmeBefore);
    expect(contosoAfter).toBe(contosoBefore);
  });
});

describe("LazyPluginLoader builder registration", () => {
  test("hasBuilder reflects current registration state", () => {
    const loader = new LazyPluginLoader();
    expect(loader.hasBuilder("salesforce")).toBe(false);
    loader.registerBuilder("salesforce", ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config }),
    );
    expect(loader.hasBuilder("salesforce")).toBe(true);
  });

  test("registerBuilder throws on duplicate catalogId — surface operator wiring mistakes early", () => {
    const loader = new LazyPluginLoader();
    const builder: LazyPluginBuilder = ({ workspaceId, catalogId, config }) =>
      buildPlugin({ id: `${catalogId}@${workspaceId}`, config });
    loader.registerBuilder("salesforce", builder);
    expect(() => loader.registerBuilder("salesforce", builder)).toThrow(/already registered/i);
  });

  test("registerBuilder rejects empty catalogId", () => {
    const loader = new LazyPluginLoader();
    expect(() =>
      loader.registerBuilder("", ({ workspaceId, catalogId, config }) =>
        buildPlugin({ id: `${catalogId}@${workspaceId}`, config }),
      ),
    ).toThrow(/catalogId/i);
  });
});
