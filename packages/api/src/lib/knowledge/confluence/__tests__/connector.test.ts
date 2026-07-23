/**
 * Tests for the Confluence KnowledgeSyncConnector (#4377) — the createClient
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

const { createConfluenceConnector } = await import("@atlas/api/lib/knowledge/confluence/connector");
const { CONFLUENCE_CATALOG_ID, CONFLUENCE_VENDOR } = await import(
  "@atlas/api/lib/knowledge/confluence/config"
);

const VALID_CONFIG = {
  base_url: "https://acme.atlassian.net/wiki",
  email: "bot@acme.com",
  space_key: "ENG",
};

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "confluence-eng", config, maxDocs: 1000 };
}

afterEach(() => {
  tokenResult = "secret-token";
});

describe("createConfluenceConnector", () => {
  it("advertises the confluence catalog id and vendor slug", () => {
    const connector = createConfluenceConnector();
    expect(connector.catalogId).toBe(CONFLUENCE_CATALOG_ID);
    expect(connector.vendor).toBe(CONFLUENCE_VENDOR);
  });

  it("builds a vendor client from valid config + a stored token", async () => {
    const connector = createConfluenceConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the stored config is missing a field", async () => {
    const connector = createConfluenceConnector();
    await expect(connector.createClient(ctx({ email: "bot@acme.com", space_key: "ENG" }))).rejects.toThrow(
      /no Confluence site URL configured/i,
    );
  });

  it("throws when the collection has no stored API token", async () => {
    tokenResult = null;
    const connector = createConfluenceConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/no stored API token/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    tokenResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createConfluenceConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
