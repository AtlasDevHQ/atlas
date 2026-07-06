/**
 * The Notion connector registration + `createClient` credential seam (#4378).
 * The credential store is mocked (all exports) so no test touches the DB; the
 * connectors registry is reset per-test (never mutated at module top-level).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

let storedToken: string | null = "ntn_workspace-token";
mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT INTO knowledge_sync_credentials …",
  saveSyncCredential: async () => {},
  deleteSyncCredential: async () => {},
  readSyncCredential: async () => storedToken,
}));

const {
  registerNotionKnowledgeConnector,
  notionKnowledgeConnector,
  NOTION_KNOWLEDGE_CATALOG_ID,
  NOTION_VENDOR,
} = await import("@atlas/api/lib/knowledge/notion/connector");
const { getKnowledgeSyncConnector, _resetKnowledgeSyncConnectors } = await import(
  "@atlas/api/lib/knowledge/connectors"
);
const { NotionVendorClient } = await import("@atlas/api/lib/knowledge/notion/client");

beforeEach(() => {
  _resetKnowledgeSyncConnectors();
  storedToken = "ntn_workspace-token";
});

describe("registerNotionKnowledgeConnector", () => {
  it("registers the connector under the catalog id, idempotently", () => {
    expect(getKnowledgeSyncConnector(NOTION_KNOWLEDGE_CATALOG_ID)).toBeUndefined();
    registerNotionKnowledgeConnector();
    const got = getKnowledgeSyncConnector(NOTION_KNOWLEDGE_CATALOG_ID);
    expect(got).toBe(notionKnowledgeConnector);
    expect(got?.vendor).toBe(NOTION_VENDOR);
    // Second call is a no-op (the registry throws on a duplicate — the helper
    // gates on it), never a throw.
    expect(() => registerNotionKnowledgeConnector()).not.toThrow();
  });

  it("stamps the vendor slug as `notion` (→ atlas_source `connector:notion`)", () => {
    expect(notionKnowledgeConnector.vendor).toBe("notion");
  });
});

describe("notionKnowledgeConnector.createClient", () => {
  const ctx = { workspaceId: "ws1", collectionSlug: "notion", config: null };

  it("builds a NotionVendorClient from the stored integration token", async () => {
    const built = await notionKnowledgeConnector.createClient(ctx);
    expect(built).toBeInstanceOf(NotionVendorClient);
  });

  it("throws an actionable error when the collection has no stored token", async () => {
    storedToken = null;
    await expect(notionKnowledgeConnector.createClient(ctx)).rejects.toThrow(
      /no integration token stored/,
    );
  });
});
