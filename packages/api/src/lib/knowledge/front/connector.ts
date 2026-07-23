/**
 * The Front Knowledge Base {@link KnowledgeSyncConnector} (#4400, PRD #4395) —
 * the catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * factory contract from ADR-0030: bind the stored per-KB config + the decrypted
 * token into a vendor client. Scheduling, backoff, reconciliation, caps, and
 * ingest are the shared engine's.
 *
 * One Front install fans out to one collection PER KNOWLEDGE BASE (the install
 * handler's job); each collection row carries its KB id, so this factory builds
 * a client scoped to exactly one knowledge base.
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
import { createFrontVendorClient, type FrontClientDeps } from "./client";
import { FRONT_CATALOG_ID, FRONT_VENDOR, parseFrontConfig } from "./config";

const log = createLogger("knowledge.front.connector");

export interface FrontConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: FrontClientDeps;
}

/** Build the Front connector. `deps` is test-only vendor-client injection. */
export function createFrontConnector(
  deps: FrontConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: FRONT_CATALOG_ID,
    vendor: FRONT_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseFrontConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiToken = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiToken === null) {
        throw new Error(
          "This Front collection has no stored API token — re-install it to re-enter the token.",
        );
      }

      return createFrontVendorClient(
        {
          knowledgeBaseId: parsed.knowledgeBaseId,
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
 * Register the Front connector idempotently — called from the boot seam that
 * also registers install handlers (`registerBuiltinInstallHandlers`), and from
 * tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog id, so
 * gate on the registry first.
 */
export function registerFrontKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(FRONT_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createFrontConnector());
  log.info({ catalogId: FRONT_CATALOG_ID }, "Registered Front knowledge sync connector");
}
