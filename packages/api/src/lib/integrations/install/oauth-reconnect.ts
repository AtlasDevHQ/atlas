/**
 * Shared `reconnect_needed` status seam for OAuth installs (#4188).
 *
 * `workspace_plugins.config.status` is the credential-health signal the
 * admin console reads to render the "Reconnect needed" CTA. Two flows
 * flip it, and both were copy-pasted per platform:
 *
 *   - **Install callback tail** — the three credential-bundle handlers
 *     (Jira / Salesforce / Linear) write `integration_credentials`
 *     SECOND (ADR-0003 two-store). If that write throws, the install
 *     row is already committed, so the handler flips
 *     `status: "reconnect_needed"` and returns
 *     `credentialResult.written: false`. This is the **fail-closed
 *     invariant**: an install can never present as "Installed" with no
 *     credential behind it. Consolidated here as
 *     {@link writeCredentialWithReconnectFallback}.
 *
 *   - **Token refresh** — the three refreshers
 *     (`{jira,linear,salesforce}-token-refresh.ts`) flip the same status
 *     on a permanent refresh failure and clear it on success. Their
 *     `markReconnectNeeded` / `clearReconnectNeeded` pairs were
 *     byte-identical apart from the catalog id and the platform name in
 *     the log line. Consolidated as the `(workspaceId, catalogId)`-keyed
 *     pair below.
 *
 * The `config || jsonb_build_object('status', …)` JSONB merge is an
 * upsert — unrelated config keys (cloudid, scopes, instance_url, …)
 * survive, and re-flipping is idempotent. Both UPDATEs are independent,
 * best-effort statements: a failure to flip/clear is logged and
 * swallowed (the caller has already thrown the tagged error or persisted
 * the fresh credentials), never propagated.
 *
 * @see ./types.ts — {@link CredentialResult} / {@link InstallRecord}
 * @see docs/adr/0003-two-store-chat-install-metadata-credentials.md
 * @see docs/adr/0005-integration-credentials-table.md
 */

import type { WorkspaceId } from "@useatlas/types";
import type { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { saveCredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CredentialBundle } from "@atlas/api/lib/integrations/credentials/store";
import type { CatalogId, CredentialResult, InstallRecord } from "./types";

type ReconnectLogger = Pick<ReturnType<typeof createLogger>, "info" | "warn">;

/**
 * Flip `workspace_plugins.config.status` to `"reconnect_needed"` for
 * `(workspaceId, catalogId)`. JSONB merge so unrelated config fields
 * survive. Best-effort: the install row vanishing between a credential
 * read and this UPDATE (concurrent disconnect) is rare but possible —
 * log + swallow, since the caller already surfaced the reconnect signal
 * via a thrown tagged error or a `written: false` result.
 */
export async function markReconnectNeeded(
  workspaceId: string,
  catalogId: string,
  log: Pick<ReturnType<typeof createLogger>, "warn">,
  failureLogMessage: string,
): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'reconnect_needed')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, catalogId],
    );
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      failureLogMessage,
    );
  }
}

/**
 * Clear the `reconnect_needed` marker (set `status: "ok"`) after a
 * successful refresh. Idempotent — a no-op JSONB merge when status was
 * already "ok". Best-effort: the refresh already persisted the fresh
 * credentials, so a failed clear is a cosmetic stale badge until the
 * next refresh, never a reason to fail the refresh (which would evict
 * the freshly-rotated cached plugin instance).
 */
export async function clearReconnectNeeded(
  workspaceId: string,
  catalogId: string,
  log: Pick<ReturnType<typeof createLogger>, "warn">,
  failureLogMessage: string,
): Promise<void> {
  try {
    await internalQuery(
      `UPDATE workspace_plugins
          SET config = config || jsonb_build_object('status', 'ok')
        WHERE workspace_id = $1 AND catalog_id = $2`,
      [workspaceId, catalogId],
    );
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      failureLogMessage,
    );
  }
}

export interface WriteCredentialWithReconnectFallbackArgs {
  readonly workspaceId: WorkspaceId;
  /** Full `plugin_catalog.id` FK ("catalog:jira") — the write + flip key. */
  readonly catalogId: string;
  /** Catalog slug ("jira") — the value echoed back in the return envelope. */
  readonly slug: CatalogId;
  readonly bundle: CredentialBundle;
  readonly installRecord: InstallRecord;
  readonly log: ReconnectLogger;
  /** Platform name composed into the log lines ("Jira" / "Salesforce" / "Linear"). */
  readonly displayName: string;
  /** Structured fields for the success `info` log (never secrets). `workspaceId` is added automatically. */
  readonly successLogFields?: Record<string, unknown>;
  /** Structured fields for the partial-failure `warn` log (never secrets). `workspaceId` + `err` are added automatically. */
  readonly failureLogFields?: Record<string, unknown>;
}

/**
 * ADR-0003 two-store SECOND write: persist the credential bundle to
 * `integration_credentials`, and on failure enforce the fail-closed
 * Reconnect invariant.
 *
 *   - Success → `credentialResult: { written: true }`.
 *   - Failure → the install row stays (never rolled back); flip
 *     `status: "reconnect_needed"` so the admin card surfaces a
 *     persistent Reconnect CTA (without it the callback's `?reconnect=`
 *     query param shows once then vanishes on the next page load), and
 *     return `credentialResult: { written: false, reason: … }`.
 *
 * The credential-write throw is the ONLY branch that flips status here —
 * a status-flip failure is itself best-effort (see
 * {@link markReconnectNeeded}). Returns the full handler envelope so the
 * caller's `handleCallback` tail is a single `return`.
 */
export async function writeCredentialWithReconnectFallback(
  args: WriteCredentialWithReconnectFallbackArgs,
): Promise<{
  readonly workspaceId: WorkspaceId;
  readonly catalogId: CatalogId;
  readonly installRecord: InstallRecord;
  readonly credentialResult: CredentialResult;
}> {
  const { workspaceId, catalogId, slug, bundle, installRecord, log, displayName } = args;
  try {
    await saveCredentialBundle(workspaceId, catalogId, bundle);
    log.info(
      { workspaceId, ...(args.successLogFields ?? {}) },
      `${displayName} install completed (both stores written)`,
    );
    return { workspaceId, catalogId: slug, installRecord, credentialResult: { written: true } };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.warn(
      { workspaceId, ...(args.failureLogFields ?? {}), err: errMessage },
      `${displayName} install record written but integration_credentials write failed — Reconnect required`,
    );
    // Flip status so the admin card surfaces a persistent Reconnect CTA.
    await markReconnectNeeded(
      workspaceId,
      catalogId,
      log,
      `Failed to mark ${displayName} install as reconnect_needed after credential write failure`,
    );
    return {
      workspaceId,
      catalogId: slug,
      installRecord,
      credentialResult: {
        written: false,
        reason: "Credential persist failed — admin should retry via Reconnect",
      },
    };
  }
}
