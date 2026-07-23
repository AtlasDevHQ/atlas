/**
 * Tests for the Zendesk KnowledgeSyncConnector (#4396) — the createClient
 * factory contract: parse the stored per-brand config, read the encrypted
 * token loudly, and build a vendor client. The credential store is mocked
 * (mock-all-exports).
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

const { createZendeskConnector } = await import("@atlas/api/lib/knowledge/zendesk/connector");
const { ZENDESK_CATALOG_ID, ZENDESK_VENDOR } = await import(
  "@atlas/api/lib/knowledge/zendesk/config"
);

const VALID_CONFIG = {
  subdomain: "acme",
  email: "ops@acme.test",
  brand_id: "10",
  brand_subdomain: "acme",
  brand_name: "Acme",
};

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "zendesk-acme", config, maxDocs: 1000 };
}

afterEach(() => {
  tokenResult = "secret-token";
});

describe("createZendeskConnector", () => {
  it("advertises the zendesk catalog id and vendor slug", () => {
    const connector = createZendeskConnector();
    expect(connector.catalogId).toBe(ZENDESK_CATALOG_ID);
    expect(connector.vendor).toBe(ZENDESK_VENDOR);
  });

  it("builds a vendor client from valid per-brand config + a stored token", async () => {
    const connector = createZendeskConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the stored config is missing the brand", async () => {
    const connector = createZendeskConnector();
    await expect(
      connector.createClient(ctx({ subdomain: "acme", email: "ops@acme.test" })),
    ).rejects.toThrow(/no Zendesk brand configured/i);
  });

  it("throws when the brand subdomain fails the host-label pattern", async () => {
    const connector = createZendeskConnector();
    await expect(
      connector.createClient(ctx({ ...VALID_CONFIG, brand_subdomain: "evil.example.com/x" })),
    ).rejects.toThrow(/no valid Zendesk brand subdomain/i);
  });

  it("throws when the collection has no stored API token", async () => {
    tokenResult = null;
    const connector = createZendeskConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/no stored API token/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    tokenResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createZendeskConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
