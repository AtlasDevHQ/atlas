/**
 * Tests for the Linear LazyPluginLoader builders (#2750).
 *
 * Two builders share this file because they share `runIssueCreate`:
 *
 *   - {@link createLinearOAuthLazyBuilder} — OAuth-bundle source, refresh
 *     on 401, evict on permanent refresh failure (mirrors Jira pattern).
 *   - {@link createLinearApiKeyLazyBuilder} — decrypts the api_key from
 *     `workspace_plugins.config`, treats 401 as "rotate your key"
 *     surface (no refresh path).
 *
 * Both builders return the same `LinearPluginInstance` shape so the
 * tool layer's dispatch can pick either.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";

const mockReadCredentialBundle: Mock<(ws: string, cat: string) => Promise<unknown>> = mock(() =>
  Promise.resolve(null),
);
void mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  readCredentialBundle: mockReadCredentialBundle,
  saveCredentialBundle: mock(() => Promise.resolve()),
  deleteCredentialBundle: mock(() => Promise.resolve(false)),
}));

const mockRefreshLinearToken: Mock<(args: unknown) => Promise<unknown>> = mock(() =>
  Promise.resolve({
    accessToken: "refreshed-access-token",
    refreshToken: "ROTATED-refresh-token",
    expiresAt: null,
    tokenType: "Bearer",
    scope: "read write issues:create",
    instanceUrl: "https://api.linear.app/graphql",
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
void mock.module("@atlas/api/lib/integrations/install/linear-token-refresh", () => ({
  refreshLinearToken: mockRefreshLinearToken,
  IntegrationReconnectRequiredError: TestReconnectError,
  // Deprecated alias still exported by the real module (#2708) — mock the
  // full export surface so the alias resolves to the same fake.
  LinearReconnectRequiredError: TestReconnectError,
  LINEAR_SLUG: "linear",
  LINEAR_CATALOG_ID: "catalog:linear",
}));

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

const ORIGINAL_FETCH = globalThis.fetch;
const mockFetch: Mock<(input: unknown, init?: unknown) => Promise<Response>> = mock(() =>
  Promise.resolve(new Response("{}", { status: 200 })),
);

type BuilderMod = typeof import("../lazy-builder");
type LinearPluginInstance = import("../lazy-builder").LinearPluginInstance;
let builderMod!: BuilderMod;

beforeAll(async () => {
  builderMod = await import("../lazy-builder");
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-linear-lazy-builder-unit-tests-long-enough";
  _resetEncryptionKeyCache();
  mockReadCredentialBundle.mockClear();
  mockRefreshLinearToken.mockClear();
  mockEvict.mockClear();
  mockFetch.mockClear();
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
  globalThis.fetch = ORIGINAL_FETCH;
});

const WSID = "ws-linear-builder-1";

const STORED_OAUTH_BUNDLE = {
  accessToken: "oauth-access-token",
  refreshToken: "oauth-refresh-token",
  expiresAt: null,
  tokenType: "Bearer",
  scope: "read write issues:create",
  instanceUrl: "https://api.linear.app/graphql",
};

// ---------------------------------------------------------------------------
// OAuth builder
// ---------------------------------------------------------------------------

describe("createLinearOAuthLazyBuilder", () => {
  it("instantiates and calls issueCreate via Bearer token", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_OAUTH_BUNDLE));
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "issue-uuid",
                  identifier: "ENG-42",
                  url: "https://linear.app/acme/issue/ENG-42",
                  title: "Stale data",
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const builder = builderMod.createLinearOAuthLazyBuilder({
      clientId: "ci",
      clientSecret: "cs",
    });
    const instance = (await builder({
      workspaceId: WSID,
      catalogId: "catalog:linear",
      config: {},
    })) as LinearPluginInstance;

    const result = await instance.createLinearIssue({ title: "Stale data" });
    expect(result).toEqual({
      id: "issue-uuid",
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42",
      title: "Stale data",
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer oauth-access-token",
    );
  });

  it("refuses to instantiate when install status is reconnect_needed", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_OAUTH_BUNDLE));
    const builder = builderMod.createLinearOAuthLazyBuilder({
      clientId: "ci",
      clientSecret: "cs",
    });
    await expect(
      builder({
        workspaceId: WSID,
        catalogId: "catalog:linear",
        config: { status: "reconnect_needed" },
      }),
    ).rejects.toBeInstanceOf(TestReconnectError);

    // No GraphQL traffic should fire — we threw before constructing the
    // instance.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes on 401 and retries the mutation once", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_OAUTH_BUNDLE));

    let call = 0;
    mockFetch.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: "u", identifier: "ENG-9", url: "https://linear.app/x", title: "OK" },
              },
            },
          }),
          { status: 200 },
        ),
      );
    });

    const builder = builderMod.createLinearOAuthLazyBuilder({
      clientId: "ci",
      clientSecret: "cs",
    });
    const instance = (await builder({
      workspaceId: WSID,
      catalogId: "catalog:linear",
      config: {},
    })) as LinearPluginInstance;

    const result = await instance.createLinearIssue({ title: "OK" });
    expect(result.identifier).toBe("ENG-9");
    expect(mockRefreshLinearToken).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call used the refreshed access token.
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer refreshed-access-token",
    );
  });

  it("evicts cached instance + rethrows when refresh fails permanently", async () => {
    mockReadCredentialBundle.mockImplementation(() => Promise.resolve(STORED_OAUTH_BUNDLE));
    mockFetch.mockImplementation(() => Promise.resolve(new Response("nope", { status: 401 })));
    mockRefreshLinearToken.mockImplementation(() =>
      Promise.reject(
        new TestReconnectError({
          workspaceId: WSID,
          platform: "linear",
          upstreamError: "invalid_grant",
        }),
      ),
    );

    const builder = builderMod.createLinearOAuthLazyBuilder({
      clientId: "ci",
      clientSecret: "cs",
    });
    const instance = (await builder({
      workspaceId: WSID,
      catalogId: "catalog:linear",
      config: {},
    })) as LinearPluginInstance;

    await expect(instance.createLinearIssue({ title: "x" })).rejects.toBeInstanceOf(
      TestReconnectError,
    );

    // Eviction fires so the agent doesn't keep re-trying through a
    // dead cached instance.
    expect(mockEvict).toHaveBeenCalledWith(WSID, "catalog:linear");
  });
});

// ---------------------------------------------------------------------------
// API-key builder
// ---------------------------------------------------------------------------

describe("createLinearApiKeyLazyBuilder", () => {
  it("decrypts api_key from config and uses it as the Bearer", async () => {
    const { encryptSecretFields } = await import("@atlas/api/lib/plugins/secrets");
    const { LINEAR_APIKEY_SECRET_FIELDS_SCHEMA } = await import(
      "@atlas/api/lib/integrations/install/linear-apikey-secret-schema"
    );
    const encrypted = encryptSecretFields(
      { api_key: "lin_api_secret_xyz", workspace_name: "Acme" },
      LINEAR_APIKEY_SECRET_FIELDS_SCHEMA,
    );

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: "id", identifier: "ENG-7", url: "u", title: "T" },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const builder = builderMod.createLinearApiKeyLazyBuilder();
    const instance = (await builder({
      workspaceId: WSID,
      catalogId: "catalog:linear-apikey",
      config: encrypted,
    })) as LinearPluginInstance;

    await instance.createLinearIssue({ title: "Hello" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer lin_api_secret_xyz",
    );

    // Refresh path is not exercised — API-key mode has no refresh.
    expect(mockRefreshLinearToken).not.toHaveBeenCalled();
  });

  it("translates 401 into LinearApiKeyRejectedError (rotate-your-key surface)", async () => {
    const { encryptSecretFields } = await import("@atlas/api/lib/plugins/secrets");
    const { LINEAR_APIKEY_SECRET_FIELDS_SCHEMA } = await import(
      "@atlas/api/lib/integrations/install/linear-apikey-secret-schema"
    );
    const encrypted = encryptSecretFields(
      { api_key: "lin_api_revoked_key" },
      LINEAR_APIKEY_SECRET_FIELDS_SCHEMA,
    );

    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("revoked", { status: 401 })),
    );

    const builder = builderMod.createLinearApiKeyLazyBuilder();
    const instance = (await builder({
      workspaceId: WSID,
      catalogId: "catalog:linear-apikey",
      config: encrypted,
    })) as LinearPluginInstance;

    await expect(instance.createLinearIssue({ title: "x" })).rejects.toBeInstanceOf(
      builderMod.LinearApiKeyRejectedError,
    );
    // Critically: no refresh, no evict — API-key mode just bubbles the
    // rotation surface to the tool layer.
    expect(mockRefreshLinearToken).not.toHaveBeenCalled();
    expect(mockEvict).not.toHaveBeenCalled();
  });

  it("throws LinearApiKeyMissingError when decrypt yields no api_key", async () => {
    const builder = builderMod.createLinearApiKeyLazyBuilder();
    await expect(
      builder({
        workspaceId: WSID,
        catalogId: "catalog:linear-apikey",
        config: { workspace_name: "Acme but no key" },
      }),
    ).rejects.toBeInstanceOf(builderMod.LinearApiKeyMissingError);
  });
});
