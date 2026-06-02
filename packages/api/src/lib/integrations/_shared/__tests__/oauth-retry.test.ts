/**
 * Tests for the shared OAuth refresh-retry harness (#2708).
 *
 * The three lazy-builder suites (salesforce / jira / linear) already cover
 * the harness end-to-end through their own contexts. This file pins the
 * extracted contract directly, in isolation from any platform:
 *
 *   - Happy path: `fn` runs against the initial context, no refresh.
 *   - Non-session errors rethrow immediately without refreshing.
 *   - Session expiry refreshes once, retries on the new context, and
 *     persists that context for later `withRetry` calls.
 *   - `refreshContext` receives the current context (the Jira base-URL
 *     fallback relies on this).
 *   - Permanent refresh failure (throws `reconnectErrorClass`) evicts the
 *     cached instance; a transient failure leaves it warm.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

// Track lazyPluginLoader.evict — the only collaborator the harness imports.
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

type RetryModule = typeof import("../oauth-retry");
let retryMod!: RetryModule;

beforeAll(async () => {
  retryMod = await import("../oauth-retry");
});

const WSID = "ws-oauth-retry-test";
const CATALOG_ID = "catalog:test";

// Silent logger — the harness only ever calls `.info`.
const logger = { info: () => {} };

/** Stand-in for the shared reconnect error — pinned via `instanceof`. */
class TestReconnectError extends Error {
  readonly _tag = "IntegrationReconnectRequiredError" as const;
}

/** The "upstream rejected the token" signal, narrowed by `isSessionExpired`. */
class SessionExpired extends Error {}
const isSessionExpired = (err: unknown): boolean => err instanceof SessionExpired;

beforeEach(() => {
  mockEvict.mockClear();
});

afterEach(() => {
  // nothing to restore — no global / env state mutated
});

describe("createOAuthRetry — happy path", () => {
  it("runs fn against the initial context and never refreshes on success", async () => {
    const refreshContext = mock(() => Promise.resolve("REFRESHED"));
    const withRetry = retryMod.createOAuthRetry<string>({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      platformLabel: "Test",
      logger,
      initialContext: "INITIAL",
      isSessionExpired,
      reconnectErrorClass: TestReconnectError,
      refreshContext,
    });

    const result = await withRetry((ctx) => Promise.resolve(`saw:${ctx}`));

    expect(result).toBe("saw:INITIAL");
    expect(refreshContext).not.toHaveBeenCalled();
    expect(mockEvict).not.toHaveBeenCalled();
  });
});

describe("createOAuthRetry — non-session errors", () => {
  it("rethrows immediately without refreshing or evicting", async () => {
    const refreshContext = mock(() => Promise.resolve("REFRESHED"));
    const withRetry = retryMod.createOAuthRetry<string>({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      platformLabel: "Test",
      logger,
      initialContext: "INITIAL",
      isSessionExpired,
      reconnectErrorClass: TestReconnectError,
      refreshContext,
    });

    await expect(
      withRetry(() => Promise.reject(new Error("unrelated boom"))),
    ).rejects.toThrow("unrelated boom");
    expect(refreshContext).not.toHaveBeenCalled();
    expect(mockEvict).not.toHaveBeenCalled();
  });
});

describe("createOAuthRetry — session expiry refresh + retry", () => {
  it("refreshes once, retries on the new context, and persists it for later calls", async () => {
    const seenByRefresh: string[] = [];
    const refreshContext = mock((current: string) => {
      seenByRefresh.push(current);
      return Promise.resolve("tok-1");
    });
    const withRetry = retryMod.createOAuthRetry<string>({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      platformLabel: "Test",
      logger,
      initialContext: "tok-0",
      isSessionExpired,
      reconnectErrorClass: TestReconnectError,
      refreshContext,
    });

    // First call: fails on tok-0, refreshes to tok-1, succeeds on retry.
    let firstCall = true;
    const first = await withRetry((ctx) => {
      if (firstCall) {
        firstCall = false;
        expect(ctx).toBe("tok-0");
        return Promise.reject(new SessionExpired("401"));
      }
      return Promise.resolve(`retry:${ctx}`);
    });
    expect(first).toBe("retry:tok-1");
    expect(refreshContext).toHaveBeenCalledTimes(1);
    // refreshContext receives the *current* context — the Jira base-URL
    // fallback depends on this.
    expect(seenByRefresh).toEqual(["tok-0"]);

    // Second call: the refreshed context persists, so no further refresh.
    const second = await withRetry((ctx) => Promise.resolve(`again:${ctx}`));
    expect(second).toBe("again:tok-1");
    expect(refreshContext).toHaveBeenCalledTimes(1);
    expect(mockEvict).not.toHaveBeenCalled();
  });
});

describe("createOAuthRetry — eviction on permanent failure", () => {
  it("evicts the cached instance and rethrows when refresh throws the reconnect error", async () => {
    const reconnectErr = new TestReconnectError("permanent");
    const withRetry = retryMod.createOAuthRetry<string>({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      platformLabel: "Test",
      logger,
      initialContext: "tok-0",
      isSessionExpired,
      reconnectErrorClass: TestReconnectError,
      refreshContext: () => Promise.reject(reconnectErr),
    });

    await expect(
      withRetry(() => Promise.reject(new SessionExpired("401"))),
    ).rejects.toBe(reconnectErr);

    expect(mockEvict).toHaveBeenCalledWith(WSID, CATALOG_ID);
    expect(mockEvict).toHaveBeenCalledTimes(1);
  });

  it("does NOT evict when refresh throws a transient (non-reconnect) error", async () => {
    const withRetry = retryMod.createOAuthRetry<string>({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      platformLabel: "Test",
      logger,
      initialContext: "tok-0",
      isSessionExpired,
      reconnectErrorClass: TestReconnectError,
      refreshContext: () => Promise.reject(new Error("ECONNRESET")),
    });

    await expect(
      withRetry(() => Promise.reject(new SessionExpired("401"))),
    ).rejects.toThrow("ECONNRESET");
    expect(mockEvict).not.toHaveBeenCalled();
  });
});
