/**
 * Tests for the Salesforce LazyPluginLoader builder (#2658).
 *
 * Coverage:
 *   - Happy path: reads workspace config + credentials, constructs a
 *     jsforce client, exposes `query(soql)`.
 *   - workspace_plugins.config.status='reconnect_needed' short-circuits
 *     to SalesforceReconnectRequiredError without reading credentials.
 *   - Missing credentials row → clear error message.
 *   - INVALID_SESSION_ID during query → refresh + retry path runs.
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

const mockRefreshSalesforceToken: Mock<(args: unknown) => Promise<unknown>> = mock(() =>
  Promise.resolve({
    accessToken: "refreshed-access-token",
    refreshToken: "refresh-token",
    expiresAt: null,
    tokenType: "Bearer",
    scope: "api refresh_token offline_access",
    instanceUrl: "https://na139.my.salesforce.com",
  }),
);
class TestSalesforceReconnectRequiredError extends Error {
  readonly _tag = "SalesforceReconnectRequiredError" as const;
  readonly workspaceId: string;
  readonly upstreamError: string;
  constructor(args: { workspaceId: string; upstreamError: string }) {
    super(`reconnect_needed: ${args.upstreamError}`);
    this.workspaceId = args.workspaceId;
    this.upstreamError = args.upstreamError;
  }
}
mock.module("@atlas/api/lib/integrations/install/salesforce-token-refresh", () => ({
  refreshSalesforceToken: mockRefreshSalesforceToken,
  SalesforceReconnectRequiredError: TestSalesforceReconnectRequiredError,
  SALESFORCE_SLUG: "salesforce",
  SALESFORCE_CATALOG_ID: "catalog:salesforce",
}));

// Mock jsforce so the test never touches a real network. Tracks the
// last-constructed Connection's args so assertions can inspect them.
const mockJsforceQuery: Mock<(soql: string) => Promise<{ records?: Record<string, unknown>[] }>> =
  mock(() => Promise.resolve({ records: [] }));
let lastConnectionArgs: unknown = null;
class MockJsforceConnection {
  constructor(args: unknown) {
    lastConnectionArgs = args;
  }
  query = mockJsforceQuery;
}
mock.module("jsforce", () => ({
  default: { Connection: MockJsforceConnection },
  Connection: MockJsforceConnection,
}));

// Track lazyPluginLoader.evict calls so we can verify the
// reconnect-needed cache eviction wire (the production code calls
// evict in withRetry when the refresh permanently fails).
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

type BuilderMod = typeof import("../lazy-builder");
type SalesforcePluginInstance = import("../lazy-builder").SalesforcePluginInstance;
let builderMod!: BuilderMod;

beforeAll(async () => {
  builderMod = await import("../lazy-builder");
});

const WSID = "ws-sf-lazy-test";
const CATALOG_ID = "catalog:salesforce";

const HAPPY_BUNDLE = {
  accessToken: "access-token-from-bundle",
  refreshToken: "refresh-token",
  expiresAt: null,
  tokenType: "Bearer",
  scope: "api refresh_token offline_access",
  instanceUrl: "https://na139.my.salesforce.com",
};

const BUILDER_CONFIG = {
  clientId: "sf-client-id",
  clientSecret: "sf-client-secret",
};

beforeEach(() => {
  mockReadCredentialBundle.mockClear();
  mockRefreshSalesforceToken.mockClear();
  mockJsforceQuery.mockClear();
  lastConnectionArgs = null;
});

afterEach(() => {
  // nothing to restore (no env / global state mutated)
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createSalesforceLazyBuilder — happy path", () => {
  it("reads credentials, constructs a Connection in OAuth-token mode, and exposes query()", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockJsforceQuery.mockResolvedValueOnce({
      records: [
        { attributes: { type: "Account" }, Id: "001x000000", Name: "Acme Corp" },
        { attributes: { type: "Account" }, Id: "001x000001", Name: "Globex" },
      ],
    });

    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
    })) as SalesforcePluginInstance;

    expect(instance.id).toBe(`salesforce:${WSID}`);
    expect(lastConnectionArgs).toEqual({
      instanceUrl: "https://na139.my.salesforce.com",
      accessToken: "access-token-from-bundle",
    });

    const result = await instance.query("SELECT Id, Name FROM Account");
    expect(result.columns).toEqual(["Id", "Name"]);
    expect(result.rows).toEqual([
      { Id: "001x000000", Name: "Acme Corp" },
      { Id: "001x000001", Name: "Globex" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// reconnect_needed short-circuit
// ---------------------------------------------------------------------------

describe("createSalesforceLazyBuilder — reconnect_needed", () => {
  it("refuses to instantiate when workspace_plugins.config.status is reconnect_needed", async () => {
    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);

    await expect(
      build({
        workspaceId: WSID,
        catalogId: CATALOG_ID,
        config: { instance_url: "https://na139.my.salesforce.com", status: "reconnect_needed" },
      }),
    ).rejects.toMatchObject({
      _tag: "SalesforceReconnectRequiredError",
      upstreamError: "install_marked_reconnect_needed",
    });

    expect(mockReadCredentialBundle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Missing credentials
// ---------------------------------------------------------------------------

describe("createSalesforceLazyBuilder — missing credentials", () => {
  it("throws a clear error when integration_credentials has no row", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(null);

    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);

    await expect(
      build({
        workspaceId: WSID,
        catalogId: CATALOG_ID,
        config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
      }),
    ).rejects.toThrow("integration_credentials row is missing");
  });
});

// ---------------------------------------------------------------------------
// Session-expired retry path
// ---------------------------------------------------------------------------

describe("createSalesforceLazyBuilder — session retry", () => {
  it("on INVALID_SESSION_ID, refreshes the token and retries the query once", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);

    let queryCalls = 0;
    mockJsforceQuery.mockImplementation((_soql: string) => {
      queryCalls++;
      if (queryCalls === 1) {
        return Promise.reject(new Error("INVALID_SESSION_ID: Session expired or invalid"));
      }
      return Promise.resolve({
        records: [{ attributes: { type: "Account" }, Id: "001x000999", Name: "Retry Co" }],
      });
    });

    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
    })) as SalesforcePluginInstance;

    const result = await instance.query("SELECT Id, Name FROM Account");

    expect(result.rows).toEqual([{ Id: "001x000999", Name: "Retry Co" }]);
    expect(mockRefreshSalesforceToken).toHaveBeenCalledTimes(1);
    expect(mockRefreshSalesforceToken).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WSID, clientId: "sf-client-id" }),
    );
    // After the refresh the rebuilt Connection should carry the new token.
    expect(lastConnectionArgs).toEqual({
      instanceUrl: "https://na139.my.salesforce.com",
      accessToken: "refreshed-access-token",
    });
  });

  it("propagates SalesforceReconnectRequiredError when the refresh fails permanently AND evicts the cached instance", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockJsforceQuery.mockRejectedValueOnce(new Error("INVALID_SESSION_ID"));
    mockRefreshSalesforceToken.mockRejectedValueOnce(
      new TestSalesforceReconnectRequiredError({
        workspaceId: WSID,
        upstreamError: "invalid_grant",
      }),
    );
    mockEvict.mockClear();

    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
    })) as SalesforcePluginInstance;

    await expect(instance.query("SELECT Id FROM Account")).rejects.toMatchObject({
      _tag: "SalesforceReconnectRequiredError",
      upstreamError: "invalid_grant",
    });

    // Critical wire: without the evict call, the cached instance with
    // a stale access token would loop on every subsequent tool call
    // until process restart. The docblock at the top of lazy-builder.ts
    // promises this happens; this test pins it.
    expect(mockEvict).toHaveBeenCalledWith(WSID, CATALOG_ID);
    expect(mockEvict).toHaveBeenCalledTimes(1);
  });

  it("does NOT evict the cache on a transient refresh failure (network blip, 5xx)", async () => {
    // Symmetric to the above — a plain Error from refresh is treated as
    // transient. Evicting on every transient failure would defeat the
    // cache's purpose (a flaky network would force re-build per call).
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockJsforceQuery.mockRejectedValueOnce(new Error("INVALID_SESSION_ID"));
    mockRefreshSalesforceToken.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockEvict.mockClear();

    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
    })) as SalesforcePluginInstance;

    await expect(instance.query("SELECT Id FROM Account")).rejects.toThrow("ECONNRESET");
    expect(mockEvict).not.toHaveBeenCalled();
  });
});
