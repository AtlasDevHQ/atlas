/**
 * The Help Scout Docs {@link KnowledgeSyncConnector} (#4398, PRD #4395) — the
 * catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * factory contract from ADR-0030: bind the stored per-site config + the
 * decrypted Docs API key into a vendor client. Scheduling, backoff,
 * reconciliation, caps, and ingest are the shared engine's.
 *
 * One Help Scout install fans out to one collection PER SITE (the install
 * handler's job); each collection row carries its site id, so this factory
 * builds a client scoped to exactly one Docs Site.
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
import { createHelpScoutVendorClient, type HelpScoutClientDeps } from "./client";
import { HELPSCOUT_CATALOG_ID, HELPSCOUT_VENDOR, parseHelpScoutConfig } from "./config";

const log = createLogger("knowledge.helpscout.connector");

export interface HelpScoutConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: HelpScoutClientDeps;
}

/** Build the Help Scout connector. `deps` is test-only vendor-client injection. */
export function createHelpScoutConnector(
  deps: HelpScoutConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: HELPSCOUT_CATALOG_ID,
    vendor: HELPSCOUT_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseHelpScoutConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiKey = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiKey === null) {
        throw new Error(
          "This Help Scout collection has no stored Docs API key — re-install it to re-enter the key.",
        );
      }

      return createHelpScoutVendorClient(
        {
          siteId: parsed.siteId,
          apiKey,
          collectionSlug: ctx.collectionSlug,
        },
        deps.clientDeps ?? {},
      );
    },
  };
}

/**
 * Register the Help Scout connector idempotently — called from the boot seam
 * that also registers install handlers (`registerBuiltinInstallHandlers`), and
 * from tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog
 * id, so gate on the registry first.
 */
export function registerHelpScoutKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(HELPSCOUT_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createHelpScoutConnector());
  log.info({ catalogId: HELPSCOUT_CATALOG_ID }, "Registered Help Scout knowledge sync connector");
}
