/**
 * Tests for the Front KnowledgeSyncConnector (#4400) — the createClient factory
 * contract: parse the stored per-KB config, read the encrypted token loudly,
 * and build a vendor client. The credential store is mocked (mock-all-exports).
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

const { createFrontConnector } = await import("@atlas/api/lib/knowledge/front/connector");
const { FRONT_CATALOG_ID, FRONT_VENDOR } = await import("@atlas/api/lib/knowledge/front/config");

const VALID_CONFIG = {
  knowledge_base_id: "kb_1",
  knowledge_base_name: "Support Center",
};

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "front-support", config, maxDocs: 1000 };
}

afterEach(() => {
  tokenResult = "secret-token";
});

describe("createFrontConnector", () => {
  it("advertises the front catalog id and vendor slug", () => {
    const connector = createFrontConnector();
    expect(connector.catalogId).toBe(FRONT_CATALOG_ID);
    expect(connector.vendor).toBe(FRONT_VENDOR);
  });

  it("builds a vendor client from valid per-KB config + a stored token", async () => {
    const connector = createFrontConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the stored config is missing the KB", async () => {
    const connector = createFrontConnector();
    await expect(connector.createClient(ctx({ knowledge_base_name: "x" }))).rejects.toThrow(
      /no Front knowledge base configured/i,
    );
  });

  it("throws when the collection has no stored API token", async () => {
    tokenResult = null;
    const connector = createFrontConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/no stored API token/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    tokenResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createFrontConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
