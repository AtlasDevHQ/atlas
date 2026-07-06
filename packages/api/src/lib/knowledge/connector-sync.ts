/**
 * The shared Knowledge Sync Connector engine (#4376, ADR-0030) — everything
 * between the sync-cycle walk and a vendor client. One engine for every
 * vendor; a connector implements only enumerate/fetch + a pure converter.
 *
 * Two cadences per collection, decided here per cycle:
 *
 *   - INCREMENTAL (the common, cheap cycle): fetch changes since the persisted
 *     high-water mark minus an OVERLAP WINDOW (absorbs vendor clock skew and
 *     minute-granularity change feeds; re-fetched unchanged docs no-op in the
 *     upsert-by-path diff, so overlap costs bandwidth, never correctness).
 *     Changed docs upsert as drafts. Deletions are INVISIBLE here — no
 *     subtractive archiving, no full-set cap validation.
 *   - RECONCILIATION (the correctness anchor, on the
 *     `ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS` settings-registry
 *     cadence — and always for a collection that has never synced): enumerate
 *     the FULL current set; paths absent from it are archived (never
 *     hard-deleted) and the ingest caps are validated over the full set with
 *     real numbers. Incremental-only sync is unsound for both launch vendors
 *     (Notion's search is officially non-exhaustive; Confluence's
 *     last-modified queries have edges) — hence the split. A crawl the client
 *     flags `coverageIncomplete` still upserts, but archives NOTHING and does
 *     not advance the reconcile clock: deletions wait for a clean crawl.
 *
 * Rate limiting is ENGINE property (not per-vendor discipline): a client
 * throws `ConnectorRateLimitError` (parsed 429/`Retry-After`) and the engine
 * applies a bounded backoff-and-retry; exhaustion becomes that collection's
 * error outcome. One collection's failure never blocks the cycle's remaining
 * collections — `syncConnectorCollection` never throws.
 *
 * Every sync attempt (success or error) upserts the collection's
 * `knowledge_sync_state` row. The high-water mark, vendor cursor, and
 * last-reconciled time advance ONLY on success (an error passes nulls and the
 * upsert COALESCEs the previous values forward), so a failed cycle can never
 * skip the changes it failed to ingest.
 *
 * NO PUBLISH PATH EXISTS HERE — structurally: every ingest goes through
 * `ingestDocuments` with source `connector:<vendor>`, and that seam rejects
 * `publish` for every non-upload source (ADR-0028 §4). This module never
 * imports the content-mode registry and never writes `status='published'`.
 *
 * Error-message hygiene: this engine never embeds install config or
 * credentials in outcomes. Vendor clients own their own messages and MUST
 * redact endpoint hosts/tokens at construction (the bundle-sync engine's
 * `hostForLog` posture) — an engine can't un-leak a vendor exception.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import type { KnowledgeIngestDocumentCounts } from "@useatlas/types";
import type { BundleEntryError } from "./bundle-archive";
import { ingestDocuments } from "./ingest-bundle";
import {
  ConnectorRateLimitError,
  type ConnectorChanges,
  type ConnectorVendorClient,
  type KnowledgeSyncConnector,
} from "./connectors";

const log = createLogger("knowledge.connector-sync");

/** Default reconciliation cadence: weekly (incremental cycles default to nightly). */
export const DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS = 168;

/**
 * The incremental overlap window: an incremental fetch asks for changes since
 * (high-water mark − this). Absorbs vendor clock skew and minute-granularity
 * change feeds (e.g. Notion's `last_edited_time`); the upsert-by-path diff
 * no-ops re-fetched unchanged docs, so the overlap is bandwidth, not churn.
 */
export const SYNC_OVERLAP_WINDOW_MS = 5 * 60 * 1000;

/** Bounded 429 backoff: total attempts (initial try + retries) per fetch. */
export const RATE_LIMIT_MAX_ATTEMPTS = 3;
/** Wait when the vendor sent no `Retry-After`. */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 2_000;
/** Hard per-wait cap — an hour-scale `Retry-After` must not wedge the cycle walk. */
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;

/** Bound the per-file rejection list persisted in `knowledge_sync_state.report`. */
const REPORT_REJECTED_CAP = 50;

/**
 * Reconciliation cadence (ms) — `ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS`
 * from the settings registry (platform-scoped, hot-reloaded per cycle read;
 * default weekly). Fractional hours are legal (soak-testing); non-positive /
 * unparseable overrides fall back to the default with a warn.
 */
export function getKnowledgeSyncReconcileIntervalMs(): number {
  const raw = getSettingAuto("ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS");
  if (raw === undefined || raw === "") return DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS * 3_600_000;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    log.warn(
      { raw },
      "ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS is non-positive or unparseable — using the weekly default",
    );
    return DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS * 3_600_000;
  }
  return hours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Sync-state bookkeeping (read + upsert)
// ---------------------------------------------------------------------------

/** The connector bookkeeping read at the top of each collection's sync. */
export interface ConnectorSyncState {
  readonly highWaterMark: string | null;
  readonly cursor: string | null;
  readonly lastReconciledAt: string | null;
}

/** Exported for the real-Postgres test. */
export const CONNECTOR_SYNC_STATE_SELECT_SQL = `SELECT high_water_mark, sync_cursor, last_reconciled_at
         FROM knowledge_sync_state
        WHERE workspace_id = $1 AND collection_id = $2`;

/**
 * The connector-sync bookkeeping upsert. Same install-existence guard as the
 * bundle-sync upsert (a sync racing an uninstall must not re-create the row
 * the uninstall just deleted); additionally COALESCEs the incremental
 * bookkeeping forward — the engine passes non-null values only on success, so
 * an error attempt records its status/error WITHOUT regressing the high-water
 * mark, cursor, or reconciliation clock. Exported for the real-Postgres test.
 */
export const CONNECTOR_SYNC_STATE_UPSERT_SQL = `INSERT INTO knowledge_sync_state
         (workspace_id, collection_id, last_sync_at, status, error, report,
          high_water_mark, sync_cursor, last_reconciled_at, created_at, updated_at)
       SELECT $1, $2, NOW(), $3, $4, $5::jsonb, $6, $7, $8, NOW(), NOW()
        WHERE EXISTS (SELECT 1 FROM workspace_plugins
                       WHERE workspace_id = $1 AND install_id = $2
                         AND pillar = 'knowledge' AND status <> 'archived')
       ON CONFLICT (workspace_id, collection_id) DO UPDATE
         SET last_sync_at = NOW(),
             status = EXCLUDED.status,
             error = EXCLUDED.error,
             report = EXCLUDED.report,
             high_water_mark = COALESCE(EXCLUDED.high_water_mark, knowledge_sync_state.high_water_mark),
             sync_cursor = COALESCE(EXCLUDED.sync_cursor, knowledge_sync_state.sync_cursor),
             last_reconciled_at = COALESCE(EXCLUDED.last_reconciled_at, knowledge_sync_state.last_reconciled_at),
             updated_at = NOW()`;

interface ConnectorSyncStateRow extends Record<string, unknown> {
  high_water_mark: Date | string | null;
  sync_cursor: string | null;
  last_reconciled_at: Date | string | null;
}

/** Normalize a timestamptz read-back (Date | ISO string | null) to ISO | null. */
function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function readConnectorSyncState(
  workspaceId: string,
  collectionSlug: string,
): Promise<ConnectorSyncState> {
  const rows = await internalQuery<ConnectorSyncStateRow>(CONNECTOR_SYNC_STATE_SELECT_SQL, [
    workspaceId,
    collectionSlug,
  ]);
  const row = rows[0];
  if (!row) return { highWaterMark: null, cursor: null, lastReconciledAt: null };
  return {
    highWaterMark: isoOrNull(row.high_water_mark),
    cursor: row.sync_cursor,
    lastReconciledAt: isoOrNull(row.last_reconciled_at),
  };
}

// ---------------------------------------------------------------------------
// Rate-limit backoff — engine property, not per-vendor discipline
// ---------------------------------------------------------------------------

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a vendor fetch with bounded 429 backoff: on `ConnectorRateLimitError`,
 * wait min(`Retry-After`, {@link RATE_LIMIT_MAX_WAIT_MS}) — or the default
 * wait when the vendor sent none — and retry, up to
 * {@link RATE_LIMIT_MAX_ATTEMPTS} total attempts. Exhaustion (and every
 * non-rate-limit error) propagates to the caller's error handling.
 */
export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  opts?: { readonly sleep?: Sleep; readonly maxAttempts?: number },
): Promise<T> {
  const sleep = opts?.sleep ?? realSleep;
  const maxAttempts = opts?.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ConnectorRateLimitError) || attempt >= maxAttempts) throw err;
      const requestedMs =
        err.retryAfterSeconds !== null && Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0
          ? err.retryAfterSeconds * 1000
          : RATE_LIMIT_DEFAULT_WAIT_MS;
      const waitMs = Math.min(requestedMs, RATE_LIMIT_MAX_WAIT_MS);
      log.info(
        { attempt, maxAttempts, waitMs, retryAfterSeconds: err.retryAfterSeconds },
        "Vendor rate limit hit — backing off before retry",
      );
      await sleep(waitMs);
    }
  }
}

// ---------------------------------------------------------------------------
// The per-collection engine
// ---------------------------------------------------------------------------

export type ConnectorSyncMode = "incremental" | "reconciliation";

/**
 * Outcome of one connector sync attempt. Document counts reuse the ingest
 * wire shape — a connector sync IS an ingest, same vocabulary as bundle-sync.
 */
export interface ConnectorSyncOutcome {
  readonly collection: string;
  readonly status: "success" | "error";
  /** `"unknown"` only when the attempt failed before the mode was decided
   *  (e.g. the sync-state read threw) — never a guessed label. */
  readonly mode: ConnectorSyncMode | "unknown";
  /** ISO-8601 completion time of this attempt. */
  readonly syncedAt: string;
  readonly error: string | null;
  readonly documents: KnowledgeIngestDocumentCounts | null;
  /** Previously-ingested docs archived by a reconciliation crawl; null otherwise. */
  readonly archivedAbsent: number | null;
  /**
   * True when the vendor client flagged the enumeration as knowingly
   * incomplete: upserts landed, but subtractive archiving was skipped and the
   * reconcile clock did not advance. Recorded in the state report so the admin
   * surface is never silently green about skipped deletions.
   */
  readonly coverageIncomplete: boolean;
  /** Per-file rejections (oversize, malformed frontmatter). */
  readonly rejected: readonly BundleEntryError[];
  /** The high-water mark persisted by this attempt (null = unchanged). */
  readonly highWaterMark: string | null;
}

export interface SyncConnectorCollectionParams {
  readonly connector: KnowledgeSyncConnector;
  readonly workspaceId: string;
  /** The collection slug (= `workspace_plugins.install_id`). */
  readonly collectionSlug: string;
  /** The install row's config. */
  readonly config: Record<string, unknown> | null;
  /** Test-only clock. */
  readonly now?: () => Date;
  /** Test-only backoff sleep. */
  readonly sleep?: Sleep;
}

/** A vendor timestamp is persisted only when it actually parses — a garbage
 *  high-water mark must be caught visibly (warn) here, not surface as an opaque
 *  state-row INSERT error. */
function validVendorTimestamp(
  value: string | null,
  context: { workspaceId: string; collectionSlug: string },
): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    log.warn(
      { ...context, value },
      "Connector returned an unparseable high-water mark — not persisting it (the previous mark, if any, carries forward via COALESCE)",
    );
    return null;
  }
  return new Date(ms).toISOString();
}

/**
 * Sync one connector collection end-to-end and record the attempt in
 * `knowledge_sync_state`. Never throws — every failure becomes a
 * `status:"error"` outcome (and an error state row) so a cycle survives any
 * single bad vendor/collection, exactly like the bundle-sync engine.
 */
export async function syncConnectorCollection(
  params: SyncConnectorCollectionParams,
): Promise<ConnectorSyncOutcome> {
  const { connector, workspaceId, collectionSlug } = params;
  const now = params.now ?? (() => new Date());

  // The attempt reports its mode as soon as it is decided, so the catch-all
  // below can record the REAL mode — or an honest "unknown" when the failure
  // happened before the decision (e.g. the sync-state read threw).
  let decidedMode: ConnectorSyncMode | "unknown" = "unknown";
  let attempt: ConnectorAttempt;
  try {
    attempt = await runConnectorAttempt(params, now, (mode) => {
      decidedMode = mode;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { workspaceId, collectionSlug, catalogId: connector.catalogId, err: msg },
      "Knowledge connector sync attempt threw past its internal handling — recording an error state",
    );
    attempt = {
      kind: "error",
      mode: decidedMode,
      error: `Sync failed unexpectedly: ${msg}. Retry "Sync now"; if it persists, check the API logs.`,
      rejected: [],
    };
  }

  const syncedAt = now().toISOString();
  const outcome: ConnectorSyncOutcome =
    attempt.kind === "ok"
      ? {
          collection: collectionSlug,
          status: "success",
          mode: attempt.mode,
          syncedAt,
          error: null,
          documents: attempt.documents,
          archivedAbsent: attempt.archivedAbsent,
          coverageIncomplete: attempt.coverageIncomplete,
          rejected: attempt.rejected,
          highWaterMark: attempt.highWaterMark,
        }
      : {
          collection: collectionSlug,
          status: "error",
          mode: attempt.mode,
          syncedAt,
          error: attempt.error,
          documents: null,
          archivedAbsent: null,
          coverageIncomplete: false,
          rejected: attempt.rejected,
          highWaterMark: null,
        };

  await recordConnectorSyncState(workspaceId, collectionSlug, outcome, {
    cursor: attempt.kind === "ok" ? attempt.cursor : null,
    // An incomplete crawl must not satisfy the reconcile clock — the next
    // cycle stays due, so the skipped deletions get a clean crawl soon.
    reconciledAt:
      attempt.kind === "ok" && attempt.mode === "reconciliation" && !attempt.coverageIncomplete
        ? syncedAt
        : null,
  });

  if (outcome.status === "success") {
    log.info(
      {
        workspaceId,
        collectionSlug,
        vendor: connector.vendor,
        mode: outcome.mode,
        ...outcome.documents,
        archivedAbsent: outcome.archivedAbsent,
        coverageIncomplete: outcome.coverageIncomplete,
        rejected: outcome.rejected.length,
        highWaterMark: outcome.highWaterMark,
      },
      "Knowledge connector sync succeeded",
    );
  } else {
    log.warn(
      { workspaceId, collectionSlug, vendor: connector.vendor, mode: outcome.mode, error: outcome.error },
      "Knowledge connector sync failed",
    );
  }
  return outcome;
}

type ConnectorAttempt =
  | {
      readonly kind: "ok";
      readonly mode: ConnectorSyncMode;
      readonly documents: KnowledgeIngestDocumentCounts;
      readonly archivedAbsent: number | null;
      readonly coverageIncomplete: boolean;
      readonly rejected: readonly BundleEntryError[];
      readonly highWaterMark: string | null;
      readonly cursor: string | null;
    }
  | {
      readonly kind: "error";
      readonly mode: ConnectorSyncMode | "unknown";
      readonly error: string;
      readonly rejected: readonly BundleEntryError[];
    };

async function runConnectorAttempt(
  params: SyncConnectorCollectionParams,
  now: () => Date,
  onModeDecided: (mode: ConnectorSyncMode) => void,
): Promise<ConnectorAttempt> {
  const { connector, workspaceId, collectionSlug, config } = params;

  // ── Bookkeeping → mode decision ────────────────────────────────────────────
  const state = await readConnectorSyncState(workspaceId, collectionSlug);
  const reconcileIntervalMs = getKnowledgeSyncReconcileIntervalMs();
  const due =
    state.lastReconciledAt === null ||
    now().getTime() - Date.parse(state.lastReconciledAt) >= reconcileIntervalMs;
  // The overlap window rewinds the mark so skewed/minute-granular vendor
  // clocks can't lose a change; unchanged re-fetches no-op in the diff.
  const sinceIso =
    state.highWaterMark === null
      ? null
      : new Date(Date.parse(state.highWaterMark) - SYNC_OVERLAP_WINDOW_MS).toISOString();
  // A collection with no high-water mark can't fetch incrementally (and a
  // vendor that returns none reconciles every cycle — correct, just not cheap).
  const mode: ConnectorSyncMode = due || sinceIso === null ? "reconciliation" : "incremental";
  onModeDecided(mode);

  // ── Vendor client ──────────────────────────────────────────────────────────
  let client: ConnectorVendorClient;
  try {
    client = await connector.createClient({ workspaceId, collectionSlug, config });
  } catch (err) {
    return {
      kind: "error",
      mode,
      error: err instanceof Error ? err.message : String(err),
      rejected: [],
    };
  }

  // ── Fetch (bounded 429 backoff — engine-owned) ─────────────────────────────
  const backoffOpts = params.sleep ? { sleep: params.sleep } : undefined;
  let changes: ConnectorChanges;
  try {
    changes =
      mode === "reconciliation"
        ? await withRateLimitBackoff(() => client.fetchAll(), backoffOpts)
        : await withRateLimitBackoff(
            () => client.fetchChanges({ since: sinceIso, cursor: state.cursor }),
            backoffOpts,
          );
  } catch (err) {
    if (err instanceof ConnectorRateLimitError) {
      return {
        kind: "error",
        mode,
        error: `The vendor is rate limiting this collection (backoff exhausted after ${RATE_LIMIT_MAX_ATTEMPTS} attempts${err.retryAfterSeconds !== null ? `; last Retry-After ${err.retryAfterSeconds}s` : ""}) — the next scheduled cycle will retry.`,
        rejected: [],
      };
    }
    return {
      kind: "error",
      mode,
      error: err instanceof Error ? err.message : String(err),
      rejected: [],
    };
  }

  const highWaterMark = validVendorTimestamp(changes.highWaterMark, { workspaceId, collectionSlug });
  const cursor = changes.cursor ?? null;
  const coverageIncomplete = changes.coverageIncomplete === true;
  if (coverageIncomplete && mode === "reconciliation") {
    log.warn(
      { workspaceId, collectionSlug, vendor: connector.vendor },
      "Connector reported an incomplete enumeration — skipping subtractive archiving and holding the reconcile clock this cycle",
    );
  }

  // ── Incremental quiet cycle: nothing changed — advance the mark, no ingest ─
  if (mode === "incremental" && changes.documents.length === 0) {
    return {
      kind: "ok",
      mode,
      documents: { created: 0, updated: 0, demoted: 0, resurrected: 0, unchanged: 0, total: 0 },
      archivedAbsent: null,
      coverageIncomplete,
      rejected: [],
      highWaterMark,
      cursor,
    };
  }

  // ── Ingest through the document-level seam ─────────────────────────────────
  // Subtractive archiving happens ONLY on a coverage-complete reconciliation
  // (`archiveAbsent`) — a knowingly-partial set must never archive the pages
  // the client missed. The seam's no_documents guard keeps an empty
  // reconciliation from archiving the entire collection off one bad vendor
  // response, and the full-set doc cap falls out of the seam's
  // too_many_documents with real numbers.
  let outcome: Awaited<ReturnType<typeof ingestDocuments>>;
  try {
    outcome = await ingestDocuments({
      workspaceId,
      collectionId: collectionSlug,
      source: `connector:${connector.vendor}`,
      files: changes.documents.map((d) => ({ path: d.path, content: d.content })),
      archiveAbsent: mode === "reconciliation" && !coverageIncomplete,
    });
  } catch (err) {
    log.error(
      { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
      "Knowledge connector sync ingest transaction failed",
    );
    return {
      kind: "error",
      mode,
      error: `Ingest failed after a successful vendor fetch: ${err instanceof Error ? err.message : String(err)}`,
      rejected: [],
    };
  }

  switch (outcome.kind) {
    case "ok":
      return {
        kind: "ok",
        mode,
        documents: {
          created: outcome.report.created,
          updated: outcome.report.updated,
          demoted: outcome.report.demoted,
          resurrected: outcome.report.resurrected,
          unchanged: outcome.report.unchanged,
          total: outcome.report.documents,
        },
        archivedAbsent: outcome.archivedAbsent,
        coverageIncomplete,
        rejected: outcome.rejected,
        highWaterMark,
        cursor,
      };
    case "install_gone":
      log.warn(
        { workspaceId, collectionSlug },
        "Knowledge connector sync aborted — the collection was uninstalled mid-sync; no writes applied",
      );
      return {
        kind: "error",
        mode,
        error: "The collection was uninstalled while the sync was running — no changes were applied.",
        rejected: outcome.rejected,
      };
    case "too_many_documents":
      return {
        kind: "error",
        mode,
        error: `The vendor returned ${outcome.count} documents, over the ${outcome.maxDocs}-document limit (ATLAS_KNOWLEDGE_INGEST_MAX_DOCS) — narrow the connector's scope or raise the cap.`,
        rejected: outcome.rejected,
      };
    case "no_documents":
      // Refuse to act on an empty reconciliation: proceeding would have
      // archived the ENTIRE collection off one bad vendor response.
      return {
        kind: "error",
        mode,
        error:
          outcome.rejected.length > 0
            ? "No ingestable documents — every document the vendor returned was rejected (see the per-file errors). Nothing was changed."
            : "The vendor returned no documents. Nothing was changed — emptying a collection requires uninstalling it.",
        rejected: outcome.rejected,
      };
  }
}

/**
 * Upsert the per-collection connector bookkeeping row. Never throws — a
 * state-write failure must not fail a sync that already committed (logged at
 * error so a persistently broken state table is visible).
 */
async function recordConnectorSyncState(
  workspaceId: string,
  collectionSlug: string,
  outcome: ConnectorSyncOutcome,
  bookkeeping: { readonly cursor: string | null; readonly reconciledAt: string | null },
): Promise<void> {
  const report =
    outcome.status === "success"
      ? {
          mode: outcome.mode,
          documents: outcome.documents,
          archivedAbsent: outcome.archivedAbsent,
          // Persisted so the admin surface can show that deletions were
          // deferred — a coverage-incomplete "success" is not silently green.
          coverageIncomplete: outcome.coverageIncomplete,
          rejected: outcome.rejected.slice(0, REPORT_REJECTED_CAP),
        }
      : outcome.rejected.length > 0
        ? { mode: outcome.mode, rejected: outcome.rejected.slice(0, REPORT_REJECTED_CAP) }
        : { mode: outcome.mode };
  try {
    await internalQuery(CONNECTOR_SYNC_STATE_UPSERT_SQL, [
      workspaceId,
      collectionSlug,
      outcome.status,
      outcome.error,
      JSON.stringify(report),
      outcome.highWaterMark,
      bookkeeping.cursor,
      bookkeeping.reconciledAt,
    ]);
  } catch (err) {
    log.error(
      { workspaceId, collectionSlug, err: err instanceof Error ? err.message : String(err) },
      "Failed to record knowledge connector sync state — the sync outcome itself is unaffected",
    );
  }
}
