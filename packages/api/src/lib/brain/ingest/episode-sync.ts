/**
 * The brain episode sync engine (#4770, ADR-0036 §Ingestion & connectors).
 *
 * ## Read this before assuming it duplicates `connector-sync.ts`
 *
 * ADR-0036 §T6 reuses the ADR-0030 engine VERBATIM and forks only the ingest
 * core. Every schedulable/retryable/cap-bearing decision below is IMPORTED
 * from that engine, not restated:
 *
 *   - the cycle that calls this lives in `lib/knowledge/sync.ts`, driven by the
 *     one existing scheduler fiber (`scheduler/knowledge-bundle-sync.ts`).
 *     There is no second scheduler;
 *   - `SYNC_OVERLAP_WINDOW_MS` — the incremental rewind;
 *   - `getKnowledgeSyncReconcileIntervalMs` — the reconcile cadence knob;
 *   - `withRateLimitBackoff` + `ConnectorRateLimitError` — the 429 policy;
 *   - `resolveIngestCaps` (from `lib/billing/knowledge-limits`, the same cap
 *     source the document engine reads) — the effective per-sync cap
 *     (`min(platform ceiling, plan tier)`), resolved ONCE and shared by the
 *     fetch bound and the ingest;
 *   - `readConnectorSyncState` / `upsertConnectorSyncState` — the
 *     `knowledge_sync_state` bookkeeping, including its COALESCE-forward
 *     semantics (an error attempt records its status WITHOUT regressing the
 *     high-water mark, so a failed cycle can never skip what it failed to
 *     ingest).
 *
 * What this module owns is the shape of an attempt around a DIFFERENT ingest
 * core, plus the outcome vocabulary that core produces (`inserted` /
 * `duplicate` / `refused`, not `created` / `updated` / `demoted`).
 *
 * ## The archive path is not "skipped" — it is unreachable
 *
 * There is no `archiveAbsent` parameter to pass `false` to, because
 * `ingestDocuments` is never called: an episode is identified by source-id and
 * an absent record is simply absent. A flag would have made "don't archive" a
 * call-site convention one edit away from being wrong.
 * `episode-sync-archive.test.ts` pins the structural version (no import, no
 * call).
 *
 * ## What `reconciliation` means here
 *
 * Not "enumerate the full set so absences can be archived" — nothing is
 * archived. ADR-0036 §Ingestion repurposes the cadence to **re-run extraction**
 * over a wider window; the fetch side may or may not do anything different, and
 * the Slack source deliberately does not (see its client's header). The mode is
 * still decided and recorded here because it is the engine's decision to make,
 * and a pass the client flags `coverageIncomplete` does NOT advance that clock,
 * so whatever is due stays due.
 *
 * The RE-EXTRACTION consumer is not built yet. #4771 shipped the extraction
 * fiber as a drain of `extracted_at IS NULL` on its own fixed clock; it reads
 * nothing from `knowledge_sync_state` and never revisits a stamped episode. So
 * the reconcile cadence currently decides only what the FETCH does — re-reading
 * this clock is what a "re-extract the last N days with a better model" pass
 * would hook into.
 *
 * Like the engine it forks, `syncBrainEpisodeSource` NEVER throws: every
 * failure becomes a `status: "error"` outcome so one bad source can't sink the
 * cycle's remaining installs.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  resolveIngestCaps,
  type EffectiveIngestCaps,
} from "@atlas/api/lib/billing/knowledge-limits";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  RATE_LIMIT_MAX_ATTEMPTS,
  SYNC_OVERLAP_WINDOW_MS,
  getKnowledgeSyncReconcileIntervalMs,
  readConnectorSyncState,
  upsertConnectorSyncState,
  withRateLimitBackoff,
} from "@atlas/api/lib/knowledge/connector-sync";
import { ingestEpisodes, type EpisodeIngestReport } from "./episodes";
import type {
  BrainSourceChanges,
  BrainSourceConnector,
  BrainSourceFetchMode,
  BrainSourceVendorClient,
} from "./types";

const log = createLogger("brain.ingest.episode-sync");

/** Bound the warning list persisted in the state report. */
const REPORT_WARNINGS_CAP = 20;

/** Outcome of one brain source sync attempt. */
export interface BrainEpisodeSyncOutcome {
  /** The install id (= the sync-state row's `collection_id`). */
  readonly installId: string;
  readonly status: "success" | "error";
  /** `"unknown"` only when the attempt failed before the mode was decided. */
  readonly mode: BrainSourceFetchMode | "unknown";
  readonly syncedAt: string;
  readonly error: string | null;
  /** Null when the attempt failed before (or during) ingest. */
  readonly episodes: EpisodeIngestReport | null;
  readonly coverageIncomplete: boolean;
  readonly warnings: readonly string[];
  /** The high-water mark persisted by this attempt (null = unchanged). */
  readonly highWaterMark: string | null;
}

export interface SyncBrainEpisodeSourceParams {
  readonly connector: BrainSourceConnector;
  readonly workspaceId: string;
  readonly installId: string;
  readonly config: Record<string, unknown> | null;
  /** Test-only clock. */
  readonly now?: () => Date;
  /** Test-only backoff sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * A source timestamp is persisted only when it actually parses — a garbage
 * high-water mark must be caught visibly (warn) here rather than surface as an
 * opaque state-row INSERT error. Same rule, same reason, as the engine's
 * `validVendorTimestamp`.
 */
function validSourceTimestamp(
  value: string | null,
  context: { workspaceId: string; installId: string },
): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    log.warn(
      { ...context, value },
      "Brain source returned an unparseable high-water mark — not persisting it (the previous mark, if any, carries forward via COALESCE)",
    );
    return null;
  }
  return new Date(ms).toISOString();
}

type BrainAttempt =
  | {
      readonly kind: "ok";
      readonly mode: BrainSourceFetchMode;
      readonly episodes: EpisodeIngestReport;
      readonly coverageIncomplete: boolean;
      readonly warnings: readonly string[];
      readonly highWaterMark: string | null;
      readonly cursor: string | null;
    }
  | {
      readonly kind: "error";
      readonly mode: BrainSourceFetchMode | "unknown";
      readonly error: string;
    };

/**
 * Sync one brain source end-to-end and record the attempt in
 * `knowledge_sync_state`.
 */
export async function syncBrainEpisodeSource(
  params: SyncBrainEpisodeSourceParams,
): Promise<BrainEpisodeSyncOutcome> {
  const { connector, workspaceId, installId } = params;
  const now = params.now ?? (() => new Date());

  // The attempt reports its mode as soon as it is decided so the catch-all can
  // record the REAL mode — or an honest "unknown" when the failure happened
  // before the decision (e.g. the state read threw).
  let decidedMode: BrainSourceFetchMode | "unknown" = "unknown";
  let attempt: BrainAttempt;
  try {
    attempt = await runBrainAttempt(params, now, (mode) => {
      decidedMode = mode;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { workspaceId, installId, catalogId: connector.catalogId, err: msg },
      "Brain episode sync attempt threw past its internal handling — recording an error state",
    );
    attempt = {
      kind: "error",
      mode: decidedMode,
      error: `Sync failed unexpectedly: ${msg}. Retry the sync; if it persists, check the API logs.`,
    };
  }

  const syncedAt = now().toISOString();
  const outcome: BrainEpisodeSyncOutcome =
    attempt.kind === "ok"
      ? {
          installId,
          status: "success",
          mode: attempt.mode,
          syncedAt,
          error: null,
          episodes: attempt.episodes,
          coverageIncomplete: attempt.coverageIncomplete,
          warnings: attempt.warnings,
          highWaterMark: attempt.highWaterMark,
        }
      : {
          installId,
          status: "error",
          mode: attempt.mode,
          syncedAt,
          error: attempt.error,
          episodes: null,
          coverageIncomplete: false,
          warnings: [],
          highWaterMark: null,
        };

  await upsertConnectorSyncState(workspaceId, installId, {
    status: outcome.status,
    error: outcome.error,
    report:
      outcome.status === "success"
        ? {
            mode: outcome.mode,
            target: "brain-episodes",
            episodes: outcome.episodes,
            // Persisted so the admin surface can show that part of the window
            // was deferred — a coverage-incomplete "success" is not silently
            // green.
            coverageIncomplete: outcome.coverageIncomplete,
            warnings: outcome.warnings.slice(0, REPORT_WARNINGS_CAP),
          }
        : { mode: outcome.mode, target: "brain-episodes" },
    highWaterMark: outcome.highWaterMark,
    cursor: attempt.kind === "ok" ? attempt.cursor : null,
    // An incomplete pass must not satisfy the reconcile clock — the next cycle
    // stays due, so the uncovered window gets a wide re-crawl soon.
    reconciledAt:
      attempt.kind === "ok" && attempt.mode === "reconciliation" && !attempt.coverageIncomplete
        ? syncedAt
        : null,
  });

  if (outcome.status === "success") {
    log.info(
      {
        workspaceId,
        installId,
        source: connector.source,
        mode: outcome.mode,
        ...outcome.episodes,
        coverageIncomplete: outcome.coverageIncomplete,
        warnings: outcome.warnings.length,
        highWaterMark: outcome.highWaterMark,
      },
      "Brain episode sync succeeded",
    );
  } else {
    log.warn(
      { workspaceId, installId, source: connector.source, mode: outcome.mode, error: outcome.error },
      "Brain episode sync failed",
    );
  }
  return outcome;
}

async function runBrainAttempt(
  params: SyncBrainEpisodeSourceParams,
  now: () => Date,
  onModeDecided: (mode: BrainSourceFetchMode) => void,
): Promise<BrainAttempt> {
  const { connector, workspaceId, installId, config } = params;

  // ── Bookkeeping → mode decision (the engine's rule, unchanged) ────────────
  const state = await readConnectorSyncState(workspaceId, installId);
  const reconcileIntervalMs = getKnowledgeSyncReconcileIntervalMs();
  const due =
    state.lastReconciledAt === null ||
    now().getTime() - Date.parse(state.lastReconciledAt) >= reconcileIntervalMs;
  const sinceIso =
    state.highWaterMark === null
      ? null
      : new Date(Date.parse(state.highWaterMark) - SYNC_OVERLAP_WINDOW_MS).toISOString();
  const mode: BrainSourceFetchMode = due || sinceIso === null ? "reconciliation" : "incremental";
  onModeDecided(mode);

  // ── Effective caps ────────────────────────────────────────────────────────
  // Episodes count against the SAME per-sync ingest cap as documents: they are
  // the unit this workspace's plan bounds, and a second cap would let the
  // brain path pull past what the knowledge path is refused.
  let caps: EffectiveIngestCaps;
  try {
    caps = await resolveIngestCaps(workspaceId);
  } catch (err) {
    return {
      kind: "error",
      mode,
      error: `Could not verify this workspace's ingest limits: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Client ────────────────────────────────────────────────────────────────
  let client: BrainSourceVendorClient;
  try {
    client = await connector.createClient({ workspaceId, installId, config });
  } catch (err) {
    return { kind: "error", mode, error: err instanceof Error ? err.message : String(err) };
  }

  // ── Fetch (bounded 429 backoff — the engine's, imported) ──────────────────
  const backoffOpts = params.sleep ? { sleep: params.sleep } : undefined;
  let changes: BrainSourceChanges;
  try {
    changes = await withRateLimitBackoff(
      () =>
        client.fetchEpisodes({
          mode,
          since: sinceIso,
          cursor: state.cursor,
          maxEpisodes: caps.maxDocs.value,
        }),
      backoffOpts,
    );
  } catch (err) {
    if (err instanceof ConnectorRateLimitError) {
      return {
        kind: "error",
        mode,
        error: `The source is rate limiting this workspace (backoff exhausted after ${RATE_LIMIT_MAX_ATTEMPTS} attempts${err.retryAfterSeconds !== null ? `; last Retry-After ${err.retryAfterSeconds}s` : ""}) — the next scheduled cycle will retry.`,
      };
    }
    return { kind: "error", mode, error: err instanceof Error ? err.message : String(err) };
  }

  const highWaterMark = validSourceTimestamp(changes.highWaterMark, { workspaceId, installId });
  const cursor = changes.cursor ?? null;
  const coverageIncomplete = changes.coverageIncomplete === true;
  const warnings = changes.warnings ?? [];

  // A source returning MORE than the cap is a client bug, not a cap refusal:
  // the cap was handed to it as `maxEpisodes` precisely so it could bound its
  // own fetch. Refuse the batch rather than store a partial window whose
  // high-water mark would claim to cover records that were dropped.
  if (changes.episodes.length > caps.maxDocs.value) {
    log.error(
      {
        workspaceId,
        installId,
        source: connector.source,
        returned: changes.episodes.length,
        maxEpisodes: caps.maxDocs.value,
      },
      "Brain source returned more episodes than the per-sync cap it was given — refusing the batch",
    );
    return {
      kind: "error",
      mode,
      error: `The source returned ${changes.episodes.length} records, over the ${caps.maxDocs.value}-record per-sync limit it was given — nothing was ingested. This is a connector defect; check the API logs.`,
    };
  }

  // ── Ingest through the FORKED core (append-only; no upsert, no archive) ───
  let report: EpisodeIngestReport;
  try {
    report = await ingestEpisodes({
      workspaceId,
      source: connector.source,
      episodes: changes.episodes,
    });
  } catch (err) {
    log.error(
      { workspaceId, installId, err: err instanceof Error ? err.message : String(err) },
      "Brain episode ingest failed after a successful source fetch",
    );
    return {
      kind: "error",
      mode,
      error: `Ingest failed after a successful fetch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { kind: "ok", mode, episodes: report, coverageIncomplete, warnings, highWaterMark, cursor };
}
