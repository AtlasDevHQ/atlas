/**
 * Tests for the Jira LazyPluginLoader builder (#2659).
 *
 * Coverage mirrors `../salesforce/__tests__/lazy-builder.test.ts`;
 * Jira-specific surface:
 *   - Cloud-aware base URL: the builder routes JQL searches to
 *     `https://api.atlassian.com/ex/jira/<cloudid>/rest/api/3/search`,
 *     not a per-tenant `instance_url` like Salesforce.
 *   - 401 from the Jira REST API (not `INVALID_SESSION_ID`) is the
 *     "session expired" signal.
 *   - On permanent refresh failure → cache eviction wire fires (same
 *     contract as Salesforce; shared IntegrationReconnectRequiredError).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

const mockReadCredentialBundle: Mock<(ws: string, cat: string) => Promise<unknown>> = mock(() =>
  Promise.resolve(null),
);
mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  readCredentialBundle: mockReadCredentialBundle,
  saveCredentialBundle: mock(() => Promise.resolve()),
  deleteCredentialBundle: mock(() => Promise.resolve(false)),
}));

const mockRefreshJiraToken: Mock<(args: unknown) => Promise<unknown>> = mock(() =>
  Promise.resolve({
    accessToken: "refreshed-access-token",
    refreshToken: "ROTATED-refresh-token",
    expiresAt: null,
    tokenType: "Bearer",
    scope: "read:jira-work read:jira-user offline_access",
    instanceUrl: "https://api.atlassian.com/ex/jira/CLOUD-1",
  }),
);

// Lightweight stand-in for the shared IntegrationReconnectRequiredError
// (#2708) — injected via the mocked token-refresh module so the builder's
// `instanceof reconnectErrorClass` eviction check matches without pulling
// the real effect/errors graph.
class TestReconnectError extends Error {
  readonly _tag = "IntegrationReconnectRequiredError" as const;
  readonly workspaceId: string;
  readonly platform: string;
  readonly upstreamError: string;
  constructor(args: { message?: string; workspaceId: string; platform: string; upstreamError: string }) {
    super(args.message ?? `reconnect_needed: ${args.upstreamError}`);
    this.workspaceId = args.workspaceId;
    this.platform = args.platform;
    this.upstreamError = args.upstreamError;
  }
}
mock.module("@atlas/api/lib/integrations/install/jira-token-refresh", () => ({
  refreshJiraToken: mockRefreshJiraToken,
  IntegrationReconnectRequiredError: TestReconnectError,
  // Deprecated alias still exported by the real module (#2708) — mock the
  // full export surface so the alias resolves to the same fake.
  JiraReconnectRequiredError: TestReconnectError,
  JIRA_SLUG: "jira",
  JIRA_CATALOG_ID: "catalog:jira",
}));

const mockEvict: Mock<(workspaceId: string, catalogId: string) => Promise<boolean>> = mock(() =>
  Promise.resolve(true),
);
mock.module("@atlas/api/lib/plugins/lazy-loader", () => ({
  lazyPluginLoader: {
    evict: mockEvict,
    hasBuilder: mock(() => false),
    registerBuilder: mock(() => undefined),
    unregisterBuilder: mock(() => true),
    size: mock(() => 0),
    getOrInstantiate: mock(() => Promise.resolve({} as unknown)),
  },
  LazyPluginLoader: class {},
  LazyPluginBuilderMissingError: class extends Error {},
  LazyPluginInstallNotFoundError: class extends Error {},
}));

const ORIGINAL_FETCH = globalThis.fetch;
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200 })),
);

type BuilderMod = typeof import("../lazy-builder");
type JiraPluginInstance = import("../lazy-builder").JiraPluginInstance;
let builderMod!: BuilderMod;

beforeAll(async () => {
  builderMod = await import("../lazy-builder");
});

const WSID = "ws-jira-lazy-test";
const CATALOG_ID = "catalog:jira";
const CLOUDID = "CLOUD-1";

const HAPPY_BUNDLE = {
  accessToken: "access-token-from-bundle",
  refreshToken: "refresh-token",
  expiresAt: null,
  tokenType: "Bearer",
  scope: "read:jira-work read:jira-user offline_access",
  instanceUrl: `https://api.atlassian.com/ex/jira/${CLOUDID}`,
};

const BUILDER_CONFIG = {
  clientId: "jira-client-id",
  clientSecret: "jira-client-secret",
};

beforeEach(() => {
  mockReadCredentialBundle.mockClear();
  mockRefreshJiraToken.mockClear();
  mockEvict.mockClear();
  mockFetch.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createJiraLazyBuilder — happy path", () => {
  it("reads credentials, posts JQL to the per-cloud REST endpoint, and shapes results into columns/rows", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [
              {
                key: "ATL-1",
                fields: {
                  summary: "Bug in login",
                  status: { name: "In Progress" },
                  assignee: { displayName: "Alice" },
                  priority: { name: "High" },
                  issuetype: { name: "Bug" },
                  created: "2026-01-01T00:00:00.000Z",
                  updated: "2026-02-01T00:00:00.000Z",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { cloudid: CLOUDID, status: "ok" },
    })) as JiraPluginInstance;

    expect(instance.id).toBe(`jira:${WSID}`);

    const result = await instance.queryJira("project = ATL");
    expect(result.columns).toEqual([
      "key",
      "summary",
      "status",
      "assignee",
      "priority",
      "issuetype",
      "created",
      "updated",
    ]);
    expect(result.rows).toEqual([
      {
        key: "ATL-1",
        summary: "Bug in login",
        status: "In Progress",
        assignee: "Alice",
        priority: "High",
        issuetype: "Bug",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-02-01T00:00:00.000Z",
      },
    ]);

    // Critical pin — the request hits the per-cloud REST endpoint, not
    // a generic api.atlassian.com URL. Without cloudid in the path the
    // request would 404 (or worse, hit another tenant if Atlassian
    // ever routed bare /rest/api/3 calls).
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.atlassian.com/ex/jira/${CLOUDID}/rest/api/3/search`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token-from-bundle",
    );
  });

  it("reconstructs the base URL from workspace_plugins.config.cloudid when the bundle's instanceUrl is empty (defensive)", async () => {
    // Defensive — shouldn't happen in practice, but a half-written
    // bundle from a pre-PR install path would otherwise crash.
    mockReadCredentialBundle.mockResolvedValueOnce({
      ...HAPPY_BUNDLE,
      instanceUrl: "",
    });
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ issues: [] }), { status: 200 })),
    );

    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { cloudid: "FALLBACK-CLOUD", status: "ok" },
    })) as JiraPluginInstance;

    await instance.queryJira("project = ATL");
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/FALLBACK-CLOUD/rest/api/3/search");
  });
});

// ---------------------------------------------------------------------------
// reconnect_needed short-circuit
// ---------------------------------------------------------------------------

describe("createJiraLazyBuilder — reconnect_needed", () => {
  it("refuses to instantiate when workspace_plugins.config.status is reconnect_needed", async () => {
    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);

    await expect(
      build({
        workspaceId: WSID,
        catalogId: CATALOG_ID,
        config: { cloudid: CLOUDID, status: "reconnect_needed" },
      }),
    ).rejects.toMatchObject({
      _tag: "IntegrationReconnectRequiredError",
      platform: "jira",
      upstreamError: "install_marked_reconnect_needed",
    });

    expect(mockReadCredentialBundle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Missing credentials
// ---------------------------------------------------------------------------

describe("createJiraLazyBuilder — missing credentials", () => {
  it("throws a clear error when integration_credentials has no row", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(null);

    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);

    await expect(
      build({
        workspaceId: WSID,
        catalogId: CATALOG_ID,
        config: { cloudid: CLOUDID, status: "ok" },
      }),
    ).rejects.toThrow("integration_credentials row is missing");
  });
});

// ---------------------------------------------------------------------------
// Session-expired retry path
// ---------------------------------------------------------------------------

describe("createJiraLazyBuilder — session retry", () => {
  it("on HTTP 401, refreshes the token and retries the query once", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);

    let calls = 0;
    mockFetch.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [{ key: "ATL-RETRY", fields: { summary: "after retry" } }],
          }),
          { status: 200 },
        ),
      );
    });

    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { cloudid: CLOUDID, status: "ok" },
    })) as JiraPluginInstance;

    const result = await instance.queryJira("project = ATL");

    expect(result.rows).toEqual([
      {
        key: "ATL-RETRY",
        summary: "after retry",
        status: undefined,
        assignee: undefined,
        priority: undefined,
        issuetype: undefined,
        created: undefined,
        updated: undefined,
      },
    ]);
    expect(mockRefreshJiraToken).toHaveBeenCalledTimes(1);
    expect(mockRefreshJiraToken).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WSID, clientId: "jira-client-id" }),
    );
    // After the refresh the retry request carries the new token.
    const [, retryInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer refreshed-access-token",
    );
  });

  it("propagates IntegrationReconnectRequiredError AND evicts the cached instance on permanent refresh failure", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    mockRefreshJiraToken.mockRejectedValueOnce(
      new TestReconnectError({
        workspaceId: WSID,
        platform: "jira",
        upstreamError: "invalid_grant",
      }),
    );

    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { cloudid: CLOUDID, status: "ok" },
    })) as JiraPluginInstance;

    await expect(instance.queryJira("project = ATL")).rejects.toMatchObject({
      _tag: "IntegrationReconnectRequiredError",
      platform: "jira",
      upstreamError: "invalid_grant",
    });

    // Without the evict call, the cached instance with a stale access
    // token would loop on every subsequent tool call until process
    // restart. The docblock at the top of lazy-builder.ts promises
    // this happens; this test pins it.
    expect(mockEvict).toHaveBeenCalledWith(WSID, CATALOG_ID);
    expect(mockEvict).toHaveBeenCalledTimes(1);
  });

  it("does NOT evict the cache on a transient refresh failure (network blip)", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    mockRefreshJiraToken.mockRejectedValueOnce(new Error("ECONNRESET"));

    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { cloudid: CLOUDID, status: "ok" },
    })) as JiraPluginInstance;

    await expect(instance.queryJira("project = ATL")).rejects.toThrow("ECONNRESET");
    expect(mockEvict).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onUninstall (#3188) — workspace-attributed webhook revocation
// ---------------------------------------------------------------------------

describe("createJiraLazyBuilder — onUninstall", () => {
  const WEBHOOK_URL = `https://api.atlassian.com/ex/jira/${CLOUDID}/rest/api/3/webhook`;

  async function buildInstance(): Promise<JiraPluginInstance> {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    const build = builderMod.createJiraLazyBuilder(BUILDER_CONFIG);
    return (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { cloudid: CLOUDID, status: "ok" },
    })) as JiraPluginInstance;
  }

  it("revokes ONLY webhooks whose callback URL carries this workspace's marker — never unattributable ones", async () => {
    const instance = await buildInstance();

    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            values: [
              // Attributable: Atlas marker for THIS workspace.
              { id: 1, url: `https://app.useatlas.dev/hooks/jira?atlas_workspace_id=${WSID}` },
              // Another workspace's marker — must survive.
              { id: 2, url: "https://app.useatlas.dev/hooks/jira?atlas_workspace_id=ws-other" },
              // No url field (out-of-band registration) — must survive.
              { id: 3 },
              // Unparseable callback URL — must survive (fail-closed).
              { id: 4, url: "not a url" },
              // No marker at all — must survive.
              { id: 5, url: "https://example.com/some-other-tooling" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response("{}", { status: 202 })),
    );

    await instance.onUninstall!(WSID);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toBe(WEBHOOK_URL);
    expect(listInit.method).toBe("GET");
    expect((listInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token-from-bundle",
    );
    const [deleteUrl, deleteInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(deleteUrl).toBe(WEBHOOK_URL);
    expect(deleteInit.method).toBe("DELETE");
    // The attribution gate: only id 1 — ids 2–5 are not ours to touch.
    expect(JSON.parse(String(deleteInit.body))).toEqual({ webhookIds: [1] });
  });

  it("issues NO delete when nothing is attributable to this workspace (zero-revocation is the correct outcome)", async () => {
    const instance = await buildInstance();

    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            values: [
              { id: 2, url: "https://app.useatlas.dev/hooks/jira?atlas_workspace_id=ws-other" },
              { id: 3 },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await instance.onUninstall!(WSID);

    // List only — no DELETE call follows.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns cleanly when the token cannot see the dynamic webhook API (403)", async () => {
    const instance = await buildInstance();
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response("{}", { status: 403 })),
    );
    await instance.onUninstall!(WSID);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on a failing list call so the host records the failure", async () => {
    const instance = await buildInstance();
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 500 })),
    );
    await expect(instance.onUninstall!(WSID)).rejects.toThrow(/HTTP 500/);
  });

  it("throws on a failing revocation so the host records the orphaned subscriptions", async () => {
    const instance = await buildInstance();
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            values: [
              { id: 7, url: `https://app.useatlas.dev/hooks/jira?atlas_workspace_id=${WSID}` },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response("{}", { status: 500 })),
    );
    await expect(instance.onUninstall!(WSID)).rejects.toThrow(/may still be delivering/);
  });

  it("refreshes the token and retries once when the list call 401s", async () => {
    const instance = await buildInstance();

    let calls = 0;
    mockFetch.mockImplementation((input: unknown) => {
      calls++;
      const url = String(input);
      if (calls === 1) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      if (url.endsWith("/rest/api/3/webhook") && calls === 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ values: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    await instance.onUninstall!(WSID);

    expect(mockRefreshJiraToken).toHaveBeenCalledTimes(1);
    // Retry carries the refreshed token.
    const [, retryInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer refreshed-access-token",
    );
  });
});

// ---------------------------------------------------------------------------
// isJiraWebhookAttributableToWorkspace — attribution gate unit pins
// ---------------------------------------------------------------------------

describe("isJiraWebhookAttributableToWorkspace", () => {
  it("attributes only an exact workspace-id marker match", () => {
    const fn = builderMod.isJiraWebhookAttributableToWorkspace;
    expect(fn(`https://x.dev/h?atlas_workspace_id=ws-1`, "ws-1")).toBe(true);
    expect(fn(`https://x.dev/h?other=1&atlas_workspace_id=ws-1`, "ws-1")).toBe(true);
    expect(fn(`https://x.dev/h?atlas_workspace_id=ws-2`, "ws-1")).toBe(false);
    expect(fn(`https://x.dev/h?atlas_workspace_id=ws-11`, "ws-1")).toBe(false);
    expect(fn("https://x.dev/h", "ws-1")).toBe(false);
  });

  it("fails closed on missing / non-string / unparseable URLs", () => {
    const fn = builderMod.isJiraWebhookAttributableToWorkspace;
    expect(fn(undefined, "ws-1")).toBe(false);
    expect(fn(null, "ws-1")).toBe(false);
    expect(fn(42, "ws-1")).toBe(false);
    expect(fn("", "ws-1")).toBe(false);
    expect(fn("not a url at all", "ws-1")).toBe(false);
  });
});
