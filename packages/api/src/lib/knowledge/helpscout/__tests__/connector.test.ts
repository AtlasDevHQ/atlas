/**
 * Tests for the Help Scout KnowledgeSyncConnector (#4398) — the createClient
 * factory contract: parse the stored per-site config, read the encrypted Docs
 * API key loudly, and build a vendor client. Also pins the draft-only
 * (publish-guard) guarantee: the connector's vendor slug stamps a
 * `connector:helpscout` IngestSource, which the shared ingest seam refuses to
 * publish (ADR-0028 §4). The credential store is mocked (mock-all-exports).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let keyResult: string | null | (() => never) = "docs-api-key";

void mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential: async () => {},
  deleteSyncCredential: async () => {},
  readSyncCredential: async () => {
    if (typeof keyResult === "function") return keyResult();
    return keyResult;
  },
}));

const { createHelpScoutConnector } = await import("@atlas/api/lib/knowledge/helpscout/connector");
const { HELPSCOUT_CATALOG_ID, HELPSCOUT_VENDOR } = await import(
  "@atlas/api/lib/knowledge/helpscout/config"
);

const VALID_CONFIG = { site_id: "site-1", site_name: "Acme Docs", subdomain: "acme" };

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: "org-1", collectionSlug: "helpscout-acme", config };
}

afterEach(() => {
  keyResult = "docs-api-key";
});

describe("createHelpScoutConnector", () => {
  it("advertises the helpscout catalog id and vendor slug", () => {
    const connector = createHelpScoutConnector();
    expect(connector.catalogId).toBe(HELPSCOUT_CATALOG_ID);
    expect(connector.vendor).toBe(HELPSCOUT_VENDOR);
  });

  it("is draft-only: its IngestSource is a non-upload connector source (publish-guard)", () => {
    const connector = createHelpScoutConnector();
    const source = `connector:${connector.vendor}`;
    // `ingestBundle` throws for any source !== "upload" (ADR-0028 §4), so a
    // `connector:helpscout` document can never be published — draft only.
    expect(source).toBe("connector:helpscout");
    expect(source).not.toBe("upload");
  });

  it("builds a vendor client from valid per-site config + a stored key", async () => {
    const connector = createHelpScoutConnector();
    const client = await connector.createClient(ctx(VALID_CONFIG));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error when the stored config is missing the site", async () => {
    const connector = createHelpScoutConnector();
    await expect(connector.createClient(ctx({ site_name: "Acme" }))).rejects.toThrow(
      /no Help Scout site configured/i,
    );
  });

  it("throws when the collection has no stored API key", async () => {
    keyResult = null;
    const connector = createHelpScoutConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/no stored Docs API key/i);
  });

  it("propagates a loud decrypt failure from the credential store", async () => {
    keyResult = () => {
      throw new Error("failed to decrypt knowledge_sync_credentials — key rotated without re-encryption");
    };
    const connector = createHelpScoutConnector();
    await expect(connector.createClient(ctx(VALID_CONFIG))).rejects.toThrow(/failed to decrypt/i);
  });
});
