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

import { readSyncCredential } from "../sync-credentials";
import type {
  ConnectorInstallContext,
  ConnectorVendorClient,
  KnowledgeSyncConnector,
} from "../connectors";
import { createConfluenceVendorClient, type ConfluenceClientDeps } from "./client";
import { CONFLUENCE_CATALOG_ID, CONFLUENCE_VENDOR, parseConfluenceConfig } from "./config";

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
