/**
 * The Confluence Data Center {@link KnowledgeSyncConnector} (#4394, PRD #4375) —
 * the catalog-id-keyed adapter the sync cycle dispatches on, the self-managed
 * sibling of the Cloud connector (`connector.ts`). It owns only the three-line
 * factory contract from ADR-0030: bind the stored config + the decrypted PAT
 * into a vendor client. Scheduling, backoff, reconciliation, caps, and ingest
 * are the shared engine's.
 *
 * `createClient` is where a bad/missing/undecryptable credential becomes an
 * actionable error surfaced on `/admin/knowledge`: `readSyncCredential` THROWS
 * on a decrypt failure (a rotated key, corrupt ciphertext) — loud, never a
 * silent unauthenticated fetch — and a missing row is a clear "re-install"
 * message.
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
import {
  createConfluenceDatacenterVendorClient,
  type ConfluenceDcClientDeps,
} from "./client-datacenter";
import {
  CONFLUENCE_DC_CATALOG_ID,
  CONFLUENCE_DC_VENDOR,
  parseConfluenceDcConfig,
} from "./config-datacenter";

const log = createLogger("knowledge.confluence.datacenter.connector");

export interface ConfluenceDcConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: ConfluenceDcClientDeps;
}

/** Build the Confluence Data Center connector. `deps` is test-only injection. */
export function createConfluenceDatacenterConnector(
  deps: ConfluenceDcConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: CONFLUENCE_DC_CATALOG_ID,
    vendor: CONFLUENCE_DC_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseConfluenceDcConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiToken = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiToken === null) {
        throw new Error(
          "This Confluence collection has no stored Personal Access Token — re-install it to re-enter the token.",
        );
      }

      return createConfluenceDatacenterVendorClient(
        {
          baseUrl: parsed.baseUrl,
          apiToken,
          spaceKey: parsed.spaceKey,
          collectionSlug: ctx.collectionSlug,
        },
        deps.clientDeps ?? {},
      );
    },
  };
}

/**
 * Register the Confluence Data Center connector idempotently — called from the
 * boot seam that also registers install handlers (`registerBuiltinInstallHandlers`),
 * and from tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog
 * id, so gate on the registry first.
 */
export function registerConfluenceDatacenterKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(CONFLUENCE_DC_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createConfluenceDatacenterConnector());
  log.info(
    { catalogId: CONFLUENCE_DC_CATALOG_ID },
    "Registered Confluence Data Center knowledge sync connector",
  );
}
