/**
 * The Confluence {@link KnowledgeSyncConnector} (#4377, PRD #4375) — the
 * catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * three-line factory contract from ADR-0030: bind the stored config + the
 * decrypted token into a vendor client. Scheduling, backoff, reconciliation,
 * caps, and ingest are the shared engine's.
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
import { createConfluenceVendorClient, type ConfluenceClientDeps } from "./client";
import { CONFLUENCE_CATALOG_ID, CONFLUENCE_VENDOR, parseConfluenceConfig } from "./config";

const log = createLogger("knowledge.confluence.connector");

export interface ConfluenceConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: ConfluenceClientDeps;
}

/** Build the Confluence connector. `deps` is test-only vendor-client injection. */
export function createConfluenceConnector(
  deps: ConfluenceConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: CONFLUENCE_CATALOG_ID,
    vendor: CONFLUENCE_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseConfluenceConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiToken = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiToken === null) {
        throw new Error(
          "This Confluence collection has no stored API token — re-install it to re-enter the token.",
        );
      }

      return createConfluenceVendorClient(
        {
          baseUrl: parsed.baseUrl,
          email: parsed.email,
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
 * Register the Confluence connector idempotently — called from the boot seam
 * that also registers install handlers (`registerBuiltinInstallHandlers`), and
 * from tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog id,
 * so gate on the registry first.
 */
export function registerConfluenceKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(CONFLUENCE_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createConfluenceConnector());
  log.info({ catalogId: CONFLUENCE_CATALOG_ID }, "Registered Confluence knowledge sync connector");
}
