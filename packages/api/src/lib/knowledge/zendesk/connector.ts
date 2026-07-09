/**
 * The Zendesk Guide {@link KnowledgeSyncConnector} (#4396, PRD #4395) — the
 * catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * factory contract from ADR-0030: bind the stored per-brand config + the
 * decrypted token into a vendor client. Scheduling, backoff, reconciliation,
 * caps, and ingest are the shared engine's.
 *
 * One Zendesk install fans out to one collection PER BRAND (the install
 * handler's job); each collection row carries its brand's subdomain, so this
 * factory builds a client scoped to exactly one brand's help center.
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
import { createZendeskVendorClient, type ZendeskClientDeps } from "./client";
import { ZENDESK_CATALOG_ID, ZENDESK_VENDOR, parseZendeskConfig } from "./config";

const log = createLogger("knowledge.zendesk.connector");

export interface ZendeskConnectorDeps {
  /** Injected fetch for tests — threaded into the vendor client. */
  readonly clientDeps?: ZendeskClientDeps;
}

/** Build the Zendesk connector. `deps` is test-only vendor-client injection. */
export function createZendeskConnector(
  deps: ZendeskConnectorDeps = {},
): KnowledgeSyncConnector {
  return {
    catalogId: ZENDESK_CATALOG_ID,
    vendor: ZENDESK_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseZendeskConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      // Decrypt failure THROWS here (loud) — the engine turns it into the
      // collection's error outcome, never a silent unauthenticated fetch.
      const apiToken = await readSyncCredential(ctx.workspaceId, ctx.collectionSlug);
      if (apiToken === null) {
        throw new Error(
          "This Zendesk collection has no stored API token — re-install it to re-enter the token.",
        );
      }

      return createZendeskVendorClient(
        {
          brandSubdomain: parsed.brandSubdomain,
          email: parsed.email,
          apiToken,
          collectionSlug: ctx.collectionSlug,
        },
        deps.clientDeps ?? {},
      );
    },
  };
}

/**
 * Register the Zendesk connector idempotently — called from the boot seam
 * that also registers install handlers (`registerBuiltinInstallHandlers`), and
 * from tests. `registerKnowledgeSyncConnector` throws on a duplicate catalog
 * id, so gate on the registry first.
 */
export function registerZendeskKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(ZENDESK_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createZendeskConnector());
  log.info({ catalogId: ZENDESK_CATALOG_ID }, "Registered Zendesk knowledge sync connector");
}
