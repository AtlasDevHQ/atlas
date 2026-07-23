/**
 * The GitBook {@link KnowledgeSyncConnector} (#4393, ADR-0030) — the
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
import { createGitbookVendorClient, type GitbookClientDeps } from "./client";
import { GITBOOK_CATALOG_ID, GITBOOK_VENDOR, parseGitbookConfig } from "./config";

const log = createLogger("knowledge.gitbook.connector");

export interface GitbookConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: GitbookClientDeps;
}

/** Build the GitBook connector. `deps` is test-only vendor-client injection. */
export function createGitbookConnector(
  deps: GitbookConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: GITBOOK_CATALOG_ID,
    vendor: GITBOOK_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseGitbookConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiToken = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiToken === null) {
        throw new Error(
          "This GitBook collection has no stored API token — re-install it to re-enter the token.",
        );
      }

      return createGitbookVendorClient(
        {
          spaceId: parsed.spaceId,
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
 * Register the GitBook connector idempotently — called from the boot seam that
 * also registers install handlers (`registerBuiltinInstallHandlers`), and from
 * tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog id, so
 * gate on the registry first.
 */
export function registerGitbookKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(GITBOOK_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createGitbookConnector());
  log.info({ catalogId: GITBOOK_CATALOG_ID }, "Registered GitBook knowledge sync connector");
}
