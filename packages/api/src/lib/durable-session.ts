/**
 * Durable agent sessions — terminal-checkpoint write path + retention sweep
 * (#3745, ADR-0020, phase 1a).
 *
 * A *run* is one user turn. Phase 1a writes exactly ONE durable row per turn at
 * completion: `done` on a clean finish, `failed` on an uncaught error. Per-step
 * `running` checkpoints and `parked`/resume land in later slices.
 *
 * These are plain (non-Effect) helpers so the agent loop (`lib/agent.ts`, a
 * plain async function) can call them directly — the same shape as the
 * `token_usage` write it sits beside. The {@link DurableSession} Effect service
 * (`lib/effect/durable-session.ts`) wraps the same helpers for Effect callers
 * (the retention-sweep fiber) and for `Layer.provide` test injection.
 *
 * Fail-soft is the contract: the terminal write rides the fire-and-forget
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

/** Run lifecycle statuses. `running`/`parked` arrive in later slices. */
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
 * Arguments for a terminal-checkpoint write. The single source of truth for the
 * write shape — referenced (via `import type`) by `DurableSessionShape`'s
 * `recordTerminal` so the Effect Tag contract can't drift from the helper.
 */
export interface RecordTerminalRunArgs {
  conversationId: string;
  orgId: string | null;
  status: TerminalAgentRunStatus;
  /**
   * Completed-step COUNT as of this turn (1-based), not a 0-based index:
   * `onFinish` passes `steps.length`; the failure paths pass `observedSteps`
   * (`onStepFinish`'s `stepNumber + 1`). Stored in the `step_index` column.
   */
  stepIndex: number;
  /** Accumulated transcript as of this turn; serialized to JSONB. */
  transcript: ModelMessage[];
}

/**
 * Persist a single terminal run checkpoint (fire-and-forget).
 *
 * Mirrors the `token_usage` write in the agent loop's `onFinish`: gated on
 * `hasInternalDB()`, routed through `internalExecute` (shared circuit breaker),
 * type-narrowed catch, never throws. The transcript is serialized to JSONB.
 */
export function recordTerminalAgentRun(args: RecordTerminalRunArgs): void {
  if (!hasInternalDB()) return;
  try {
    internalExecute(
      `INSERT INTO agent_runs (conversation_id, org_id, status, step_index, transcript, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
      [
        args.conversationId,
        args.orgId,
        args.status,
        args.stepIndex,
        JSON.stringify(args.transcript ?? []),
      ],
    );
  } catch (err) {
    // internalExecute is itself fire-and-forget; this guards a synchronous
    // throw (e.g. JSON.stringify on a circular transcript) so the stream is
    // never disrupted. ADR-0020: a degraded checkpoint store costs
    // resumability, never the current answer.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId: args.conversationId,
        status: args.status,
      },
      "Failed to record terminal agent run checkpoint",
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
