/**
 * Knowledge bundle sync engine (#4211, ADR-0028 §5 follow-up) — "fetch, then
 * ingest". A synced collection (a `bundle-sync` install) points at an endpoint
 * serving its OKF bundle as a `.tar` / `.tar.gz` / `.zip` (including GitHub /
 * GitLab repo-archive URLs); this module pulls it and re-runs the #4207 ingest
 * so the diff falls out of upsert-by-path. NOTE: path identity includes the
 * archive's top-level folder — repo BRANCH archives (stable `repo-main/`
 * prefix) diff cleanly across pulls, but a moving prefix (tag/commit archive
 * URLs) changes every path and archives-and-recreates the whole tree each
 * sync. Point synced collections at branch archives or a stable-layout
 * endpoint.
 *
 * The diff:
 *
 *   - unchanged docs no-op, changed published docs demote to `draft`, new docs
 *     insert as `draft` (`ingestBundle` → `ingestBundleIntoCollection`, source `bundle-sync`);
 *   - paths ABSENT from the fetched bundle are ARCHIVED — never hard-deleted
 *     (the same posture as uninstall, ADR-0028 §5). Files the bundle DID carry
 *     but that failed extraction/parsing (oversize, malformed frontmatter)
 *     are NOT treated as absent — a transiently-broken file must not archive
 *     its previously-reviewed document.
 *
 * **No publish path exists here — structurally.** Synced content always lands
 * `draft` (ADR-0028 §4: connector-style ingest has no upload-&-publish
 * shortcut). This module never imports the content-mode registry and never
 * writes `status='published'` (a test pins both), and the shared
 * `ingestBundle` seam itself rejects `publish` for non-upload sources.
 *
 * **The fetched bundle is third-party input**, so the fetch is hardened on top
 * of the #4207 ingest caps (which all still apply — doc cap, per-doc bytes,
 * decompression-bomb streaming abort):
 *   - SSRF: every request goes through `guardedFetch` (`openapi/egress-guard`)
 *     — private/loopback/link-local/internal targets are blocked at the initial
 *     URL AND at every redirect hop, and the auth header is stripped on
 *     cross-origin redirects (exactly what a git-forge archive redirect needs).
 *   - Size: the response is rejected on a too-large `Content-Length` and the
 *     body is STREAMED with a cumulative cap (`ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES`)
 *     so a lying/chunked endpoint can't buffer unbounded bytes.
 *   - Time: the whole fetch (redirects + body) runs under an `AbortSignal`
 *     budget (`ATLAS_KNOWLEDGE_SYNC_FETCH_TIMEOUT_SECONDS`).
 *   - Per-file errors are surfaced in the sync report, never silently skipped.
 *   - An EMPTY / doc-less bundle is a whole-sync error with NO writes — a
 *     misbehaving endpoint must not archive an entire collection.
 *
 * Every sync attempt (success or error) upserts one `knowledge_sync_state`
 * row per collection — the `/admin/knowledge` list reads the time/status/error
 * columns (#4209 coordination); the JSONB `report` (counts + capped per-file
 * rejections) is persisted for a fuller drill-down surface (no reader yet).
 * Error messages are host-redacted at construction so a credentialed URL can
 * never leak into state rows or logs.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { KnowledgeBundleFormat, KnowledgeIngestDocumentCounts } from "@useatlas/types";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  guardedFetch,
  hostForLog,
  EgressBlockedError,
} from "@atlas/api/lib/openapi/egress-guard";
import type { BundleEntryError } from "./bundle-archive";
import { readBodyWithCap, BodyCapExceededError } from "./read-body-cap";
import type { IngestReport } from "./ingest";
import { ingestBundle } from "./ingest-bundle";
import { positiveIntSetting } from "./ingest-limits";
import {
  capIsOperatorTunable,
  resolveIngestCaps,
  type CapBoundBy,
  type EffectiveIngestCaps,
} from "@atlas/api/lib/billing/knowledge-limits";
import { readSyncCredential } from "./sync-credentials";
import {
  getKnowledgeSyncConnector,
  listKnowledgeSyncConnectorCatalogIds,
} from "./connectors";
import { syncConnectorCollection } from "./connector-sync";
import {
  BUNDLE_SYNC_CATALOG_ID,
  parseBundleSyncConfig,
  type BundleSyncAuthScheme,
} from "@atlas/api/lib/integrations/install/bundle-sync-form-handler";

const log = createLogger("knowledge.sync");

/**
 * Name the lever a sync-state error line should point at (#4235). A sync
 * surfaces a status row, not an HTTP response, so there is no upgrade envelope
 * here — only honest wording. `capIsOperatorTunable` is the shared rule: the
 * plain "limit" wording is reserved for the operator-tunable case, because on
 * SaaS even a platform-bound refusal is a plan ceiling to the reader.
 */
function capOwner(boundBy: CapBoundBy): string {
  return capIsOperatorTunable(boundBy) ? "limit" : "limit on your plan";
}

export const DEFAULT_SYNC_FETCH_TIMEOUT_SECONDS = 60;

/** Bound the per-file rejection list persisted in `knowledge_sync_state.report`. */
const REPORT_REJECTED_CAP = 50;

/**
 * The per-collection sync bookkeeping upsert, keyed on the migration-0164
 * primary key. The `WHERE EXISTS` guard skips the write entirely when the
 * install is gone (uninstall archives it and hard-deletes its sync state), so
 * a sync racing an uninstall can't re-create the row the uninstall just
 * deleted. (A sub-millisecond interleaving — the uninstall's DELETE executing
 * between this statement's read and its commit — can still leave a state row
 * behind, but it is keyed to an archived install the list route never joins,
 * so it is invisible and harmless.) Exported for the real-Postgres test.
 */
export const SYNC_STATE_UPSERT_SQL = `INSERT INTO knowledge_sync_state
         (workspace_id, collection_id, last_sync_at, status, error, report, created_at, updated_at)
       SELECT $1, $2, NOW(), $3, $4, $5::jsonb, NOW(), NOW()
        WHERE EXISTS (SELECT 1 FROM workspace_plugins
                       WHERE workspace_id = $1 AND install_id = $2
                         AND pillar = 'knowledge' AND status <> 'archived')
       ON CONFLICT (workspace_id, collection_id) DO UPDATE
         SET last_sync_at = NOW(),
             status = EXCLUDED.status,
             error = EXCLUDED.error,
             report = EXCLUDED.report,
             updated_at = NOW()`;

/** Per-sync fetch time budget (ms), settings-registry driven. */
export function getKnowledgeSyncFetchTimeoutMs(): number {
  return (
    positiveIntSetting(
      "ATLAS_KNOWLEDGE_SYNC_FETCH_TIMEOUT_SECONDS",
      getSettingAuto("ATLAS_KNOWLEDGE_SYNC_FETCH_TIMEOUT_SECONDS"),
      DEFAULT_SYNC_FETCH_TIMEOUT_SECONDS,
    ) * 1000
  );
}

/**
 * Outcome of one sync attempt. `status: "error"` carries an actionable,
 * host-redacted `error`; the ingest fields are null when the sync failed
 * before (or during) ingest. Document counts reuse the ingest wire shape
 * (`KnowledgeIngestDocumentCounts` from `@useatlas/types`) — sync IS an
 * ingest, so the counts are the same vocabulary.
 */
export interface KnowledgeSyncOutcome {
  readonly collection: string;
  readonly status: "success" | "error";
  /** ISO-8601 completion time of this attempt. */
  readonly syncedAt: string;
  readonly error: string | null;
  readonly format: KnowledgeBundleFormat | null;
  readonly documents: KnowledgeIngestDocumentCounts | null;
  /** Previously-ingested docs archived because their path left the bundle. */
  readonly archivedAbsent: number | null;
  readonly linksWritten: number | null;
  /** Per-file rejections (unsafe path, oversize, malformed frontmatter). */
  readonly rejected: ReadonlyArray<BundleEntryError>;
}

export interface SyncCollectionParams {
  readonly workspaceId: string;
  /** The collection slug (= `workspace_plugins.install_id`). */
  readonly collectionSlug: string;
  /** The install row's config (endpoint_url / auth_scheme). */
  readonly config: Record<string, unknown> | null;
  /** Test-only fetch injection, forwarded to `guardedFetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test-only clock. */
  readonly now?: () => Date;
}

/**
 * Sync one collection end-to-end and record the attempt in
 * `knowledge_sync_state`. Never throws — every failure becomes a
 * `status: "error"` outcome (and an error state row) so a scheduler cycle
 * survives any single bad endpoint. The catch below makes that claim
 * structural: even a defect escaping `runSyncAttempt` (a settings/parse
 * regression) still lands an error state row, so the admin surface can never
 * keep showing a stale "success" for a sync that is silently failing.
 */
export async function syncCollection(params: SyncCollectionParams): Promise<KnowledgeSyncOutcome> {
  const { workspaceId, collectionSlug } = params;
  const now = params.now ?? (() => new Date());

  let attempt: SyncAttempt;
  try {
    attempt = await runSyncAttempt(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { workspaceId, collectionSlug, err: msg },
      "Knowledge bundle sync attempt threw past its internal handling — recording an error state",
    );
    attempt = {
      kind: "error",
      error: `Sync failed unexpectedly: ${msg}. Retry "Sync now"; if it persists, check the API logs.`,
      rejected: [],
    };
  }
  const syncedAt = now().toISOString();
  const outcome: KnowledgeSyncOutcome =
    attempt.kind === "ok"
      ? {
          collection: collectionSlug,
          status: "success",
          syncedAt,
          error: null,
          format: attempt.format,
          documents: {
            created: attempt.report.created,
            updated: attempt.report.updated,
            demoted: attempt.report.demoted,
            resurrected: attempt.report.resurrected,
            unchanged: attempt.report.unchanged,
            total: attempt.report.documents,
          },
          archivedAbsent: attempt.archivedAbsent,
          linksWritten: attempt.report.linksWritten,
          rejected: attempt.rejected,
        }
      : {
          collection: collectionSlug,
          status: "error",
          syncedAt,
          error: attempt.error,
          format: null,
          documents: null,
          archivedAbsent: null,
          linksWritten: null,
          rejected: attempt.rejected,
        };

  await recordSyncState(workspaceId, collectionSlug, outcome);

  // Mirror invalidation is owned by the shared `ingestBundle` seam (it fires
  // exactly when the committed write changed something visible), so scheduled
  // and manual syncs get it without a route hook.

  if (outcome.status === "success") {
    log.info(
      { workspaceId, collectionSlug, ...outcome.documents, archivedAbsent: outcome.archivedAbsent, rejected: outcome.rejected.length },
      "Knowledge bundle sync succeeded",
    );
  } else {
    log.warn(
      { workspaceId, collectionSlug, error: outcome.error },
      "Knowledge bundle sync failed",
    );
  }
  return outcome;
}

type SyncAttempt =
  | {
      readonly kind: "ok";
      readonly format: KnowledgeBundleFormat;
      readonly report: IngestReport;
      readonly archivedAbsent: number;
      readonly rejected: ReadonlyArray<BundleEntryError>;
    }
  | {
      readonly kind: "error";
      readonly error: string;
      readonly rejected: ReadonlyArray<BundleEntryError>;
    };

async function runSyncAttempt(params: SyncCollectionParams): Promise<SyncAttempt> {
  const { workspaceId, collectionSlug, config } = params;

  // ── Resolve endpoint + auth from the install config ──────────────────────
  // The install handler owns the config shape; this shared parser keeps the
  // JSONB field names from being re-derived by hand here (a rename would
  // compile clean and silently break every sync).
  const parsedConfig = parseBundleSyncConfig(config);
  if (!parsedConfig.ok) {
    return { kind: "error", error: parsedConfig.error, rejected: [] };
  }
  const { endpointUrl, authScheme } = parsedConfig;

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(workspaceId, collectionSlug, authScheme);
  } catch (err) {
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
      rejected: [],
    };
  }

  // ── Fetch (SSRF-guarded, time-budgeted, size-capped) ─────────────────────
  // The download cap is the workspace's EFFECTIVE cap — `min(platform ceiling,
  // plan tier)` (#4235) — so a synced collection can't pull past what an upload
  // of the same size would be refused. Resolved once and handed to
  // `ingestBundle` below so both stages agree. A tier-lookup fault throws
  // (`check_failed`); it is deliberately NOT caught here — `syncCollection`'s
  // outer net records it as an error state, so the failure is surfaced once
  // with its own message rather than reworded into a cap error it isn't.
  const caps: EffectiveIngestCaps = await resolveIngestCaps(workspaceId);
  const maxBundleBytes = caps.maxBundleBytes.value;
  const timeoutMs = getKnowledgeSyncFetchTimeoutMs();
  const host = hostForLog(endpointUrl);

  let bytes: Uint8Array;
  try {
    const response = await guardedFetch(
      endpointUrl,
      { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) },
      params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
    );
    if (!response.ok) {
      return {
        kind: "error",
        error: `Bundle endpoint "${host}" responded HTTP ${response.status} — check the URL and auth configuration.`,
        rejected: [],
      };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBundleBytes) {
      return {
        kind: "error",
        error: `Bundle from "${host}" declares ${declared} bytes, over the ${maxBundleBytes}-byte ${capOwner(caps.maxBundleBytes.boundBy)}.`,
        rejected: [],
      };
    }
    bytes = await readBodyWithCap(response.body, maxBundleBytes, { host });
  } catch (err) {
    // `EgressBlockedError` (SSRF block) carries a host-redacted, actionable
    // message by construction — pass it through. The shared cap error carries
    // no source details, so it is rebuilt around the host here. EVERY other
    // error (DNS, TLS, connection reset, abort) is rebuilt around the host so
    // a credentialed URL can never reach the state row, folding in the
    // narrowed `cause` (undici buries the useful part there — a bare "fetch
    // failed" wraps the real ECONNREFUSED/ENOTFOUND).
    if (err instanceof EgressBlockedError) {
      return { kind: "error", error: err.message, rejected: [] };
    }
    if (err instanceof BodyCapExceededError) {
      return {
        kind: "error",
        error: `Bundle from "${host}" exceeds the ${maxBundleBytes}-byte ${capOwner(caps.maxBundleBytes.boundBy)} — download aborted.`,
        rejected: [],
      };
    }
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return {
        kind: "error",
        error: `Fetching the bundle from "${host}" exceeded the ${timeoutMs / 1000}s time budget.`,
        rejected: [],
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg =
      err instanceof Error && err.cause instanceof Error && err.cause.message !== ""
        ? ` (${err.cause.message})`
        : "";
    return {
      kind: "error",
      error: `Fetching the bundle from "${host}" failed: ${msg}${causeMsg} — check the endpoint is reachable and serving the archive.`,
      rejected: [],
    };
  }

  // ── Ingest through the shared seam (`ingestBundle` owns extract → parse →
  // caps → transaction → archive-absent → mirror invalidation; the #4207 caps
  // + per-file rejections all apply). This engine is the sync disposition
  // adapter: every failure kind maps to a `status:"error"` outcome with
  // endpoint-appropriate wording — never an HTTP status, never a throw.
  let outcome: Awaited<ReturnType<typeof ingestBundle>>;
  try {
    outcome = await ingestBundle({
      caps,
      workspaceId,
      collectionId: collectionSlug,
      source: "bundle-sync",
      bytes,
      // The endpoint owns the tree: paths absent from the fetched bundle are
      // archived (never hard-deleted). NO publish option exists on this path —
      // `ingestBundle` itself rejects publish for non-upload sources (ADR-0028 §4).
      archiveAbsent: true,
    });
  } catch (err) {
    log.error(
      { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
      "Knowledge bundle sync ingest transaction failed",
    );
    return {
      kind: "error",
      error: `Ingest failed after a successful fetch: ${err instanceof Error ? err.message : String(err)}`,
      rejected: [],
    };
  }

  switch (outcome.kind) {
    case "ok":
      return {
        kind: "ok",
        format: outcome.format,
        report: outcome.report,
        archivedAbsent: outcome.archivedAbsent ?? 0,
        rejected: outcome.rejected,
      };
    case "install_gone":
      // Uninstall × in-flight sync race: the pre-fetch check saw a live
      // install, the uninstall landed during the fetch window, and the seam's
      // in-transaction FOR UPDATE re-check aborted before any write — nothing
      // resurrected, no sync bookkeeping re-created.
      log.warn(
        { workspaceId, collectionSlug },
        "Knowledge bundle sync aborted — the collection was uninstalled mid-sync; no writes applied",
      );
      return {
        kind: "error",
        error: "The collection was uninstalled while the sync was running — no changes were applied.",
        rejected: outcome.rejected,
      };
    case "empty_bundle":
      return {
        kind: "error",
        error: `Bundle endpoint "${host}" returned an empty body — nothing was synced.`,
        rejected: [],
      };
    case "bundle_too_large":
      // Normally unreachable — `readBodyWithCap` already aborts an over-cap
      // stream — but the seam reports it, so map it.
      return {
        kind: "error",
        error: `Bundle from "${host}" is ${outcome.bytes} bytes, over the ${outcome.maxBundleBytes}-byte ${capOwner(outcome.boundBy)}.`,
        rejected: [],
      };
    case "invalid_bundle":
      return { kind: "error", error: outcome.message, rejected: [] };
    case "too_many_documents":
      return {
        kind: "error",
        error: `Bundle has ${outcome.count} documents, over the ${outcome.maxDocs}-document ${capOwner(outcome.boundBy)}.`,
        rejected: outcome.rejected,
      };
    case "no_documents":
      // Refuse to act on a doc-less bundle: proceeding would have archived the
      // ENTIRE collection off one bad response (a wrong URL, an HTML error page
      // that happened to be a valid archive, an emptied repo). `ingestBundle`
      // fails before any write.
      return {
        kind: "error",
        error:
          outcome.rejected.length > 0
            ? "No ingestable documents — every file in the fetched bundle was rejected (see the per-file errors). Nothing was changed."
            : "The fetched bundle contains no markdown documents. Nothing was changed.",
        rejected: outcome.rejected,
      };
  }
}

/**
 * Build the request headers for the configured auth scheme. Bearer sends the
 * secret as `Authorization: Bearer <token>`; basic expects a `user:password`
 * secret and base64-encodes it. A scheme that requires a secret but has no
 * credential row (or an undecryptable one) fails loudly — silently fetching a
 * private endpoint unauthenticated would surface as a misleading 401.
 */
async function buildAuthHeaders(
  workspaceId: string,
  collectionSlug: string,
  authScheme: BundleSyncAuthScheme,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept: "*/*" };
  if (authScheme === "none") return headers;
  let secret: string | null;
  try {
    secret = await readSyncCredential(workspaceId, collectionSlug);
  } catch (err) {
    log.error(
      { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
      "Knowledge sync credential could not be decrypted",
    );
    throw new Error(
      "The collection's auth secret could not be decrypted — re-enter it by editing the collection.",
      { cause: err },
    );
  }
  if (secret === null) {
    throw new Error(
      `The collection is configured for ${authScheme} auth but has no stored secret — edit the collection and re-enter it.`,
    );
  }
  headers.authorization =
    authScheme === "bearer"
      ? `Bearer ${secret}`
      : `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
  return headers;
}

/**
 * Upsert the per-collection sync bookkeeping row. Never throws — a state-write
 * failure must not fail a sync that already committed (it is logged at error
 * so a persistently broken state table is visible).
 */
async function recordSyncState(
  workspaceId: string,
  collectionSlug: string,
  outcome: KnowledgeSyncOutcome,
): Promise<void> {
  // Error outcomes keep their (capped) per-file rejections too — several
  // error messages point the admin at "the per-file errors", so they must
  // actually be persisted somewhere the surface can read.
  const report =
    outcome.status === "success"
      ? {
          format: outcome.format,
          documents: outcome.documents,
          archivedAbsent: outcome.archivedAbsent,
          linksWritten: outcome.linksWritten,
          rejected: outcome.rejected.slice(0, REPORT_REJECTED_CAP),
        }
      : outcome.rejected.length > 0
        ? { rejected: outcome.rejected.slice(0, REPORT_REJECTED_CAP) }
        : null;
  try {
    await internalQuery(SYNC_STATE_UPSERT_SQL, [
      workspaceId,
      collectionSlug,
      outcome.status,
      outcome.error,
      report === null ? null : JSON.stringify(report),
    ]);
  } catch (err) {
    log.error(
      { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
      "Failed to record knowledge sync state — the sync outcome itself is unaffected",
    );
  }
}

// ---------------------------------------------------------------------------
// Cycle — walk every enabled synced collection (the scheduler tick body).
// Dispatch is keyed on catalog id (#4376): `bundle-sync` installs pull their
// endpoint through this module's fetch path; installs of a REGISTERED
// Knowledge Sync Connector catalog row go through the connector engine
// (`connector-sync.ts` — incremental/reconciliation cadence, high-water
// marks, 429 backoff). Both engines isolate per-collection failures, so one
// bad endpoint/vendor never blocks the cycle's remaining collections.
// ---------------------------------------------------------------------------

export interface KnowledgeSyncCycleResult {
  /** Enabled synced installs (bundle-sync + connector) inspected this cycle. */
  readonly inspected: number;
  readonly succeeded: number;
  readonly failed: number;
  /**
   * True when the installs query itself failed — the zero counts then mean
   * "couldn't look", not "nothing to sync". Callers (the scheduler span, the
   * heartbeat log) must not present such a cycle as an idle success.
   */
  readonly queryFailed: boolean;
}

interface SyncInstallRow extends Record<string, unknown> {
  workspace_id: string;
  install_id: string;
  catalog_id: string;
  config: Record<string, unknown> | null;
}

/**
 * The cycle's install listing — every enabled, non-archived install of a
 * synced catalog row (`bundle-sync` + registered connectors), ordered for
 * deterministic walks. Exported for the real-Postgres test so the WHERE
 * predicates are executed, not just asserted as a string.
 */
export const SYNC_CYCLE_INSTALLS_SQL = `SELECT workspace_id, install_id, catalog_id, config
         FROM workspace_plugins
        WHERE catalog_id = ANY($1::text[]) AND pillar = 'knowledge'
          AND enabled = true AND status <> 'archived'
        ORDER BY workspace_id ASC, install_id ASC`;

/**
 * Run one sync pass over every enabled, non-archived synced install.
 * Sequential (one endpoint/vendor at a time — a slow tenant can't starve
 * another's connection pool slot), per-collection failures isolated. Never
 * throws.
 */
export async function runKnowledgeSyncCycle(options?: {
  readonly fetchImpl?: typeof globalThis.fetch;
}): Promise<KnowledgeSyncCycleResult> {
  if (!hasInternalDB()) {
    return { inspected: 0, succeeded: 0, failed: 0, queryFailed: false };
  }

  const catalogIds = [BUNDLE_SYNC_CATALOG_ID, ...listKnowledgeSyncConnectorCatalogIds()];
  let installs: SyncInstallRow[];
  try {
    installs = await internalQuery<SyncInstallRow>(SYNC_CYCLE_INSTALLS_SQL, [catalogIds]);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Knowledge sync cycle: failed to query synced installs",
    );
    return { inspected: 0, succeeded: 0, failed: 0, queryFailed: true };
  }

  let succeeded = 0;
  let failed = 0;
  for (const install of installs) {
    // Neither engine throws; the belt-and-braces catch keeps a future
    // regression from sinking the remaining collections in the cycle.
    try {
      const status = await dispatchInstall(install, options);
      if (status === "success") succeeded++;
      else failed++;
    } catch (err) {
      failed++;
      log.error(
        {
          workspaceId: install.workspace_id,
          collectionSlug: install.install_id,
          catalogId: install.catalog_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Knowledge sync cycle: a sync engine threw past its internal catch",
      );
    }
  }

  if (installs.length > 0) {
    log.info({ inspected: installs.length, succeeded, failed }, "Knowledge sync cycle complete");
  }
  return { inspected: installs.length, succeeded, failed, queryFailed: false };
}

/** Route one install to its engine by catalog id. */
async function dispatchInstall(
  install: SyncInstallRow,
  options?: { readonly fetchImpl?: typeof globalThis.fetch },
): Promise<"success" | "error"> {
  if (install.catalog_id === BUNDLE_SYNC_CATALOG_ID) {
    const outcome = await syncCollection({
      workspaceId: install.workspace_id,
      collectionSlug: install.install_id,
      config: install.config,
      ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    return outcome.status;
  }
  const connector = getKnowledgeSyncConnector(install.catalog_id);
  if (connector === undefined) {
    // Unreachable through this walk (the install filter is built FROM the
    // registry) — but a registry mutation racing the cycle must be a counted,
    // visible failure, never a silent skip.
    log.error(
      { workspaceId: install.workspace_id, collectionSlug: install.install_id, catalogId: install.catalog_id },
      "Knowledge sync cycle: install's catalog id has no registered connector — skipping",
    );
    return "error";
  }
  const outcome = await syncConnectorCollection({
    connector,
    workspaceId: install.workspace_id,
    collectionSlug: install.install_id,
    config: install.config,
  });
  return outcome.status;
}

