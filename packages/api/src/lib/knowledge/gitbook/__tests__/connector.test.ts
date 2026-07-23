/**
 * Tests for the GitBook KnowledgeSyncConnector (#4393) — the createClient
 * factory contract: parse stored config, read the encrypted token loudly, and
 * build a vendor client. The credential store is mocked (mock-all-exports).
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

const { createGitbookConnector } = await import("@atlas/api/lib/knowledge/gitbook/connector");
const { GITBOOK_CATALOG_ID, GITBOOK_VENDOR } = await import("@atlas/api/lib/knowledge/gitbook/config");

const VALID_CONFIG = { space_id: "space-123" };

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "gitbook-docs", config, maxDocs: 1000 };
}

afterEach(() => {
  tokenResult = "secret-token";
});

describe("createGitbookConnector", () => {
  it("advertises the gitbook catalog id and vendor slug", () => {
    const connector = createGitbookConnector();
    expect(connector.catalogId).toBe(GITBOOK_CATALOG_ID);
    expect(connector.vendor).toBe(GITBOOK_VENDOR);
  });

  it("builds a vendor client from valid config + a stored token", async () => {
    const connector = createGitbookConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the stored config has no space id", async () => {
    const connector = createGitbookConnector();
    await expect(connector.createClient(ctx({}))).rejects.toThrow(/no GitBook space id configured/i);
  });

  it("throws when the collection has no stored API token", async () => {
    tokenResult = null;
    const connector = createGitbookConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/no stored API token/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    tokenResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createGitbookConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
