/**
 * Tests for the Confluence Data Center KnowledgeSyncConnector (#4394) — the
 * createClient factory contract: parse stored config, read the encrypted PAT
 * loudly, and build a vendor client. The credential store is mocked
 * (mock-all-exports).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let tokenResult: string | null | (() => never) = "pat-secret-token";

mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential: async () => {},
  deleteSyncCredential: async () => {},
  readSyncCredential: async () => {
    if (typeof tokenResult === "function") return tokenResult();
    return tokenResult;
  },
}));

const { createConfluenceDatacenterConnector } = await import(
  "@atlas/api/lib/knowledge/confluence/connector-datacenter"
);
const { CONFLUENCE_DC_CATALOG_ID, CONFLUENCE_DC_VENDOR } = await import(
  "@atlas/api/lib/knowledge/confluence/config-datacenter"
);

const VALID_CONFIG = {
  base_url: "https://confluence.acme.com",
  space_key: "ENG",
};

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "confluence-dc-eng", config };
}

afterEach(() => {
  tokenResult = "pat-secret-token";
});

describe("createConfluenceDatacenterConnector", () => {
  it("advertises the confluence-datacenter catalog id and vendor slug", () => {
    const connector = createConfluenceDatacenterConnector();
    expect(connector.catalogId).toBe(CONFLUENCE_DC_CATALOG_ID);
    expect(connector.vendor).toBe(CONFLUENCE_DC_VENDOR);
  });

  it("builds a vendor client from valid config + a stored PAT", async () => {
    const connector = createConfluenceDatacenterConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the stored config is missing the base URL", async () => {
    const connector = createConfluenceDatacenterConnector();
    await expect(connector.createClient(ctx({ space_key: "ENG" }))).rejects.toThrow(
      /no Confluence base URL configured/i,
    );
  });

  it("throws an actionable error when the stored config is missing the space key", async () => {
    const connector = createConfluenceDatacenterConnector();
    await expect(
      connector.createClient(ctx({ base_url: "https://confluence.acme.com" })),
    ).rejects.toThrow(/no Confluence space key configured/i);
  });

  it("throws when the collection has no stored Personal Access Token", async () => {
    tokenResult = null;
    const connector = createConfluenceDatacenterConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(
      /no stored Personal Access Token/i,
    );
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    tokenResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createConfluenceDatacenterConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
