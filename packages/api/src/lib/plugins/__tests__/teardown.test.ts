/**
 * Tests for the shared per-workspace plugin teardown (#3681).
 *
 * `tearDownWorkspaceInstall` factors the credential + scheduled-task + hook +
 * loader-evict teardown out of `WorkspaceInstaller.uninstall` so the catalog
 * and marketplace uninstall routes run the SAME teardown. These tests pin the
 * orchestration order, the best-effort (never-throw) contract, and the
 * `invokeHook` / `deleteCredentials` toggles the datasource path relies on.
 *
 * #4353 — the orchestrator also owns identity resolution now: it accepts a
 * bare `installationId` (folded in from the retired hook-only
 * `invokeOnUninstallHookForInstallRow` shim) as well as a resolved
 * `(catalogId, catalogSlug)`. The second describe block pins that BOTH forms
 * run all three steps, so no entry point can run the hook alone again.
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

void mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: async (teamId: string) => {
    slackDeletes.push(teamId);
  },
  saveInstallation: async () => {},
}));

void mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  deleteCredentialBundle: async (workspaceId: string, catalogId: string) => {
    credBundleDeletes.push({ workspaceId, catalogId });
    return true;
  },
  saveCredentialBundle: async () => {},
  readCredentialBundle: async () => null,
}));

void mock.module("@atlas/api/lib/integrations/twenty/store", () => ({
  deleteTwentyIntegration: async (workspaceId: string) => {
    twentyDeletes.push(workspaceId);
    return true;
  },
  saveTwentyIntegration: async () => null,
  getTwentyIntegrationPublic: async () => null,
  getTwentyIntegrationWithSecret: async () => null,
}));

void mock.module("@atlas/api/lib/discord/store", () => ({
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

/**
 * A queryFn covering BOTH statements the orchestrator can issue: the
 * `installationId` identity lookup (`SELECT … FROM workspace_plugins`) and the
 * `DELETE FROM scheduled_tasks` cleanup. `installRow` (when given) is what the
 * lookup resolves to; the task DELETE returns `rowCount` rows.
 */
function fakeQueryFn(opts?: {
  rowCount?: number;
  reject?: boolean;
  rejectLookup?: boolean;
  installRow?: { catalog_id: string; slug: string | null; team_id: string | null } | null;
}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fn = async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("FROM workspace_plugins")) {
      if (opts?.rejectLookup) throw new Error("internal db unavailable (lookup)");
      return (opts?.installRow ? [opts.installRow] : []) as T[];
    }
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

// ── #4353 — one teardown contract ────────────────────────────────────────
//
// The retired `invokeOnUninstallHookForInstallRow` shim resolved
// `(catalog_id, slug)` from an installation id and then ran the hook ONLY:
// any route wired to it skipped dedicated-credential and scheduled-task
// teardown, silently re-opening the orphaned-credential class the orchestrator
// was built to close. These tests pin that the `installationId` identity form
// runs the SAME three steps as the `(catalogId, catalogSlug)` form.
describe("tearDownWorkspaceInstall — installationId identity form", () => {
  test("clears credentials AND scheduled_tasks regardless of entry point (#4353)", async () => {
    const byInstallation = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      installationId: "inst-1",
      loader: fakeLoader(),
      registry: fakeRegistry("twenty", async () => {}),
      queryFn: fakeQueryFn({
        rowCount: 2,
        installRow: { catalog_id: "cat:twenty", slug: "twenty", team_id: null },
      }).fn,
    });

    const twentyDeletesByInstallation = [...twentyDeletes];
    const evictsByInstallation = [...evictCalls];
    twentyDeletes.length = 0;
    evictCalls.length = 0;

    const byCatalog = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      catalogId: "cat:twenty",
      catalogSlug: "twenty",
      loader: fakeLoader(),
      registry: fakeRegistry("twenty", async () => {}),
      queryFn: fakeQueryFn({ rowCount: 2 }).fn,
    });

    // Identity resolved from the install row, and both forms agree.
    expect(byInstallation.identityResolved).toBe(true);
    expect(byInstallation.catalogId).toBe("cat:twenty");
    expect(byInstallation.catalogSlug).toBe("twenty");
    // Credentials cleared (twenty_integrations) on BOTH paths — the exact step
    // the hook-only shim skipped.
    expect(byInstallation.credentialStoreCleared).toBe(true);
    expect(byCatalog.credentialStoreCleared).toBe(true);
    expect(twentyDeletesByInstallation).toEqual(["ws-1"]);
    expect(twentyDeletes).toEqual(["ws-1"]); // byCatalog (array reset above)
    // scheduled_tasks cleared on BOTH paths.
    expect(byInstallation.scheduledTasksDeleted).toBe(2);
    expect(byCatalog.scheduledTasksDeleted).toBe(2);
    // Hook ran (and evicted the loader) on BOTH paths.
    expect(byInstallation.hookInvoked).toContain("twenty");
    expect(byCatalog.hookInvoked).toContain("twenty");
    expect(evictsByInstallation).toEqual([{ workspaceId: "ws-1", catalogId: "cat:twenty" }]);
    expect(evictCalls).toEqual([{ workspaceId: "ws-1", catalogId: "cat:twenty" }]);
  });

  test("resolves team_id from the install row so Slack credentials are cleared", async () => {
    // The shim's lookup never selected `team_id`, so a Slack disconnect routed
    // through it could not have cleared `slack_installations` at all.
    const { fn } = fakeQueryFn({
      rowCount: 0,
      installRow: { catalog_id: "cat:slack", slug: "slack", team_id: "T-77" },
    });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      installationId: "inst-slack",
      loader: fakeLoader(),
      registry: fakeRegistry("none", async () => {}),
      queryFn: fn,
    });
    expect(slackDeletes).toEqual(["T-77"]);
    expect(result.credentialStoreCleared).toBe(true);
    expect(result.credentialError).toBeUndefined();
  });

  test("scopes the identity lookup by (installationId, workspaceId)", async () => {
    const { fn, calls } = fakeQueryFn({
      installRow: { catalog_id: "cat:jira", slug: "jira", team_id: null },
    });
    await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      installationId: "inst-1",
      loader: fakeLoader(),
      registry: fakeRegistry("none", async () => {}),
      queryFn: fn,
    });
    const lookup = calls.find((c) => c.sql.includes("FROM workspace_plugins"));
    expect(lookup).toBeDefined();
    // Cross-workspace isolation: never resolve an install row by id alone.
    expect(lookup!.sql).toContain("wp.workspace_id = $2");
    expect(lookup!.params).toEqual(["inst-1", "ws-1"]);
  });

  test("a NULL catalog slug (raced catalog delete) still runs hook + scheduled_tasks", async () => {
    const { fn } = fakeQueryFn({
      rowCount: 4,
      installRow: { catalog_id: "cat:gone", slug: null, team_id: null },
    });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      installationId: "inst-1",
      loader: fakeLoader(),
      registry: fakeRegistry("cat:gone", async () => {}),
      queryFn: fn,
    });
    expect(result.catalogSlug).toBe("");
    expect(result.hookInvoked).toContain("cat:gone");
    expect(result.scheduledTasksDeleted).toBe(4);
    // No dedicated store matches "" → the switch no-ops without throwing.
    expect(result.credentialStoreCleared).toBe(true);
  });

  test("missing install row → identityResolved:false and no teardown step runs", async () => {
    const { fn, calls } = fakeQueryFn({ rowCount: 3, installRow: null });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      installationId: "missing",
      loader: fakeLoader(),
      registry: fakeRegistry("twenty", async () => {}),
      queryFn: fn,
    });
    expect(result.identityResolved).toBe(false);
    expect(result.identityError).toBeUndefined();
    expect(result.hookInvoked).toEqual([]);
    expect(twentyDeletes).toEqual([]);
    expect(result.scheduledTasksDeleted).toBe(0);
    // Only the lookup ran — no scheduled_tasks DELETE on the caller's 404 path.
    expect(calls.filter((c) => c.sql.includes("DELETE FROM scheduled_tasks"))).toEqual([]);
  });

  test("a lookup failure is captured in identityError, never thrown", async () => {
    const { fn } = fakeQueryFn({ rejectLookup: true });
    const result = await tearDownWorkspaceInstall({
      workspaceId: "ws-1",
      installationId: "inst-1",
      loader: fakeLoader(),
      registry: fakeRegistry("none", async () => {}),
      queryFn: fn,
    });
    expect(result.identityResolved).toBe(false);
    expect(result.identityError).toMatch(/internal db unavailable/);
    expect(result.hookFailures).toEqual([]);
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
