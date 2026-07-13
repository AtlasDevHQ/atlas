/**
 * Per-connection profile-tier state (#4509) — the durable store behind
 * CONTEXT.md § Semantic improvement's two tiers of "knowing a connection":
 *
 *   • Baseline profile — cheap, deterministic (schema/types/counts/samples).
 *     Runs automatically when a profilable connection is created (REST excluded)
 *     and lazily backfills on first need. The `TableProfile[]` payload is stored
 *     so the briefing's staleness marker and the coverage view read tracked data
 *     WITHOUT re-querying the customer database just to start a chat.
 *
 *   • LLM profile — the enrichment pass. Never automatic, billing-gated, tracked
 *     per connection: when it last ran and over what scope.
 *
 * This module is the DB seam only (store + typed reads + a pure freshness
 * helper); the orchestration that RUNS a baseline (resolve live connection →
 * profile → upsert) lives in `lib/datasources/connection-baseline.ts` so this
 * layer stays free of the connection-resolution machinery and is trivially
 * mockable via the `db/internal` `internalQuery`-spy pattern.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { TableProfile } from "@useatlas/types";

/**
 * What an LLM-profile (enrichment) run covered — the "over what" the issue
 * tracks alongside "when". `tables` is the set the last run enriched; shaped as
 * a list so a future batch enrich can record several at once.
 */
export interface LlmProfileScope {
  readonly tables: readonly string[];
}

/** Baseline tier success facts — present only when a baseline has succeeded. */
export interface BaselineProfileState {
  /** ISO-8601 timestamp of the last successful baseline profile. */
  readonly profiledAt: string;
  /** Number of tables/objects in the stored payload. */
  readonly tableCount: number;
}

/** LLM tier as surfaced to consumers. */
export interface LlmProfileState {
  /** ISO-8601 timestamp of the last enrichment run. */
  readonly profiledAt: string;
  /** What the last run covered, or `null` when unrecorded. */
  readonly scope: LlmProfileScope | null;
}

/** Both tiers for one connection, with freshness readable per tier. */
export interface ConnectionProfileState {
  readonly installId: string;
  readonly orgId: string | null;
  readonly connectionGroupId: string | null;
  readonly dbType: string | null;
  /** Success facts of the last successful baseline; `null` until one succeeds. */
  readonly baseline: BaselineProfileState | null;
  /**
   * The latest baseline FAILURE reason (DSN-scrubbed), surfaced INDEPENDENTLY of
   * whether a prior success exists — so a first-ever baseline failure is VISIBLE
   * (never indistinguishable from "never profiled"), and a re-profile failure
   * after a success surfaces the reason alongside the last good `baseline` facts.
   * `null` when the last baseline attempt succeeded or none has run.
   */
  readonly baselineError: string | null;
  /** `null` until the first enrichment run is recorded. */
  readonly llm: LlmProfileState | null;
}

/**
 * The COALESCE sentinel that keeps a NULL-owner (legacy self-hosted) row a
 * single bucket — MUST match the raw-SQL expression unique index in migration
 * 0171 (`uq_connection_profile_state_org_install`).
 */
const SELF_HOSTED_SENTINEL = "__self_hosted__";
const ON_CONFLICT = `(COALESCE(org_id, '${SELF_HOSTED_SENTINEL}'), install_id)`;

/** Normalise undefined / "" → null so a "no scope" caller can't split buckets. */
function normGroup(connectionGroupId: string | null | undefined): string | null {
  return connectionGroupId == null || connectionGroupId === "" ? null : connectionGroupId;
}

/**
 * Default staleness TTL for an in-flight baseline claim (seconds). A claim older
 * than this is treated as ABANDONED (a crashed/killed run) and re-claimable, so a
 * connection can never wedge permanently in "profiling".
 *
 * INVARIANT: this MUST stay above the worst-case real profile duration. A run that
 * legitimately exceeds the TTL is mistaken for abandoned and re-claimed while still
 * live, re-admitting one overlapping profile per TTL — a bounded partial return of
 * the re-storm. 300s clears a ~120-table schema (profiled in a few minutes) with
 * margin; a much larger warehouse would need this raised (or a progress heartbeat).
 */
export const BASELINE_CLAIM_TTL_SECONDS = 300;

/**
 * Atomically claim the in-flight baseline slot for one connection — the guard
 * that collapses poll-driven backfill calls to ONE running profile per
 * connection across replicas (the coverage re-storm fix, migration 0174).
 *
 * A single guarded UPSERT stamps `baseline_started_at = now()` and returns the
 * row ONLY when the claim is won: no successful baseline exists yet AND no fresh
 * claim is in flight within {@link BASELINE_CLAIM_TTL_SECONDS}. When another
 * caller already holds a fresh claim (or a baseline already succeeded), the
 * `WHERE` fails, no row is returned, and the caller MUST NOT run a profile.
 *
 * Correct under a race: two replicas both UPSERT a brand-new connection — one
 * INSERTs (claim won), the other conflicts and its `DO UPDATE ... WHERE` sees the
 * winner's fresh `baseline_started_at` and matches nothing (claim lost). Exactly
 * one runs. Returns `false` when there's no internal DB (nowhere to profile).
 */
export async function claimBaselineSlot(input: {
  orgId: string | null;
  installId: string;
  connectionGroupId?: string | null;
  dbType: string;
  ttlSeconds?: number;
}): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const rows = await internalQuery<{ id: string }>(
    `INSERT INTO connection_profile_state
       (org_id, install_id, connection_group_id, db_type, baseline_started_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ${ON_CONFLICT}
     DO UPDATE SET baseline_started_at = now(),
                   connection_group_id = EXCLUDED.connection_group_id,
                   db_type = EXCLUDED.db_type,
                   updated_at = now()
       WHERE connection_profile_state.baseline_profiled_at IS NULL
         AND (connection_profile_state.baseline_started_at IS NULL
              OR connection_profile_state.baseline_started_at
                   < now() - make_interval(secs => $5))
     RETURNING id`,
    [
      input.orgId,
      input.installId,
      normGroup(input.connectionGroupId),
      input.dbType,
      input.ttlSeconds ?? BASELINE_CLAIM_TTL_SECONDS,
    ],
  );
  return rows.length > 0;
}

/**
 * Store a fresh baseline profile for one connection. Upserts ONLY the baseline
 * columns (leaves the LLM tier untouched), stamps `baseline_profiled_at = now()`,
 * CLEARS any prior `baseline_error`, and RELEASES the in-flight claim
 * (`baseline_started_at → NULL`) so a future genuine re-profile can re-claim.
 */
export async function upsertBaselineProfile(input: {
  orgId: string | null;
  installId: string;
  connectionGroupId?: string | null;
  dbType: string;
  profiles: readonly TableProfile[];
}): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal DB required for connection profile state");
  }
  await internalQuery(
    `INSERT INTO connection_profile_state
       (org_id, install_id, connection_group_id, db_type,
        baseline_profiles, baseline_table_count, baseline_profiled_at, baseline_error)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), NULL)
     ON CONFLICT ${ON_CONFLICT}
     DO UPDATE SET connection_group_id = EXCLUDED.connection_group_id,
                   db_type = EXCLUDED.db_type,
                   baseline_profiles = EXCLUDED.baseline_profiles,
                   baseline_table_count = EXCLUDED.baseline_table_count,
                   baseline_profiled_at = now(),
                   baseline_error = NULL,
                   baseline_started_at = NULL,
                   updated_at = now()`,
    [
      input.orgId,
      input.installId,
      normGroup(input.connectionGroupId),
      input.dbType,
      JSON.stringify(input.profiles),
      input.profiles.length,
    ],
  );
}

/**
 * Record a baseline-profile FAILURE for one connection — the visible reason the
 * auto/backfill profile couldn't complete. Leaves any prior successful baseline
 * (payload + `baseline_profiled_at`) intact: a re-profile that fails keeps the
 * last good facts and surfaces the new error. RELEASES the in-flight claim
 * (`baseline_started_at → NULL`) so the connection is re-attempted on next need
 * rather than blocked by a stale claim.
 */
export async function recordBaselineError(input: {
  orgId: string | null;
  installId: string;
  connectionGroupId?: string | null;
  dbType: string;
  error: string;
}): Promise<void> {
  if (!hasInternalDB()) {
    throw new Error("Internal DB required for connection profile state");
  }
  await internalQuery(
    `INSERT INTO connection_profile_state
       (org_id, install_id, connection_group_id, db_type, baseline_error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ${ON_CONFLICT}
     DO UPDATE SET connection_group_id = EXCLUDED.connection_group_id,
                   db_type = EXCLUDED.db_type,
                   baseline_error = EXCLUDED.baseline_error,
                   baseline_started_at = NULL,
                   updated_at = now()`,
    [input.orgId, input.installId, normGroup(input.connectionGroupId), input.dbType, input.error],
  );
}

/**
 * Record an LLM-profile (enrichment) run for one connection: stamps
 * `llm_profiled_at = now()` and the run's scope. Upserts ONLY the LLM columns
 * (leaves the baseline tier untouched). Fire-and-forget at the enrichment seam,
 * so it swallows nothing but a missing internal DB (a no-op there).
 */
export async function recordLlmProfileRun(input: {
  orgId: string | null;
  installId: string;
  connectionGroupId?: string | null;
  scope: LlmProfileScope;
}): Promise<void> {
  if (!hasInternalDB()) return;
  await internalQuery(
    `INSERT INTO connection_profile_state
       (org_id, install_id, connection_group_id, llm_profiled_at, llm_profile_scope)
     VALUES ($1, $2, $3, now(), $4::jsonb)
     ON CONFLICT ${ON_CONFLICT}
     -- Preserve a baseline-recorded group when the enrichment caller doesn't
     -- thread one (the wizard doesn't), so recording a run never NULLs the group
     -- a prior baseline established — unlike the baseline upserts, which own it.
     DO UPDATE SET connection_group_id = COALESCE(EXCLUDED.connection_group_id, connection_profile_state.connection_group_id),
                   llm_profiled_at = now(),
                   llm_profile_scope = EXCLUDED.llm_profile_scope,
                   updated_at = now()`,
    [input.orgId, input.installId, normGroup(input.connectionGroupId), JSON.stringify(input.scope)],
  );
}

interface ProfileStateRow extends Record<string, unknown> {
  install_id: string;
  org_id: string | null;
  connection_group_id: string | null;
  db_type: string | null;
  baseline_table_count: number | null;
  baseline_profiled_at: Date | string | null;
  baseline_error: string | null;
  llm_profiled_at: Date | string | null;
  llm_profile_scope: unknown;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseScope(raw: unknown): LlmProfileScope | null {
  // pg returns jsonb already parsed. Tolerate a malformed payload rather than
  // throwing a read — a bad scope shouldn't hide a connection's freshness.
  if (raw == null || typeof raw !== "object") return null;
  const tables = (raw as { tables?: unknown }).tables;
  if (!Array.isArray(tables)) return null;
  return { tables: tables.filter((t): t is string => typeof t === "string") };
}

function mapRow(row: ProfileStateRow): ConnectionProfileState {
  const baselineProfiledAt = toIso(row.baseline_profiled_at);
  const llmProfiledAt = toIso(row.llm_profiled_at);
  return {
    installId: row.install_id,
    orgId: row.org_id,
    connectionGroupId: row.connection_group_id,
    dbType: row.db_type,
    baseline: baselineProfiledAt
      ? {
          profiledAt: baselineProfiledAt,
          tableCount: typeof row.baseline_table_count === "number" ? row.baseline_table_count : 0,
        }
      : null,
    // Surfaced at the top level, NOT nested under `baseline`, so a first-ever
    // failure (baseline_error set, baseline_profiled_at still NULL) is visible.
    baselineError: row.baseline_error,
    llm: llmProfiledAt ? { profiledAt: llmProfiledAt, scope: parseScope(row.llm_profile_scope) } : null,
  };
}

const STATE_COLUMNS = `install_id, org_id, connection_group_id, db_type,
       baseline_table_count, baseline_profiled_at, baseline_error,
       llm_profiled_at, llm_profile_scope`;

/**
 * Read one connection's profile-tier state (both tiers + freshness). Returns
 * `null` when there's no row (never profiled) or no internal DB. Keyed on the
 * same COALESCE sentinel as the write path so a legacy NULL-owner row resolves.
 */
export async function getConnectionProfileState(
  orgId: string | null,
  installId: string,
): Promise<ConnectionProfileState | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<ProfileStateRow>(
    `SELECT ${STATE_COLUMNS}
       FROM connection_profile_state
      WHERE COALESCE(org_id, '${SELF_HOSTED_SENTINEL}') = COALESCE($1, '${SELF_HOSTED_SENTINEL}')
        AND install_id = $2
      LIMIT 1`,
    [orgId, installId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Read the stored baseline `TableProfile[]` payload for one connection — the
 * coverage view's data source (the physical schema matched against the semantic
 * store). Returns `null` when unprofiled / no internal DB, and tolerates a
 * NON-ARRAY payload by returning `null` (the caller triggers a re-profile). The
 * cast trusts element shape: the payload is origin-written by
 * {@link upsertBaselineProfile} from real `TableProfile[]`, never user input.
 *
 * This module is a deliberately logger-free DB seam, so a persistently-corrupt
 * payload degrades silently to "unprofiled" — an acceptable trade for diagnostic
 * metadata; the re-profile a reader triggers is the recovery path.
 */
export async function getBaselineProfiles(
  orgId: string | null,
  installId: string,
): Promise<TableProfile[] | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ baseline_profiles: unknown }>(
    `SELECT baseline_profiles
       FROM connection_profile_state
      WHERE COALESCE(org_id, '${SELF_HOSTED_SENTINEL}') = COALESCE($1, '${SELF_HOSTED_SENTINEL}')
        AND install_id = $2
      LIMIT 1`,
    [orgId, installId],
  );
  const payload = rows[0]?.baseline_profiles;
  if (!Array.isArray(payload)) return null;
  return payload as TableProfile[];
}

/**
 * List every tracked connection profile state for a workspace — the briefing /
 * coverage-overview read. Empty when no internal DB.
 */
export async function listConnectionProfileStates(orgId: string | null): Promise<ConnectionProfileState[]> {
  if (!hasInternalDB()) return [];
  const rows = await internalQuery<ProfileStateRow>(
    `SELECT ${STATE_COLUMNS}
       FROM connection_profile_state
      WHERE COALESCE(org_id, '${SELF_HOSTED_SENTINEL}') = COALESCE($1, '${SELF_HOSTED_SENTINEL}')
      ORDER BY connection_group_id NULLS FIRST, install_id`,
    [orgId],
  );
  return rows.map(mapRow);
}

/** Human-readable freshness for a tracked timestamp. */
export interface ProfileFreshness {
  /** Whole days since the profile ran (0 = today; negative clamps to 0). */
  readonly days: number;
  /** "profiled today" / "profiled 1 day ago" / "profiled N days ago". */
  readonly label: string;
}

/**
 * Pure freshness helper — feeds the briefing's "profiled N days ago" staleness
 * marker. `now` is injected so it's deterministic under test. Returns `null` for
 * an absent/malformed timestamp (never profiled).
 */
export function describeProfileFreshness(
  profiledAtIso: string | null,
  now: Date,
): ProfileFreshness | null {
  if (!profiledAtIso) return null;
  const then = new Date(profiledAtIso);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
  const label =
    days === 0 ? "profiled today" : days === 1 ? "profiled 1 day ago" : `profiled ${days} days ago`;
  return { days, label };
}
