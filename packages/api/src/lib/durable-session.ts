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

/** Run lifecycle statuses. `running` is written per-step (1b); `parked` arrives with resume. */
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

/** Fallback retention window when the setting is unset/unparseable. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Whether durability is enabled for this workspace. Reads the hot-reloadable
 * settings flag (workspace > platform > env > default), defaulting OFF. The
 * per-workspace check belongs at the agent-loop call site, not the write
 * helper, because the retention sweep is operator-global and ignores it.
 */
export function isDurabilityEnabled(orgId?: string): boolean {
  return getSettingAuto(DURABILITY_ENABLED_SETTING, orgId) === "true";
}

/** Resolve the retention window (days), clamped to a sane positive integer. */
export function getRetentionDays(orgId?: string): number {
  const raw = getSettingAuto(DURABILITY_RETENTION_DAYS_SETTING, orgId);
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
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
