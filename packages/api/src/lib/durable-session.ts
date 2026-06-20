/**
 * Durable agent sessions — per-step + terminal checkpoint write path + retention
 * sweep (#3745 phase 1a, #3746 phase 1b, ADR-0020).
 *
 * A *run* is one user turn occupying exactly ONE durable row, keyed on a stable
 * per-turn run id and advanced IN PLACE:
 *   - phase 1b ({@link recordRunCheckpoint}) upserts a `running` checkpoint at
 *     every agent step boundary — monotonic step index, transcript grown to the
 *     accumulated messages as of that step — so an interrupted turn leaves a
 *     recoverable mid-flight row.
 *   - phase 1a ({@link recordTerminalAgentRun}) flips that same row to `done` on
 *     a clean finish or `failed` on an error.
 * Both target the same row id, so a turn is still one row (in-place update, not
 * append) and retention pressure is unchanged from 1a.
 *
 * These are plain (non-Effect) helpers so the agent loop (`lib/agent.ts`, a
 * plain async function) can call them directly — the same shape as the
 * `token_usage` write it sits beside. The {@link DurableSession} Effect service
 * (`lib/effect/durable-session.ts`) wraps the same helpers for Effect callers
 * (the retention-sweep fiber) and for `Layer.provide` test injection.
 *
 * Fail-soft is the contract: every write rides the fire-and-forget
 * `internalExecute` circuit breaker (shared with token_usage / audit), so a
 * persistence failure logs and never disrupts the live stream. When there is no
 * internal DB the write is a no-op and the loop behaves exactly as it does
 * today — durability is an enhancement, never a new hard requirement.
 */

import type { ModelMessage } from "ai";
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("durable-session");

/** Run lifecycle statuses. `running` is written per-step (1b); `parked` is written on approval-park (#3748). */
export const AGENT_RUN_STATUS = {
  RUNNING: "running",
  PARKED: "parked",
  DONE: "done",
  FAILED: "failed",
} as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUS)[keyof typeof AGENT_RUN_STATUS];

/** Statuses a terminal checkpoint may carry in phase 1a. */
export type TerminalAgentRunStatus =
  | typeof AGENT_RUN_STATUS.DONE
  | typeof AGENT_RUN_STATUS.FAILED;

/** Settings key gating durability on/off (default OFF). */
export const DURABILITY_ENABLED_SETTING = "ATLAS_DURABILITY_ENABLED";
/** Settings key for the terminal-run retention window, in days. */
export const DURABILITY_RETENTION_DAYS_SETTING = "ATLAS_DURABILITY_RETENTION_DAYS";
/** Settings key for the resume-lease TTL, in seconds (#3747). */
export const RESUME_LEASE_TTL_SETTING = "ATLAS_DURABILITY_RESUME_LEASE_SECONDS";
/** Settings key for the max time a turn may stay parked awaiting approval, in minutes (#3748). */
export const MAX_PARK_MINUTES_SETTING = "ATLAS_DURABILITY_MAX_PARK_MINUTES";

/** Fallback retention window when the setting is unset/unparseable. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Default max-park duration. A turn parks awaiting a human approval decision;
 * past this it is swept to `failed` so a never-decided request can't pin a row
 * forever. 1440 minutes (24h) mirrors the approval-queue's own 24h
 * `expires_at` default — by the time the queue entry expires, the parked run
 * the requester was waiting on is reaped on the same clock.
 */
export const DEFAULT_MAX_PARK_MINUTES = 1440;

/**
 * Default resume-lease TTL. A live resume must out-live one full agent turn,
 * so the lease can't expire under the resumer and let a concurrent resume fork
 * the turn: the agent loop's own wall-clock budget is 180s (`totalMs`), so a
 * 300s lease covers a worst-case turn plus stream teardown with headroom. The
 * lease is best-effort-released at stream end; the TTL is the self-heal for a
 * resumer that dies mid-resume (the row unwedges once it lapses).
 */
export const DEFAULT_RESUME_LEASE_SECONDS = 300;

/**
 * Whether durability is enabled for this workspace. Reads the hot-reloadable
 * settings flag (workspace > platform > env > default), defaulting OFF. The
 * per-workspace check belongs at the agent-loop call site, not the write
 * helper, because the retention sweep is operator-global and ignores it.
 */
export function isDurabilityEnabled(orgId?: string): boolean {
  return getSettingAuto(DURABILITY_ENABLED_SETTING, orgId) === "true";
}

/**
 * Clamp a raw settings string to a sane positive integer, else `fallback`. The
 * single home for the "parse + clamp to a positive int, else default" rule the
 * durability knobs share, so a new knob can't drift (e.g. forget the `<= 0`
 * clamp). The `getSettingAuto` READ stays inline at each call site below so the
 * settings-reader parity check (check-settings-readers.sh, #3382) can see each
 * key named next to its reader.
 */
function clampPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Resolve the retention window (days), clamped to a sane positive integer. */
export function getRetentionDays(orgId?: string): number {
  return clampPositiveInt(getSettingAuto(DURABILITY_RETENTION_DAYS_SETTING, orgId), DEFAULT_RETENTION_DAYS);
}

/** Resolve the resume-lease TTL (seconds), clamped to a sane positive integer (#3747). */
export function getResumeLeaseSeconds(orgId?: string): number {
  return clampPositiveInt(getSettingAuto(RESUME_LEASE_TTL_SETTING, orgId), DEFAULT_RESUME_LEASE_SECONDS);
}

/**
 * Resolve the max-park duration (minutes), clamped to a sane positive integer
 * (#3748). The sweep is operator-global, so this reads the platform/env/default
 * tier (no orgId) — same as {@link getRetentionDays}.
 */
export function getMaxParkMinutes(orgId?: string): number {
  return clampPositiveInt(getSettingAuto(MAX_PARK_MINUTES_SETTING, orgId), DEFAULT_MAX_PARK_MINUTES);
}

/**
 * Shared write shape for an agent-run checkpoint. The single source of truth for
 * the upsert columns — referenced (via `import type`) by `DurableSessionShape`'s
 * methods so the Effect Tag contract can't drift from the helpers.
 */
interface AgentRunWrite {
  /**
   * Stable per-turn run id (a UUID). Keys the in-place upsert so every
   * checkpoint of one turn — each per-step `running` write plus the terminal
   * write — targets the SAME row. One row per turn; retention pressure is
   * unchanged from 1a.
   */
  runId: string;
  conversationId: string;
  orgId: string | null;
  /**
   * Completed-step COUNT as of this checkpoint (1-based), not a 0-based index:
   * per-step writes pass `onStepFinish`'s `stepNumber + 1`; the terminal write
   * passes `steps.length` (clean finish) or `observedSteps` (failure). Stored in
   * the `step_index` column and advanced with `GREATEST`, so a reordered
   * fire-and-forget write can never move it backwards.
   */
  stepIndex: number;
  /** Accumulated transcript as of this checkpoint; serialized to JSONB. */
  transcript: ModelMessage[];
}

/** Arguments for a per-step `running` checkpoint write (#3746, phase 1b). */
export type RecordRunCheckpointArgs = AgentRunWrite;

/** Arguments for a terminal (`done`/`failed`) checkpoint write (#3745, phase 1a). */
export interface RecordTerminalRunArgs extends AgentRunWrite {
  status: TerminalAgentRunStatus;
}

/** Arguments for a `parked` checkpoint write (#3748, phase 3). */
export interface RecordParkedRunArgs extends AgentRunWrite {
  /** Approval-queue request id this turn parked on, stored in `parked_reason`. */
  parkedReason: string;
}

// Exported for the real-Postgres upsert-behavior tests (migrate-pg.test.ts) so
// they exercise the EXACT SQL the helpers run, not a hand-copied reimplementation.
export const AGENT_RUN_INSERT = `INSERT INTO agent_runs (id, conversation_id, org_id, status, step_index, transcript, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`;

/**
 * Per-step upsert. Advances step index (monotonically) + transcript in place,
 * but ONLY while the row is still `running` — the `WHERE` guard means a stale,
 * reordered checkpoint can never resurrect a row a later terminal write already
 * flipped to `done`/`failed` (or a future `parked`). `internalExecute` is
 * fire-and-forget and unordered, so the guard, not call order, is what keeps the
 * lifecycle one-directional.
 *
 * `transcript` is guarded the same way as `step_index`: it is only overwritten
 * when the incoming checkpoint is at least as advanced (`EXCLUDED.step_index >=
 * agent_runs.step_index`). Without this a reordered stale checkpoint would pair
 * the higher (GREATEST-preserved) step index with its own older, shorter
 * transcript — leaving step index and transcript mutually inconsistent.
 */
export const RUNNING_UPSERT_SQL = `${AGENT_RUN_INSERT}
       ON CONFLICT (id) DO UPDATE SET
         step_index = GREATEST(agent_runs.step_index, EXCLUDED.step_index),
         transcript = CASE
           WHEN EXCLUDED.step_index >= agent_runs.step_index THEN EXCLUDED.transcript
           ELSE agent_runs.transcript
         END,
         updated_at = now()
       WHERE agent_runs.status NOT IN ('done', 'failed', 'parked')`;

/**
 * Terminal upsert. Always wins the status AND the transcript — the terminal
 * write carries the authoritative full-turn transcript, so (unlike the running
 * path) it overwrites unconditionally. Step index never regresses (`GREATEST`).
 */
export const TERMINAL_UPSERT_SQL = `${AGENT_RUN_INSERT}
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         step_index = GREATEST(agent_runs.step_index, EXCLUDED.step_index),
         transcript = EXCLUDED.transcript,
         updated_at = now()`;

/**
 * Parked upsert (#3748, ADR-0020 phase 3). A turn that hit an approval-required
 * action flips its row to `parked` carrying the approval-queue ref in
 * `parked_reason` and the full transcript-as-of-park — the park IS the
 * authoritative end of this stream (the loop made no further model calls), so it
 * overwrites status + transcript within the conflict branch.
 *
 * Lifecycle guard (`WHERE agent_runs.status NOT IN ('done', 'failed')`): like
 * {@link RUNNING_UPSERT_SQL}, the lifecycle is one-directional and
 * `internalExecute` is fire-and-forget + unordered. The `terminalWritten` flag
 * in the loop already stops a terminal and a parked write from BOTH being queued
 * for one run, but the guard is the durable backstop: a `parked` write that
 * somehow lands after a terminal (`done`/`failed`) write can never resurrect the
 * row back to `parked`. The extra `$7` param is the `parked_reason` the
 * running/terminal upserts don't carry, so this is its own statement rather than
 * a reuse of {@link AGENT_RUN_INSERT}.
 */
export const PARKED_UPSERT_SQL = `INSERT INTO agent_runs (id, conversation_id, org_id, status, step_index, transcript, parked_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         step_index = GREATEST(agent_runs.step_index, EXCLUDED.step_index),
         transcript = EXCLUDED.transcript,
         parked_reason = EXCLUDED.parked_reason,
         updated_at = now()
       WHERE agent_runs.status NOT IN ('done', 'failed')`;

/**
 * Shared write body for both checkpoint helpers (fire-and-forget).
 *
 * Mirrors the `token_usage` write in the agent loop: gated on `hasInternalDB()`,
 * routed through `internalExecute` (shared circuit breaker), type-narrowed
 * catch, never throws. The transcript is serialized to JSONB inside the `try`
 * so a synchronous `JSON.stringify` throw (e.g. a circular transcript) is caught
 * and the stream is never disrupted.
 */
function writeAgentRunCheckpoint(
  sql: string,
  args: AgentRunWrite,
  status: AgentRunStatus,
  failureMessage: string,
): void {
  if (!hasInternalDB()) return;
  try {
    internalExecute(sql, [
      args.runId,
      args.conversationId,
      args.orgId,
      status,
      args.stepIndex,
      JSON.stringify(args.transcript ?? []),
    ]);
  } catch (err) {
    // ADR-0020: a degraded checkpoint store costs resumability, never the
    // current answer.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId: args.conversationId,
        runId: args.runId,
        status,
      },
      failureMessage,
    );
  }
}

/**
 * Persist a per-step `running` checkpoint (fire-and-forget, #3746). Upserts the
 * run row in place keyed on {@link AgentRunWrite.runId} so an interrupted turn
 * leaves a recoverable mid-flight row at the last completed step.
 */
export function recordRunCheckpoint(args: RecordRunCheckpointArgs): void {
  writeAgentRunCheckpoint(
    RUNNING_UPSERT_SQL,
    args,
    AGENT_RUN_STATUS.RUNNING,
    "Failed to record agent run checkpoint",
  );
}

/**
 * Persist a terminal run checkpoint (`done`/`failed`, fire-and-forget, #3745).
 * Flips the same per-turn row to its terminal status.
 */
export function recordTerminalAgentRun(args: RecordTerminalRunArgs): void {
  writeAgentRunCheckpoint(
    TERMINAL_UPSERT_SQL,
    args,
    args.status,
    "Failed to record terminal agent run checkpoint",
  );
}

/**
 * Persist a `parked` checkpoint (fire-and-forget, #3748). Flips the per-turn row
 * to `parked` with the approval-queue ref in `parked_reason` and the full
 * transcript-as-of-park, after the agent loop stopped at the gated step. Mirrors
 * {@link recordTerminalAgentRun}'s fail-soft contract (gated on `hasInternalDB`,
 * routed through the shared `internalExecute` circuit breaker, type-narrowed
 * catch, never throws) but carries the extra `parked_reason` param.
 */
export function recordParkedAgentRun(args: RecordParkedRunArgs): void {
  if (!hasInternalDB()) return;
  try {
    internalExecute(PARKED_UPSERT_SQL, [
      args.runId,
      args.conversationId,
      args.orgId,
      AGENT_RUN_STATUS.PARKED,
      args.stepIndex,
      JSON.stringify(args.transcript ?? []),
      args.parkedReason,
    ]);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId: args.conversationId,
        runId: args.runId,
        parkedReason: args.parkedReason,
      },
      "Failed to record parked agent run checkpoint",
    );
  }
}

/**
 * Delete terminal (`done`/`failed`) runs whose last update is older than the
 * retention window. Non-terminal (`running`/`parked`) runs are never touched —
 * they are the live working set for resume. Returns the number of rows deleted,
 * or -1 on error (mirrors `cleanupExpiredShares`).
 */
export async function sweepTerminalAgentRuns(retentionDays: number): Promise<number> {
  if (!hasInternalDB()) return 0;
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS;
  try {
    const rows = await internalQuery<{ id: string }>(
      `DELETE FROM agent_runs
        WHERE status IN ('done', 'failed')
          AND updated_at < now() - ($1 || ' days')::interval
        RETURNING id`,
      [String(days)],
    );
    const count = rows.length;
    if (count > 0) {
      log.info({ count, retentionDays: days }, "Swept terminal agent runs past retention window");
    }
    return count;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to sweep terminal agent runs",
    );
    return -1;
  }
}

/**
 * Fail `parked` runs whose last update (the park time) is older than the
 * max-park window (#3748). A turn parks awaiting a human approval decision; if
 * the decision never lands, the run would pin a non-terminal row forever — so
 * it is swept to `failed` (NOT deleted), which both releases it from the live
 * working set and lets the existing terminal retention sweep reap it later on
 * the normal clock. Returns the number of rows failed, or -1 on error (mirrors
 * {@link sweepTerminalAgentRuns}).
 */
// Exported for the real-Postgres sweep test (migrate-pg.test.ts) so it exercises
// the EXACT interval/UPDATE the helper runs, not a hand-copied reimplementation.
export const PARKED_SWEEP_SQL = `UPDATE agent_runs
          SET status = 'failed', parked_reason = NULL, updated_at = now()
        WHERE status = 'parked'
          AND updated_at < now() - ($1 || ' minutes')::interval
        RETURNING id`;

export async function sweepExpiredParkedRuns(maxParkMinutes: number): Promise<number> {
  if (!hasInternalDB()) return 0;
  const minutes =
    Number.isFinite(maxParkMinutes) && maxParkMinutes > 0 ? maxParkMinutes : DEFAULT_MAX_PARK_MINUTES;
  try {
    const rows = await internalQuery<{ id: string }>(PARKED_SWEEP_SQL, [String(minutes)]);
    const count = rows.length;
    if (count > 0) {
      log.info({ count, maxParkMinutes: minutes }, "Failed parked agent runs past max-park duration");
    }
    return count;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to sweep expired parked agent runs",
    );
    return -1;
  }
}

// ── Crash-resume (#3747, ADR-0020 phase 2) ──────────────────────────────────

/**
 * A leased, resumable run loaded from the checkpoint store. The transcript is
 * the accumulated `ModelMessage[]` as of `stepIndex` — the input messages plus
 * every completed step's assistant/tool messages. Re-entering `streamText` with
 * it makes the model CONTINUE (the completed tool calls are already in the
 * messages array) rather than re-execute. `orgId` is the run's stored tenant,
 * surfaced for telemetry only — security is re-resolved LIVE at resume time from
 * the request's auth context, never from this field (ADR-0020 invariant).
 */
export interface ResumableRun {
  /** The run id — reused so resumed checkpoints target the SAME row. */
  readonly runId: string;
  readonly conversationId: string;
  readonly orgId: string | null;
  /** Completed-step count as of the loaded checkpoint; the resume continues at stepIndex+1. */
  readonly stepIndex: number;
  /** Accumulated transcript as of `stepIndex`. */
  readonly transcript: ModelMessage[];
  /** The lease token this resume holds — pass to {@link releaseResumeLease} to free it. */
  readonly leaseOwner: string;
}

/**
 * Outcome of an attempt to claim a resumable run.
 *
 * - `"resumable"` — a non-terminal run existed and we won its lease; the run is
 *   carried.
 * - `"none"` — no non-terminal run exists for this conversation (nothing to
 *   resume — the last turn finished cleanly, or durability was never on).
 * - `"leased"` — a non-terminal run exists but another resume already holds a
 *   live lease on it; this is the single-flight rejection.
 * - `"no_db"` — no internal DB (durability is a no-op).
 * - `"error"` — the claim query failed; the caller fails closed (does NOT
 *   resume) so a transient DB blip can never silently start a second stream.
 */
export type ResumeClaim =
  | { readonly status: "resumable"; readonly run: ResumableRun }
  | { readonly status: "none" }
  | { readonly status: "leased" }
  | { readonly status: "no_db" }
  | { readonly status: "error" };

/**
 * Atomically find and lease the latest non-terminal run for a conversation.
 *
 * The single-flight guard lives in ONE statement (a CTE-driven conditional
 * UPDATE), so there is no TOCTOU window between "find the resumable run" and
 * "claim its lease": two concurrent resumes of the same run race on the row
 * lock and exactly one wins the UPDATE. The loser sees the row already leased
 * (its `WHERE` no longer matches) and gets `"leased"`.
 *
 * The lease is claimable when `resuming_lease IS NULL` (never leased) OR
 * `resuming_lease < now()` (a stale lease from a resumer that died mid-resume —
 * the TTL self-heal). Winning stamps a fresh `leaseOwner` token and a
 * `now() + ttl` expiry. `leaseSeconds` is the caller-resolved TTL.
 *
 * Returns the run's stored transcript + step index + run id for re-entry, plus
 * the lease token the caller must pass to {@link releaseResumeLease}. The org id
 * is surfaced for telemetry only — the caller re-resolves auth/whitelist/RLS
 * LIVE, never from the stored row.
 */
// Exported for the real-Postgres single-flight test (migrate-pg.test.ts) so it
// exercises the EXACT claim SQL the helper runs, not a hand-copied one.
//
// Existence probe: is there a crash-resumable (`running`) run for this
// conversation? Distinguishes "nothing to resume" (`none`) from "exists but
// already leased" (`leased`) so the caller rejects a double-attach distinctly
// from a clean no-op.
//
// #3748 — `parked` is deliberately EXCLUDED. A parked run is intentionally
// suspended awaiting a human approval decision, not a crash victim; auto-
// resuming it would let the model answer "still pending" and burn the park.
// Resolution (`resolveParkedRun`) flips it back to `running` once the decision
// lands, at which point this probe (and the claim below) picks it up.
export const RESUME_EXISTS_SQL = `SELECT id FROM agent_runs
        WHERE conversation_id = $1 AND status = 'running'
        ORDER BY updated_at DESC
        LIMIT 1`;

// Atomic lease claim. The CTE picks the latest crash-resumable (`running`)
// CLAIMABLE row (lease free or expired) FOR UPDATE SKIP LOCKED — a concurrent
// claimer skips the locked row rather than blocking — and the UPDATE only fires
// when the lease is free/expired. RETURNING the transcript means the read and
// the claim are the same statement, so there is no TOCTOU window: exactly one of
// two concurrent resumes wins the row, the other gets zero rows back
// (→ `leased`). `parked` is excluded for the same reason as the existence probe
// above (#3748).
export const RESUME_CLAIM_SQL = `WITH target AS (
         SELECT id FROM agent_runs
          WHERE conversation_id = $1 AND status = 'running'
            AND (resuming_lease IS NULL OR resuming_lease < now())
          ORDER BY updated_at DESC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE agent_runs a
          SET resuming_lease = now() + ($2 || ' seconds')::interval,
              resuming_lease_owner = $3,
              updated_at = now()
         FROM target
        WHERE a.id = target.id
        RETURNING a.id, a.org_id, a.step_index, a.transcript`;

export async function loadAndLeaseResumableRun(
  conversationId: string,
  leaseSeconds: number,
): Promise<ResumeClaim> {
  if (!hasInternalDB()) return { status: "no_db" };
  const ttl = Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : DEFAULT_RESUME_LEASE_SECONDS;
  const leaseOwner = crypto.randomUUID();
  try {
    const existing = await internalQuery<{ id: string }>(RESUME_EXISTS_SQL, [conversationId]);
    if (existing.length === 0) return { status: "none" };

    const claimed = await internalQuery<{
      id: string;
      org_id: string | null;
      step_index: number;
      transcript: unknown;
    }>(RESUME_CLAIM_SQL, [conversationId, String(ttl), leaseOwner]);

    if (claimed.length === 0) {
      // A non-terminal run exists (the SELECT above found one) but the claim
      // updated nothing — another resume holds a live lease (or locked the row).
      // Single-flight rejection.
      return { status: "leased" };
    }

    const row = claimed[0]!;
    const transcript = Array.isArray(row.transcript)
      ? (row.transcript as ModelMessage[])
      : [];
    return {
      status: "resumable",
      run: {
        runId: row.id,
        conversationId,
        orgId: row.org_id,
        // Clamp non-negative at the read boundary: a corrupt negative
        // `step_index` must not seed a negative resume offset (which would
        // regress the step counter / starve the per-request budget downstream).
        stepIndex: Math.max(
          0,
          typeof row.step_index === "number" ? row.step_index : Number(row.step_index) || 0,
        ),
        transcript,
        leaseOwner,
      },
    };
  } catch (err) {
    // Fail closed: a claim failure must NOT resume (a transient DB blip can't be
    // allowed to silently start a second concurrent stream). The caller maps
    // `error` to a 503-style retry, never a resume.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId },
      "Failed to load/lease resumable run",
    );
    return { status: "error" };
  }
}

/**
 * The latest run's lifecycle state for a conversation, as surfaced to the web
 * chat client at load/reconnect time (#3749). Unlike {@link loadAndLeaseResumableRun}
 * this is a pure READ — it claims no lease and never mutates — so the client can
 * decide whether to render a resume affordance (`running`), a waiting-on-approval
 * state (`parked`), or nothing (`done`/`failed`/`none`) before any resume is
 * attempted. `none` means there is no run to surface: no internal DB, durability
 * never wrote a row, a read blip (fail-soft), or an unrecognized status value.
 */
export type LatestRunStatus =
  | { readonly status: AgentRunStatus; readonly runId: string; readonly parkedReason: string | null }
  | { readonly status: "none" };

// Read-only peek at the most-recently-touched run for a conversation. NOT
// status-filtered: it reports whatever the latest run is, so a terminal latest
// run correctly yields "no affordance" instead of being masked by an older
// `running` row. Mirrors the ORDER BY of the resume probe so "latest" means the
// same row the resume endpoint would act on.
export const LATEST_RUN_STATUS_SQL = `SELECT id, status, parked_reason FROM agent_runs
        WHERE conversation_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`;

const KNOWN_RUN_STATUSES: ReadonlySet<string> = new Set(Object.values(AGENT_RUN_STATUS));

/**
 * Read the latest run's status for a conversation so the web chat can detect, on
 * load/reconnect, whether to offer resume (`running`), show a waiting-on-approval
 * state (`parked`), or render nothing (`done`/`failed`/`none`) (#3749).
 *
 * Fail-soft: this is a non-critical load-time enhancement, so a no-DB, no-row, or
 * read-error case all degrade to `{ status: "none" }` (no affordance) rather than
 * surfacing an error and blocking the conversation open — the blip is logged. An
 * unrecognized status string (schema drift / corruption) is likewise coerced to
 * `none` so a bogus value never reaches the client.
 *
 * Caller is responsible for conversation ownership (the read is keyed on
 * conversation id only) exactly as the resume endpoint is — this never authorizes.
 */
export async function loadLatestRunStatus(conversationId: string): Promise<LatestRunStatus> {
  if (!hasInternalDB()) return { status: "none" };
  try {
    const rows = await internalQuery<{ id: string; status: string; parked_reason: string | null }>(
      LATEST_RUN_STATUS_SQL,
      [conversationId],
    );
    const row = rows[0];
    if (!row) return { status: "none" };
    if (!KNOWN_RUN_STATUSES.has(row.status)) {
      log.warn(
        { conversationId, runId: row.id, status: row.status },
        "Latest run carries an unrecognized status — coercing to none",
      );
      return { status: "none" };
    }
    return {
      status: row.status as AgentRunStatus,
      runId: row.id,
      parkedReason: row.parked_reason ?? null,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId },
      "Failed to load latest run status",
    );
    return { status: "none" };
  }
}

/**
 * Release a resume lease — best-effort, fire-and-forget. Clears the lease only
 * while THIS resumer still owns it (`resuming_lease_owner = $2`): a TTL-expired
 * resumer whose release fires late can't wipe a lease a second resumer already
 * re-claimed (which would let a third fork the turn). Never throws; a failed
 * release just leaves the lease to lapse on its TTL.
 *
 * Takes a single object param (not two positional strings) so `runId` and
 * `leaseOwner` can't be silently transposed at a call site — a swap would
 * UPDATE nothing (the owner guard never matches) and leak the lease until its
 * TTL with no error.
 */
export function releaseResumeLease({
  runId,
  leaseOwner,
}: {
  runId: string;
  leaseOwner: string;
}): void {
  if (!hasInternalDB()) return;
  try {
    internalExecute(
      `UPDATE agent_runs
          SET resuming_lease = NULL, resuming_lease_owner = NULL, updated_at = now()
        WHERE id = $1 AND resuming_lease_owner = $2`,
      [runId, leaseOwner],
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), runId },
      "Failed to release resume lease (will lapse on TTL)",
    );
  }
}

// ── Approval-park resolution (#3748, ADR-0020 phase 3) ──────────────────────

/** A parked run loaded for approval resolution. */
export interface ParkedRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly orgId: string | null;
  readonly stepIndex: number;
  /**
   * The approval-queue ref this run parked on (the `parked_reason` column). A
   * parked row ALWAYS has one — it is the only link from a decision back to the
   * suspended turn — so it is non-null here (the load filters `status = 'parked'`,
   * and the `chk_agent_runs_parked_reason` CHECK forbids a reason-less parked row).
   */
  readonly parkedReason: string;
  /** Transcript-as-of-park (carries the needs-approval tool result to rewrite). */
  readonly transcript: ModelMessage[];
}

/**
 * Outcome of {@link loadParkedRunByApprovalRef}.
 *
 * - `"found"` — a parked run is waiting; `run` carries it.
 * - `"none"` — no parked run is waiting (already resolved/expired, never parked,
 *   or no internal DB / durability off). Benign: nothing to re-arm.
 * - `"error"` — the DB could not be reached to even check. Distinct from `"none"`
 *   so the caller can surface a read-side blip as actionable (`failed`) rather
 *   than silently treating a stuck-but-unreadable parked run as "nothing here".
 */
export type LoadParkedRunResult =
  | { readonly status: "found"; readonly run: ParkedRun }
  | { readonly status: "none" }
  | { readonly status: "error" };

/**
 * Load the parked run that is waiting on a given approval-queue request, keyed
 * on the `parked_reason` the park write stamped (#3748). `agent_runs` and the
 * approval queue are decoupled at the schema level, so `parked_reason` IS the
 * link from a decision back to the suspended turn. Returns a three-way result so
 * the caller can tell "nothing to re-arm" (`none`) apart from "could not reach
 * the DB to check" (`error`) — a read-side blip must not masquerade as benign,
 * or an approved request could sit stuck until the 24h sweep with no actionable
 * log. (The write side, `resolveParkedRun`, already distinguishes its `error`.)
 *
 * Tenancy: looked up by the approval-request UUID alone (not org-scoped). The
 * sole caller (the admin review endpoint) reaches here only AFTER
 * `reviewApprovalRequest` authorized the request against the reviewer's org, and
 * the parked run's `org_id` equals that approval's org — so cross-tenant
 * resolution is already prevented upstream.
 */
export async function loadParkedRunByApprovalRef(approvalRequestId: string): Promise<LoadParkedRunResult> {
  if (!hasInternalDB()) return { status: "none" };
  try {
    const rows = await internalQuery<{
      id: string;
      conversation_id: string;
      org_id: string | null;
      step_index: number;
      parked_reason: string | null;
      transcript: unknown;
    }>(
      `SELECT id, conversation_id, org_id, step_index, parked_reason, transcript
         FROM agent_runs
        WHERE parked_reason = $1 AND status = 'parked'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [approvalRequestId],
    );
    const row = rows[0];
    if (!row) return { status: "none" };
    return {
      status: "found",
      run: {
        runId: row.id,
        conversationId: row.conversation_id,
        orgId: row.org_id,
        stepIndex: Math.max(
          0,
          typeof row.step_index === "number" ? row.step_index : Number(row.step_index) || 0,
        ),
        // Non-null for a `status = 'parked'` row (the WHERE matched it on `$1`, and
        // the CHECK forbids a reason-less parked row); fall back to the queried ref.
        parkedReason: row.parked_reason ?? approvalRequestId,
        transcript: Array.isArray(row.transcript) ? (row.transcript as ModelMessage[]) : [],
      },
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), approvalRequestId },
      "Failed to load parked run for approval resolution",
    );
    return { status: "error" };
  }
}

/**
 * Commit an approval decision to a parked run: write the rewritten transcript
 * (the needs-approval tool result replaced by an approved/denied result) and
 * flip the row `parked` → `running`, clearing `parked_reason` (#3748). The run
 * is now an ordinary mid-flight checkpoint the resume endpoint claims and
 * continues IN THE REQUESTER'S live context — security (auth/whitelist/RLS) is
 * re-resolved fresh at resume, never from this row (ADR-0020 invariant), which
 * is why the decision does NOT execute the gated query here.
 *
 * The `status = 'parked'` guard makes a double-resolution (e.g. an approve+deny
 * race, or a retried review) a `"noop"` rather than resurrecting a run that
 * already resumed. Awaited (not fire-and-forget) so the caller learns whether
 * the resume was armed; the three-way outcome lets it tell a benign no-op
 * (`"noop"` — nothing to arm) apart from a real failure to arm (`"error"` — a DB
 * write blip the caller should surface as actionable, since a recorded decision
 * then never resumes the requester's turn).
 */
export type ResolveParkedRunOutcome = "resolved" | "noop" | "error";
// Exported for the real-Postgres resolution test (migrate-pg.test.ts) so it
// exercises the EXACT UPDATE (with its `status = 'parked'` double-resolution
// guard) the helper runs.
export const PARKED_RESOLVE_SQL = `UPDATE agent_runs
          SET status = 'running',
              transcript = $2::jsonb,
              parked_reason = NULL,
              step_index = GREATEST(step_index, $3),
              updated_at = now()
        WHERE id = $1 AND status = 'parked'
        RETURNING id`;

/**
 * Arguments for {@link resolveParkedRun}. A single object (not positional) for
 * the same anti-transposition reason as {@link releaseResumeLease}, and named
 * like the sibling `*Args` write types.
 */
export interface ResolveParkedRunArgs {
  readonly runId: string;
  readonly transcript: ModelMessage[];
  readonly stepIndex: number;
}

export async function resolveParkedRun(args: ResolveParkedRunArgs): Promise<ResolveParkedRunOutcome> {
  if (!hasInternalDB()) return "noop";
  try {
    const rows = await internalQuery<{ id: string }>(PARKED_RESOLVE_SQL, [
      args.runId,
      JSON.stringify(args.transcript ?? []),
      args.stepIndex,
    ]);
    return rows.length > 0 ? "resolved" : "noop";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), runId: args.runId },
      "Failed to resolve parked agent run",
    );
    return "error";
  }
}
