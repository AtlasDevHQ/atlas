/**
 * Tests for the Freshdesk KnowledgeSyncConnector (#4401) — the createClient
 * factory contract: parse the stored per-category config, read the encrypted
 * API key loudly, and build a vendor client. The credential store is mocked
 * (mock-all-exports).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let keyResult: string | null | (() => never) = "secret-key";

void mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential: async () => {},
  deleteSyncCredential: async () => {},
  readSyncCredential: async () => {
    if (typeof keyResult === "function") return keyResult();
    return keyResult;
  },
}));

const { createFreshdeskConnector } = await import("@atlas/api/lib/knowledge/freshdesk/connector");
const { FRESHDESK_CATALOG_ID, FRESHDESK_VENDOR } = await import(
  "@atlas/api/lib/knowledge/freshdesk/config"
);

const VALID_CONFIG = {
  subdomain: "acme",
  category_id: "80000001",
  category_name: "Support",
};

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "freshdesk-support", config };
}

afterEach(() => {
  keyResult = "secret-key";
});

describe("createFreshdeskConnector", () => {
  it("advertises the freshdesk catalog id and vendor slug", () => {
    const connector = createFreshdeskConnector();
    expect(connector.catalogId).toBe(FRESHDESK_CATALOG_ID);
    expect(connector.vendor).toBe(FRESHDESK_VENDOR);
  });

  it("builds a vendor client from valid per-category config + a stored key", async () => {
    const connector = createFreshdeskConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the config has no subdomain", async () => {
    const connector = createFreshdeskConnector();
    await expect(
      connector.createClient(ctx({ category_id: "1", category_name: "x" })),
    ).rejects.toThrow(/no valid Freshdesk subdomain/i);
  });

  it("throws an actionable error when the config has no category", async () => {
    const connector = createFreshdeskConnector();
    await expect(
      connector.createClient(ctx({ subdomain: "acme" })),
    ).rejects.toThrow(/no Freshdesk Solutions category/i);
  });

  it("throws when the collection has no stored API key", async () => {
    keyResult = null;
    const connector = createFreshdeskConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/no stored API key/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    keyResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createFreshdeskConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
