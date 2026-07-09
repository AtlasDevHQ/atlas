/**
 * Tests for the Salesforce LazyPluginLoader builder (#2658).
 *
 * Coverage:
 *   - Happy path: reads workspace config + credentials, constructs a
 *     jsforce client, exposes `query(soql)`.
 *   - workspace_plugins.config.status='reconnect_needed' short-circuits
 *     to IntegrationReconnectRequiredError without reading credentials.
 *   - Missing credentials row → clear error message.
 *   - INVALID_SESSION_ID during query → refresh + retry path runs.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

const mockReadCredentialBundle: Mock<(ws: string, cat: string) => Promise<unknown>> = mock(() =>
  Promise.resolve(null),
);
void mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
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
void mock.module("@atlas/api/lib/integrations/install/salesforce-token-refresh", () => ({
  refreshSalesforceToken: mockRefreshSalesforceToken,
  IntegrationReconnectRequiredError: TestReconnectError,
  // Deprecated alias still exported by the real module (#2708) — mock the
  // full export surface so the alias resolves to the same fake.
  SalesforceReconnectRequiredError: TestReconnectError,
  SALESFORCE_SLUG: "salesforce",
  SALESFORCE_CATALOG_ID: "catalog:salesforce",
}));

// Mock jsforce so the test never touches a real network. Tracks the
// last-constructed Connection's args so assertions can inspect them.
const mockJsforceQuery: Mock<
  (soql: string) => Promise<{ records?: Record<string, unknown>[]; done?: boolean; nextRecordsUrl?: string | null }>
> = mock(() => Promise.resolve({ records: [] }));
const mockJsforceQueryMore: Mock<
  (url: string) => Promise<{ records?: Record<string, unknown>[]; done?: boolean; nextRecordsUrl?: string | null }>
> = mock(() => Promise.resolve({ records: [], done: true }));
const mockDescribeGlobal: Mock<() => Promise<{ sobjects?: { name?: string; queryable?: boolean }[] }>> =
  mock(() => Promise.resolve({ sobjects: [] }));
const mockDescribe: Mock<(name: string) => Promise<{ fields?: Record<string, unknown>[] }>> =
  mock(() => Promise.resolve({ fields: [] }));
let lastConnectionArgs: unknown = null;
class MockJsforceConnection {
  constructor(args: unknown) {
    lastConnectionArgs = args;
  }
  query = mockJsforceQuery;
  queryMore = mockJsforceQueryMore;
  describeGlobal = mockDescribeGlobal;
  describe = mockDescribe;
}
void mock.module("jsforce", () => ({
  default: { Connection: MockJsforceConnection },
  Connection: MockJsforceConnection,
}));

// Track lazyPluginLoader.evict calls so we can verify the
// reconnect-needed cache eviction wire (the production code calls
// evict in withRetry when the refresh permanently fails).
const mockEvict: Mock<(workspaceId: string, catalogId: string) => Promise<boolean>> = mock(() =>
  Promise.resolve(true),
);
void mock.module("@atlas/api/lib/plugins/lazy-loader", () => ({
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
  mockJsforceQueryMore.mockClear();
  mockDescribeGlobal.mockClear();
  mockDescribe.mockClear();
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
// #3667 — introspection as a capability of the live OAuth connection
// ---------------------------------------------------------------------------

describe("createSalesforceLazyBuilder — OAuth introspection (#3667)", () => {
  async function buildInstance(): Promise<SalesforcePluginInstance> {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);
    return (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
    })) as SalesforcePluginInstance;
  }

  it("listObjects() enumerates the queryable SObjects over the OAuth session", async () => {
    mockDescribeGlobal.mockResolvedValueOnce({
      sobjects: [
        { name: "Account", queryable: true },
        { name: "Contact", queryable: true },
        { name: "ApexClass", queryable: false }, // not queryable → filtered
      ],
    });
    const instance = await buildInstance();
    const objects = await instance.listObjects();
    expect(objects).toEqual([
      { name: "Account", type: "table" },
      { name: "Contact", type: "table" },
    ]);
  });

  it("profile() maps describe metadata → column profiles (Id PK, reference FK, picklist enum) end-to-end", async () => {
    mockDescribeGlobal.mockResolvedValueOnce({ sobjects: [{ name: "Account", queryable: true }] });
    mockDescribe.mockResolvedValueOnce({
      fields: [
        { name: "Id", type: "id", nillable: false },
        { name: "Name", type: "string", nillable: true },
        { name: "OwnerId", type: "reference", nillable: true, referenceTo: ["User"] },
        {
          name: "Industry",
          type: "picklist",
          nillable: true,
          picklistValues: [
            { value: "Tech", active: true },
            { value: "Retired", active: false },
          ],
        },
      ],
    });
    // SELECT COUNT(Id) → Salesforce returns { expr0: N }.
    mockJsforceQuery.mockResolvedValueOnce({ records: [{ expr0: 42 }] });

    const instance = await buildInstance();
    const result = await instance.profile();

    expect(result.profiles).toHaveLength(1);
    const p = result.profiles[0];
    expect(p.table_name).toBe("Account");
    expect(p.row_count).toBe(42);
    expect(p.primary_key_columns).toEqual(["Id"]);
    // reference field → foreign key to the referenced SObject's Id.
    expect(p.foreign_keys).toEqual([
      { from_column: "OwnerId", to_table: "User", to_column: "Id", source: "constraint" },
    ]);
    // picklist → enum-like, active values only.
    const industry = p.columns.find((c) => c.name === "Industry");
    expect(industry?.is_enum_like).toBe(true);
    expect(industry?.sample_values).toEqual(["Tech"]);
  });

  it("a mid-profile INVALID_SESSION_ID refreshes the token once and retries (no silent failure)", async () => {
    mockDescribeGlobal.mockResolvedValueOnce({ sobjects: [{ name: "Account", queryable: true }] });
    // First describe throws INVALID_SESSION_ID → the retry harness refreshes and
    // retries; the second describe succeeds.
    mockDescribe
      .mockRejectedValueOnce(new Error("INVALID_SESSION_ID: Session expired or invalid"))
      .mockResolvedValueOnce({ fields: [{ name: "Id", type: "id", nillable: false }] });
    mockJsforceQuery.mockResolvedValueOnce({ records: [{ expr0: 1 }] });

    const instance = await buildInstance();
    const result = await instance.profile();

    expect(mockRefreshSalesforceToken).toHaveBeenCalledTimes(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].table_name).toBe("Account");
  });
});

// ---------------------------------------------------------------------------
// #4397 — raw paged SOQL + describeObject (the Knowledge sync surface)
// ---------------------------------------------------------------------------

describe("createSalesforceLazyBuilder — paged query surface (#4397)", () => {
  async function buildInstance(): Promise<SalesforcePluginInstance> {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    const build = builderMod.createSalesforceLazyBuilder(BUILDER_CONFIG);
    return (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: { instance_url: "https://na139.my.salesforce.com", status: "ok" },
    })) as SalesforcePluginInstance;
  }

  it("queryPage keeps jsforce's paging bookkeeping (done + nextRecordsUrl) intact", async () => {
    mockJsforceQuery.mockResolvedValueOnce({
      records: [{ attributes: { type: "Knowledge__kav" }, Id: "ka0x001" }],
      done: false,
      nextRecordsUrl: "/services/data/v60.0/query/01gxx-2000",
    });
    const instance = await buildInstance();
    const page = await instance.queryPage("SELECT Id FROM Knowledge__kav WHERE PublishStatus = 'Online'");
    expect(page.records).toHaveLength(1);
    expect(page.done).toBe(false);
    expect(page.nextRecordsUrl).toBe("/services/data/v60.0/query/01gxx-2000");
  });

  it("queryMorePage continues from the locator", async () => {
    mockJsforceQueryMore.mockResolvedValueOnce({
      records: [{ Id: "ka0x002" }],
      done: true,
      nextRecordsUrl: null,
    });
    const instance = await buildInstance();
    const page = await instance.queryMorePage("/services/data/v60.0/query/01gxx-2000");
    expect(page.records).toEqual([{ Id: "ka0x002" }]);
    expect(page.done).toBe(true);
    expect(mockJsforceQueryMore).toHaveBeenCalledWith("/services/data/v60.0/query/01gxx-2000");
  });

  it("treats a done:false response with no locator as done (cannot continue)", async () => {
    mockJsforceQuery.mockResolvedValueOnce({ records: [], done: false });
    const instance = await buildInstance();
    const page = await instance.queryPage("SELECT Id FROM Knowledge__kav WHERE PublishStatus = 'Online'");
    expect(page.done).toBe(true);
    expect(page.nextRecordsUrl).toBeNull();
  });

  it("describeObject exposes the object's field metadata over the OAuth session", async () => {
    mockDescribe.mockResolvedValueOnce({
      fields: [{ name: "Id", type: "id" }, { name: "Body__c", type: "textarea", custom: true }],
    });
    const instance = await buildInstance();
    const described = await instance.describeObject("Knowledge__kav");
    expect(described.fields.map((f) => f.name)).toEqual(["Id", "Body__c"]);
    expect(mockDescribe).toHaveBeenCalledWith("Knowledge__kav");
  });

  it("refresh-retries a paged query on INVALID_SESSION_ID like query()", async () => {
    mockJsforceQuery
      .mockRejectedValueOnce(new Error("INVALID_SESSION_ID: Session expired or invalid"))
      .mockResolvedValueOnce({ records: [{ Id: "ka0x003" }], done: true });
    const instance = await buildInstance();
    const page = await instance.queryPage("SELECT Id FROM Knowledge__kav WHERE PublishStatus = 'Online'");
    expect(page.records).toEqual([{ Id: "ka0x003" }]);
    expect(mockRefreshSalesforceToken).toHaveBeenCalledTimes(1);
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
      _tag: "IntegrationReconnectRequiredError",
      platform: "salesforce",
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

  it("propagates IntegrationReconnectRequiredError when the refresh fails permanently AND evicts the cached instance", async () => {
    mockReadCredentialBundle.mockResolvedValueOnce(HAPPY_BUNDLE);
    mockJsforceQuery.mockRejectedValueOnce(new Error("INVALID_SESSION_ID"));
    mockRefreshSalesforceToken.mockRejectedValueOnce(
      new TestReconnectError({
        workspaceId: WSID,
        platform: "salesforce",
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
      _tag: "IntegrationReconnectRequiredError",
      platform: "salesforce",
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
