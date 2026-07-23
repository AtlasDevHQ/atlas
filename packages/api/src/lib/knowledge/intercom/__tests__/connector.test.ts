/**
 * Tests for the Intercom KnowledgeSyncConnector (#4399) — the createClient
 * factory contract: read the encrypted token loudly and build a vendor client.
 * The credential store is mocked (mock-all-exports).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let tokenResult: string | null | (() => never) = "secret-token";

void mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential: async () => {},
  deleteSyncCredential: async () => {},
  readSyncCredential: async () => {
    if (typeof tokenResult === "function") return tokenResult();
    return tokenResult;
  },
}));

const { createIntercomConnector } = await import("@atlas/api/lib/knowledge/intercom/connector");
const { INTERCOM_CATALOG_ID, INTERCOM_VENDOR } = await import("@atlas/api/lib/knowledge/intercom/config");

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "intercom-docs", config, maxDocs: 1000 };
}

afterEach(() => {
  tokenResult = "secret-token";
});

describe("createIntercomConnector", () => {
  it("advertises the intercom catalog id and vendor slug", () => {
    const connector = createIntercomConnector();
    expect(connector.catalogId).toBe(INTERCOM_CATALOG_ID);
    expect(connector.vendor).toBe(INTERCOM_VENDOR);
  });

  it("builds a vendor client from a stored token", async () => {
    const connector = createIntercomConnector();
    const client = await connector.createClient(ctx({ description: "Support docs" }));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws when the collection has no stored access token", async () => {
    tokenResult = null;
    const connector = createIntercomConnector();
    await expect(connector.createClient(ctx({}))).rejects.toThrow(/no stored access token/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    tokenResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createIntercomConnector();
    await expect(connector.createClient(ctx(null))).rejects.toThrow(/failed to decrypt/i);
  });
});
