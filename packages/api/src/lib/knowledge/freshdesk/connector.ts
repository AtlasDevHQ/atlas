/**
 * The Freshdesk Solutions {@link KnowledgeSyncConnector} (#4401, PRD #4395) —
 * the catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * factory contract from ADR-0030: bind the stored per-category config + the
 * decrypted API key into a vendor client. Scheduling, backoff, reconciliation,
 * caps, and ingest are the shared engine's.
 *
 * One Freshdesk install fans out to one collection PER SOLUTIONS CATEGORY (the
 * install handler's job); each collection row carries its category id, so this
 * factory builds a client scoped to exactly one category's folder→article tree.
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
import { createFreshdeskVendorClient, type FreshdeskClientDeps } from "./client";
import { FRESHDESK_CATALOG_ID, FRESHDESK_VENDOR, parseFreshdeskConfig } from "./config";

const log = createLogger("knowledge.freshdesk.connector");

export interface FreshdeskConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: FreshdeskClientDeps;
}

/** Build the Freshdesk connector. `deps` is test-only vendor-client injection. */
export function createFreshdeskConnector(
  deps: FreshdeskConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: FRESHDESK_CATALOG_ID,
    vendor: FRESHDESK_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseFreshdeskConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiKey = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiKey === null) {
        throw new Error(
          "This Freshdesk collection has no stored API key — re-install it to re-enter the key.",
        );
      }

      return createFreshdeskVendorClient(
        {
          subdomain: parsed.subdomain,
          categoryId: parsed.categoryId,
          categoryName: parsed.categoryName,
          apiKey,
          collectionSlug: ctx.collectionSlug,
        },
        // Bound the vendor fetch by the EFFECTIVE per-sync cap, not the raw
        // platform ceiling — otherwise a lower-tier workspace pulls documents
        // it can never ingest, every sync (#4235).
        { ...(deps.clientDeps ?? {}), maxDocs: ctx.maxDocs },
      );
    },
  };
}

/**
 * Register the Freshdesk connector idempotently — called from the boot seam
 * that also registers install handlers (`registerBuiltinInstallHandlers`), and
 * from tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog
 * id, so gate on the registry first.
 */
export function registerFreshdeskKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(FRESHDESK_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createFreshdeskConnector());
  log.info(
    { catalogId: FRESHDESK_CATALOG_ID },
    "Registered Freshdesk knowledge sync connector",
  );
}
