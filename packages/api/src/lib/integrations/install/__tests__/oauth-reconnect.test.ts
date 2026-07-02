/**
 * Direct unit tests for the shared reconnect-status seam (#4188):
 * {@link markReconnectNeeded} / {@link clearReconnectNeeded} and the
 * fail-closed {@link writeCredentialWithReconnectFallback}.
 *
 * The two invariants under test — previously re-asserted per platform:
 *
 *   1. The `mark`/`clear` pair emits the exact `config || jsonb_build_object`
 *      UPDATE keyed on `(workspace_id, catalog_id)`, and swallows a DB
 *      failure (best-effort) rather than propagating.
 *   2. `writeCredentialWithReconnectFallback` enforces the fail-closed
 *      Reconnect rule: on a credential-write throw the install row is NOT
 *      rolled back, `status` is flipped to `reconnect_needed`, and the
 *      caller gets `credentialResult.written: false`.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks (must precede the SUT import)
// ---------------------------------------------------------------------------

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([]),
);
mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const mockSaveCredentialBundle: Mock<
  (ws: string, cat: string, bundle: unknown) => Promise<void>
> = mock(() => Promise.resolve());
mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  saveCredentialBundle: mockSaveCredentialBundle,
  readCredentialBundle: mock(() => Promise.resolve(null)),
  deleteCredentialBundle: mock(() => Promise.resolve(false)),
}));

type Seam = typeof import("../oauth-reconnect");
let seam!: Seam;

beforeEach(async () => {
  seam ??= await import("../oauth-reconnect");
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockSaveCredentialBundle.mockClear();
  mockSaveCredentialBundle.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  mockInternalQuery.mockClear();
  mockSaveCredentialBundle.mockClear();
});

const WSID = "ws-reconnect-test-1" as WorkspaceId;

function makeLog(): { info: ReturnType<typeof mock>; warn: ReturnType<typeof mock> } {
  return { info: mock(() => undefined), warn: mock(() => undefined) };
}

const BUNDLE = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: null,
  tokenType: "Bearer",
  scope: "read",
  instanceUrl: "https://example.test",
};

const INSTALL_RECORD = { id: "row-1", workspaceId: WSID, catalogId: "jira" };

function findUpdate(status: "reconnect_needed" | "ok") {
  return mockInternalQuery.mock.calls.find(
    (c) => (c[0] as string).includes("UPDATE workspace_plugins") && (c[0] as string).includes(`'${status}'`),
  );
}

// ---------------------------------------------------------------------------
// markReconnectNeeded / clearReconnectNeeded
// ---------------------------------------------------------------------------

describe("markReconnectNeeded", () => {
  it("fires the reconnect_needed UPDATE keyed on (workspace_id, catalog_id)", async () => {
    const log = makeLog();
    await seam.markReconnectNeeded(WSID, "catalog:jira", log, "mark failed");

    const call = findUpdate("reconnect_needed");
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual([WSID, "catalog:jira"]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("swallows a DB failure (best-effort) and logs instead of throwing", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.reject(new Error("row disconnected")));
    const log = makeLog();

    await seam.markReconnectNeeded(WSID, "catalog:jira", log, "mark failed message");

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toBe("mark failed message");
  });
});

describe("clearReconnectNeeded", () => {
  it("fires the status='ok' UPDATE keyed on (workspace_id, catalog_id)", async () => {
    const log = makeLog();
    await seam.clearReconnectNeeded(WSID, "catalog:linear", log, "clear failed");

    const call = findUpdate("ok");
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual([WSID, "catalog:linear"]);
  });

  it("swallows a DB failure (best-effort)", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const log = makeLog();
    await seam.clearReconnectNeeded(WSID, "catalog:linear", log, "clear failed message");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// writeCredentialWithReconnectFallback — the fail-closed invariant
// ---------------------------------------------------------------------------

describe("writeCredentialWithReconnectFallback — success", () => {
  it("persists the bundle and returns written:true with the slug echoed back", async () => {
    const log = makeLog();
    const result = await seam.writeCredentialWithReconnectFallback({
      workspaceId: WSID,
      catalogId: "catalog:jira",
      slug: "jira",
      bundle: BUNDLE,
      installRecord: INSTALL_RECORD,
      log,
      displayName: "Jira",
      successLogFields: { cloudid: "cloud-1" },
    });

    expect(mockSaveCredentialBundle).toHaveBeenCalledWith(WSID, "catalog:jira", BUNDLE);
    expect(result).toEqual({
      workspaceId: WSID,
      catalogId: "jira",
      installRecord: INSTALL_RECORD,
      credentialResult: { written: true },
    });
    // No status flip on the happy path.
    expect(findUpdate("reconnect_needed")).toBeUndefined();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe("writeCredentialWithReconnectFallback — partial failure (fail-closed)", () => {
  it("flips reconnect_needed and returns written:false WITHOUT rolling back the install row", async () => {
    mockSaveCredentialBundle.mockImplementationOnce(() => Promise.reject(new Error("db write failed")));
    const log = makeLog();

    const result = await seam.writeCredentialWithReconnectFallback({
      workspaceId: WSID,
      catalogId: "catalog:jira",
      slug: "jira",
      bundle: BUNDLE,
      installRecord: INSTALL_RECORD,
      log,
      displayName: "Jira",
      failureLogFields: { cloudid: "cloud-1" },
    });

    // Install record preserved (no rollback DELETE), Reconnect surfaced.
    expect(result.installRecord).toEqual(INSTALL_RECORD);
    expect(result.credentialResult.written).toBe(false);
    expect(result.credentialResult.reason).toContain("Reconnect");
    expect(result.catalogId).toBe("jira");

    // The status flip is the persistent-Reconnect-CTA signal.
    const flip = findUpdate("reconnect_needed");
    expect(flip).toBeDefined();
    expect(flip?.[1]).toEqual([WSID, "catalog:jira"]);
    // Only the status flip UPDATE — no rollback statement.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });

  it("still returns written:false when the status-flip UPDATE itself fails (best-effort)", async () => {
    mockSaveCredentialBundle.mockImplementationOnce(() => Promise.reject(new Error("db write failed")));
    mockInternalQuery.mockImplementationOnce(() => Promise.reject(new Error("status flip failed")));
    const log = makeLog();

    const result = await seam.writeCredentialWithReconnectFallback({
      workspaceId: WSID,
      catalogId: "catalog:salesforce",
      slug: "salesforce",
      bundle: BUNDLE,
      installRecord: { ...INSTALL_RECORD, catalogId: "salesforce" },
      log,
      displayName: "Salesforce",
    });

    expect(result.credentialResult.written).toBe(false);
    // Two warns: the credential-write failure + the swallowed flip failure.
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
