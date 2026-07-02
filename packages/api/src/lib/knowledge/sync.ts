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
 *     insert as `draft` (`ingestBundleIntoCollection`, source `bundle-sync`);
 *   - paths ABSENT from the fetched bundle are ARCHIVED — never hard-deleted
 *     (the same posture as uninstall, ADR-0028 §5). Files the bundle DID carry
 *     but that failed extraction/parsing (oversize, malformed frontmatter)
 *     are NOT treated as absent — a transiently-broken file must not archive
 *     its previously-reviewed document.
 *
 * **No publish path exists here — structurally.** Synced content always lands
 * `draft` (ADR-0028 §4: connector-style ingest has no upload-&-publish
 * shortcut). This module never imports the content-mode registry and never
 * writes `status='published'`; a test pins that.
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
import {
  getInternalDB,
  hasInternalDB,
  internalQuery,
  type InternalPoolClient,
} from "@atlas/api/lib/db/internal";
import type { KnowledgeIngestDocumentCounts } from "@useatlas/types";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  guardedFetch,
  hostForLog,
  EgressBlockedError,
} from "@atlas/api/lib/openapi/egress-guard";
import { extractBundle, BundleFormatError, type BundleEntryError } from "./bundle-archive";
import { parseLenientBundle } from "./parse-lenient";
import {
  ingestBundleIntoCollection,
  type IngestClient,
  type IngestReport,
} from "./ingest";
import {
  getIngestMaxDocs,
  getIngestMaxDocBytes,
  getIngestMaxBundleBytes,
  positiveIntSetting,
} from "./ingest-limits";
import { readSyncCredential } from "./sync-credentials";
import {
  BUNDLE_SYNC_CATALOG_ID,
  parseBundleSyncConfig,
  type BundleSyncAuthScheme,
} from "@atlas/api/lib/integrations/install/bundle-sync-form-handler";

const log = createLogger("knowledge.sync");

export const DEFAULT_SYNC_FETCH_TIMEOUT_SECONDS = 60;

/** Bound the per-file rejection list persisted in `knowledge_sync_state.report`. */
const REPORT_REJECTED_CAP = 50;

/**
 * Archive every previously-ingested doc whose path is NOT in the fetched
 * bundle's present set (`$3` — parsed docs plus per-file rejections; a
 * present-but-broken file must not archive its reviewed document). Exported so
 * the real-Postgres test executes this exact string against the live schema.
 */
export const ARCHIVE_ABSENT_SQL = `UPDATE knowledge_documents
            SET status = 'archived', updated_at = NOW()
          WHERE workspace_id = $1 AND collection_id = $2 AND status <> 'archived'
            AND path <> ALL($3::text[])
          RETURNING id`;

/**
 * The per-collection sync bookkeeping upsert, keyed on the migration-0164
 * primary key. Exported for the real-Postgres test.
 */
export const SYNC_STATE_UPSERT_SQL = `INSERT INTO knowledge_sync_state
         (workspace_id, collection_id, last_sync_at, status, error, report, created_at, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5::jsonb, NOW(), NOW())
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
 * The response body was rejected mid-stream by the size cap. Message is
 * host-only at construction (never the path/query), so it may pass through the
 * fetch catch verbatim — same posture as `EgressBlockedError`.
 */
class BundleDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleDownloadError";
  }
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
  readonly format: "tar" | "tar.gz" | "zip" | null;
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

  // Bust the per-mode knowledge disk mirror (#4208, ADR-0028 §3) whenever a
  // sync actually changed documents, so the next `explore` call rebuilds the
  // `knowledge/` subtree from the DB — the same posture as the admin ingest /
  // uninstall routes. Scheduled syncs have no route hook, so the invalidation
  // must live here. An all-unchanged sync skips it (no churn).
  if (
    attempt.kind === "ok" &&
    attempt.report.created +
      attempt.report.updated +
      attempt.report.demoted +
      attempt.report.resurrected +
      attempt.archivedAbsent >
      0
  ) {
    try {
      // Lazy import (mirrors admin-knowledge.ts) so the scheduler's static
      // graph doesn't require `semantic/sync` at load time.
      const { invalidateOrgModeRoots } = await import("@atlas/api/lib/semantic/sync");
      invalidateOrgModeRoots(workspaceId);
    } catch (err) {
      log.warn(
        { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
        "Failed to invalidate knowledge mirror after sync — the agent may serve a stale knowledge/ subtree until the next rebuild",
      );
    }
  }

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
      readonly format: "tar" | "tar.gz" | "zip";
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
  const maxBundleBytes = getIngestMaxBundleBytes();
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
        error: `Bundle from "${host}" declares ${declared} bytes, over the ${maxBundleBytes}-byte limit.`,
        rejected: [],
      };
    }
    bytes = await readBodyWithCap(response, maxBundleBytes, host);
  } catch (err) {
    // `EgressBlockedError` (SSRF block) and `BundleDownloadError` (size cap)
    // carry host-redacted, actionable messages by construction — pass them
    // through. EVERY other error (DNS, TLS, connection reset, abort) is
    // rebuilt around the host so a credentialed URL can never reach the state
    // row, folding in the narrowed `cause` (undici buries the useful part
    // there — a bare "fetch failed" wraps the real ECONNREFUSED/ENOTFOUND).
    if (err instanceof EgressBlockedError || err instanceof BundleDownloadError) {
      return { kind: "error", error: err.message, rejected: [] };
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

  if (bytes.length === 0) {
    return {
      kind: "error",
      error: `Bundle endpoint "${host}" returned an empty body — nothing was synced.`,
      rejected: [],
    };
  }

  // ── Extract → parse (the #4207 caps + per-file rejections apply) ─────────
  let extracted: ReturnType<typeof extractBundle>;
  try {
    extracted = extractBundle(bytes, {
      maxDocBytes: getIngestMaxDocBytes(),
      maxTotalBytes: maxBundleBytes,
    });
  } catch (err) {
    if (err instanceof BundleFormatError) {
      return { kind: "error", error: err.message, rejected: [] };
    }
    throw err;
  }

  const parsed = parseLenientBundle(extracted.files);
  const rejected: BundleEntryError[] = [...extracted.errors, ...parsed.errors];

  const maxDocs = getIngestMaxDocs();
  if (parsed.docs.length > maxDocs) {
    return {
      kind: "error",
      error: `Bundle has ${parsed.docs.length} documents, over the ${maxDocs}-document limit.`,
      rejected,
    };
  }
  // Refuse to act on a doc-less bundle: proceeding would archive the ENTIRE
  // collection off one bad response (a wrong URL, an HTML error page that
  // happened to be a valid archive, an emptied repo). Fail the sync instead.
  if (parsed.docs.length === 0) {
    return {
      kind: "error",
      error:
        rejected.length > 0
          ? "No ingestable documents — every file in the fetched bundle was rejected (see the per-file errors). Nothing was changed."
          : "The fetched bundle contains no markdown documents. Nothing was changed.",
      rejected,
    };
  }

  // ── Ingest + archive-absent in ONE transaction ───────────────────────────
  // Absent = not among the parsed docs AND not among per-file rejections: a
  // file that is present-but-broken this round must not archive its
  // previously-reviewed document.
  const presentPaths = [
    ...parsed.docs.map((d) => d.path),
    ...rejected.map((r) => r.path),
  ];

  try {
    const { report, archivedAbsent } = await withTransaction(async (client) => {
      const ingestReport = await ingestBundleIntoCollection({
        // Same minimal-client cast the admin ingest route uses — the ingest
        // core only calls `.query()`.
        client: client as unknown as IngestClient,
        workspaceId,
        collectionId: collectionSlug,
        source: "bundle-sync",
        docs: parsed.docs,
      });
      const archivedRows = await (client as unknown as IngestClient).query<{ id: string }>(
        ARCHIVE_ABSENT_SQL,
        [workspaceId, collectionSlug, presentPaths],
      );
      return { report: ingestReport, archivedAbsent: archivedRows.rows.length };
    });
    return { kind: "ok", format: extracted.format, report, archivedAbsent, rejected };
  } catch (err) {
    log.error(
      { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
      "Knowledge bundle sync ingest transaction failed",
    );
    return {
      kind: "error",
      error: `Ingest failed after a successful fetch: ${err instanceof Error ? err.message : String(err)}`,
      rejected,
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
 * Stream a response body with a cumulative size cap, so a chunked / lying
 * endpoint can't buffer unbounded bytes (the `Content-Length` pre-check is
 * advisory; this is the authoritative guard). Throws an `Error` whose message
 * is host-only.
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number,
  host: string,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        throw new BundleDownloadError(
          `Bundle from "${host}" exceeds the ${maxBytes}-byte limit — download aborted.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Release the connection whether we finished or bailed on the cap.
    await reader.cancel().catch((err: unknown) => {
      log.debug(
        { host, err: err instanceof Error ? err.message : String(err) },
        "Bundle body reader cancel failed after read completed/aborted",
      );
    });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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
// Cycle — walk every enabled synced collection (the scheduler tick body)
// ---------------------------------------------------------------------------

export interface KnowledgeSyncCycleResult {
  /** Enabled bundle-sync installs inspected this cycle. */
  readonly inspected: number;
  readonly succeeded: number;
  readonly failed: number;
}

interface SyncInstallRow extends Record<string, unknown> {
  workspace_id: string;
  install_id: string;
  config: Record<string, unknown> | null;
}

/**
 * Run one sync pass over every enabled, non-archived `bundle-sync` install.
 * Sequential (one endpoint at a time — a slow tenant can't starve another's
 * connection pool slot), per-collection failures isolated. Never throws.
 */
export async function runKnowledgeSyncCycle(options?: {
  readonly fetchImpl?: typeof globalThis.fetch;
}): Promise<KnowledgeSyncCycleResult> {
  if (!hasInternalDB()) {
    return { inspected: 0, succeeded: 0, failed: 0 };
  }

  let installs: SyncInstallRow[];
  try {
    installs = await internalQuery<SyncInstallRow>(
      `SELECT workspace_id, install_id, config
         FROM workspace_plugins
        WHERE catalog_id = $1 AND pillar = 'knowledge'
          AND enabled = true AND status <> 'archived'
        ORDER BY workspace_id ASC, install_id ASC`,
      [BUNDLE_SYNC_CATALOG_ID],
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Knowledge sync cycle: failed to query bundle-sync installs",
    );
    return { inspected: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  for (const install of installs) {
    // `syncCollection` never throws; the belt-and-braces catch keeps a future
    // regression from sinking the remaining collections in the cycle.
    try {
      const outcome = await syncCollection({
        workspaceId: install.workspace_id,
        collectionSlug: install.install_id,
        config: install.config,
        ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (outcome.status === "success") succeeded++;
      else failed++;
    } catch (err) {
      failed++;
      log.error(
        {
          workspaceId: install.workspace_id,
          collectionSlug: install.install_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Knowledge sync cycle: syncCollection threw past its internal catch",
      );
    }
  }

  if (installs.length > 0) {
    log.info({ inspected: installs.length, succeeded, failed }, "Knowledge sync cycle complete");
  }
  return { inspected: installs.length, succeeded, failed };
}

// ---------------------------------------------------------------------------
// Local transaction helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a transaction on a dedicated internal-DB client. Mirrors the
 * BEGIN/COMMIT/ROLLBACK + `release(err)` discipline in `admin-publish.ts` /
 * `admin-knowledge.ts` (a failed ROLLBACK destroys the client so a dirty
 * connection can't poison the next borrower). Local copy because `lib/` must
 * not import from `api/routes/`.
 */
async function withTransaction<T>(fn: (client: InternalPoolClient) => Promise<T>): Promise<T> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let rollbackErr: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { err: rollbackErr.message },
        "ROLLBACK failed after knowledge sync transaction error — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}
