/**
 * Unit tests for `BundleSyncFormInstallHandler` (#4211) — the synced-collection
 * install.
 *
 * Focus: field validation (endpoint URL + SSRF gate, auth pair), the credential
 * routing (secret → `knowledge_sync_credentials` via the store, NEVER into
 * `workspace_plugins.config`), the multi-instance `pillar='knowledge'` upsert
 * shape, and the cross-catalog slug guard. The internal DB is a
 * SQL-string-dispatching mock; the live INSERT is pinned against real Postgres
 * in the `-pg` test. The SSRF check is the REAL `assertBaseUrlAllowed` (not a
 * mock) so the guard's actual policy — https-only, private-address blocking —
 * is what these tests exercise.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:bundle-sync" }];
let INSERT_RETURNS_ID = true;
let CROSS_CATALOG_ROWS: { catalog_id: string }[] = [];
const insertCalls: { sql: string; params: unknown[] }[] = [];

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("FROM plugin_catalog")) return CATALOG_ROWS;
  if (sql.includes("catalog_id <> $3")) return CROSS_CATALOG_ROWS;
  if (sql.includes("INSERT INTO workspace_plugins")) {
    insertCalls.push({ sql, params });
    return INSERT_RETURNS_ID ? [{ id: params[0] }] : [];
  }
  throw new Error(`unexpected SQL: ${sql.slice(0, 50)}`);
});

mock.module("@atlas/api/lib/db/internal", () => buildInternalDbMockDefaults({ internalQuery }));
mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

// Credential store — spied so the tests assert routing without touching crypto.
const saveSyncCredential = mock(async (_w: string, _c: string, _s: string) => {});
const deleteSyncCredential = mock(async (_w: string, _c: string) => {});
const readSyncCredential = mock(async () => null);
mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  saveSyncCredential,
  deleteSyncCredential,
  readSyncCredential,
}));

const { BundleSyncFormInstallHandler, BUNDLE_SYNC_SLUG } = await import(
  "@atlas/api/lib/integrations/install/bundle-sync-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const ENDPOINT = "https://example.com/kb/archive/main.tar.gz";

function handler() {
  return new BundleSyncFormInstallHandler({ idGenerator: () => "fixed-id" });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:bundle-sync" }];
  INSERT_RETURNS_ID = true;
  CROSS_CATALOG_ROWS = [];
  insertCalls.length = 0;
  internalQuery.mockClear();
  saveSyncCredential.mockClear();
  deleteSyncCredential.mockClear();
});
afterEach(() => internalQuery.mockClear());

/** Extract the first field error for `field`, or undefined. */
async function fieldErrorOf(
  promise: Promise<unknown>,
  field: string,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.fieldErrors[field]?.[0];
    throw err;
  }
  return undefined;
}

describe("BundleSyncFormInstallHandler.validateConfig — endpoint validation", () => {
  it("requires endpoint_url", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, {}), "endpoint_url");
    expect(msg).toMatch(/required/);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects a malformed URL with a field error", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { endpoint_url: "not a url" }),
      "endpoint_url",
    );
    expect(msg).toMatch(/well-formed/);
  });

  it("rejects a non-http(s) scheme", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { endpoint_url: "ftp://example.com/kb.tar" }),
      "endpoint_url",
    );
    expect(msg).toMatch(/http/);
  });

  it("blocks SSRF targets — cloud metadata IP is a field error, not a 500", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { endpoint_url: "https://169.254.169.254/latest/meta-data" }),
      "endpoint_url",
    );
    expect(msg).toMatch(/private|internal|Refusing/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("blocks plain-http public hosts (guard demands HTTPS)", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { endpoint_url: "http://example.com/kb.tar.gz" }),
      "endpoint_url",
    );
    expect(msg).toBeDefined();
  });
});

describe("BundleSyncFormInstallHandler.validateConfig — auth pair", () => {
  it("rejects an unknown auth scheme", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { endpoint_url: ENDPOINT, auth_scheme: "digest" }),
      "auth_scheme",
    );
    expect(msg).toBeDefined();
  });

  it("requires a secret for bearer", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { endpoint_url: ENDPOINT, auth_scheme: "bearer" }),
      "auth_secret",
    );
    expect(msg).toMatch(/token/i);
  });

  it("requires user:password shape for basic", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, {
        endpoint_url: ENDPOINT,
        auth_scheme: "basic",
        auth_secret: "no-colon-here",
      }),
      "auth_secret",
    );
    expect(msg).toMatch(/user:password/);
  });

  it("rejects a stray secret when scheme is none (never silently ignore a credential)", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, {
        endpoint_url: ENDPOINT,
        auth_scheme: "none",
        auth_secret: "tok",
      }),
      "auth_secret",
    );
    expect(msg).toBeDefined();
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });
});

describe("BundleSyncFormInstallHandler.validateConfig — persistence", () => {
  it("installs without auth: config carries endpoint + scheme, no credential row, stale secret cleared", async () => {
    const { installRecord, credentialWritten } = await handler().validateConfig(WORKSPACE, {
      endpoint_url: ENDPOINT,
      description: " Product docs ",
    });
    expect(credentialWritten).toBe(false);
    expect(installRecord).toEqual({ id: "fixed-id", workspaceId: WORKSPACE, catalogId: BUNDLE_SYNC_SLUG });
    expect(saveSyncCredential).not.toHaveBeenCalled();
    // An edit back to "none" must clear a previously-stored secret.
    expect(deleteSyncCredential).toHaveBeenCalledWith(WORKSPACE, BUNDLE_SYNC_SLUG);

    // install_id ($4) defaults to the catalog slug; pillar knowledge; published.
    expect(insertCalls[0].params[3]).toBe(BUNDLE_SYNC_SLUG);
    expect(insertCalls[0].sql).toContain("'knowledge'");
    expect(insertCalls[0].sql).toContain("'published'");
    expect(JSON.parse(insertCalls[0].params[4] as string)).toEqual({
      endpoint_url: ENDPOINT,
      auth_scheme: "none",
      description: "Product docs",
    });
  });

  it("routes a bearer secret to the credential store and keeps it OUT of config", async () => {
    const { credentialWritten } = await handler().validateConfig(WORKSPACE, {
      __install_id__: "docs",
      endpoint_url: ENDPOINT,
      auth_scheme: "bearer",
      auth_secret: " tok-123 ",
    });
    expect(credentialWritten).toBe(true);
    expect(saveSyncCredential).toHaveBeenCalledWith(WORKSPACE, "docs", "tok-123");

    const persistedConfig = JSON.parse(insertCalls[0].params[4] as string) as Record<string, unknown>;
    expect(persistedConfig).toEqual({ endpoint_url: ENDPOINT, auth_scheme: "bearer" });
    expect(JSON.stringify(persistedConfig)).not.toContain("tok-123");
  });

  it("writes the credential BEFORE the install row (Twenty ordering — retry heals)", async () => {
    let credentialWrittenFirst = false;
    saveSyncCredential.mockImplementationOnce(async () => {
      credentialWrittenFirst = insertCalls.length === 0;
    });
    await handler().validateConfig(WORKSPACE, {
      endpoint_url: ENDPOINT,
      auth_scheme: "bearer",
      auth_secret: "tok",
    });
    expect(credentialWrittenFirst).toBe(true);
  });

  it("rejects a slug already used by another knowledge catalog (okf-upload) before any write", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:okf-upload" }];
    await expect(
      handler().validateConfig(WORKSPACE, { __install_id__: "runbooks", endpoint_url: ENDPOINT }),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("throws when the catalog row is missing (seed misconfig → 500, not silent)", async () => {
    CATALOG_ROWS = [];
    await expect(
      handler().validateConfig(WORKSPACE, { endpoint_url: ENDPOINT }),
    ).rejects.toThrow(/not found or disabled/);
  });

  it("fails loud when the upsert returns no id (Postgres invariant break)", async () => {
    INSERT_RETURNS_ID = false;
    await expect(
      handler().validateConfig(WORKSPACE, { endpoint_url: ENDPOINT }),
    ).rejects.toThrow(/returned no id/);
  });
});
