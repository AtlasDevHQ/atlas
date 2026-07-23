/**
 * The Intercom {@link KnowledgeSyncConnector} (#4399, PRD #4395) — the
 * catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * factory contract from ADR-0030: bind the stored config + the decrypted token
 * into a vendor client. Scheduling, backoff, reconciliation, caps, and ingest
 * are the shared engine's.
 *
 * `createClient` is where a bad/missing/undecryptable credential becomes an
 * actionable error surfaced on `/admin/knowledge`: `readSyncCredential` THROWS
 * on a decrypt failure (a rotated key, corrupt ciphertext) — loud, never a
 * silent unauthenticated fetch — and a missing row is a clear "re-install"
 * message. Intercom has no per-collection scope (one workspace = one
 * collection), so there is nothing to parse from `config`.
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
import { createIntercomVendorClient, type IntercomClientDeps } from "./client";
import { INTERCOM_CATALOG_ID, INTERCOM_VENDOR } from "./config";

const log = createLogger("knowledge.intercom.connector");

export interface IntercomConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: IntercomClientDeps;
}

/** Build the Intercom connector. `deps` is test-only vendor-client injection. */
export function createIntercomConnector(
  deps: IntercomConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: INTERCOM_CATALOG_ID,
    vendor: INTERCOM_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiToken = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiToken === null) {
        throw new Error(
          "This Intercom collection has no stored access token — re-install it to re-enter the token.",
        );
      }

      return createIntercomVendorClient(
        {
          apiToken,
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
 * Register the Intercom connector idempotently — called from the boot seam that
 * also registers install handlers (`registerBuiltinInstallHandlers`), and from
 * tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog id, so
 * gate on the registry first.
 */
export function registerIntercomKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(INTERCOM_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createIntercomConnector());
  log.info({ catalogId: INTERCOM_CATALOG_ID }, "Registered Intercom knowledge sync connector");
}
