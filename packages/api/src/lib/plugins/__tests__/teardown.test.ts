/**
 * Tests for the shared per-workspace plugin teardown (#3681).
 *
 * `tearDownWorkspaceInstall` factors the credential + scheduled-task + hook +
 * loader-evict teardown out of `WorkspaceInstaller.uninstall` so the catalog
 * and marketplace uninstall routes run the SAME teardown. These tests pin the
 * orchestration order, the best-effort (never-throw) contract, and the
 * `invokeHook` / `deleteCredentials` toggles the datasource path relies on.
 *
 * The credential-store modules are `mock.module()`-shadowed (they are
 * lazy-`require`d by `deleteDedicatedCredentialStore`); the loader + registry
 * are injected as seams so the real `invokeOnUninstallHook` resolves the
 * fake candidates. ALL named exports of each shadowed module are provided.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { PluginLike } from "../registry";
import type { LazyPluginLoader } from "../lazy-loader";

// --- Credential-store mocks (lazy-required by deleteDedicatedCredentialStore) ---

const slackDeletes: string[] = [];
const credBundleDeletes: Array<{ workspaceId: string; catalogId: string }> = [];
const twentyDeletes: string[] = [];
const discordDeletes: string[] = [];

mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: async (teamId: string) => {
    slackDeletes.push(teamId);
  },
  saveInstallation: async () => {},
}));

mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  deleteCredentialBundle: async (workspaceId: string, catalogId: string) => {
    credBundleDeletes.push({ workspaceId, catalogId });
    return true;
  },
  saveCredentialBundle: async () => {},
  readCredentialBundle: async () => null,
}));

mock.module("@atlas/api/lib/integrations/twenty/store", () => ({
  deleteTwentyIntegration: async (workspaceId: string) => {
    twentyDeletes.push(workspaceId);
    return true;
  },
  saveTwentyIntegration: async () => null,
  getTwentyIntegrationPublic: async () => null,
  getTwentyIntegrationWithSecret: async () => null,
}));

mock.module("@atlas/api/lib/discord/store", () => ({
  getDiscordInstallation: async () => null,
  getDiscordInstallationByOrg: async () => null,
  saveDiscordInstallation: async () => {},
  deleteDiscordInstallation: async () => {},
  deleteDiscordInstallationByOrg: async (orgId: string) => {
    discordDeletes.push(orgId);
    return true;
  },
}));

import {
  tearDownWorkspaceInstall,
  deleteDedicatedCredentialStore,
  INTEGRATION_CREDENTIALS_SLUGS,
} from "../teardown";

// --- Loader / registry seams ---------------------------------------------

const evictCalls: Array<{ workspaceId: string; catalogId: string }> = [];

/** A loader with no lazy builder — the global-registry branch is exercised instead. */
function fakeLoader(): Pick<LazyPluginLoader, "hasBuilder" | "getOrInstantiate" | "evict"> {
  return {
    hasBuilder: () => false,
    getOrInstantiate: async () => {
      throw new Error("getOrInstantiate should not be called (no builder)");
    },
    evict: async (workspaceId: string, catalogId: string) => {
      evictCalls.push({ workspaceId, catalogId });
      return true;
    },
  };
}

/** A registry whose `get` returns a fake plugin (with an onUninstall spy) for `pluginId`. */
function fakeRegistry(pluginId: string, onUninstall: (workspaceId: string) => Promise<void>) {
  const plugin = { id: pluginId, onUninstall } as unknown as PluginLike;
  return {
    get: (id: string) => (id === pluginId ? plugin : undefined),
  };
}

/** A queryFn that records DELETE FROM scheduled_tasks calls and returns `rowCount` rows. */
function fakeQueryFn(opts?: { rowCount?: number; reject?: boolean }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fn = async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
    calls.push({ sql, params });
    if (opts?.reject) throw new Error("internal db unavailable");
    return Array.from({ length: opts?.rowCount ?? 0 }, (_, i) => ({ id: `task-${i}` })) as T[];
  };
  return { fn, calls };
}

beforeEach(() => {
  slackDeletes.length = 0;
  credBundleDeletes.length = 0;
  twentyDeletes.length = 0;
  discordDeletes.length = 0;
  evictCalls.length = 0;
});

describe("tearDownWorkspaceInstall", () => {
  test("runs hook + dedicated credentials + scheduled_tasks and returns a summary", async () => {
    const onUninstall = mock(async (_workspaceId: string) => {});
    const { fn, calls } = fakeQueryFn({ rowCount: 2 });

    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      catalogId: "cat:twenty",
      catalogSlug: "twenty",
      loader: fakeLoader(),
      registry: fakeRegistry("twenty", onUninstall),
      queryFn: fn,
    });

    // Hook ran against the right workspace and was reported as invoked.
    expect(onUninstall).toHaveBeenCalledWith("ws-1");
    expect(result.hookInvoked).toContain("twenty");
    expect(result.hookFailures).toEqual([]);
    // Dedicated credential store cleared (Twenty → twenty_integrations).
    expect(twentyDeletes).toEqual(["ws-1"]);
    expect(result.credentialStoreCleared).toBe(true);
    expect(result.credentialError).toBeUndefined();
    // scheduled_tasks scoped by (plugin_id = catalogId, org_id = workspaceId).
    const taskDelete = calls.find((c) => c.sql.includes("DELETE FROM scheduled_tasks"));
    expect(taskDelete).toBeDefined();
    expect(taskDelete!.params).toEqual(["cat:twenty", "ws-1"]);
    expect(result.scheduledTasksDeleted).toBe(2);
    // Loader evicted (inside the hook).
    expect(evictCalls).toEqual([{ workspaceId: "ws-1", catalogId: "cat:twenty" }]);
  });

  test("deleteCredentials:false retains the credential store (datasource archive)", async () => {
    const { fn } = fakeQueryFn({ rowCount: 1 });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      catalogId: "cat:twenty",
      catalogSlug: "twenty",
      loader: fakeLoader(),
      registry: fakeRegistry("none", async () => {}),
      queryFn: fn,
      deleteCredentials: false,
    });
    expect(twentyDeletes).toEqual([]);
    expect(result.credentialStoreCleared).toBe(false);
    // scheduled_tasks still cleaned.
    expect(result.scheduledTasksDeleted).toBe(1);
  });

  test("invokeHook:false skips the onUninstall hook (datasource path)", async () => {
    const onUninstall = mock(async (_workspaceId: string) => {});
    const { fn } = fakeQueryFn({ rowCount: 0 });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      catalogId: "cat:postgres",
      catalogSlug: "postgres",
      loader: fakeLoader(),
      registry: fakeRegistry("postgres", onUninstall),
      queryFn: fn,
      invokeHook: false,
      deleteCredentials: false,
    });
    expect(onUninstall).not.toHaveBeenCalled();
    expect(result.hookInvoked).toEqual([]);
    expect(evictCalls).toEqual([]);
  });

  test("best-effort: a credential-store throw is captured, scheduled_tasks still runs", async () => {
    const { fn } = fakeQueryFn({ rowCount: 3 });
    // Slack with no team_id throws inside deleteDedicatedCredentialStore.
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      catalogId: "cat:slack",
      catalogSlug: "slack",
      teamId: null,
      loader: fakeLoader(),
      registry: fakeRegistry("none", async () => {}),
      queryFn: fn,
    });
    expect(result.credentialStoreCleared).toBe(false);
    expect(result.credentialError).toMatch(/team_id/);
    // The throw did NOT abort the teardown — scheduled_tasks still ran.
    expect(result.scheduledTasksDeleted).toBe(3);
    expect(slackDeletes).toEqual([]);
  });

  test("best-effort: a scheduled_tasks failure is captured, never thrown", async () => {
    const { fn } = fakeQueryFn({ reject: true });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      catalogId: "cat:email",
      catalogSlug: "email",
      loader: fakeLoader(),
      registry: fakeRegistry("none", async () => {}),
      queryFn: fn,
    });
    expect(result.scheduledTasksDeleted).toBe(0);
    expect(result.scheduledTasksError).toMatch(/internal db unavailable/);
    // Form slug → no dedicated credential store, but the call did not throw.
    expect(result.credentialStoreCleared).toBe(true);
  });
});

describe("deleteDedicatedCredentialStore", () => {
  test("Slack → deletes the slack installation by team_id", async () => {
    await deleteDedicatedCredentialStore("slack", "ws-1", "cat:slack", "T123");
    expect(slackDeletes).toEqual(["T123"]);
  });

  test("Slack without team_id throws (corrupted row is not a silent no-op)", async () => {
    await expect(
      deleteDedicatedCredentialStore("slack", "ws-1", "cat:slack", null),
    ).rejects.toThrow(/team_id/);
  });

  test("integration_credentials slugs → delete the credential bundle", async () => {
    for (const slug of INTEGRATION_CREDENTIALS_SLUGS) {
      await deleteDedicatedCredentialStore(slug, "ws-1", `cat:${slug}`, null);
    }
    expect(credBundleDeletes).toEqual(
      [...INTEGRATION_CREDENTIALS_SLUGS].map((slug) => ({ workspaceId: "ws-1", catalogId: `cat:${slug}` })),
    );
  });

  test("Twenty → deletes the twenty_integrations row", async () => {
    await deleteDedicatedCredentialStore("twenty", "ws-1", "cat:twenty", null);
    expect(twentyDeletes).toEqual(["ws-1"]);
  });

  test("Discord → deletes the discord_installations row by org", async () => {
    await deleteDedicatedCredentialStore("discord", "ws-1", "cat:discord", null);
    expect(discordDeletes).toEqual(["ws-1"]);
  });

  test("form / static-bot slug → no dedicated store (no-op)", async () => {
    await deleteDedicatedCredentialStore("email", "ws-1", "cat:email", null);
    await deleteDedicatedCredentialStore("telegram", "ws-1", "cat:telegram", "T999");
    expect(slackDeletes).toEqual([]);
    expect(credBundleDeletes).toEqual([]);
    expect(twentyDeletes).toEqual([]);
    expect(discordDeletes).toEqual([]);
  });

  test("INTEGRATION_CREDENTIALS_SLUGS contains the OAuth credential-bearing slugs", () => {
    expect(INTEGRATION_CREDENTIALS_SLUGS.has("salesforce")).toBe(true);
    expect(INTEGRATION_CREDENTIALS_SLUGS.has("jira")).toBe(true);
    expect(INTEGRATION_CREDENTIALS_SLUGS.has("linear")).toBe(true);
    // API-key Linear keeps creds inline → NOT in the dedicated-store set.
    expect(INTEGRATION_CREDENTIALS_SLUGS.has("linear-apikey")).toBe(false);
  });
});
