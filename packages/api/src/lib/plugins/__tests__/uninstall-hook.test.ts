/**
 * Tests for the per-workspace `onUninstall` hook invocation (#3188).
 *
 * Everything injects fresh `LazyPluginLoader` / `PluginRegistry`
 * instances via the helper's test seams — no process-wide singleton
 * mutation, no `mock.module()`. The DB lookup variant injects `queryFn`.
 */

import { describe, expect, it } from "bun:test";

import { LazyPluginLoader } from "../lazy-loader";
import { PluginRegistry, type PluginLike } from "../registry";
import {
  invokeOnUninstallHook,
  invokeOnUninstallHookForInstallRow,
} from "../uninstall-hook";

const WSID = "ws-hook-test";
const CATALOG_ID = "catalog:jira";

function makePlugin(
  id: string,
  onUninstall?: PluginLike["onUninstall"],
): PluginLike {
  return {
    id,
    types: ["action"] as const,
    version: "1.0.0",
    ...(onUninstall ? { onUninstall } : {}),
  };
}

/** A loader stub with no builders — `hasBuilder` is always false. */
function emptyLoader(): LazyPluginLoader {
  return new LazyPluginLoader();
}

/**
 * Structural loader stub recording `evict` calls — the helper depends on
 * `hasBuilder` + `getOrInstantiate` + `evict` only.
 */
function makeStubLoader(args: {
  hasBuilder?: (catalogId: string) => boolean;
  getOrInstantiate?: (workspaceId: string, catalogId: string) => Promise<PluginLike>;
  evict?: (workspaceId: string, catalogId: string) => Promise<boolean>;
}) {
  const evictCalls: Array<{ workspaceId: string; catalogId: string }> = [];
  return {
    evictCalls,
    loader: {
      hasBuilder: args.hasBuilder ?? (() => false),
      getOrInstantiate:
        args.getOrInstantiate ??
        (async (): Promise<PluginLike> => {
          throw new Error("getOrInstantiate not stubbed");
        }),
      evict:
        args.evict ??
        (async (workspaceId: string, catalogId: string) => {
          evictCalls.push({ workspaceId, catalogId });
          return true;
        }),
    },
  };
}

describe("invokeOnUninstallHook — lazy per-workspace instance", () => {
  it("invokes the hook with the right workspaceId on the lazy-built instance", async () => {
    const calls: string[] = [];
    // The real loader's getOrInstantiate reads workspace_plugins.config
    // from the internal DB, so the lazy surface is stubbed structurally —
    // the helper only depends on `hasBuilder` + `getOrInstantiate` + `evict`.
    const { loader: stubLoader } = makeStubLoader({
      hasBuilder: (catalogId: string) => catalogId === CATALOG_ID,
      getOrInstantiate: async (workspaceId: string, _catalogId: string) =>
        makePlugin("jira:ws", async (wid) => {
          calls.push(`${workspaceId}:${wid}`);
        }),
    });

    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
    });

    expect(calls).toEqual([`${WSID}:${WSID}`]);
    expect(result.invoked).toEqual(["jira:ws"]);
    expect(result.failures).toEqual([]);
  });

  it("skips cleanly when the lazy instance has no onUninstall", async () => {
    const { loader: stubLoader } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async () => makePlugin("jira:ws"),
    });
    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
    });
    expect(result.invoked).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("logs + continues when the lazy build throws (uninstall must proceed)", async () => {
    const { loader: stubLoader } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async (): Promise<PluginLike> => {
        throw new Error("integration_credentials row missing");
      },
    });
    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
    });
    expect(result.invoked).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain("integration_credentials row missing");
  });

  it("a throwing hook is captured as a failure, not propagated", async () => {
    const { loader: stubLoader } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async () =>
        makePlugin("jira:ws", async () => {
          throw new Error("Jira API returned HTTP 500");
        }),
    });
    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
    });
    expect(result.invoked).toEqual([]);
    expect(result.failures).toEqual([
      { pluginId: "jira:ws", error: "Jira API returned HTTP 500" },
    ]);
  });

  it("a hook that never resolves is recorded as a timeout failure within the deadline", async () => {
    const { loader: stubLoader } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async () =>
        makePlugin("jira:ws", () => new Promise<void>(() => {
          // never settles — simulates a hung revocation HTTP call
        })),
    });

    const started = Date.now();
    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
      // Short injected deadline — the production default is
      // ON_UNINSTALL_HOOK_TIMEOUT_MS; tests must not wait 15s.
      hookTimeoutMs: 25,
    });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.invoked).toEqual([]);
    expect(result.failures).toEqual([
      { pluginId: "jira:ws", error: "onUninstall timed out after 25ms" },
    ]);
  });

  it("evicts the lazy loader entry after the hooks ran (marketplace route must not leak a warmed instance)", async () => {
    const { loader: stubLoader, evictCalls } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async () => makePlugin("jira:ws", async () => undefined),
    });

    await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
    });

    expect(evictCalls).toEqual([{ workspaceId: WSID, catalogId: CATALOG_ID }]);
  });

  it("a throwing evict is logged, never propagated, and does not pollute the summary", async () => {
    const { loader: stubLoader } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async () => makePlugin("jira:ws", async () => undefined),
      evict: async () => {
        throw new Error("teardown exploded");
      },
    });

    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: stubLoader,
      registry: new PluginRegistry(),
    });

    expect(result.invoked).toEqual(["jira:ws"]);
    expect(result.failures).toEqual([]);
  });
});

describe("invokeOnUninstallHook — globally-registered plugins", () => {
  it("resolves a global plugin by exact slug id", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register(makePlugin("jira", async (wid) => {
        calls.push(wid);
      }));

    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: emptyLoader(),
      registry,
    });
    expect(calls).toEqual([WSID]);
    expect(result.invoked).toEqual(["jira"]);
  });

  it("resolves a global plugin by the <slug>-<type> convention (jira → jira-action)", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register(makePlugin("jira-action", async (wid) => {
        calls.push(wid);
      }));

    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: emptyLoader(),
      registry,
    });
    expect(calls).toEqual([WSID]);
    expect(result.invoked).toEqual(["jira-action"]);
  });

  it("does NOT prefix-match unrelated plugins (email must not resolve email-digest)", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register(makePlugin("email-digest", async (wid) => {
        calls.push(wid);
      }));

    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: "catalog:email",
      catalogSlug: "email",
      loader: emptyLoader(),
      registry,
    });
    expect(calls).toEqual([]);
    expect(result.invoked).toEqual([]);
  });

  it("skips cleanly when no plugin matches at all", async () => {
    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: "catalog:unknown",
      catalogSlug: "unknown",
      loader: emptyLoader(),
      registry: new PluginRegistry(),
    });
    expect(result.invoked).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("invokes each instance at most once when slug and catalogId resolve the same plugin", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    // Registered under the catalog id itself — also matched via the
    // catalogId candidate; must still be invoked exactly once.
    registry.register(makePlugin(CATALOG_ID, async (wid) => {
        calls.push(wid);
      }));

    const result = await invokeOnUninstallHook({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      catalogSlug: "jira",
      loader: emptyLoader(),
      registry,
    });
    expect(calls).toEqual([WSID]);
    expect(result.invoked).toEqual([CATALOG_ID]);
  });
});

describe("invokeOnUninstallHookForInstallRow", () => {
  it("looks up (catalogId, slug) from the install row, then invokes the hook", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register(makePlugin("jira-action", async (wid) => {
        calls.push(wid);
      }));

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const queryFn = async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
      queries.push({ sql, params });
      return [{ catalog_id: CATALOG_ID, slug: "jira" }] as T[];
    };

    const result = await invokeOnUninstallHookForInstallRow({
      workspaceId: WSID,
      installationId: "inst-1",
      queryFn,
      loader: emptyLoader(),
      registry,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual(["inst-1", WSID]);
    expect(calls).toEqual([WSID]);
    expect(result.invoked).toEqual(["jira-action"]);
  });

  it("returns empty result when the install row is missing (route 404 path)", async () => {
    const result = await invokeOnUninstallHookForInstallRow({
      workspaceId: WSID,
      installationId: "missing",
      queryFn: async () => [],
      loader: emptyLoader(),
      registry: new PluginRegistry(),
    });
    expect(result.invoked).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("never throws when the lookup query rejects — and reports the failure (distinguishable from nothing-to-do)", async () => {
    const result = await invokeOnUninstallHookForInstallRow({
      workspaceId: WSID,
      installationId: "inst-1",
      queryFn: async () => {
        throw new Error("internal DB unavailable");
      },
      loader: emptyLoader(),
      registry: new PluginRegistry(),
    });
    expect(result.invoked).toEqual([]);
    // Keyed by the installation id — no plugin id was ever resolved.
    expect(result.failures).toEqual([
      { pluginId: "inst-1", error: "internal DB unavailable" },
    ]);
  });

  it("evicts the lazy loader entry on the install-row (marketplace route) path too", async () => {
    const { loader: stubLoader, evictCalls } = makeStubLoader({
      hasBuilder: () => true,
      getOrInstantiate: async () => makePlugin("jira:ws", async () => undefined),
    });

    await invokeOnUninstallHookForInstallRow({
      workspaceId: WSID,
      installationId: "inst-1",
      queryFn: async <T = unknown>(): Promise<T[]> =>
        [{ catalog_id: CATALOG_ID, slug: "jira" }] as T[],
      loader: stubLoader,
      registry: new PluginRegistry(),
    });

    expect(evictCalls).toEqual([{ workspaceId: WSID, catalogId: CATALOG_ID }]);
  });
});
