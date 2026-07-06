/**
 * The Notion Knowledge Sync Connector registration (#4378, ADR-0030) — binds
 * the `catalog:notion-knowledge` catalog row to the {@link NotionVendorClient}
 * the shared engine drives. The engine (`connector-sync.ts`) owns everything
 * else; this file is only the catalog↔client seam plus the vendor's identity
 * constants (the one home the install handler, catalog seed, and admin route
 * all import).
 *
 * `createClient` reads the workspace's internal-integration token from the
 * shared `knowledge_sync_credentials` store (the bundle-sync credential seam,
 * reused per PRD #4375) and constructs a version-pinned HTTP client. A missing
 * or undecryptable credential throws with an actionable message — the engine
 * surfaces it on `/admin/knowledge` as that collection's error, never a silent
 * unauthenticated fetch.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { readSyncCredential } from "../sync-credentials";
import {
  getKnowledgeSyncConnector,
  registerKnowledgeSyncConnector,
  type ConnectorInstallContext,
  type ConnectorVendorClient,
  type KnowledgeSyncConnector,
} from "../connectors";
import { NotionHttpClient } from "./http";
import { NotionVendorClient } from "./client";

const log = createLogger("knowledge.notion.connector");

/** The plugin_catalog slug (distinct from the `notion-data` REST datasource). */
export const NOTION_KNOWLEDGE_SLUG = "notion-knowledge";
/** The catalog row id = the cycle-walk dispatch key. */
export const NOTION_KNOWLEDGE_CATALOG_ID = "catalog:notion-knowledge";
/** The vendor slug stamped into `atlas_source` as `connector:notion`. */
export const NOTION_VENDOR = "notion";

/** Build the vendor client for one installed Notion collection. */
async function createNotionClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
  // Throws on decrypt failure (rotated key / corrupt ciphertext) — the sync
  // must fail loudly, never fetch unauthenticated (a 401 would mask the cause).
  const token = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
  if (token === null || token.trim() === "") {
    throw new Error(
      "This Notion collection has no integration token stored — re-install it with a valid internal-integration token (Admin → Integrations → Notion).",
    );
  }
  return new NotionVendorClient({ http: new NotionHttpClient({ token }) });
}

/** The registered connector for the built-in Notion knowledge catalog row. */
export const notionKnowledgeConnector: KnowledgeSyncConnector = {
  catalogId: NOTION_KNOWLEDGE_CATALOG_ID,
  vendor: NOTION_VENDOR,
  createClient: createNotionClient,
};

/**
 * Register the Notion connector idempotently — safe to call from the boot seam
 * that also registers install handlers (and from tests). `registerKnowledge...`
 * throws on a duplicate catalog id, so gate on the registry first.
 */
export function registerNotionKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(NOTION_KNOWLEDGE_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(notionKnowledgeConnector);
  log.info({ catalogId: NOTION_KNOWLEDGE_CATALOG_ID }, "Registered Notion knowledge sync connector");
}
